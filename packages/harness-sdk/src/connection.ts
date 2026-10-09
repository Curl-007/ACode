// Harness SDK 连接层：子进程 stdio、握手、pending request map、事件扇出与 seq gap 检测。
// SDK 客户端状态（seq/订阅/pending map）的生命周期所有者是本实例（spec R5）。

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  HARNESS_API_VERSION_MAJOR,
  HARNESS_MAX_LINE_LENGTH,
  parseEventLoose,
  parseFrameLoose,
  type HarnessEvent,
} from "@acode/shared/harness-api";
import { HarnessDisconnectError, HarnessRpcError } from "./errors.js";
import type { HarnessConnectionOptions, HarnessServerInfo } from "./connection-types.js";
import { performHandshake } from "./handshake.js";

// 公开类型下沉在 connection-types.ts（handshake.ts 共同引用的中立落点）；
// 此处原样转发，@acode/harness-sdk 包根与既有 ./connection.js 导入面不变。
export type { HarnessConnectionOptions, HarnessServerInfo } from "./connection-types.js";

export interface SpawnTarget {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class HarnessConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: HarnessConnectionOptions;
  #nextRequestId = 0;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventListeners = new Set<
    (frame: { sessionId: string; seq: number; event: HarnessEvent }) => void
  >();
  #lastSeq: number | undefined;
  #buffer = "";
  #closed = false;
  #closeError: unknown;
  #closeWaiters: (() => void)[] = [];
  readonly #serverInfo: HarnessServerInfo;
  // M1：握手阶段与稳态共用同一个 StringDecoder——跨 chunk 的多字节 UTF-8 序列
  // （握手→稳态的监听器移交窗口内切开的字符）由同一解码器持有，不产生 U+FFFD。
  readonly #decoder: StringDecoder;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    serverInfo: HarnessServerInfo,
    options: HarnessConnectionOptions,
    decoder: StringDecoder,
  ) {
    this.#child = child;
    this.#serverInfo = serverInfo;
    this.#options = options;
    this.#decoder = decoder;
  }

  /**
   * spawn 子进程并完成握手；任何失败都会清理子进程后抛 HarnessDisconnectError。
   * 握手监听器 → 连接层监听器的移交用 pause/attach/resume 保证零丢帧零双发
   * （握手与移交前半段在 handshake.ts，本方法完成移交后半段）。
   */
  static async connect(
    target: SpawnTarget,
    options: HarnessConnectionOptions = {},
  ): Promise<HarnessConnection> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(target.command, target.args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(target.env ? { env: target.env } : {}),
        ...(target.cwd ? { cwd: target.cwd } : {}),
      });
    } catch (error) {
      throw new HarnessDisconnectError(
        "spawn-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const handshake = await performHandshake(child, options);

    // ── 监听器移交（后半段）：握手模块已 pause stdout 并摘除握手监听，
    // 这里构造连接 → 注入残留缓冲 → attach → resume。
    // pause 期间到达的数据由流缓冲，保证不丢帧也不双发。
    // M1：decoder 随残留缓冲一并移交——部分多字节序列在 decoder 内等下一 chunk 补全。
    const connection = new HarnessConnection(
      child,
      handshake.serverInfo,
      options,
      handshake.decoder,
    );
    if (handshake.residualBuffer.length > 0) {
      connection.#buffer = handshake.residualBuffer + connection.#buffer;
    }
    connection.#attach();
    child.stdout.resume();
    return connection;
  }

  #attach(): void {
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) =>
      this.#options.stderr?.(chunk.toString("utf8")),
    );
    this.#child.once("exit", (code, signal) => {
      this.#failPending(
        new HarnessDisconnectError(
          "process-exit",
          `harness process exited (code=${code ?? "null"} signal=${signal ?? "none"})`,
        ),
      );
      this.#setClosed();
    });
    this.#child.stdout.once("close", () => {
      this.#failPending(new HarnessDisconnectError("stream-closed", "stdout stream closed"));
      this.#setClosed();
    });
    this.#child.once("error", (error) => {
      this.#failPending(new HarnessDisconnectError("process-exit", error.message));
      this.#setClosed();
    });
  }

  #onData(chunk: Buffer): void {
    // M1：StringDecoder 持有跨 chunk 的部分多字节序列（中文帧跨 chunk 切开不损坏）。
    this.#buffer += this.#decoder.write(chunk);
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      // M4：单行上限（防 OOM）——失控/恶意的无界行直接断连，不继续缓冲。
      if (line.length > HARNESS_MAX_LINE_LENGTH) {
        this.#failOversizeLine();
        return;
      }
      if (line.trim().length > 0) {
        this.#handleLine(line);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > HARNESS_MAX_LINE_LENGTH) {
      this.#failOversizeLine();
    }
  }

  #failOversizeLine(): void {
    const error = new HarnessDisconnectError(
      "frame-too-large",
      `server line exceeds ${HARNESS_MAX_LINE_LENGTH} characters; disconnecting to avoid unbounded buffering`,
    );
    this.#buffer = "";
    this.#failPending(error);
    this.#setClosed();
    this.#child.kill();
  }

  #handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 非 JSON 行按兼容铁律忽略（不抛、不断连）。
      return;
    }
    const frame = parseFrameLoose(raw);
    if (frame.kind === "response") {
      const id = Number(frame.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (frame.ok) pending.resolve(frame.result);
      else
        pending.reject(
          new HarnessRpcError(frame.error.code, frame.error.message, frame.error.details),
        );
      return;
    }
    if (frame.kind === "event") {
      // seq 单调性检查：相邻帧出现缺口即上报 onGap（丢帧/乱序检测）。
      if (this.#lastSeq !== undefined && frame.seq > this.#lastSeq + 1) {
        this.#options.onGap?.({
          expectedSeq: this.#lastSeq + 1,
          receivedSeq: frame.seq,
          sessionId: frame.sessionId,
        });
      }
      if (this.#lastSeq === undefined || frame.seq > this.#lastSeq) {
        this.#lastSeq = frame.seq;
      }
      const event = parseEventLoose(frame.event);
      const payload = { sessionId: frame.sessionId, seq: frame.seq, event };
      for (const listener of Array.from(this.#eventListeners)) {
        try {
          listener(payload);
        } catch {
          // 消费方监听器异常不阻断其它监听器与连接。
        }
      }
      return;
    }
    if (frame.kind === "error") {
      // 协议级错误帧（版本不匹配等）在握手后出现视为连接层故障。
      this.#failPending(
        new HarnessDisconnectError("handshake-failed", `${frame.code}: ${frame.message}`),
      );
      return;
    }
    // 兼容铁律：未知帧（hello 重复、request 回流、unknown）一律忽略。
  }

  #failPending(error: unknown): void {
    for (const [, pending] of this.#pending) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#closeError ??= error;
  }

  #setClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#closeWaiters) waiter();
    this.#closeWaiters = [];
  }

  get serverInfo(): HarnessServerInfo {
    return this.#serverInfo;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** M3 诊断：连接层事件监听器数量（session 泄漏回归观测点）。 */
  get eventListenerCount(): number {
    return this.#eventListeners.size;
  }

  addEventListener(
    listener: (frame: { sessionId: string; seq: number; event: HarnessEvent }) => void,
  ): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      throw this.#closeError instanceof Error
        ? this.#closeError
        : new HarnessDisconnectError("stream-closed", "connection is closed");
    }
    const id = this.#nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "request",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return promise;
  }

  #send(frame: unknown): void {
    if (this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** 结束连接：关闭 stdin 并等待子进程退出（kill 兜底）。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
    });
    const timeout = setTimeout(() => this.#child.kill(), 3_000);
    await exited;
    clearTimeout(timeout);
    this.#setClosed();
  }

  /** 立即终止子进程（SIGTERM；测试与宿主强制回收用，正常关闭走 close）。 */
  kill(): void {
    this.#child.kill();
  }

  /** 等待连接关闭（进程退出/流关闭）。 */
  done(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#closeWaiters.push(resolve);
    });
  }
}
