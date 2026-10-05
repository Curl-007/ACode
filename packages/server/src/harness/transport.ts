// Harness API stdio 传输：NDJSON 行协议 codec（一行一帧对象）。
// 参照 jcode (MIT) harness-api 的 NDJSON 帧形态，自撰实现。
// stdout 只承载协议帧；所有日志必须走 stderr（与 entry-stdio 同一纪律）。

import { StringDecoder } from "node:string_decoder";
import {
  HARNESS_API_VERSION_MAJOR,
  HARNESS_MAX_LINE_LENGTH,
} from "@acode/shared/harness-api";

export interface HarnessStdioTransport {
  /** 逐行产出（已去除换行；空行跳过）。输入流结束后迭代器自然完结。 */
  readLines(): AsyncIterable<string>;
  /** 写出一帧（自动补换行）。写入失败（流已关）时静默丢弃——关闭语义由 onClose 承载。 */
  writeLine(line: string): void;
  /** 底层输入流关闭（end/error/close）后 resolve。 */
  onClose(): Promise<void>;
  /** 主动终止传输（幂等）。 */
  dispose(): void;
}

export function createStdioTransport(
  input: NodeJS.ReadableStream & { pause?: () => void; resume?: () => void },
  output: NodeJS.WritableStream,
): HarnessStdioTransport {
  // 用推拉混合模型：data 事件填充行缓冲队列，readLines 消费；关闭时 flush 哨兵。
  const pendingLines: string[] = [];
  const wakeups: (() => void)[] = [];
  let ended = false;
  let buffer = "";
  let closePromise: Promise<void> | undefined;
  let closeResolve: (() => void) | undefined;
  let disposed = false;
  // M4 写背压：下游 write() 返回 false 时暂停输入泵（停读新请求），drain 后恢复。
  let awaitingDrain = false;
  // M1：跨 chunk 的多字节 UTF-8 序列必须经 StringDecoder 解码——
  // chunk.toString("utf8") 会在多字节字符中间切开产生 U+FFFD（中文帧损坏，实证缺陷）。
  const decoder = new StringDecoder("utf8");

  const signalWakeup = (): void => {
    while (wakeups.length > 0) {
      wakeups.shift()?.();
    }
  };

  // M4：单行超限处理——回 line_too_long error 帧并断连（防 OOM）。
  const failOversizeLine = (): void => {
    ended = true;
    buffer = "";
    const frame = `${JSON.stringify({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "error",
      code: "line_too_long",
      message: `input line exceeds ${HARNESS_MAX_LINE_LENGTH} characters; closing connection`,
    })}\n`;
    (output as NodeJS.WritableStream & { write(s: string): boolean }).write(frame);
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    signalWakeup();
  };

  const handleChunk = (chunk: Buffer | string): void => {
    if (disposed || ended) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > HARNESS_MAX_LINE_LENGTH) {
        failOversizeLine();
        return;
      }
      if (line.trim().length > 0) {
        pendingLines.push(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
    // M4：无换行的无界缓冲同样受限（超限时对端要么失控要么恶意，停止解析）。
    if (buffer.length > HARNESS_MAX_LINE_LENGTH) {
      failOversizeLine();
      return;
    }
    signalWakeup();
  };

  const handleEnd = (): void => {
    if (disposed) return;
    if (buffer.trim().length > 0) {
      pendingLines.push(buffer.replace(/\r$/, ""));
      buffer = "";
    }
    ended = true;
    signalWakeup();
  };

  input.on("data", (chunk: Buffer | string) => handleChunk(chunk));
  input.on("end", handleEnd);
  input.on("error", handleEnd);
  input.on("close", handleEnd);

  return {
    readLines() {
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (pendingLines.length > 0) {
              yield pendingLines.shift() as string;
            }
            if (ended) return;
            await new Promise<void>((resolve) => {
              wakeups.push(resolve);
            });
          }
        },
      };
    },
    writeLine(line: string) {
      if (disposed) return;
      // writable.write 失败由返回值/backpressure 承载；帧协议不做重试。
      const writable = output as NodeJS.WritableStream & { write(s: string): boolean };
      if (writable.write(`${line}\n`) === false && !awaitingDrain) {
        // M4：慢消费者不无限缓冲——暂停输入泵（上游停止读请求），
        // 输出流 drain 后恢复；dedup 保证一次背压期只挂一个 drain 监听。
        awaitingDrain = true;
        input.pause?.();
        output.once("drain", () => {
          awaitingDrain = false;
          input.resume?.();
        });
      }
    },
    onClose() {
      closePromise ??= new Promise<void>((resolve) => {
        closeResolve = resolve;
        if (ended) resolve();
      });
      if (ended) closeResolve?.();
      // 结束哨兵在 handleEnd 中已经触发；这里再挂一次兜底 close 事件。
      input.once("close", () => {
        ended = true;
        closeResolve?.();
        signalWakeup();
      });
      return closePromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ended = true;
      signalWakeup();
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    },
  };
}
