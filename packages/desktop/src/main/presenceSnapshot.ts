// presence 快照（specs/main-stall-diagnostics.md R10）：suspend / lock-screen /
// unlock-screen / resume / Session 状态（user-did-become-active）/ 窗口 focus
// 六事件总线 + 锁屏判定自愈 + 可空快照。
//
// 单一所有者纪律：tracker 是 presence 状态的唯一所有者，事件只能经 handleEvent
// 进入；接线侧（index.ts）不得另建第二份记录路径。系统源（powerMonitor 的三个
// getter）经接口注入，本文件不 import electron——与 desktopWebContentsGuard 同款
// 「裁决收敛在纯函数、接线只消费结果」纪律，node:test 可直接驱动。

/** presence 事件名闭集（内部名；接线映射见 POWER_MONITOR_EVENT_MAP / APP_FOCUS_EVENT）。 */
export const PRESENCE_EVENT_NAMES = [
  "suspend",
  "lock",
  "unlock",
  "resume",
  "session",
  "focus",
] as const;

export type PresenceEventName = (typeof PRESENCE_EVENT_NAMES)[number];

/** powerMonitor 事件名 → 内部事件名（attach 接线的映射事实源；session=用户回到活跃态）。 */
export const POWER_MONITOR_EVENT_MAP = {
  suspend: "suspend",
  "lock-screen": "lock",
  "unlock-screen": "unlock",
  resume: "resume",
  "user-did-become-active": "session",
} as const;

/** app 侧的 focus 事件名（browser-window-focus 覆盖所有窗口的聚焦）。 */
export const APP_FOCUS_EVENT = "browser-window-focus";

/** 快照字段名是任务契约（snake_case 日志键），缺失/异常一律 null 而非猜测。 */
export interface PresenceSnapshotPayload {
  seconds_since_resume: number | null;
  seconds_since_unlock: number | null;
  idle_seconds: number | null;
  locked: boolean | null;
  on_battery: boolean | null;
}

const NULL_PRESENCE_SNAPSHOT: PresenceSnapshotPayload = {
  seconds_since_resume: null,
  seconds_since_unlock: null,
  idle_seconds: null,
  locked: null,
  on_battery: null,
};

/** powerMonitor 的最小结构面（接线用真实 powerMonitor 适配，单测注入假源）。 */
export interface PresenceSystemSource {
  /** powerMonitor.getSystemIdleTime()：系统空闲秒数。 */
  getSystemIdleSeconds(): number;
  /** powerMonitor.getSystemIdleState(1) === "locked"。 */
  isScreenLockedBySystem(): boolean;
  /** powerMonitor.isOnBatteryPower()。 */
  isOnBatteryPower(): boolean;
}

export interface PresencePowerMonitorLike {
  on(event: "suspend", listener: () => void): unknown;
  on(event: "lock-screen", listener: () => void): unknown;
  on(event: "unlock-screen", listener: () => void): unknown;
  on(event: "resume", listener: () => void): unknown;
  on(event: "user-did-become-active", listener: () => void): unknown;
}

export interface PresenceAppLike {
  on(event: "browser-window-focus", listener: () => void): unknown;
}

export interface PresenceTracker {
  /** 唯一写入口：记录事件墙钟时刻并广播订阅者。未知事件名抛错（fail-closed）。 */
  handleEvent(name: PresenceEventName, atMs?: number): void;
  /** 六事件总线订阅面；返回退订函数。 */
  subscribe(listener: (name: PresenceEventName, atMs: number) => void): () => void;
  /** 一次性接线六事件（powerMonitor 五件 + app focus）；应用生命周期内常驻。 */
  attach(emitters: { powerMonitor: PresencePowerMonitorLike; app: PresenceAppLike }): void;
  /** 锁屏判定（含 stale lock 自愈，spec R10）。 */
  isScreenLocked(nowMs?: number): boolean;
  /** 快照：任一 getter 抛错 ⇒ 整体全 null（快照失败不得反杀调用方）。 */
  getSnapshot(nowMs?: number): PresenceSnapshotPayload;
}

export interface CreatePresenceTrackerOptions {
  /** 墙钟注入（默认 Date.now）；假时钟单测用。 */
  now?: () => number;
  /** 系统源缺席（如 app ready 前）时 idle/locked/on_battery 均为 null。 */
  system?: PresenceSystemSource | null;
  /** stale lock 自愈容差（默认 2000ms，spec R10）。 */
  staleLockToleranceMs?: number;
}

