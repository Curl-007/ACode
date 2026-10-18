// MCP 静默探测阶梯（specs/mcp-startup-gate-breaker.md R3）。
//
// 机制形态参照外部成熟实现的公开行为（曾连接成功的远程 server 失联后，后台静默
// 探测 15s 起步指数退避至 5min 上限，直到恢复 / 显式断开 / 重新配置），实现自撰。
// 为什么需要阶梯：HTTP/SSE server 重启部署、笔记本唤醒网络未恢复等场景里，server
// 会按自己的节奏回来；没有后台探测时它一直停在 disconnected，直到下一次工具调用
// 碰上或用户发现。阶梯保证恢复流量有界（最密 15s 一次，退避到 5min），绝不高频
// 打洞。stdio server 不适用：进程死了等不来，定时重拉正是崩溃风暴熔断要停掉的
// fork 风暴（spec R3）。
//
// 状态所有者：本类实例（NodeMcpAdapter 私有字段，按 server 隔离）。armed 窗口内
// 的探测只有一个执行者；探测的成败结果由调用方（adapter）负责 re-arm 或 stop——
// 本类只管调度节奏，不发起连接。

/** 首次静默探测延迟（ms）。 */
export const MCP_PROBE_BASE_DELAY_MS = 15_000;
/** 探测延迟上限（ms）：15s → 30s → 60s → 120s → 300s 封顶。 */
export const MCP_PROBE_MAX_DELAY_MS = 5 * 60_000;

export interface McpProbeLadderOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * 定时器注入点：`(serverName, delayMs, fire) => 取消函数`。缺省 setTimeout +
   * unref（不阻止进程退出）。测试注入假定时器获得确定性时序。
   */
  arm?: (serverName: string, delayMs: number, fire: () => void) => () => void;
}

interface ProbeScheduleState {
  cancel?: () => void;
  /** 下一次武装使用的延迟（arm 时消费并立即倍增，保证失败重试单调退避）。 */
  nextDelayMs: number;
}

export class McpProbeLadder {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly armFn: NonNullable<McpProbeLadderOptions["arm"]>;
  private readonly schedules = new Map<string, ProbeScheduleState>();

  constructor(options: McpProbeLadderOptions = {}) {
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? MCP_PROBE_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? MCP_PROBE_MAX_DELAY_MS);
    this.armFn =
      options.arm ??
      ((_serverName, delayMs, fire) => {
        const timer = setTimeout(fire, delayMs);
        // unref：静默探测是后台礼貌行为，绝不把进程吊在退出边缘。
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /**
   * 武装（或确认已在武装）一次静默探测。已武装时幂等 no-op——同一 server 永远
   * 只有一个 pending 定时器。延迟从当前累积值取用并立即倍增：探测失败后调用方
   * 重新 arm 时自然落到下一个退避档。
   */
  arm(serverName: string, onProbe: (serverName: string) => void): void {
    const existing = this.schedules.get(serverName);
    if (existing?.cancel) return;
    const state: ProbeScheduleState = existing ?? {
      nextDelayMs: this.baseDelayMs,
    };
    const delayMs = state.nextDelayMs;
    state.nextDelayMs = Math.min(delayMs * 2, this.maxDelayMs);
    state.cancel = this.armFn(serverName, delayMs, () => {
      // 定时器到点即解除武装：探测的成败结果由调用方决定 re-arm / stop，
      // 期间 arm() 不再被「已武装」挡住，也不会叠加第二个定时器。
      if (this.schedules.get(serverName) === state) state.cancel = undefined;
      onProbe(serverName);
    });
    this.schedules.set(serverName, state);
  }

  /** 是否有 pending 的探测定时器。 */
  isArmed(serverName: string): boolean {
    return this.schedules.get(serverName)?.cancel !== undefined;
  }

  /** 拆除：连接成功 / 显式断开 / 熔断 / adapter close。延迟累积一并清除（重新武装从 base 起步）。 */
  stop(serverName: string): void {
    const state = this.schedules.get(serverName);
    if (!state) return;
    state.cancel?.();
    this.schedules.delete(serverName);
  }

  stopAll(): void {
    for (const serverName of Array.from(this.schedules.keys())) {
      this.stop(serverName);
    }
  }
}
