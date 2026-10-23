// ============================================================
// jcode 桥接：ACP 客户端（唯一外部 I/O 边界）
// spec: apps/acode-cli/specs/jcode-agent-bridge.md R1/R4/R5
//
// 根 AGENTS.md「外部 I/O 边界收敛」：本模块是 jcode-bridge 里**唯一**允许触碰
// child_process 与 process.env 的文件；host.ts / event-translator.ts /
// command-translator.ts 都只依赖此处暴露的接口，不自行 spawn 或读环境。
//
// 安全硬要求（spec R4，全部有测试断言）：
//   R4-2 spawn env 必须注入 JCODE_NO_TELEMETRY=1 + DO_NOT_TRACK=1，argv 必须含
//        --no-update —— jcode 遥测默认开且上报自有端点 telemetry.jcode.sh，
//        ACode 的 no-telemetry 守护测试只扫仓库内 JS/TS，对原生子进程失明。
//   R4-3 cwd 指向 jcode 源码检出时必须拒绝 spawn（self-dev 会让 agent 改写自己
//        被分发的二进制），argv 另带 --no-selfdev 作第二道保险。
//   R5   executeCommand 必须恰好 settle 一次；所有失败路径（超时、子进程死亡、
//        畸形帧）都要 reject，不能让调用方悬挂导致 CommandInbox 的 per-session
//        gate 永久卡死。
//
// 可测性：帧循环与请求关联走注入的 AcpTransport（内存管道即可测），只有
// spawnJcodeProcess 这一个函数真碰 child_process。
// ============================================================

import type { Logger } from "@acode/contracts";

import {
  classifyInboundFrame,
  isAcpErrorResponse,
  isAcpSuccessResponse,
  type AcpInitializeResult,
  type AcpInboundNotification,
  type AcpPromptBlock,
  type AcpPromptResult,
  type AcpRequest,
  type AcpSessionResult,
} from "./acp-types.js";
import {
  JCODE_ACP_PROTOCOL_VERSION,
  JCODE_ACP_REQUEST_TIMEOUT_MS,
  JCODE_PROMPT_TIMEOUT_MS,
  JCODE_SELFDEV_CWD_REJECTED_REASON,
  JCODE_SPAWN_ARGS,
  JCODE_TELEMETRY_OFF_ENV,
  JCODE_UNKNOWN_ERROR_CODE,
} from "./constants.js";
import { describeSelfdevRejection, detectJcodeRepo, type JcodeRepoProbe } from "./selfdev-guard.js";

/** 传输抽象：一行入一行出（生产 = 子进程 stdio，测试 = 内存管道）。 */
export interface AcpTransport {
  /** 写一行（实现负责补 \n）。 */
  writeLine(line: string): void;
  /** 入站行迭代；流结束即迭代完结。 */
  lines(): AsyncIterable<string>;
  /** 关闭传输（best-effort，不抛）。 */
  close(): void;
}

/** 真子进程句柄的最小面（便于测试用假进程替换）。 */
export interface JcodeChildHandle {
  transport: AcpTransport;
  /** 子进程退出/被杀时 resolve；code 为 null 表示被信号终止。 */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** 主动终止（含进程树，对齐 acodeStdioTransport 的 terminateProcessTree 纪律）。 */
  kill(): void;
}

export interface SpawnJcodeOptions {
  /** jcode 可执行文件路径（win32 需 .exe）。 */
  binaryPath: string;
  /** 会话工作目录；必须是普通 workspace，不能是 jcode 源码检出（R4-3）。 */
  cwd: string;
  /** 额外 env（会与 R4-2 的强制关闭项合并，且**不能覆盖**它们）。 */
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

/** spawn 前校验失败（self-dev 风险等）——用稳定 reasonCode 供上层 ACK 映射。 */
export class JcodeSpawnRejectedError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "JcodeSpawnRejectedError";
    this.reasonCode = reasonCode;
  }
}

/**
 * 构造 spawn jcode 的 argv 与 env（纯函数，供测试直接断言 R4-2/R4-3）。
 *
 * env 合并顺序是安全关键：调用方给的 env 先展开，**强制关闭项后展开**，
 * 使调用方无法把遥测重新打开（与 ACode 打包态标记「spread 在 inheritedEnv 之后」
 * 的同一哲学，见 agent-command-env-gate.md R1）。
 */
