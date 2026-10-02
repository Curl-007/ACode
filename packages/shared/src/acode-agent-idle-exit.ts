// chat lane 空闲回收的共享契约与纯状态机。
// spec: packages/services/specs/chat-lane-idle-reclaim.md
//
// 三方消费:
// - CLI(bootstrap): 读 env 配置,60s 采样节拍驱动 evaluator,宣告后走优雅退出链;
// - Host(services processManager): 消费宣告帧记录 expected 终止意图,退出码兜底归因;
// - 测试: evaluator 是纯状态机(now/collectFacts/announce/requestShutdown 全部注入)。

/**
 * Host→CLI 装配通道的调优 env(与 ACODE_WORKSPACE_IDENTITY 同模式):
 * 正整数 = 连续静默阈值(ms);`0` = 禁用;非法值 fail-safe 按禁用处理。
 * 这是资源调优面,不是安全边界(与 agent-command-env-gate 的二进制替换面无关)。
 * plugin / mcp-status lane 由 Host spawn 时显式注入 `0` 保持现状(spec R8)。
 */
export const ACODE_AGENT_IDLE_EXIT_ENV_KEY = "ACODE_AGENT_IDLE_EXIT_MS";

/**
 * 保留退出码:宣告帧丢失/与 EOF 竞态时,Host 兜底把该退出码归因为
 * expected/cli-idle-exit-code(spec R3)。与既有 0/1/129/130/143 约定无冲突;
 * signal 崩溃的 exit code 为 null,不会误命中。
 */
export const ACODE_AGENT_IDLE_EXIT_CODE = 85;

/** 缺省连续静默阈值:15 分钟(> 驻留池 10 分钟驱逐,先释放会话、后释放进程)。 */
export const ACODE_AGENT_IDLE_EXIT_DEFAULT_MS = 15 * 60_000;

/** Host 收到宣告帧后的宽限:超时可视为 CLI 退出链卡死,主动回收防悬挂(spec R3)。 */
export const ACODE_AGENT_IDLE_EXIT_GRACE_MS = 10_000;

export interface ACodeAgentIdleExitConfig {
  enabled: boolean;
  idleExitMs: number;
  /** 非法 env 原值,供调用方打 warn;fail-safe 语义 = 禁用。 */
  parseError?: string;
}

export function resolveACodeAgentIdleExitConfig(
  env: Record<string, string | undefined>,
): ACodeAgentIdleExitConfig {
  const raw = env[ACODE_AGENT_IDLE_EXIT_ENV_KEY];
  if (raw === undefined) {
    return { enabled: true, idleExitMs: ACODE_AGENT_IDLE_EXIT_DEFAULT_MS };
  }
  const trimmed = raw.trim();
  if (trimmed === "0") {
    return { enabled: false, idleExitMs: 0 };
  }
  // 只接受纯十进制整数字符串:"1e3"/"1.5"/"-5" 等一律 fail-safe 禁用,
  // 避免不同工具链对科学计数法/浮点的解析差异造成阈值意外。
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0) {
      return { enabled: true, idleExitMs: parsed };
    }
  }
  return { enabled: false, idleExitMs: 0, parseError: raw };
}

/** 静默事实聚合结果;reasons 仅诊断用(日志/计数器),不参与判定分支。 */
export interface ACodeAgentQuiescenceFacts {
  quiescent: boolean;
  reasons: readonly string[];
}

export interface ACodeAgentIdleExitEvaluatorOptions {
  /** 必须为正;`0` 语义只存在于 config 层(禁用时不创建 evaluator)。 */
  idleExitMs: number;
  collectFacts: () => ACodeAgentQuiescenceFacts;
  /** 发送 runtime/idleExit 宣告帧;由调用方接到协议 connection 上。 */
  announce: (params: { quiescentMs: number }) => void;
  /** 触发进程优雅退出;由调用方接到 lifecycle.requestShutdown(undefined, code)。 */
  requestShutdown: (exitCode: number) => void;
  now?: () => number;
  /** 观测钩子(日志);evaluator 自身不做 IO。 */
  onEvent?: (event: {
    kind: "announced" | "quiescence-broken";
    quiescentMs?: number;
    reasons?: readonly string[];
  }) => void;
}

export interface ACodeAgentIdleExitEvaluator {
  /** 由 60s 资源采样节拍调用;纯状态机,单次失败只损失当轮计时。 */
  onTick(): void;
  /** 内存诊断计数器,并入 60s memory sample。 */
  collectCounters(): Record<string, number>;
}

/**
 * 连续静默计时:任一条件破坏即清零重计(spec R2)。首次观察到静默的时刻作为
 * 起点(保守:真实静默起点在上一 tick 与本次之间,取晚者不会提前退出)。
 * 触发一次后进入 announced 终态,不重复宣告。
 */
export function createACodeAgentIdleExitEvaluator(
  options: ACodeAgentIdleExitEvaluatorOptions,
): ACodeAgentIdleExitEvaluator {
  if (!Number.isFinite(options.idleExitMs) || options.idleExitMs <= 0) {
    throw new RangeError("idle exit evaluator requires a positive idleExitMs");
  }
  const now = options.now ?? Date.now;
  let quiescentSinceMs: number | undefined;
  let announced = false;
  return {
    onTick() {
      if (announced) return;
      const facts = options.collectFacts();
      const nowMs = now();
      if (!facts.quiescent) {
        if (quiescentSinceMs !== undefined) {
          options.onEvent?.({ kind: "quiescence-broken", reasons: facts.reasons });
        }
        quiescentSinceMs = undefined;
        return;
      }
      quiescentSinceMs ??= nowMs;
      const quiescentMs = nowMs - quiescentSinceMs;
      if (quiescentMs < options.idleExitMs) return;
      announced = true;
      options.announce({ quiescentMs });
      options.onEvent?.({ kind: "announced", quiescentMs });
      options.requestShutdown(ACODE_AGENT_IDLE_EXIT_CODE);
    },
    collectCounters() {
      const nowMs = now();
      return {
        "idleExit.quiescentMs":
          quiescentSinceMs === undefined ? 0 : Math.max(0, nowMs - quiescentSinceMs),
        "idleExit.announced": announced ? 1 : 0,
      };
    },
  };
}
