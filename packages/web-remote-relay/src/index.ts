/* eslint-disable max-lines -- 配对状态机与 socket 生命周期共享同一份 deviceSid 索引：
   每个处理函数都要读改写 devices/terminalBySocket，并把结果回写到两端 socket。
   拆文件就得把这份索引与它的全部读写规则一起搬走，收益是行数、代价是「谁改了这个 map」变隐式。 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import {
  WEB_REMOTE_CONTROL_MAX_BINARY_FRAME_BYTES,
  buildWebRemoteControlProofMessage,
  webRemoteControlRelayInboundMessageSchema,
  type WebRemoteControlPairStatus,
  type WebRemoteControlRelayErrorCode,
} from "@acode/shared";

// 手机扫码远控的 relay。
//
// 职责只有四件：配对、鉴权、转发、隔离。**不保存任何业务状态**——没有任务队列、没有
// 快照、没有会话内容（AGENTS.md「进程、协议与远程控制」明确要求 relay 只做鉴权、配对、
// 心跳、转发与 attachment 调度）。它甚至不理解自己转发的是什么字节。
//
// 传输形态（同一条 WebSocket）：
//   - 文本帧 = 控制消息（JSON），本文件解析
//   - 二进制帧 = 配对成立后从一端**原样**转给另一端
//
// 信任模型：relay 会看到 passHash（它就是二维码里带的配对密钥），因此 relay 是信任边界，
// 必须自托管。它看不到工作区内容之外的任何东西——二进制帧不透明。

const DEVICE_AUTH_TIMEOUT_MS = 30_000;
const TERMINAL_AUTH_TIMEOUT_MS = 30_000;
/** 一段时间没有任何控制消息或二进制帧即认为链路已死。桌面侧心跳是 10s±2s。 */
const IDLE_TIMEOUT_MS = 90_000;
/**
 * 设备 socket 断开后保留其注册多久。
 *
 * **不能一断就删**：桌面侧重连延迟是 1s，网络抖动/relay 重启都会断一次；若此时把
 * deviceSid 删掉，桌面的 `persisted` 重连必然 AUTH_FAILED → 降级重新注册 → 拿到新的
 * deviceSid → **二维码被换掉**，手机上那条链接直接作废。
 *
 * 保留窗口同时决定了「桌面退出后旧二维码还能用多久」，所以不能太长。
 */
const DEVICE_RETENTION_MS = 5 * 60_000;

export interface WebRemoteRelayLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface DeviceRecord {
  socket: WebSocket;
  deviceMid: string;
  passHash: string;
  meta: unknown;
  authenticated: boolean;
  pairStatus: WebRemoteControlPairStatus;
  terminal?: TerminalRecord;
  authNonce?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  /** 保留窗口定时器：socket 断开后延迟清理注册。已重连时为 undefined。 */
  retentionTimer?: ReturnType<typeof setTimeout>;
}

interface TerminalRecord {
  socket: WebSocket;
  deviceSid: string;
  authenticated: boolean;
  authNonce?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  /** attach 是否已就绪：就绪前不转发二进制帧，避免把半个握手喂给手机。 */
  attachReady: boolean;
}

export interface WebRemoteRelayServer {
  handleUpgrade(request: unknown, socket: unknown, head: unknown): void;
  close(): void;
  /** 诊断用。 */
  getStats(): { devices: number; terminals: number };
}

