export type AppShutdownKind = "normal" | "update-install";

// shutdownTasks.ts 显式依赖该形状（cleanupBudgetMs/watchdogDelayMs），导出类型面。
export interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
  // runShutdown 并行清理任务的总预算（specs/shutdown-keepawake-containment.md R2/R6）：
  // 到期即 abort 等待并把未完成 handler 记入 pending_handlers，不取消 handler 本身。
  // 必须覆盖同档 waitTimeoutMs 的 Host 进程屏障，否则屏障还没收口就先记超时。
  cleanupBudgetMs: number;
  // 清理证据落盘后的强制退出看门狗延迟（R3）：unref 计时，不阻止正常退出；
  // 到期事件循环仍存活 → 证据标记 watchdog_fired 后 forceExit(0)。
  watchdogDelayMs: number;
}

interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
  upgraded: boolean;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
  cleanupBudgetMs: 20_000,
  watchdogDelayMs: 15_000,
};

const WINDOWS_NORMAL_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // 普通退出仍给 Host 内部 3.5 秒进程树兜底留出执行时间，
  // 但不再承担更新前资源锁扫描所需的额外余量。
  forceKillDelayMs: 4_000,
  waitTimeoutMs: 4_500,
  cleanupBudgetMs: 12_000,
  watchdogDelayMs: 10_000,
};

export function resolveAppShutdownPolicy(
  kind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicy {
  if (platform === "win32" && kind === "normal") {
    return WINDOWS_NORMAL_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  // 更新安装的优先级只增不减：已创建的普通退出短 timer 不做破坏性重建，更新仍在
  // 现有屏障后 fail-open 进入资源扫描和安装器，保证“可能残留”不会升级成“无法更新”。
  const kind =
    activeKind === "update-install" || requestedKind === "update-install"
      ? "update-install"
      : "normal";
  return {
    kind,
    policy: resolveAppShutdownPolicy(kind, platform),
    upgraded: activeKind === "normal" && kind === "update-install",
  };
}
