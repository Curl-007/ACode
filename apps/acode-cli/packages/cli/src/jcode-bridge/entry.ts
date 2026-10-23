// ============================================================
// `acode jcode-bridge --stdio` 子命令入口（spec: jcode-agent-bridge.md R1/R7）
//
// 职责只有装配：storage 首帧 → connection → gateway(host) → dispatch → 起停，
// 外加 jcode 二进制解析与子进程生命周期。协议翻译在 event/command-translator，
// host 实现在 host.ts，v4 路由在 dispatch.ts——本文件不承载判定逻辑。
//
// 与 acp-command.ts 同为 stdio 子命令入口，但方向相反：acp-command 让 ACode 被 IDE
// 驱动（ACP server）；本命令让 ACode 客户端驱动 jcode（北向 v4 server + 南向 ACP client）。
//
// 装配缝判定（见 spec R1「北向复用」）：现有 ACodeProtocolAgentServer 把 gateway 硬编码
// 在构造函数、强依赖 native createACodeApp，无 host 注入缝，故此处**不 new server**，
// 只复用 host 无关的 ConversationV4Gateway + ACodeProtocolNdjsonConnection，
// dispatch 走自写瘦路由（dispatch.ts，照 server.ts 的 v4 子集）。
// ============================================================

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as nodePath from "node:path";
import type { Logger } from "@acode/contracts";
import {
  acodeProtocolNotifications,
  acodeStorageStartupStateSchema,
} from "@acode/shared";
import {
  ACodeProtocolNdjsonConnection,
  ConversationV4Gateway,
} from "@acode/bootstrap";
import type { RunContext } from "@acode/shared-types";

import { JcodeAcpClient } from "./acp-client.js";
import type { AcpInboundNotification, AcpSessionUpdateParams, TranslatedSessionEvent } from "./acp-types.js";
import { JCODE_SPAWN_READY_TIMEOUT_MS } from "./constants.js";
import type { JcodeBridgeRuntime } from "./command-translator.js";
import { createJcodeMessageHandler, type JcodeDispatchDeps, type PostResponseOutbox } from "./dispatch.js";
import { JcodeEventTranslator } from "./event-translator.js";
import { createJcodeHost } from "./host.js";
import { JcodeSessionMap } from "./session-map.js";
import { resolveJcodeBinary } from "./resolve-binary.js";
import { spawnJcodeProcess } from "./spawn-jcode.js";
import { installStderrConsoleBoundary } from "../protocol-console.js";

/** jcode 后端无对应能力时的合成默认值（spec R2 usage/SessionCreated 行、R7）。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_COLLABORATION_MODE = "build";

/** 最小 stderr logger：本文件是 I/O 边界，允许直写 process.stderr。 */
function createStderrLogger(stderr: NodeJS.WriteStream): Logger {
  const write = (level: string, message: string, extra?: unknown): void => {
    const suffix = extra === undefined ? "" : ` ${safeStringify(extra)}`;
    stderr.write(`[jcode-bridge] ${level} ${message}${suffix}\n`);
  };
  const self: Logger = {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, error, context) =>
      write("error", message, { error: error?.message ?? String(error), ...context }),
    child: () => self,
  };
  return self;
}

/** 诊断序列化不得抛出（logger 不能反噬主链路），也不得泄露凭据（只 stringify 浅层）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface RunJcodeBridgeOptions {
  /** 显式 jcode 二进制路径（CLI `--jcode-binary`）；缺省走 PATH 解析（spec R7）。 */
  jcodeBinary?: string;
}

/**
 * 运行 jcode 桥接进程。
 *
 * 北向：stdin/stdout 上讲 acode-protocol-v4（ACode 客户端零改动）。
 * 南向：spawn 一个 jcode 子进程跑 `acp`，stdio 上讲 ACP JSON-RPC（spec R1 的 1:1）。
 *
 * 返回码只反映进程级故障（二进制缺失、spawn 失败）；正常生命周期由 stdin 关闭驱动
 * （connection.waitForClose 返回后 dispose，返回 0）。
 */
