// Ported from oh-my-pi (MIT) — 内部小工具（Bun API 降解 node:*；Promise.withResolvers
// 以显式 deferred 表达，规避各包 tsconfig lib 差异）。

/** 可从外部 resolve/reject 的 promise 句柄。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 定时等待（Bun.sleep 的 node:* 等价物）；不持句柄，短延时无泄漏面。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 停止后仍返回最终状态的定时等待；超时返回 false，先 settle 返回 true。 */
export async function waitForSettled(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
