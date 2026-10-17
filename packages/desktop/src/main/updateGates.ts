/**
 * 更新门控计算（价值提取第二轮 T1-s3「三件增量」，spec 见
 * packages/desktop/specs/update-gates-endpoint-registry.md）。
 *
 * 唯一所有者边界：本模块拥有 cap 比较、宿主忙碌延迟判定、gateReason 闭集与结构化
 * 门控日志；autoUpdater.ts 仍是更新状态机/single-flight/下载取消的所有者，只消费
 * 本模块的判定结论。本模块不 import electron（信号通过注入获得），保证可独立测试。
 */
import semver from "semver";

/** 门控原因闭集：所有 defer/skip/fail 原因收敛到该集合，全部进结构化日志。 */
export const UPDATE_GATE_REASONS = [
  "stale",
  "invalid_feed",
  "invalid_pointer",
  "capped",
  "busy_deferred",
  "install_failed",
  "fetch_failed",
  "disabled_by_policy",
  "not_packaged",
  "already_in_flight",
  "state_conflict",
  "user_skipped_version",
] as const;
export type UpdateGateReason = (typeof UPDATE_GATE_REASONS)[number];

export interface UpdateGateLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 结构化门控日志。上下文对象禁用 `status` 键（日志上下文保留键），统一用
 * `gateReason`；detail 归并进同一对象，保持一行一事件可 grep 可聚合。
 */
export function logUpdateGate(
  logger: UpdateGateLogger,
  gateReason: UpdateGateReason,
  context?: Record<string, unknown>,
): void {
  const { status: _reserved, ...rest } = context ?? {};
  logger.info("[auto-update] gate", { gateReason, ...rest });
}

/** 失败来源 → 闭集归并：安装链路失败与检查/下载网络失败分开。 */
export function classifyUpdateFailureGateReason(
  source: string,
): Extract<UpdateGateReason, "install_failed" | "fetch_failed"> {
  return /install|quit/i.test(source) ? "install_failed" : "fetch_failed";
}

export const UPDATE_MAX_VERSION_ENV = "ACODE_UPDATE_MAX_VERSION";
export const UPDATE_MAX_VERSION_SWITCH = "--acode-update-max-version";

export interface ResolvedUpdateVersionCap {
  /** 归一化后的 cap（semver 合法）；未配置为 null。 */
  cap: string | null;
  /** 配置了但无法解析的原始值；非 null 时按 fail-closed（capped）处理。 */
  invalidValue: string | null;
}

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length).trim() || undefined;
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) return next.trim() || undefined;
      return undefined;
    }
  }
  return undefined;
}

/**
 * cap 配置面解析：显式注入（打包/开发均生效）优先；env/argv 仅非打包构建生效
 * （与更新源覆盖 P1-7 同一哲学：打包版不吃用户态 env 注入，避免「静默断更」）。
 * 非法值不丢弃也不猜测：原样返回 invalidValue，由判定层 fail-closed 成 capped。
 */
export function resolveUpdateVersionCap(source: {
  explicit?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[];
  isPackaged?: boolean;
}): ResolvedUpdateVersionCap {
  const env = source.env ?? process.env;
  const argv = source.argv ?? process.argv;
  const raw =
    source.explicit?.trim() ||
    (source.isPackaged
      ? undefined
      : (readSwitchValue(argv, UPDATE_MAX_VERSION_SWITCH) ??
        env[UPDATE_MAX_VERSION_ENV]?.trim())) ||
    null;
  if (!raw) return { cap: null, invalidValue: null };
  const normalized = semver.valid(semver.coerce(raw));
  if (!normalized) return { cap: null, invalidValue: raw };
  return { cap: normalized, invalidValue: null };
}

export type UpdateCapGateDetail =
  | "current_at_or_above_cap"
  | "candidate_above_cap"
  | "cap_invalid"
  | "version_unparseable";

export interface UpdateCapGateResult {
  gated: boolean;
  detail?: UpdateCapGateDetail;
}

const NOT_GATED: UpdateCapGateResult = { gated: false };

/** cap 生效前提下版本不可解析 → 无法证明未超 cap，保守按 capped 处理。 */
function gateUnparseable(cap: ResolvedUpdateVersionCap): UpdateCapGateResult {
  if (cap.invalidValue) return { gated: true, detail: "cap_invalid" };
  return { gated: true, detail: "version_unparseable" };
}

/** 当前版本 ≥ cap（或 cap/版本非法）→ 一律不发起更新检查。 */
export function evaluateCurrentVersionCap(input: {
  cap: ResolvedUpdateVersionCap;
  currentVersion: string;
}): UpdateCapGateResult {
  const { cap } = input;
  if (!cap.cap && !cap.invalidValue) return NOT_GATED;
  if (!cap.cap) return { gated: true, detail: "cap_invalid" };
  const current = semver.valid(semver.coerce(input.currentVersion.trim()));
  if (!current) return gateUnparseable(cap);
  return semver.gte(current, cap.cap)
    ? { gated: true, detail: "current_at_or_above_cap" }
    : NOT_GATED;
}

/** 候选版本 > cap（或不可解析）→ 忽略该候选，不进入下载/安装。 */
export function evaluateCandidateVersionCap(input: {
  cap: ResolvedUpdateVersionCap;
  candidateVersion: string;
}): UpdateCapGateResult {
  const { cap } = input;
  if (!cap.cap && !cap.invalidValue) return NOT_GATED;
  if (!cap.cap) return { gated: true, detail: "cap_invalid" };
  const candidate = semver.valid(semver.coerce(input.candidateVersion.trim()));
  if (!candidate) return gateUnparseable(cap);
  return semver.gt(candidate, cap.cap) ? { gated: true, detail: "candidate_above_cap" } : NOT_GATED;
}

