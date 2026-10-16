// keep-awake 认领台账（specs/shutdown-keepawake-containment.md R8-R13）。
// 命名 claim 集合（turn/background_task/loop，按会话 id 细分）+ 单一 powerSaveBlocker
// 引用计数。策略门（总开关/电池/2h 上限）任一变化都收敛到 reconcile() 这一个 blocker
// 写路径；总开关关闭时 claim 照记但显式日志「recorded but not applied」；终结态闭集
// {close,error,stopped,paused,archived,deleted} 释放该会话全部 claim；away-ms 计量在
// claims 非空期间周期采样 getSystemIdleTime()，clamp 到 claim 持有窗口。
// 本文件不 import electron：blocker/powerMonitor 经 deps 端口注入，index.ts 是唯一
// Electron 接触点（installKeepAwakeClaims 替换 :252-270 布尔逻辑）。

export const KEEP_AWAKE_CLAIM_KINDS = ["turn", "background_task", "loop"] as const;
export type KeepAwakeClaimKind = (typeof KEEP_AWAKE_CLAIM_KINDS)[number];

/** 会话终结态闭集：只有这些状态触发释放，未知状态拒绝并 warn（R10）。 */
export const KEEP_AWAKE_SESSION_TERMINAL_STATES = [
  "close",
  "error",
  "stopped",
  "paused",
  "archived",
  "deleted",
] as const;
export type KeepAwakeSessionTerminalState = (typeof KEEP_AWAKE_SESSION_TERMINAL_STATES)[number];

/** loop/background_task 类 claim 的连续持有上限（R9.3），turn 不过期。 */
const KEEP_AWAKE_CLAIM_CAP_MS = 2 * 60 * 60 * 1000;
/** away-ms 采样周期（R11）。 */
const KEEP_AWAKE_AWAY_SAMPLE_INTERVAL_MS = 60_000;
const SESSION_ID_LOG_MAX_LENGTH = 64;
const BLOCKER_TYPE = "prevent-app-suspension";

