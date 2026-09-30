// Provider Doctor 内部小工具：计时与错误归一（不做判定，只 formatting）。
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。

export async function timedRun<T>(run: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const started = Date.now();
  const result = await run();
  return { result, durationMs: Math.max(0, Date.now() - started) };
}

/** 单行、限长的错误摘要；调用方还会再过 redactor（spec R5）。 */
export function describeError(error: unknown, maxLength = 160): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