/** dev 自定义 feed 覆盖（更新指针）校验：不可解析 → invalid_pointer 门控。 */
export function validateCustomUpdateFeedPointer(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export interface UpdateHostBusySignals {
  /** 活跃 agent 会话数（index.ts getRunningAgentSessionCount 接线；缺省按 0）。 */
  getRunningAgentSessionCount?: () => number;
  /** 任一窗口聚焦。 */
  hasFocusedWindow?: () => boolean;
  /** 系统空闲秒数（powerMonitor.getSystemIdleTime 语义）。 */
  getSystemIdleSeconds?: () => number;
}

export interface UpdateBusyThresholds {
  /** 系统空闲达到该秒数视为安静。 */
  idleQuietSeconds: number;
  /** 无聚焦窗口持续该毫秒数视为安静。 */
  unfocusedQuietMs: number;
  /** 相邻采样间隔超过该毫秒数视为「不在场」：不累计忙碌且清失焦计时。 */
  busyGapMaxMs: number;
  /** 忙碌累计达到该毫秒数后强制检查（长任务宿主不能永不更新）。 */
  busyForceCheckMs: number;
}

/** 移植自参考实现常量：idle 300s / 失焦 30s / 间隔窗 45min / 强制检查 2h。 */
export const DEFAULT_UPDATE_BUSY_THRESHOLDS: UpdateBusyThresholds = {
  idleQuietSeconds: 300,
  unfocusedQuietMs: 30_000,
  busyGapMaxMs: 2_700_000,
  busyForceCheckMs: 7_200_000,
};

/** 延迟后的重判间隔（unref 定时器由 autoUpdater 持有）。 */
export const UPDATE_BUSY_DEFER_RETRY_MS = 60_000;

export interface UpdateBusyDeferralDecision {
  /** true=推迟本次后台更新检查。 */
  defer: boolean;
  /** 本延迟 episode 的首次采样（结构化 busy_deferred 日志只在这一次记）。 */
  firstSighting: boolean;
  /** 忙碌累计满 2h，强制放行检查。 */
  forcedAfterBusy: boolean;
  /** 此前在延迟 episode 中，本次因安静恢复放行。 */
  quietAfterBusy: boolean;
  /** 累计忙碌分钟数（日志上下文）。 */
  busyMinutes: number;
}

interface BusyTrackerState {
  busyMs: number;
  lastSightingAt: number;
  unfocusedSince: number | null;
}

/**
 * 宿主忙碌感知延迟 tracker（纯状态机；定时器由 autoUpdater 持有）。
 * sample() 在每次后台检查（startup/poll/延迟重试）入口调用。
 */
export function createUpdateBusyDeferralTracker(options: {
  signals: UpdateHostBusySignals;
  thresholds?: UpdateBusyThresholds;
  now?: () => number;
}): {
  sample: () => UpdateBusyDeferralDecision;
  reset: () => void;
} {
  const thresholds = options.thresholds ?? DEFAULT_UPDATE_BUSY_THRESHOLDS;
  const now = options.now ?? Date.now;
  let state: BusyTrackerState | null = null;

  return {
    sample(): UpdateBusyDeferralDecision {
      const nowMs = now();
      const firstSighting = state === null;
      state ??= { busyMs: 0, lastSightingAt: nowMs, unfocusedSince: null };
      const gap = nowMs - state.lastSightingAt;
      if (gap > 0 && gap <= thresholds.busyGapMaxMs) {
        state.busyMs += gap;
      } else if (gap > thresholds.busyGapMaxMs) {
        // 长时间不在场（休眠/挂起）：这段间隔既不算忙碌，也不能把失焦计时接上。
        state.unfocusedSince = null;
      }
      state.lastSightingAt = nowMs;

      const focused = options.signals.hasFocusedWindow?.() === true;
      const agentSessions = Math.max(0, options.signals.getRunningAgentSessionCount?.() ?? 0);
      const idleSeconds = Math.max(0, options.signals.getSystemIdleSeconds?.() ?? 0);
      if (focused) {
        state.unfocusedSince = null;
      } else {
        state.unfocusedSince ??= nowMs;
      }
      const unfocusedQuiet =
        state.unfocusedSince !== null &&
        nowMs - state.unfocusedSince >= thresholds.unfocusedQuietMs;
      const quiet =
        (idleSeconds >= thresholds.idleQuietSeconds || unfocusedQuiet) && agentSessions === 0;
      const busyMinutes = Math.round(state.busyMs / 60_000);

      if (quiet) {
        return {
          defer: false,
          firstSighting,
          forcedAfterBusy: false,
          quietAfterBusy: !firstSighting,
          busyMinutes,
        };
      }
      if (state.busyMs >= thresholds.busyForceCheckMs) {
        return {
          defer: false,
          firstSighting,
          forcedAfterBusy: true,
          quietAfterBusy: false,
          busyMinutes,
        };
      }
      return {
        defer: true,
        firstSighting,
        forcedAfterBusy: false,
        quietAfterBusy: false,
        busyMinutes,
      };
    },
    reset(): void {
      // 检查真正放行后清空累计（与参考实现「check 启动即重置」一致）：
      // 下一轮延迟 episode 从首次采样重新计。
      state = null;
    },
  };
}
