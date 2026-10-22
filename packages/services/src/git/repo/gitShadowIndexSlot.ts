import {
  createShadowIndexError,
  SHADOW_INDEX_ERROR_CODE,
  type ShadowIndexError,
} from "./gitShadowIndexErrors.js";

/**
 * shadow index 复制的并发闸门（specs/shadow-git-index.md R3）：
 * per-path singleflight + 全局并发预算 + 可 abort/可超时等待。
 *
 * 蓝本：Claude Desktop 2.37337 `index.chunk-PMGadqIZ.js:169-236`
 * （模块级 k/O/A 状态、ne() 等待、re() slot 获取循环）。
 * 并发状态是进程内语义（蓝本同款）；跨进程互斥不在范围。
 */

/** 全局并发复制预算（蓝本 D=2，PMGadqIZ.js:168）。 */
export const SHADOW_INDEX_COPY_BUDGET_DEFAULT = 2;
/** singleflight/预算等待超时（蓝本 ee=5e3，PMGadqIZ.js:172）。 */
export const SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT = 5_000;

// ---- 模块级并发状态（进程内语义，蓝本 k/O/A，PMGadqIZ.js:169-171）----

const copiesBySourcePath = new Map<string, Promise<void>>();
let activeCopyCount = 0;
let budgetGate: { promise: Promise<void>; settle: () => void } | undefined;

/** 诊断/测试用：当前在飞复制数与排队中的源路径数。 */
export function getShadowIndexPipelineStats(): {
  activeCopyCount: number;
  queuedSourcePaths: number;
} {
  return { activeCopyCount, queuedSourcePaths: copiesBySourcePath.size };
}

/**
 * 可 abort/可超时的等待（蓝本 ne() + re() 的懒超时 controller，PMGadqIZ.js:177-190）。
 * 超时与 abort 走同一分类错误：等待只终止"排队拿优化资源"，不掩盖任何状态。
 */
async function waitAbortable(
  target: Promise<void>,
  options: { signal?: AbortSignal; timeoutMs: number; makeError: () => ShadowIndexError },
): Promise<void> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  timer.unref();
  const combined = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  // 目标 promise 的成败都要触发等待方重检（蓝本 then(void 0, void 0)）。
  const settled = target.then(
    () => undefined,
    () => undefined,
  );
  try {
    if (combined.aborted) {
      throw options.makeError();
    }
    await new Promise<void>((resolveWait, rejectWait) => {
      const onAbort = () => rejectWait(options.makeError());
      combined.addEventListener("abort", onAbort, { once: true });
      void settled.then(() => {
        combined.removeEventListener("abort", onAbort);
        resolveWait();
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * slot 获取（蓝本 re()，PMGadqIZ.js:191-236）：
 * per-path singleflight 串行化同源复制（不是结果合并）→ 全局预算 gate → 占位并
 * 返回 release。等待方被唤醒后重新 loop 竞争，与蓝本一致。
 * singleflight key 用 resolve 后的 verbatim 路径，不做 realpath 归一（登记残余，R3）。
 */
export async function acquireCopySlot(
  sourceIndexPath: string,
  options: { signal?: AbortSignal; budget: number; waitTimeoutMs: number },
): Promise<() => void> {
  for (;;) {
    const inFlight = copiesBySourcePath.get(sourceIndexPath);
    if (inFlight) {
      await waitAbortable(inFlight, {
        signal: options.signal,
        timeoutMs: options.waitTimeoutMs,
        makeError: () =>
          createShadowIndexError(
            `[git] could not make a private copy of ${sourceIndexPath}: still waiting for an earlier copy of it to finish`,
            SHADOW_INDEX_ERROR_CODE.copy,
          ),
      });
      continue;
    }
    if (activeCopyCount >= options.budget) {
      if (!budgetGate) {
        let settleGate!: () => void;
        const promise = new Promise<void>((settle) => {
          settleGate = settle;
        });
        budgetGate = { promise, settle: settleGate };
      }
      const budget = options.budget;
      await waitAbortable(budgetGate.promise, {
        signal: options.signal,
        timeoutMs: options.waitTimeoutMs,
        makeError: () =>
          createShadowIndexError(
            `[git] could not make a private copy of ${sourceIndexPath}: still waiting for ${budget} other index copies to finish`,
            SHADOW_INDEX_ERROR_CODE.copy,
          ),
      });
      continue;
    }
    activeCopyCount += 1;
    let settlePathGate!: () => void;
    copiesBySourcePath.set(
      sourceIndexPath,
      new Promise<void>((settle) => {
        settlePathGate = settle;
      }),
    );
    return () => {
      activeCopyCount -= 1;
      copiesBySourcePath.delete(sourceIndexPath);
      settlePathGate();
      // 释放时 settle 并清空预算 gate，唤醒等待方重新竞争（蓝本同款）。
      const gate = budgetGate;
      budgetGate = undefined;
      gate?.settle();
    };
  }
}
