// 连接握手阶段（自 connection.ts 拆出的内聚内部模块，行为保持原样）：
// hello → hello_ack 的握手帧收发、握手超时/版本不符/进程提前退出的失败归因，
// 以及「握手监听器 → 连接层监听器」移交的前半段（pause + 摘除握手监听）。
// 移交后半段（构造 HarnessConnection、注入残留缓冲、attach、resume）在
// connection.ts 的 connect() 内完成——零丢帧零双发语义与原实现一致。

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  HARNESS_API_VERSION_MAJOR,
  HARNESS_MAX_LINE_LENGTH,
  parseFrameLoose,
} from "@acode/shared/harness-api";
import { HarnessDisconnectError } from "./errors.js";
import { SDK_HANDSHAKE_TIMEOUT_MS } from "./constants.js";
import type { HarnessConnectionOptions, HarnessServerInfo } from "./connection-types.js";

export interface HandshakeOutcome {
  serverInfo: HarnessServerInfo;
  /** 握手期间已读入但尚未按行消费的残留缓冲（移交连接层继续解析）。 */
  residualBuffer: string;
  /** M1：与稳态共用的 StringDecoder——跨 chunk 的部分多字节序列随移交带走。 */
  decoder: StringDecoder;
}

/**
 * 在已 spawn 的子进程上完成握手；任何失败都会清理子进程后抛 HarnessDisconnectError。
 * 成功返回时 stdout 已 pause、握手监听器已摘除，等待 connect() 完成后半段移交。
 */
export async function performHandshake(
  child: ChildProcessWithoutNullStreams,
  options: HarnessConnectionOptions,
): Promise<HandshakeOutcome> {
  let handshakeResolve: () => void;
  let handshakeReject: (error: unknown) => void;
  const handshakePromise = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  let serverInfo: HarnessServerInfo | undefined;
  let buffer = "";
  let settled = false;
  // M1：StringDecoder 持有跨 chunk 的部分多字节序列（与稳态共用，见 connection.ts 构造器）。
  const decoder = new StringDecoder("utf8");
  const timeout = setTimeout(() => {
    settle(new HarnessDisconnectError("handshake-failed", "no hello_ack within handshake timeout"));
  }, options.handshakeTimeoutMs ?? SDK_HANDSHAKE_TIMEOUT_MS);

  const settle = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) handshakeReject(error);
    else handshakeResolve();
  };

  const onData = (chunk: Buffer): void => {
    buffer += decoder.write(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      // M4：握手期单行同样受上限约束（失控服务端的无界行不进缓冲，防 OOM）。
      if (line.length > HARNESS_MAX_LINE_LENGTH) {
        settle(
          new HarnessDisconnectError(
            "frame-too-large",
            `server line exceeds ${HARNESS_MAX_LINE_LENGTH} characters during handshake`,
          ),
        );
        child.kill();
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        settle(
          new HarnessDisconnectError(
            "handshake-failed",
            `non-JSON frame during handshake: ${line.slice(0, 120)}`,
          ),
        );
        return;
      }
      const frame = parseFrameLoose(raw);
      if (frame.kind === "hello_ack") {
        serverInfo = {
          server: frame.server,
          protocolMinor: frame.protocolMinor,
          capabilities: frame.capabilities,
        };
        settle();
        return;
      }
      if (frame.kind === "error") {
        if (frame.code === "version_mismatch") {
          settle(new HarnessDisconnectError("version-mismatch", frame.message));
        } else {
          settle(new HarnessDisconnectError("handshake-failed", `${frame.code}: ${frame.message}`));
        }
        return;
      }
      // 兼容铁律：握手前未知帧忽略（服务端 additive 演进不破坏老 SDK 的握手）。
    }
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    settle(
      new HarnessDisconnectError(
        "process-exit",
        `harness process exited before handshake completed (code=${code ?? "null"} signal=${signal ?? "none"})`,
      ),
    );
  };

  child.stdout.on("data", onData);
  child.once("exit", onExit);
  // 行为保持：stderr 直通在握手期挂载且成功后不摘除——稳态 #attach 会再挂一路，
  // 两路并存是拆分前的既有行为，本次拆分原样保留（不顺手改变 stderr 投递次数）。
  child.stderr.on("data", (chunk: Buffer) => {
    options.stderr?.(chunk.toString("utf8"));
  });

  // 先发 hello 再等 ack。
  child.stdin.write(
    `${JSON.stringify({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "hello",
      client: "acode-harness-sdk",
      capabilities: ["events", "structured-output", "tools-configure"],
    })}\n`,
  );

  try {
    await handshakePromise;
  } catch (error) {
    child.stdout.removeListener("data", onData);
    child.removeListener("exit", onExit);
    child.kill();
    throw error;
  }

  // ── 监听器移交（前半段）：pause 后摘握手监听；构造连接 → 注入残留缓冲 →
  // attach → resume 在 connection.ts connect() 完成后半段。
  // pause 期间到达的数据由流缓冲，保证不丢帧也不双发。
  // M1：decoder 随残留缓冲一并移交——部分多字节序列在 decoder 内等下一 chunk 补全。
  child.stdout.pause();
  child.stdout.removeListener("data", onData);
  child.removeListener("exit", onExit);
  // settle() 只在收到 hello_ack 时成功 resolve，此分支 serverInfo 必然已赋值。
  return { serverInfo: serverInfo!, residualBuffer: buffer, decoder };
}