export interface KeepAwakeClaimsLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface KeepAwakePowerSaveBlockerPort {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export interface KeepAwakePowerMonitorPort {
  on(event: "on-ac" | "on-battery", listener: () => void): void;
  off(event: "on-ac" | "on-battery", listener: () => void): void;
  /** 系统空闲秒数；异常/非法值按不可用处理。 */
  getSystemIdleTime(): number;
  isOnBatteryPower(): boolean;
}

export interface KeepAwakeClaimsDeps {
  logger: KeepAwakeClaimsLogger;
  powerSaveBlocker: KeepAwakePowerSaveBlockerPort;
  powerMonitor: KeepAwakePowerMonitorPort;
  /** 总开关唯一真值来源（现有 keepAwakeWhileRunning 设置），控制器不复制该状态。 */
  getMasterSwitch: () => boolean;
  /** 电池策略门：true/缺省 = 电池下也允许 applied（与现有全局布尔行为一致）。 */
  getBatteryPolicy?: () => boolean;
  /** 单调时钟，默认 performance.now。 */
  now?: () => number;
  claimCapMs?: number;
  awaySampleIntervalMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface KeepAwakeClaimSnapshotEntry {
  key: string;
  claim_kind: KeepAwakeClaimKind;
  session_id: string;
  held_ms: number;
  max_away_ms: number;
}

export interface KeepAwakeClaimsSnapshot {
  claims: KeepAwakeClaimSnapshotEntry[];
  blocker_id: number | null;
  applied: boolean;
  suppressed_reason: string | null;
  on_battery: boolean;
}

export interface KeepAwakeClaimsController {
  /** 认领一个 claim；返回幂等释放函数。重复认领同 key 不重置持有窗口。 */
  acquire(kind: KeepAwakeClaimKind, sessionId: string): () => void;
  release(kind: KeepAwakeClaimKind, sessionId: string): void;
  /** 终结态闭集之一到达时释放该会话全部 claim；未知状态不释放并 warn。 */
  releaseSession(sessionId: string, state: string): void;
  /** 策略门变化（设置/电源事件/采样）后的唯一重估入口。 */
  reconcile(reason: string): void;
  getSnapshot(): KeepAwakeClaimsSnapshot;
  dispose(): void;
}

interface ClaimEntry {
  kind: KeepAwakeClaimKind;
  sessionId: string;
  key: string;
  /** 单调时钟下的持有起点；away clamp 与 2h 上限都以它为准。 */
  since: number;
  maxAwayMs: number;
  capTimer?: ReturnType<typeof setTimeout>;
}

function sanitizeForLog(value: string): string {
  // 会话 id 进日志前做封闭字符集收敛，防止把任意文本/凭据带进日志面。
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return cleaned.length > SESSION_ID_LOG_MAX_LENGTH
    ? `${cleaned.slice(0, SESSION_ID_LOG_MAX_LENGTH)}…`
    : cleaned;
}

function isKeepAwakeClaimKind(value: string): value is KeepAwakeClaimKind {
  return (KEEP_AWAKE_CLAIM_KINDS as readonly string[]).includes(value);
}

function isKeepAwakeSessionTerminalState(value: string): value is KeepAwakeSessionTerminalState {
  return (KEEP_AWAKE_SESSION_TERMINAL_STATES as readonly string[]).includes(value);
}

export function installKeepAwakeClaims(deps: KeepAwakeClaimsDeps): KeepAwakeClaimsController {
  const now = deps.now ?? (() => performance.now());
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const claimCapMs = deps.claimCapMs ?? KEEP_AWAKE_CLAIM_CAP_MS;
  const awaySampleIntervalMs = deps.awaySampleIntervalMs ?? KEEP_AWAKE_AWAY_SAMPLE_INTERVAL_MS;
  const claims = new Map<string, ClaimEntry>();
  let blockerId: number | null = null;
  let samplerTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function isOnBattery(): boolean {
    try {
      return deps.powerMonitor.isOnBatteryPower();
    } catch {
      // 电源状态查询失败按「在交流电上」处理：宁可继续 applied 也不误杀用户显式开启的保持唤醒。
      return false;
    }
  }

  /** 压制原因（R9）：null = 允许 applied。 */
  function suppressedReason(): string | null {
    if (!deps.getMasterSwitch()) {
      return "setting_off";
    }
    if (isOnBattery() && deps.getBatteryPolicy?.() === false) {
      return "on_battery";
    }
    return null;
  }

  function claimKeys(): string[] {
    return [...claims.keys()];
  }

  function sampleAway(): void {
    let idleMs: number | undefined;
    try {
      const idleSeconds = deps.powerMonitor.getSystemIdleTime();
      idleMs = Number.isFinite(idleSeconds) && idleSeconds >= 0 ? idleSeconds * 1000 : undefined;
    } catch {
      idleMs = undefined;
    }
    if (idleMs === undefined) {
      return;
    }
    const current = now();
    for (const entry of claims.values()) {
      // clamp 到 claim 持有窗口：认领前累积的系统空闲不算到该 claim 头上（R11）。
      entry.maxAwayMs = Math.max(entry.maxAwayMs, Math.min(idleMs, current - entry.since));
    }
  }

  function ensureSampler(): void {
    if (claims.size > 0 && samplerTimer === null) {
      samplerTimer = setIntervalFn(() => {
        sampleAway();
      }, awaySampleIntervalMs);
      samplerTimer.unref?.();
    } else if (claims.size === 0 && samplerTimer !== null) {
      clearIntervalFn(samplerTimer);
      samplerTimer = null;
    }
  }

  /** 唯一 blocker 停用出口：id 可能已被系统回收，异常吞掉。 */
  function stopBlocker(): number | null {
    if (blockerId === null) {
      return null;
    }
    const stoppedId = blockerId;
    blockerId = null;
    try {
      deps.powerSaveBlocker.stop(stoppedId);
    } catch {
      // 忽略：id 可能已失效。
    }
    return stoppedId;
  }

  function reconcile(reason: string): void {
    if (disposed) {
      return;
    }
    const suppression = suppressedReason();
    const shouldApply = claims.size > 0 && suppression === null;
    const keys = claimKeys();
    if (shouldApply && blockerId === null) {
      try {
        blockerId = deps.powerSaveBlocker.start(BLOCKER_TYPE);
      } catch (error) {
        // start 失败（如 app ready 前调用）不能炸掉会话运行面；claim 台账保留，
        // 下次 reconcile 会重试。acquire 侧日志会显式标注 recorded but not applied。
        deps.logger.warn("[keep-awake] blocker start failed", {
          event: "keep_awake_blocker_start_failed",
          outcome: "start_failed",
          claims: keys,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        ensureSampler();
        return;
      }
      deps.logger.info(`[keep-awake] blocker started (id=${blockerId}, claims=${keys.join(",")})`, {
        event: "keep_awake_blocker_started",
        outcome: "applied",
        blocker_id: blockerId,
        claims: keys,
        on_battery: isOnBattery(),
        reason,
      });
    } else if (!shouldApply && blockerId !== null) {
      const stoppedId = stopBlocker();
      const outcome = claims.size === 0 ? "last_claim_released" : "suppressed";
      deps.logger.info(
        claims.size === 0
          ? `[keep-awake] blocker stopped (id=${stoppedId}): last claim released`
          : `[keep-awake] blocker stopped (id=${stoppedId}): suppressed by ${suppression} (claims kept: ${keys.join(",")})`,
        {
          event: "keep_awake_blocker_stopped",
          outcome,
          blocker_id: stoppedId,
          suppressed_reason: suppression,
          claims: keys,
          reason,
        },
      );
    }
    ensureSampler();
  }

  function releaseKey(key: string, outcome: string, extra?: Record<string, unknown>): boolean {
    const entry = claims.get(key);
    if (entry === undefined) {
      return false;
    }
    // 释放前先补一次采样，held/max_away 计量覆盖到最后一刻。
    sampleAway();
    if (entry.capTimer !== undefined) {
      clearTimeoutFn(entry.capTimer);
    }
    claims.delete(key);
    const heldMs = Math.round(now() - entry.since);
    deps.logger.info(
      `[keep-awake] claim ${key} released (${outcome}, held ${heldMs}ms, max away ${Math.round(entry.maxAwayMs)}ms)`,
      {
        event: "keep_awake_claim_released",
        outcome,
        claim_kind: entry.kind,
        session_id: sanitizeForLog(entry.sessionId),
        held_ms: heldMs,
        max_away_ms: Math.round(entry.maxAwayMs),
        ...extra,
      },
    );
    reconcile(`release:${outcome}`);
    return true;
  }

  const onPowerChange = (): void => {
    const onBattery = isOnBattery();
    deps.logger.info(`[keep-awake] power source changed (on_battery=${onBattery})`, {
      event: "keep_awake_power_changed",
      outcome: onBattery ? "on_battery" : "on_ac",
      claims: claimKeys(),
    });
    reconcile("power-source");
  };

  deps.powerMonitor.on("on-ac", onPowerChange);
  deps.powerMonitor.on("on-battery", onPowerChange);

  return {
    acquire(kind, sessionId) {
      if (!isKeepAwakeClaimKind(kind)) {
        // kind 是闭集：非法值属于编程错误，必须炸出来而不是静默记错账。
        throw new TypeError(`invalid keep-awake claim kind: ${String(kind)}`);
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new TypeError("keep-awake claim requires a non-empty session id");
      }
      const key = `${kind}:${sessionId}`;
      if (claims.has(key)) {
        // 重复认领幂等：不重置持有窗口（2h 上限按连续持有计）。
        return () => releaseKey(key, "released");
      }
      const sessionLog = sanitizeForLog(sessionId);
      const entry: ClaimEntry = { kind, sessionId, key, since: now(), maxAwayMs: 0 };
      if (kind !== "turn") {
        entry.capTimer = setTimeoutFn(() => {
          entry.capTimer = undefined;
          // loop/background_task 类 claim 到期自动下线，防止忘释放导致永久保持唤醒。
          deps.logger.warn(`[keep-awake] claim ${key} expired after cap`, {
            event: "keep_awake_claim_expired",
            outcome: "capped",
            claim_kind: kind,
            session_id: sessionLog,
            cap_ms: claimCapMs,
          });
          releaseKey(key, "capped");
        }, claimCapMs);
        entry.capTimer.unref?.();
      }
      claims.set(key, entry);
      reconcile("acquire");
      const applied = blockerId !== null;
      const suppression = suppressedReason();
      const message = applied
        ? `[keep-awake] claim ${key} acquired`
        : `[keep-awake] claim ${key} recorded but not applied: ${suppression ?? "blocker unavailable"}`;
      deps.logger.info(message, {
        event: "keep_awake_claim_acquired",
        outcome: applied ? "applied" : "recorded_but_not_applied",
        claim_kind: kind,
        session_id: sessionLog,
        suppressed_reason: suppression,
        claims: claimKeys(),
      });
      return () => releaseKey(key, "released");
    },
    release(kind, sessionId) {
      releaseKey(`${kind}:${sessionId}`, "released");
    },
    releaseSession(sessionId, state) {
      if (!isKeepAwakeSessionTerminalState(state)) {
        // 中间态/未知状态不释放：宁可多保持也不能把仍在跑的会话断掉（R10）。
        deps.logger.warn("[keep-awake] session release rejected: unknown terminal state", {
          event: "keep_awake_session_release_rejected",
          outcome: "unknown_state",
          session_id: sanitizeForLog(String(sessionId)),
          state: sanitizeForLog(String(state)),
        });
        return;
      }
      for (const key of claimKeys()) {
        const entry = claims.get(key);
        if (entry !== undefined && entry.sessionId === sessionId) {
          releaseKey(key, "session_terminal", { terminal_state: state });
        }
      }
    },
    reconcile(reason) {
      reconcile(reason);
    },
    getSnapshot() {
      const current = now();
      return {
        claims: [...claims.values()].map((entry) => ({
          key: entry.key,
          claim_kind: entry.kind,
          session_id: sanitizeForLog(entry.sessionId),
          held_ms: Math.round(current - entry.since),
          max_away_ms: Math.round(entry.maxAwayMs),
        })),
        blocker_id: blockerId,
        applied: blockerId !== null,
        suppressed_reason: suppressedReason(),
        on_battery: isOnBattery(),
      };
    },
    dispose() {
      disposed = true;
      deps.powerMonitor.off("on-ac", onPowerChange);
      deps.powerMonitor.off("on-battery", onPowerChange);
      if (samplerTimer !== null) {
        clearIntervalFn(samplerTimer);
        samplerTimer = null;
      }
      for (const entry of claims.values()) {
        if (entry.capTimer !== undefined) {
          clearTimeoutFn(entry.capTimer);
        }
      }
      claims.clear();
      stopBlocker();
    },
  };
}
