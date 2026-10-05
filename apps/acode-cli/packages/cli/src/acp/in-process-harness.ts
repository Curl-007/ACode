// ============================================================
// in-process harness 链路：把 K7 翻译桥（createHarnessApiServer）挂到内存
// loopback 传输上，同进程直连 services——不绕道子进程（spec R1 语义要求）。
//
// 为什么不用 AcodeHarnessClient（K7 SDK）：其连接层与子进程 stdio 强耦合
// （私有构造器持有 ChildProcessWithoutNullStreams），in-process 化需重构
// K7 本体；services 层又在 server 包——SDK 不宜反向依赖。决策记录见
// spec 附录 A.1。本文件即「适配层自带的薄客户端链路」：hello 握手 +
// request 关联 + 事件扇出，全部讲 K7 的 NDJSON 帧协议（同一 wire 契约，
// 与 spawn 形态互通）。
//
// 参照 jcode (MIT) sdk crate 的双模式形态问题分解，自撰实现。
// ============================================================

import { HarnessRpcError, SDK_HANDSHAKE_TIMEOUT_MS } from "@acode/harness-sdk";
import {
  createHarnessApiServer,
  type HarnessApiServer,
  type HarnessStdioTransport,
} from "@acode/server/harness";
import type { HarnessServiceCollection } from "@acode/server/harness-inprocess";
import {
  HARNESS_API_VERSION_MAJOR,
  parseEventLoose,
  type HarnessEvent,
} from "@acode/shared/harness-api";

/** 事件帧的窄形态（与 harness-sdk addEventListener 同形）。 */
export interface HarnessEventFrame {
  sessionId: string;
  seq: number;
  event: HarnessEvent;
}

export interface InProcessHarnessLink {
  /** harness 方法请求（NDJSON 帧往返；失败拒绝为 HarnessRpcError）。 */
  request(method: string, params?: unknown): Promise<unknown>;
  /** 连接级事件监听（多会话各自订阅由 subscribe_events 方法面承载）。 */
  addEventListener(listener: (frame: HarnessEventFrame) => void): () => void;
  /**
   * F7（K8 对抗复核）：链路死亡回调——client 侧 close 或 server 侧 stop
   * （transport dispose）任一先发生时触发一次（先到先报）。适配层据此
   * failPending，消费方不挂等超时。
   */
  onClose(listener: (reason: "closed" | "server-stopped") => void): () => void;
  /** 停止桥（幂等）。services 生命周期（dispose）由装配方持有，不在此收口。 */
  close(): Promise<void>;
}

export interface CreateInProcessHarnessLinkOptions {
  /** ServiceCollection（测试桩）或懒工厂（生产经 @acode/server/harness-inprocess 装配）。 */
  services:
    | HarnessServiceCollection
    | (() => HarnessServiceCollection | Promise<HarnessServiceCollection>);
  serverName?: string;
  log?: (message: string) => void;
  /**
   * F7 回归钩子：持 server 引用以便测试模拟 server 侧死亡（server.stop()）。
   * 生产不传——server 的正常停止路径只有 link.close()。
   */
  onServer?: (server: HarnessApiServer) => void;
}

/**
 * 内存 loopback 上的 K7 翻译桥 + 薄客户端链路。
 *
 * 帧流向：client.request() → clientToServer 队列 → 桥 readLines() →
 * 桥 writeLine()（response/event/hello_ack）→ 本链路 demux → pending 结算 /
 * 事件监听器扇出。无子进程、无真实流——同一进程内两条纯内存队列。
 */