export function buildJcodeSpawnSpec(
  options: Pick<SpawnJcodeOptions, "cwd" | "env">,
  baseEnv: Record<string, string | undefined>,
): { args: string[]; env: Record<string, string | undefined>; cwd: string } {
  return {
    args: [...JCODE_SPAWN_ARGS],
    env: {
      ...baseEnv,
      ...options.env,
      ...JCODE_TELEMETRY_OFF_ENV,
    },
    cwd: options.cwd,
  };
}

/**
 * self-dev 防护闸（spec R4-3）。
 *
 * 抽出为独立函数以便单测注入 probe，不必真建目录。命中即抛 JcodeSpawnRejectedError，
 * 由调用方翻成 v4 ACK 的 rejected + reasonCode，绝不 spawn。
 */
export function assertNotJcodeRepo(cwd: string, probe: JcodeRepoProbe): void {
  const verdict = detectJcodeRepo(cwd, probe);
  if (verdict.isJcodeRepo) {
    throw new JcodeSpawnRejectedError(
      JCODE_SELFDEV_CWD_REJECTED_REASON,
      describeSelfdevRejection(cwd, verdict.matchedMarkers),
    );
  }
}

/** 单个在飞请求的关联态。 */
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** ACP 错误的稳定包装（保留 jcode 的 code/message，不丢原因链）。 */
export class JcodeAcpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JcodeAcpError";
    this.code = code;
    this.data = data;
  }
}

export interface JcodeAcpClientOptions {
  transport: AcpTransport;
  /** 子进程退出信号；用于把在飞请求全部 reject（R5 不悬挂）。 */
  exited?: Promise<{ code: number | null; signal: string | null }>;
  /** 主动终止子进程（dispose 时用）。 */
  kill?: () => void;
  logger?: Logger;
  now?(): number;
  /** 测试可缩短超时。 */
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
}

/**
 * ACP 客户端：请求关联 + 通知分发 + 生命周期。
 *
 * 一个 client 对一个 jcode 子进程（spec R1 的 1:1）。多会话在同一连接上以
 * sessionId 区分（spike §4.3 实测同一连接可开多个 session）。
 */
