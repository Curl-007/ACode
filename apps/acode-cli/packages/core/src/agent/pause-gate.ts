// ============================================================
// PauseGate - 进程级冻结闸门（WI-10 R4）
// ============================================================
//
// Ported from oh-my-pi (MIT) — packages/agent/src/pause.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs
//
// 移植说明：类体近逐字移植。Bun API 降解——原实现零 Bun 依赖；
// Promise.withResolvers 为 Node 22+ 原生（mise.toml 钉 Node 24），无需 polyfill。
//
// 语义（specs/stable-prefix-pause-gate.md R4）：
// - 进程内所有 agent loop（主会话 + 同进程子代理 child runtime + 舰队会话）在
//   两个安全点轮询本闸门：模型调用前（turn-loop.ts while 顶部）、工具调用前
//   （turn-tools.ts executeTools 批级入口）。闸门关闭 ⇒ 全部 loop 在下一个
//   安全点 park。
// - pause 不 abort 任何在飞操作：已发起的 provider 流、已进入 handler 的工具
//   跑完才 park；排队中的 steer/follow-up 消息保持排队，resume 后照常投递。
// - 单 run 的 AbortSignal 只释放本 waiter（闸门保持关闭）——取消一个 run
//   不需要解冻全进程。
// - host 驱动单例（如 /pause 命令，接线归命令面所有者）；库代码只读。
// - omp 的 MAX_PAUSED_TURN_CONTINUATIONS 是 provider pause_turn 非终结 stop 的
//   重采样上限，与闸门无关；ACode 无 pause_turn 面，不移植（spec R4 调查结论）。

/** 每次 pause/resume 转变时被调用的监听器。 */
export type AgentPauseListener = (paused: boolean) => void;

/** 进程内全部 agent loop 共享的冻结开关。 */
export class AgentPauseGate {
  /** paused 期间挂起；resume 时 resolve 并清空。 */
  #gate: PromiseWithResolvers<void> | undefined;
  #pausedAt = 0;
  #listeners = new Set<AgentPauseListener>();

  /** 闸门是否关闭。 */
  get paused(): boolean {
    return this.#gate !== undefined;
  }

  /** 当前 pause 的起始 epoch ms；running 时 undefined。 */
  get pausedAt(): number | undefined {
    return this.#gate ? this.#pausedAt : undefined;
  }

  /** 关闭闸门。已处于 paused 时无操作并返回 false（幂等）。 */
  pause(): boolean {
    if (this.#gate) return false;
    this.#gate = Promise.withResolvers<void>();
    this.#pausedAt = Date.now();
    this.#notify(true);
    return true;
  }

  /**
   * 释放闸门，唤醒全部 parked loop。返回冻结时长 ms；
   * 闸门本就开启时返回 undefined（幂等）。
   */
  resume(): number | undefined {
    const gate = this.#gate;
    if (!gate) return undefined;
    this.#gate = undefined;
    gate.resolve();
    this.#notify(false);
    return Date.now() - this.#pausedAt;
  }

  /** 订阅 pause/resume 转变。返回退订函数。 */
  onChange(listener: AgentPauseListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * park 至闸门释放；未 paused 时立即 resolve。`signal` 上的 abort 只释放
   * 本次等待（闸门保持关闭）——被取消的 run 自行解绕，进程其余部分继续冻结。
   */
  async waitUntilResumed(signal?: AbortSignal): Promise<void> {
    // 循环：resume() 会换掉 gate promise，waiter 两次 await 之间又被 pause 的
    // 必须重新 park，不得漏过（omp 同款 while 语义，验收场景 4 覆盖）。
    while (this.#gate) {
      if (signal?.aborted) return;
      const gate = this.#gate.promise;
      if (!signal) {
        await gate;
        continue;
      }
      const abort = Promise.withResolvers<void>();
      const onAbort = () => abort.resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([gate, abort.promise]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  #notify(paused: boolean): void {
    for (const listener of this.#listeners) {
      try {
        listener(paused);
      } catch {
        // host UI 监听器绝不能破坏闸门。
      }
    }
  }
}

/** 进程级单例：turn loop 安全点轮询的唯一闸门。 */
export const agentPauseGate = new AgentPauseGate();

/**
 * 安全点统一入口（spec R4 SP①/SP②）：闸门关闭才 park，开启时零开销直通。
 * abort 释放 park 后由调用方的既有 abort 检查（throwIfTurnAborted /
 * executor cancelled result）接管解绕，本函数不吞不改 abort 语义。
 */
export async function parkAtPauseSafePoint(signal?: AbortSignal): Promise<void> {
  if (agentPauseGate.paused) {
    await agentPauseGate.waitUntilResumed(signal);
  }
}
