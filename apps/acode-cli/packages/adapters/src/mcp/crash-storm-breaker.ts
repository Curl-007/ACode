// MCP 崩溃风暴熔断（specs/mcp-startup-gate-breaker.md R2）。
//
// 机制形态参照外部成熟实现的公开行为（滑动窗口 30s 内 >5 次断连 → 挂起自动重连、
// 手动重连复位窗口），实现自撰。为什么需要独立熔断：懒重连预算（R1，
// reconnect-budget.ts）的计数器会被「连接成功」复位——一个「每次都能连上、但进程
// 活不过一个窗口」的 stdio server（握手完成后立刻退出）每轮 spawn 都以成功开表，
// connect_failures 永远归零、in_call_crashes 只数调用中途断开，两次调用之间崩溃的
// 形态两个计数器都追不到，spawn 循环无上界（参考实现 issue #1592 的 fork-bomb
// 形态）。风暴熔断数的是**毫无产出的连接死亡**，专抓这个盲区。
//
// 「毫无产出」判据（与 R1 半可用契约不打架的关键）：断连之间夹着**完整成功工具
// 调用**的 server 是 R1 认定的半可用形态（「成功/崩溃交替永不挂起，继续服务」），
// 一次完整成功调用即清空窗口。调用方（adapter）只在 record.workedSinceConnect 为
// 假时计数，并在成功调用点调用 reset——本类只做窗口算术，不做语义判定。
//
// 与 R1 预算的边界（spec R2 表格）：预算管退避节奏与调用路径挂起，熔断管风暴停机；
// 两者各自持有状态、互不喂计数，懒重连与探测先查熔断再查预算。
//
// 状态所有者：本类实例（NodeMcpAdapter 私有字段，按 server 隔离）。显式操作
// （connectServer / disconnectServer）是唯一复位面；自动路径永不自我复位。

/** 滑动窗口宽度（ms）：断连事件超出窗口即老化出局。 */
export const MCP_CRASH_STORM_WINDOW_MS = 30_000;
/** 窗口内断连次数上限：第 6 次（>5）入列即熔断。 */
export const MCP_CRASH_STORM_LIMIT = 5;

export interface McpCrashStormBreakerOptions {
  windowMs?: number;
  limit?: number;
  now?: () => number;
}

export interface McpCrashStormTrip {
  /** 窗口内断连次数（触发时的计数，> limit）。 */
  windowCount: number;
  /** 窗口宽度（ms），随事件透出便于日志自解释。 */
  windowMs: number;
}

export class McpCrashStormBreaker {
  readonly windowMs: number;
  private readonly limit: number;
  private readonly now: () => number;
  /** 每 server 的断连时间戳窗口；tripped 后保留条目直到显式复位（计数冻结可见）。 */
  private readonly windows = new Map<string, number[]>();

  constructor(options: McpCrashStormBreakerOptions = {}) {
    this.windowMs = Math.max(1, options.windowMs ?? MCP_CRASH_STORM_WINDOW_MS);
    this.limit = Math.max(1, options.limit ?? MCP_CRASH_STORM_LIMIT);
    this.now = options.now ?? Date.now;
  }

  /** 窗口宽度（ms），供拒绝文案与状态面引用同一常量来源。 */
  get windowSizeMs(): number {
    return this.windowMs;
  }

  /**
   * 登记一次意外断开（已建立连接的 onclose）。返回 tripped=true 表示本次入列
   * 越过上限、刚刚进入熔断态；已在熔断态时继续计数（窗口事实持续累积），但
   * tripped 只在**越过上限的那一次**为 true——调用方据此只发一次挂起状态面。
   */
  recordDisconnect(serverName: string): { tripped: boolean; trip?: McpCrashStormTrip } {
    const nowMs = this.now();
    const previous = this.windows.get(serverName) ?? [];
    // 先剪枝再入列：单次瞬时故障随时间老化出局，只惩罚突发密集断连。
    const recent = previous.filter((timestamp) => nowMs - timestamp < this.windowMs);
    recent.push(nowMs);
    this.windows.set(serverName, recent);

    if (recent.length > this.limit) {
      return {
        tripped: true,
        trip: { windowCount: recent.length, windowMs: this.windowMs },
      };
    }
    return { tripped: false };
  }

  /** 是否处于熔断态（窗口计数仍超上限）。 */
  isTripped(serverName: string): boolean {
    const window = this.windows.get(serverName);
    if (!window) return false;
    const nowMs = this.now();
    const recent = window.filter((timestamp) => nowMs - timestamp < this.windowMs);
    return recent.length > this.limit;
  }

  /** 窗口计数快照（日志与诊断用；未过限返回 0）。 */
  windowCount(serverName: string): number {
    const window = this.windows.get(serverName);
    if (!window) return 0;
    const nowMs = this.now();
    return window.filter((timestamp) => nowMs - timestamp < this.windowMs).length;
  }

  /** 显式操作复位（connectServer / disconnectServer / adapter close）。 */
  reset(serverName: string): void {
    this.windows.delete(serverName);
  }
}