export async function runJcodeBridge(
  ctx: RunContext,
  options: RunJcodeBridgeOptions = {},
): Promise<number> {
  // stdout 只承载 v4 协议帧：任何 console 输出（三方依赖 debug 等）引到 stderr。
  const restoreConsole = installStderrConsoleBoundary(ctx.stderr);
  const logger = createStderrLogger(ctx.stderr);

  // R7：解析 jcode 二进制。失败即退出，不发半死 storage 帧。
  let binaryPath: string;
  try {
    binaryPath = resolveJcodeBinary(options.jcodeBinary, process.platform, (name) =>
      whichOnPath(name),
    );
  } catch (error) {
    ctx.stderr.write(`acode jcode-bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const sessions = new JcodeSessionMap();
  const translators = new Map<string, JcodeEventTranslator>();
  const outbox: PostResponseOutbox = new Map();

  // 可变 holder：gateway 早于 connection 建（host.emitWireFrame 需引用 connection.send）。
  let connection!: ACodeProtocolNdjsonConnection;
  const sendFrame = (frame: unknown): void => {
    // connection.send 期望协议消息形状；frame 已是 {method,params} 通知。
    connection.send(frame as Parameters<ACodeProtocolNdjsonConnection["send"]>[0]);
  };

  let client: JcodeAcpClient | undefined;
  let killChild: (() => void) | undefined;

  const runtime: JcodeBridgeRuntime = {
    get client() {
      if (!client) throw new Error("jcode bridge: acp client not initialized");
      return client;
    },
    sessions,
    ensureTranslator: (v4SessionId) => {
      const existing = translators.get(v4SessionId);
      if (existing) return existing;
      const created = new JcodeEventTranslator({
        now: () => Date.now(),
        nextEventId: () => `evt_${randomUUID()}`,
        v4SessionId,
        traceId: `trace_${v4SessionId}`,
        defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
        defaultMode: DEFAULT_COLLABORATION_MODE,
      });
      translators.set(v4SessionId, created);
      return created;
    },
    translator: (v4SessionId) => translators.get(v4SessionId),
    ingestEvents: (v4SessionId, events) => {
      for (const event of events) gateway.ingest(v4SessionId, event as never);
    },
    newV4SessionId: () => `jcode-${randomUUID()}`,
    // R7：本地 workspace 的 workspaceId 即 workspacePath；归一为平台原生绝对路径
    // （spike §2：jcode 拒非绝对路径）。远程 workspace 不在本期范围。
    resolveCwd: (workspaceId) => nodePath.resolve(workspaceId || process.cwd()),
    now: () => Date.now(),
    logger,
  };

  const host = createJcodeHost({ runtime, sessions, sendWireFrame: sendFrame, logger });
  const gateway = new ConversationV4Gateway(host);
  const dispatchDeps: JcodeDispatchDeps = { gateway, outbox };
  const handleMessage = createJcodeMessageHandler(dispatchDeps);

  connection = new ACodeProtocolNdjsonConnection({
    input: ctx.stdin,
    output: ctx.stdout,
    logger,
    handleMessage: async (message) => (await handleMessage(message)) ?? undefined,
    takePostResponseBatch: (requestId) => {
      const batch = outbox.get(requestId) ?? null;
      outbox.delete(requestId);
      return batch;
    },
    clearPostResponseMessages: () => outbox.clear(),
    onTransportClosed: (error) => {
      logger.debug("jcode bridge transport closed", { error: error?.message ?? String(error) });
    },
  });

  try {
    // storage 首帧必须第一条 line（客户端 acodeProtocolClient.ts:302-316 等待）。
    // env-override 接线下客户端不硬阻塞（gate 不 arm），但仍发 phase=ready 最小帧：
    // 匹配 spec 验收 #1，且避免 acodeAgentProcessManager 的 idle-timer 分叉。
    // schema 是 .strict()，只填必填字段。shim 无 native storage，故 databaseId 用固定标识。
    const ready = acodeStorageStartupStateSchema.parse({
      schemaVersion: 1,
      attemptId: randomUUID(),
      sequence: 1,
      databaseId: "jcode-bridge",
      databaseKind: "session",
      phase: "ready",
      elapsedMs: 0,
    });
    connection.send({
      method: acodeProtocolNotifications.storageStartup,
      params: ready,
    } as Parameters<ACodeProtocolNdjsonConnection["send"]>[0]);

    // 南向：spawn jcode acp 子进程（R4-2 遥测硬关 + R4-3 self-dev 防护在 spawn 内）。
    const child = await spawnJcodeProcess({ binaryPath, cwd: process.cwd(), logger });
    killChild = child.kill;
    client = new JcodeAcpClient({
      transport: child.transport,
      exited: child.exited,
      kill: child.kill,
      logger,
    });
    // jcode 的 session/update 事件按 jcodeSessionId 路由回对应会话的 translator。
    client.onNotification((notification: AcpInboundNotification) => {
      routeNotification(runtime, notification);
    });
    client.startReadLoop();

    // ACP 握手（spike §2 实测：jcode 强制 pin protocolVersion=1）。
    await withTimeout(
      client.initialize("acode-jcode-bridge"),
      JCODE_SPAWN_READY_TIMEOUT_MS,
      "jcode acp initialize",
    );
    logger.info("jcode bridge ready", { binaryPath });

    // 北向：启动读循环，等 stdin 关闭驱动生命周期收尾。
    connection.start();
    await connection.waitForClose();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`acode jcode-bridge failed: ${message}\n`);
    return 1;
  } finally {
    client?.dispose();
    killChild?.();
    gateway.dispose();
    restoreConsole();
  }
}

/**
 * 把 jcode 的 session/update 通知路由到对应会话的 translator，产出的 SessionEvent
 * 喂进 gateway.ingest（顺序不变量由 translator 内部保证，见 event-translator.ts）。
 *
 * 未登记的 jcodeSessionId（非本进程创建）→ 忽略并留痕，不伪造会话。
 */
function routeNotification(runtime: JcodeBridgeRuntime, notification: AcpInboundNotification): void {
  if (notification.method !== "session/update") return;
  const params = notification.params as AcpSessionUpdateParams | undefined;
  const jcodeSessionId = params?.sessionId;
  if (!jcodeSessionId) return;
  const v4SessionId = runtime.sessions.toV4(jcodeSessionId);
  if (!v4SessionId) {
    runtime.logger?.debug("jcode bridge: session/update for unmapped jcode session", { jcodeSessionId });
    return;
  }
  const translator = runtime.translator(v4SessionId);
  if (!translator) return;
  const update = params?.update;
  if (!update) return;
  const events: TranslatedSessionEvent[] = translator.translate(update as never);
  if (events.length > 0) runtime.ingestEvents(v4SessionId, events);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * PATH 上查可执行文件（spec R7：不新增 env，走 PATH/CLI 参数）。
 * 只做存在性探测，解析交给 resolve-binary.ts；此处用同步 execFileSync 避免
 * 在 entry 里引入 async which 依赖。跨平台：Windows 用 where，POSIX 用 command -v。
 */
function whichOnPath(name: string): string | null {
  const isWin = process.platform === "win32";
  try {
    const out = execFileSync(isWin ? "where" : "command", isWin ? [name] : ["-v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // command -v 是 POSIX shell 内建，需经 shell；where 是独立 exe，不需。
      shell: !isWin,
    });
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}