export async function createInProcessHarnessLink(
  options: CreateInProcessHarnessLinkOptions,
): Promise<InProcessHarnessLink> {
  const log = options.log ?? (() => undefined);

  // ── client→server 行队列（传输读侧）──
  const clientLines: string[] = [];
  const readWakeups: (() => void)[] = [];
  let readEnded = false;

  // ── client 侧状态：握手 / pending / 事件监听器 ──
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const eventListeners = new Set<(frame: HarnessEventFrame) => void>();
  // F7：链路死亡回调（先到先报一次：client close 或 server stop）。
  const closeListeners = new Set<(reason: "closed" | "server-stopped") => void>();
  let linkDead = false;
  let nextRequestId = 0;
  let handshakeSettlers: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let closed = false;

  const notifyLinkClosed = (reason: "closed" | "server-stopped"): void => {
    if (linkDead) return;
    linkDead = true;
    for (const listener of Array.from(closeListeners)) {
      try {
        listener(reason);
      } catch {
        // 消费方监听器异常不阻断其它监听器（与事件扇出同款纪律）。
      }
    }
  };

  const settleHandshake = (error?: Error): void => {
    if (!handshakeSettlers) return;
    const { resolve, reject } = handshakeSettlers;
    handshakeSettlers = undefined;
    if (error) reject(error);
    else resolve();
  };

  /** server 输出行的 demux（传输写侧回调）。 */
  const handleServerLine = (line: string): void => {
    if (closed || line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 兼容铁律（与 K7 连接层一致）：非 JSON 行忽略，不断连。
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const frame = raw as Record<string, unknown>;
    if (frame.kind === "hello_ack") {
      settleHandshake();
      return;
    }
    if (frame.kind === "error") {
      // 协议级错误帧（版本不匹配等）视为链路故障。
      settleHandshake(
        new Error(`harness link error: ${String(frame.code)}: ${String(frame.message)}`),
      );
      return;
    }
    if (frame.kind === "response") {
      const id = Number(frame.id);
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (frame.ok === true) {
        entry.resolve(frame.result);
      } else if (frame.ok === false && typeof frame.error === "object" && frame.error !== null) {
        const error = frame.error as { code?: unknown; message?: unknown; details?: unknown };
        entry.reject(
          new HarnessRpcError(
            typeof error.code === "string" ? error.code : "internal_error",
            typeof error.message === "string" ? error.message : "harness rpc failed",
            error.details,
          ),
        );
      } else {
        entry.reject(new HarnessRpcError("internal_error", "malformed harness response frame"));
      }
      return;
    }
    if (frame.kind === "event") {
      const payload: HarnessEventFrame = {
        sessionId: String(frame.sessionId),
        seq: Number(frame.seq),
        event: parseEventLoose(frame.event),
      };
      for (const listener of Array.from(eventListeners)) {
        try {
          listener(payload);
        } catch {
          // 消费方监听器异常不阻断其它监听器（与 K7 连接层同款纪律）。
        }
      }
      return;
    }
    // 兼容铁律：未知帧（重复 hello 等）忽略。
  };

  // ── 内存传输：实现 server 包的 HarnessStdioTransport 契约 ──
  // onClose 必须只在传输真正关闭（dispose）时 resolve——server 侧把它当
  // 「客户端断开」信号触发 stop()；若立即 resolve 会让桥在 hello 到达前
  // 自杀（实测缺陷：握手后所有请求帧被丢弃、消费方永久挂起）。
  let transportDisposed = false;
  let transportCloseResolve: (() => void) | undefined;
  const transportClosePromise = new Promise<void>((resolve) => {
    transportCloseResolve = resolve;
  });
  const transport: HarnessStdioTransport = {
    readLines() {
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (clientLines.length > 0) yield (clientLines.shift() as string);
            if (readEnded) return;
            await new Promise<void>((resolve) => {
              readWakeups.push(resolve);
            });
          }
        },
      };
    },
    writeLine(line: string) {
      handleServerLine(line);
    },
    onClose() {
      return transportClosePromise;
    },
    dispose() {
      if (transportDisposed) return;
      transportDisposed = true;
      readEnded = true;
      transportCloseResolve?.();
      while (readWakeups.length > 0) (readWakeups.shift() as () => void)();
      // 桥已停（server.stop/链路关闭都会走到这里）：未决请求统一拒绝，
      // 防消费方在断链后永久挂起。
      for (const [, entry] of pending) {
        entry.reject(new HarnessRpcError("internal_error", "harness transport disposed"));
      }
      pending.clear();
      // F7：server 侧 stop 的死亡传播——transport dispose 经 onClose 回调面
      // 通知适配层（failPending）；client 主动 close 的场景已在 close() 里
      // 先行通报（先到先报，此处不重复）。
      notifyLinkClosed("server-stopped");
    },
  };

  const sendFrame = (frame: Record<string, unknown>): void => {
    if (closed) return;
    if (readEnded) {
      // F7：读侧已死（server stop / transport dispose）——帧无人消费，
      // 记 warn 不静默（诊断断链后掉帧），不入队。
      log("sendFrame dropped: harness server side already stopped");
      return;
    }
    clientLines.push(JSON.stringify(frame));
    while (readWakeups.length > 0) (readWakeups.shift() as () => void)();
  };

  const server: HarnessApiServer = createHarnessApiServer({
    transport,
    services: options.services,
    serverName: options.serverName ?? "acode-acp-internal",
    log: (message) => log(message),
  });
  // F7 回归钩子：测试持 server 引用模拟 server 侧死亡（stop）。
  options.onServer?.(server);

  // ── 握手：hello → hello_ack（超时与 SDK 同款）。 ──
  const handshakePromise = new Promise<void>((resolve, reject) => {
    handshakeSettlers = { resolve, reject };
  });
  const handshakeTimer = setTimeout(() => {
    settleHandshake(new Error("no hello_ack within handshake timeout"));
  }, SDK_HANDSHAKE_TIMEOUT_MS);
  sendFrame({
    v: HARNESS_API_VERSION_MAJOR,
    kind: "hello",
    client: "acode-acp-adapter",
    capabilities: ["events"],
  });
  try {
    await handshakePromise;
  } catch (error) {
    clearTimeout(handshakeTimer);
    transport.dispose();
    await server.stop().catch(() => undefined);
    throw error;
  }
  clearTimeout(handshakeTimer);

  return {
    request(method, params) {
      if (closed) {
        return Promise.reject(new HarnessRpcError("internal_error", "harness link is closed"));
      }
      // F7：server 侧 stop（transport dispose）后读侧已死——立即以可读错误
      // 拒绝，不静默入队让消费方永久挂起。
      if (readEnded) {
        return Promise.reject(
          new HarnessRpcError("internal_error", "harness link is dead (server stopped)"),
        );
      }
      const id = nextRequestId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      sendFrame({
        v: HARNESS_API_VERSION_MAJOR,
        kind: "request",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      return promise;
    },
    addEventListener(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      // 未决请求统一拒绝（消费方按断连归因）。
      for (const [, entry] of pending) {
        entry.reject(new HarnessRpcError("internal_error", "harness link closed"));
      }
      pending.clear();
      settleHandshake(new Error("harness link closed"));
      eventListeners.clear();
      // F7：client 侧主动关闭先通报（先到先报），transport.dispose 内的
      // "server-stopped" 通报不会重复触发。
      notifyLinkClosed("closed");
      transport.dispose();
      await server.stop().catch(() => undefined);
    },
  };
}