const DEFAULT_STALE_LOCK_TOLERANCE_MS = 2_000;

export function createPresenceTracker(options: CreatePresenceTrackerOptions = {}): PresenceTracker {
  const now = options.now ?? (() => Date.now());
  const system = options.system ?? null;
  const staleLockToleranceMs = options.staleLockToleranceMs ?? DEFAULT_STALE_LOCK_TOLERANCE_MS;

  /** 每事件最近一次墙钟时刻；lock 另维护 lockedAt 标志（unlock/自愈清除）。 */
  const eventAt = new Map<PresenceEventName, number>();
  let lockedAtMs: number | null = null;
  const listeners = new Set<(name: PresenceEventName, atMs: number) => void>();

  const secondsSince = (atMs: number | undefined, nowMs: number): number | null =>
    atMs === undefined ? null : Math.max(0, Math.round((nowMs - atMs) / 1_000));

  const handleEvent = (name: PresenceEventName, atMs?: number): void => {
    if (!(PRESENCE_EVENT_NAMES as readonly string[]).includes(name)) {
      // fail-closed：未知事件名是编程错误，静默吞掉会让总线退化成死数据。
      throw new TypeError(`[presence] unknown event name: ${String(name)}`);
    }
    const at = atMs ?? now();
    eventAt.set(name, at);
    if (name === "lock") lockedAtMs = at;
    if (name === "unlock") lockedAtMs = null;
    for (const listener of listeners) listener(name, at);
  };

  const isScreenLocked = (nowMs?: number): boolean => {
    const at = nowMs ?? now();
    if (lockedAtMs !== null && system) {
      // 锁屏自愈（spec R10）：unlock 事件可能丢失（Linux 显示管理器不发、跨睡眠
      // 锁屏等）。系统空闲时长证明「加锁之后有过用户活动」⇒ stale lock，清标志。
      try {
        const idleSeconds = system.getSystemIdleSeconds();
        if (
          Number.isFinite(idleSeconds) &&
          at - idleSeconds * 1_000 > lockedAtMs + staleLockToleranceMs
        ) {
          lockedAtMs = null;
        }
      } catch {
        // 系统源异常时保守保留 lockedAt（宁可误报锁屏，不可漏报）。
      }
    }
    if (lockedAtMs !== null) return true;
    if (!system) return false;
    try {
      return system.isScreenLockedBySystem();
    } catch {
      return false;
    }
  };

  return {
    handleEvent,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(emitters) {
      // 逐事件显式注册：powerMonitor 的 on 是逐事件重载面，union 事件名不匹配任何
      // 单一重载；显式列出也让「powerMonitor 事件名 → 内部事件名」映射可审。
      const { powerMonitor, app } = emitters;
      powerMonitor.on("suspend", () => handleEvent("suspend"));
      powerMonitor.on("lock-screen", () => handleEvent("lock"));
      powerMonitor.on("unlock-screen", () => handleEvent("unlock"));
      powerMonitor.on("resume", () => handleEvent("resume"));
      powerMonitor.on("user-did-become-active", () => handleEvent("session"));
      app.on(APP_FOCUS_EVENT, () => handleEvent("focus"));
    },
    isScreenLocked,
    getSnapshot(nowMs) {
      const at = nowMs ?? now();
      try {
        return {
          seconds_since_resume: secondsSince(eventAt.get("resume"), at),
          seconds_since_unlock: secondsSince(eventAt.get("unlock"), at),
          idle_seconds: system ? system.getSystemIdleSeconds() : null,
          locked: isScreenLocked(at),
          on_battery: system ? system.isOnBatteryPower() : null,
        };
      } catch {
        return { ...NULL_PRESENCE_SNAPSHOT };
      }
    },
  };
}

/**
 * 接线助手：用真实 electron powerMonitor 构造系统源（index.ts 一行接入）。
 * 传入的是结构面而非 import，保持本文件纯 Node。
 */
export function createPresenceSystemSource(powerMonitor: {
  getSystemIdleTime(): number;
  getSystemIdleState(thresholdSeconds: number): string;
  isOnBatteryPower(): boolean;
}): PresenceSystemSource {
  return {
    getSystemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    isScreenLockedBySystem: () => powerMonitor.getSystemIdleState(1) === "locked",
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
  };
}