export function createWebRemoteRelayServer(
  options: {
    logger?: WebRemoteRelayLogger;
  } = {},
): WebRemoteRelayServer {
  const logger: WebRemoteRelayLogger = options.logger ?? {
    info: () => {},
    warn: () => {},
  };

  /** deviceSid → 设备记录。relay 是 deviceSid 的唯一签发者。 */
  const devices = new Map<string, DeviceRecord>();
  /** 反向索引：socket → 它属于哪个 deviceSid，便于 close 时清理。 */
  const deviceSidBySocket = new WeakMap<WebSocket, string>();
  const terminalBySocket = new WeakMap<WebSocket, TerminalRecord>();

  const wss = new WebSocketServer({ noServer: true });

  function sendControl(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      logger.warn("[relay] send control failed", error);
    }
  }

  function sendError(
    socket: WebSocket,
    code: WebRemoteControlRelayErrorCode,
    message: string,
  ): void {
    sendControl(socket, { type: "error", code, message });
  }

  function calculateProof(
    passHash: string,
    nonce: string,
    role: string,
    deviceSid: string,
  ): string {
    return createHmac("sha256", passHash)
      .update(
        buildWebRemoteControlProofMessage({
          nonce,
          role: role as "device" | "terminal",
          deviceSid,
        }),
      )
      .digest("base64url");
  }

  /** 定长比较：proof 是密钥材料，不能靠字符串比较的短路行为泄露前缀。 */
  function proofMatches(expected: string, actual: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(actual, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function closeDevice(deviceSid: string, reason: string): void {
    const device = devices.get(deviceSid);
    if (!device) return;
    devices.delete(deviceSid);
    if (device.authTimer) clearTimeout(device.authTimer);
    if (device.retentionTimer) clearTimeout(device.retentionTimer);
    // 设备走了，它配对的手机也必须掉线：否则手机以为还连着，实际对端已经没人读。
    detachTerminal(device, "desktop-disconnected", 4010);
    try {
      device.socket.close(1000, reason);
    } catch {
      // 同上。
    }
    logger.info(`[relay] device closed sid=${deviceSid.slice(-6)} reason=${reason}`);
  }

  /**
   * 让当前配对的手机掉线，但保留设备注册。
   *
   * 与 closeDevice 的区别是「设备还在不在」：这里设备只是暂时不可达（断线/被顶掉），
   * 注册要继续有效，好让桌面用持久化凭证重连回同一个 deviceSid。
   */
  function detachTerminal(device: DeviceRecord, errorCode: string, closeCode: number): void {
    const terminal = device.terminal;
    if (!terminal) return;
    device.terminal = undefined;
    device.pairStatus = "waiting";
    if (terminal.authTimer) clearTimeout(terminal.authTimer);
    sendError(terminal.socket, "INTERNAL", errorCode);
    try {
      terminal.socket.close(closeCode, errorCode);
    } catch {
      // 关闭失败不影响清理：引用已从记录里摘掉。
    }
  }

  /**
   * 设备 socket 断开：不立即删注册，进入保留窗口。
   *
   * 桌面侧的自动重连是 1s，绝大多数断开会在保留窗口内被重连回同一个 deviceSid；
   * 用户点「停止」时会显式发 device_release，走 closeDevice 立即失效。
   */
  function detachDevice(deviceSid: string, reason: string): void {
    const device = devices.get(deviceSid);
    if (!device) return;
    device.authenticated = false;
    if (device.authTimer) clearTimeout(device.authTimer);
    device.authTimer = undefined;
    device.authNonce = undefined;
    detachTerminal(device, "desktop-disconnected", 4010);
    if (device.retentionTimer) clearTimeout(device.retentionTimer);
    device.retentionTimer = setTimeout(() => {
      const current = devices.get(deviceSid);
      if (current !== device) return;
      devices.delete(deviceSid);
      logger.info(`[relay] device registration expired sid=${deviceSid.slice(-6)}`);
    }, DEVICE_RETENTION_MS);
    device.retentionTimer.unref?.();
    logger.info(
      `[relay] device detached sid=${deviceSid.slice(-6)} reason=${reason} retained=${DEVICE_RETENTION_MS}ms`,
    );
  }

  function handleDeviceRegisterInit(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "device_register_init" }
    >,
  ): void {
    // 一个 deviceMid 只允许一条在线设备连接：重复注册说明旧连接已经失联但还没被回收，
    // 放两条进来会让同一台桌面出现两个 deviceSid，二维码指向哪个都说不清。
    for (const [sid, existing] of devices) {
      if (existing.deviceMid === message.device_mid) {
        logger.info(`[relay] superseding stale device sid=${sid.slice(-6)}`);
        closeDevice(sid, "superseded");
      }
    }
    const deviceSid = randomUUID();
    const record: DeviceRecord = {
      socket,
      deviceMid: message.device_mid,
      passHash: message.pass_hash,
      meta: message.meta,
      authenticated: false,
      pairStatus: "waiting",
    };
    devices.set(deviceSid, record);
    deviceSidBySocket.set(socket, deviceSid);
    sendControl(socket, { type: "device_register_ack", device_sid: deviceSid });
    logger.info(`[relay] device registered sid=${deviceSid.slice(-6)}`);
  }

  function beginChallenge(socket: WebSocket, deviceSid: string, role: "device" | "terminal"): void {
    const nonce = randomBytes(24).toString("base64url");
    const timer = setTimeout(
      () => {
        sendError(socket, "AUTH_FAILED", "鉴权超时");
        try {
          socket.close(4001, "auth-timeout");
        } catch {
          // 超时清理：socket 引用由 close 处理器回收。
        }
      },
      role === "device" ? DEVICE_AUTH_TIMEOUT_MS : TERMINAL_AUTH_TIMEOUT_MS,
    );
    timer.unref?.();

    if (role === "device") {
      const device = devices.get(deviceSid);
      if (device) {
        device.authNonce = nonce;
        device.authTimer = timer;
      }
    } else {
      const terminal = terminalBySocket.get(socket);
      if (terminal) {
        terminal.authNonce = nonce;
        terminal.authTimer = timer;
      }
    }
    sendControl(socket, { type: "auth_challenge", nonce });
  }

  function handleAuthInit(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "auth_init" }
    >,
  ): void {
    if (message.role === "device") {
      const device = devices.get(message.device_sid);
      if (!device) {
        sendError(socket, "AUTH_FAILED", "设备句柄无效");
        return;
      }
      // 保留窗口内重连：换绑到新 socket，取消清理定时器。deviceSid 与 passHash 不变，
      // 因此桌面上的二维码继续有效、手机不需要重新扫码。
      if (device.retentionTimer) {
        clearTimeout(device.retentionTimer);
        device.retentionTimer = undefined;
      }
      device.socket = socket;
      device.meta = message.meta;
      beginChallenge(socket, message.device_sid, "device");
      return;
    }

    const device = devices.get(message.device_sid);
    if (!device) {
      // 手机拿着一个已经不存在的 deviceSid（二维码过期 / 桌面已关闭）。
      sendError(socket, "AUTH_FAILED", "配对会话不存在或已失效");
      return;
    }
    beginChallenge(socket, message.device_sid, "terminal");
  }

  function handleAuthResponse(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "auth_response" }
    >,
  ): void {
    const device = devices.get(message.device_sid);
    if (!device) {
      sendError(socket, "AUTH_FAILED", "配对会话不存在或已失效");
      return;
    }

    // 谁在应答？socket 决定角色，不接受消息里自称的角色。
    const isDevice = device.socket === socket;
    const terminal = terminalBySocket.get(socket);
    if (!isDevice && !terminal) {
      sendError(socket, "AUTH_FAILED", "未参与本次配对的连接");
      return;
    }

    const nonce = isDevice ? device.authNonce : terminal?.authNonce;
    if (!nonce) {
      sendError(socket, "AUTH_FAILED", "鉴权挑战已失效");
      return;
    }
    const role = isDevice ? "device" : "terminal";
    const expected = calculateProof(device.passHash, nonce, role, message.device_sid);
    if (!proofMatches(expected, message.proof)) {
      logger.warn(`[relay] proof mismatch role=${role} sid=${message.device_sid.slice(-6)}`);
      sendError(socket, "AUTH_FAILED", "配对凭证校验失败");
      try {
        socket.close(4003, "auth-failed");
      } catch {
        // 失败路径：连接即将关闭，无需进一步处理。
      }
      return;
    }

    if (isDevice) {
      if (device.authTimer) clearTimeout(device.authTimer);
      device.authTimer = undefined;
      device.authNonce = undefined;
      device.authenticated = true;
      sendControl(socket, { type: "auth_ack", pair_status: device.pairStatus });
      return;
    }

    if (!terminal) return;
    if (terminal.authTimer) clearTimeout(terminal.authTimer);
    terminal.authTimer = undefined;
    terminal.authNonce = undefined;
    terminal.authenticated = true;

    // 单页面约束：同一设备同一时刻只允许一个手机页。旧页面被踢，与官方文案一致。
    if (device.terminal && device.terminal.socket !== socket) {
      const previous = device.terminal;
      sendError(previous.socket, "KICKED", "同一配对同时只支持一个手机页面");
      try {
        previous.socket.close(4009, "session-conflict");
      } catch {
        // 旧页面连接即将关闭。
      }
      logger.info(`[relay] terminal superseded sid=${message.device_sid.slice(-6)}`);
    }

    device.terminal = terminal;
    device.pairStatus = "matched";
    sendControl(socket, { type: "auth_ack", pair_status: "matched" });
    sendControl(device.socket, { type: "pair_status_ack", pair_status: "matched" });
    logger.info(`[relay] paired sid=${message.device_sid.slice(-6)}`);
  }

  function handleTerminalJoin(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "terminal_join" }
    >,
  ): void {
    const device = devices.get(message.device_sid);
    if (!device) {
      sendError(socket, "AUTH_FAILED", "配对会话不存在或已失效");
      return;
    }
    // passHash 就是二维码里的配对密钥：比对失败说明二维码过期（已刷新）或被改过。
    if (!proofMatches(device.passHash, message.pass_hash)) {
      logger.warn(`[relay] terminal join rejected sid=${message.device_sid.slice(-6)}`);
      sendError(socket, "AUTH_FAILED", "配对链接已失效，请重新扫码");
      return;
    }
    terminalBySocket.set(socket, {
      socket,
      deviceSid: message.device_sid,
      authenticated: false,
      attachReady: false,
    });
    // 让手机立刻走 challenge 流程，不用等它自己发 auth_init。
    beginChallenge(socket, message.device_sid, "terminal");
  }

  function handleAttachReady(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "attach_ready" }
    >,
  ): void {
    const device = devices.get(message.device_sid);
    if (!device || device.socket !== socket || !device.authenticated) return;
    const terminal = device.terminal;
    if (!terminal || !terminal.authenticated) return;
    terminal.attachReady = true;
    sendControl(terminal.socket, {
      type: "attach_ready",
      device_sid: message.device_sid,
      client_ts: message.client_ts,
    });
    logger.info(`[relay] attach ready sid=${message.device_sid.slice(-6)}`);
  }

  function handleAttachError(
    socket: WebSocket,
    message: Extract<
      ReturnType<typeof webRemoteControlRelayInboundMessageSchema.parse>,
      { type: "attach_error" }
    >,
  ): void {
    const device = devices.get(message.device_sid);
    if (!device || device.socket !== socket) return;
    const terminal = device.terminal;
    if (!terminal) return;
    sendControl(terminal.socket, {
      type: "attach_error",
      device_sid: message.device_sid,
      reason: message.reason,
      error: message.error,
      client_ts: message.client_ts,
    });
  }

  function handleControlMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(socket, "WRONG_PARAM", "控制帧不是合法 JSON");
      return;
    }
    const result = webRemoteControlRelayInboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      sendError(socket, "WRONG_PARAM", "控制帧不符合协议");
      return;
    }
    const message = result.data;
    switch (message.type) {
      case "device_register_init":
        handleDeviceRegisterInit(socket, message);
        return;
      case "terminal_join":
        handleTerminalJoin(socket, message);
        return;
      case "auth_init":
        handleAuthInit(socket, message);
        return;
      case "auth_response":
        handleAuthResponse(socket, message);
        return;
      case "pair_status_query": {
        const device = devices.get(message.device_sid);
        if (!device || device.socket !== socket) return;
        sendControl(socket, { type: "pair_status_ack", pair_status: device.pairStatus });
        return;
      }
      case "attach_ready":
        handleAttachReady(socket, message);
        return;
      case "attach_error":
        handleAttachError(socket, message);
        return;
      case "device_release": {
        // 用户主动停止：立即失效，二维码马上作废。
        const device = devices.get(message.device_sid);
        if (!device || device.socket !== socket) return;
        closeDevice(message.device_sid, "released-by-device");
        return;
      }
      case "attach_request": {
        // 手机请求建立 attachment：转给设备，由设备决定怎么 attach。
        const device = devices.get(message.device_sid);
        if (!device) return;
        const terminal = terminalBySocket.get(socket);
        if (!terminal || device.terminal?.socket !== socket) return;
        sendControl(device.socket, {
          type: "attach_request",
          device_sid: message.device_sid,
          client_ts: message.client_ts,
        });
        return;
      }
    }
  }

  function handleBinaryFrame(socket: WebSocket, data: Buffer): void {
    if (data.byteLength > WEB_REMOTE_CONTROL_MAX_BINARY_FRAME_BYTES) {
      logger.warn(`[relay] oversize binary frame dropped bytes=${data.byteLength}`);
      try {
        socket.close(4008, "frame-too-large");
      } catch {
        // 超限连接即将关闭。
      }
      return;
    }
    // 只转发，不解析。relay 不理解自己搬运的字节。
    const deviceSid = deviceSidBySocket.get(socket);
    if (deviceSid) {
      const device = devices.get(deviceSid);
      const terminal = device?.terminal;
      if (!device?.authenticated || !terminal?.authenticated || !terminal.attachReady) return;
      if (terminal.socket.readyState === terminal.socket.OPEN) {
        terminal.socket.send(data, { binary: true });
      }
      return;
    }
    const terminal = terminalBySocket.get(socket);
    if (!terminal?.authenticated || !terminal.attachReady) return;
    const device = devices.get(terminal.deviceSid);
    if (!device?.authenticated) return;
    if (device.socket.readyState === device.socket.OPEN) {
      device.socket.send(data, { binary: true });
    }
  }

  wss.on("connection", (socket: WebSocket) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touchIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          socket.close(4000, "idle-timeout");
        } catch {
          // 空闲超时：连接即将关闭。
        }
      }, IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };
    touchIdle();

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      touchIdle();
      if (isBinary) {
        handleBinaryFrame(socket, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      handleControlMessage(socket, Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });

    socket.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      const deviceSid = deviceSidBySocket.get(socket);
      if (deviceSid) {
        const device = devices.get(deviceSid);
        // 已经被换绑到新 socket（保留窗口内重连过）：这条旧连接的 close 是迟到的，忽略。
        if (device && device.socket !== socket) return;
        detachDevice(deviceSid, "device-disconnected");
        return;
      }
      const terminal = terminalBySocket.get(socket);
      if (!terminal) return;
      if (terminal.authTimer) clearTimeout(terminal.authTimer);
      const device = devices.get(terminal.deviceSid);
      if (!device) return;
      if (device.terminal === terminal) {
        device.terminal = undefined;
        // 回到 waiting：桌面侧据此判断「手机走了」，但它仍可继续等下一个手机扫码。
        device.pairStatus = "waiting";
        sendControl(device.socket, { type: "pair_status_ack", pair_status: "waiting" });
      }
      logger.info(`[relay] terminal disconnected sid=${terminal.deviceSid.slice(-6)}`);
    });

    socket.on("error", (error: Error) => {
      logger.warn("[relay] socket error", error.message);
    });
  });

  return {
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(
        request as Parameters<typeof wss.handleUpgrade>[0],
        socket as Parameters<typeof wss.handleUpgrade>[1],
        head as Buffer,
        (ws) => wss.emit("connection", ws, request),
      );
    },
    close() {
      for (const deviceSid of Array.from(devices.keys())) closeDevice(deviceSid, "shutdown");
      wss.close();
    },
    getStats() {
      let terminals = 0;
      for (const device of devices.values()) if (device.terminal) terminals += 1;
      return { devices: devices.size, terminals };
    },
  };
}

/** 供部署脚本使用：把 relay 挂到一个已有的 http server 上。 */
export function attachWebRemoteRelayToHttpServer(
  server: HttpServer,
  relay: WebRemoteRelayServer,
): void {
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    relay.handleUpgrade(request, socket, head);
  });
}

export { createWebRemoteRelayStaticHandler, type WebRemoteRelayStaticHandler } from "./static.js";
