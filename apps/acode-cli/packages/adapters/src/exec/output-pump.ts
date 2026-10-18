// Mechanism ported from oh-my-pi (MIT) crates/pi-shell N-API 输出桥 — 语义参照，Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 输出有界队列背压 + coalesce（specs/fs-hotpath-mechanisms.md R4）
//
// stdout/stderr chunk 进入 64-chunk 有界队列，微任务批量派发；队列将满时新
// chunk 合并（coalesce）进队尾同流条目——不丢弃、不阻塞读端，防止刷屏型
// 命令把事件派发冲垮。事件形状由调用方保持（{type:"stdout"|"stderr", ...}）。
// ============================================================

export const OUTPUT_PUMP_MAX_QUEUE = 64;

export type PumpedStreamName = "stdout" | "stderr";

export interface PumpedItem {
  stream: PumpedStreamName;
  buffer: Buffer;
  text: string;
}

export interface BoundedOutputPumpOptions {
  /** 批量派发回调：一次 flush 的全部条目（保序）。 */
  flush: (items: PumpedItem[]) => void;
  /** 增量解码（与既有 ExecutionOutputDecoder 对齐）。 */
  decode: (buffer: Buffer) => string;
  maxQueue?: number;
}

export interface BoundedOutputPump {
  append: (stream: PumpedStreamName, buffer: Buffer) => void;
  /** 立即派发队列中全部条目（流 close 时兜底，防结果后迟到事件）。 */
  flushSync: () => void;
  /** 仅用于测试观察。 */
  debugQueueLength: () => number;
}

export function createBoundedOutputPump(options: BoundedOutputPumpOptions): BoundedOutputPump {
  const maxQueue = options.maxQueue ?? OUTPUT_PUMP_MAX_QUEUE;
  const queue: PumpedItem[] = [];
  let flushScheduled = false;

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flushSync();
    });
  };

  const flushSync = (): void => {
    if (queue.length === 0) return;
    const items = queue.splice(0, queue.length);
    options.flush(items);
  };

  return {
    append: (stream, buffer) => {
      // 队列将满时 coalesce 进队尾同流条目：文本增量解码后拼接，Buffer concat。
      // 找不到同流条目（罕见：长短交替流占满队列）时软越界追加，不丢数据。
      if (queue.length >= maxQueue) {
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const last = queue[index];
          if (last && last.stream === stream) {
            last.buffer = Buffer.concat([last.buffer, buffer]);
            last.text += options.decode(buffer);
            return;
          }
        }
      }
      queue.push({ stream, buffer, text: options.decode(buffer) });
      scheduleFlush();
    },
    flushSync,
    debugQueueLength: () => queue.length,
  };
}