export class JcodeAcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(n: AcpInboundNotification) => void>();
  private readLoopStarted = false;
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;

  constructor(private readonly options: JcodeAcpClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? JCODE_ACP_REQUEST_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? JCODE_PROMPT_TIMEOUT_MS;
    // 子进程死亡时把所有在飞请求 reject —— 否则 executeCommand 不会 settle，
    // CommandInbox 的 per-session FIFO gate 永久卡死（spec R5）。
    void options.exited?.then(({ code, signal }) => {
      this.failAllPending(`jcode process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });
  }

  /** 订阅 jcode 通知（session/update 等）。返回取消订阅函数。 */
  onNotification(handler: (n: AcpInboundNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /** 启动读循环（幂等）。畸形帧只丢弃留痕，不断链——一个坏帧不该废掉整条会话。 */
  startReadLoop(): void {
    if (this.readLoopStarted) return;
    this.readLoopStarted = true;
    void (async () => {
      try {
        for await (const line of this.options.transport.lines()) {
          this.handleLine(line);
        }
      } catch (error) {
        this.options.logger?.warn("jcode acp read loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.failAllPending("jcode acp read loop terminated");
      }
    })();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // jcode 偶发把非协议文本写到 stdout（如启动提示）；丢弃并留痕，不回错误帧
      // （无 id 可回），也不断链。
      this.options.logger?.debug("jcode acp non-json stdout line dropped", {
        length: trimmed.length,
      });
      return;
    }
    const frame = classifyInboundFrame(parsed);
    if (!frame) {
      this.options.logger?.debug("jcode acp unclassified frame dropped");
      return;
    }
    // 先按响应类型守卫收窄（isAcp*Response 用 "error"/"result" in frame 判别），
    // 两支返回后剩余即通知——比先判 method 更稳（复合 method 条件无法收窄 union）。
    if (isAcpErrorResponse(frame)) {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        this.options.logger?.debug("jcode acp error for unknown id", { id: frame.id });
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.reject(
        new JcodeAcpError(
          frame.error?.code ?? JCODE_UNKNOWN_ERROR_CODE,
          frame.error?.message ?? "jcode acp error",
          frame.error?.data,
        ),
      );
      return;
    }
    if (isAcpSuccessResponse(frame)) {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        this.options.logger?.debug("jcode acp response for unknown id", { id: frame.id });
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame.result);
      return;
    }
    // 剩余 = 通知（session/update 等）。
    for (const handler of this.notificationHandlers) {
      try {
        handler(frame);
      } catch (error) {
        // 处理器异常不能反噬读循环（否则一个翻译 bug 会杀掉整条会话）。
        this.options.logger?.error("jcode acp notification handler threw", error as Error);
      }
    }
  }

  /** 发一个请求并等响应。timeoutMs 到即 reject（R5：必 settle）。 */
  request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JcodeAcpError(JCODE_UNKNOWN_ERROR_CODE, `jcode acp client closed (method=${method})`));
    }
    const id = this.nextId++;
    const frame: AcpRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new JcodeAcpError(JCODE_UNKNOWN_ERROR_CODE, `jcode acp request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      // 定时器不阻塞进程退出（shim 是长驻进程，但空闲时不该被 timer 吊住）。
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.options.transport.writeLine(JSON.stringify(frame));
      } catch (error) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** initialize 握手（jcode 强制 pin protocolVersion=1，spike §2 实测）。 */
  initialize(clientName: string): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>("initialize", {
      protocolVersion: JCODE_ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: clientName },
    });
  }

  /**
   * session/new。
   *
   * cwd 必须是**平台原生绝对路径**：spike §2 实测 jcode 对 msys 风格 `/tmp/...`
   * 回 -32602 "ACP cwd must be absolute"。调用方须先经 Node path API 归一。
   */
  newSession(cwd: string): Promise<AcpSessionResult> {
    return this.request<AcpSessionResult>("session/new", { cwd, mcpServers: [] });
  }

  /** session/load。注意 jcode 对不存在的会话 fail-open 返回 {}（spec R4-4）。 */
  loadSession(sessionId: string, cwd: string): Promise<AcpSessionResult> {
    return this.request<AcpSessionResult>("session/load", { sessionId, cwd, mcpServers: [] });
  }

  /** session/prompt。超时用 prompt 专用值（一轮 agent 执行可能很长）。 */
  prompt(sessionId: string, blocks: AcpPromptBlock[]): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>(
      "session/prompt",
      { sessionId, prompt: blocks },
      this.promptTimeoutMs,
    );
  }

  /** session/cancel（spike §4.3 实测对空闲会话幂等，返回 {}）。 */
  cancel(sessionId: string): Promise<unknown> {
    return this.request<unknown>("session/cancel", { sessionId });
  }

  /** session/close。 */
  closeSession(sessionId: string): Promise<unknown> {
    return this.request<unknown>("session/close", { sessionId });
  }

  /** session/set_model。 */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request<unknown>("session/set_model", { sessionId, modelId });
  }

  /** session/set_reasoning_effort。 */
  setReasoningEffort(sessionId: string, effort: string): Promise<unknown> {
    return this.request<unknown>("session/set_reasoning_effort", { sessionId, effort });
  }

  private failAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new JcodeAcpError(JCODE_UNKNOWN_ERROR_CODE, `${reason} (pending method=${entry.method})`));
      this.pending.delete(id);
    }
  }

  /** 关闭：拒绝所有在飞请求、关传输、杀子进程。幂等。 */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending("jcode acp client disposed");
    try {
      this.options.transport.close();
    } catch {
      // 传输已断时 close 可能抛；dispose 是收尾路径，不再上抛。
    }
    this.options.kill?.();
  }

  /** 诊断：在飞请求数（测试断言无悬挂）。 */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** 生产用的 spawn 工厂类型（唯一真碰 child_process 的地方，见 spawn-jcode.ts）。 */
export type SpawnJcodeFn = (options: SpawnJcodeOptions) => Promise<JcodeChildHandle>;
