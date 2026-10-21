import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@acode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

const STARTUP_AGENT_WARMUP_LIMIT = 3;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

function resolveStartupAgentWarmupTargets(
  settings: Pick<ReturnType<typeof appSettingsSchema.parse>, "recentProjects">,
  activeTarget: StartupWorkspaceWarmupTarget,
): StartupWorkspaceWarmupTarget[] {
  const candidates: StartupWorkspaceWarmupTarget[] = [
    activeTarget,
    ...(settings.recentProjects ?? []).map((workspacePath) => ({
      workspacePath,
    })),
  ];
  const seen = new Set<string>();
  const targets: StartupWorkspaceWarmupTarget[] = [];

  for (const candidate of candidates) {
    const workspaceKey = candidate.workspaceIdentity?.trim() || candidate.workspacePath;
    if (!workspaceKey || seen.has(workspaceKey)) {
      continue;
    }
    seen.add(workspaceKey);
    targets.push(candidate);
    if (targets.length === STARTUP_AGENT_WARMUP_LIMIT) {
      break;
    }
  }

  return targets;
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

// ── WI-E4：内存压力下的预热让路（apps/acode-cli/specs/cli-governor.md R8） ──
// desktop 与 CLI governor 跨进程，不转发压力信号（spec 非目标 #1）；本钩子按
// 同阈值（5%/2%）本地裁决：压力时只保留 primary target（活动窗口 workspace，
// 对齐「user spawn 永不阻塞」哲学），其余预热让路——用户切到对应项目时走
// 既有冷启动路径。

/** free-ratio warning 阈值：5%（与 cli-governor spec R5 缺省一致）。 */
export const WARMUP_PRESSURE_WARNING_RATIO = 0.05;
/** free-ratio critical 阈值：2%（与 cli-governor spec R5 缺省一致）。 */
export const WARMUP_PRESSURE_CRITICAL_RATIO = 0.02;
/** per-level 日志抑制窗：60s（防多窗口反复 spawn 刷屏，spec R8）。 */
export const WARMUP_PRESSURE_LOG_SUPPRESSION_MS = 60_000;

export type WarmupPressureLevel = "warning" | "critical";

interface SystemMemoryInfoLike {
  total: number;
  free: number;
  swapTotal?: number;
  swapFree?: number;
}

/**
 * desktop 侧 free-ratio 读取（spec R5 平台裁决）：Electron main
 * `process.getSystemMemoryInfo()`，ratio = min(free/total, swapFree/swapTotal)
 * ——swap 参与防「内存够但 swap 枯竭」误判（蓝本等价实现同款）。非 Electron
 * 环境（单测）返回 1（无压力）。读取抛错视为无压力（fail-open：预热是优化，
 * 不是正确性面）。
 */
export function getDesktopFreeMemoryRatio(): number {
  try {
    const reader = (process as { getSystemMemoryInfo?: () => SystemMemoryInfoLike | undefined })
      .getSystemMemoryInfo;
    const info = typeof reader === "function" ? reader.call(process) : undefined;
    if (!info || !(info.total > 0)) return 1;
    const ratio = info.free / info.total;
    if (info.swapTotal && info.swapFree !== undefined) {
      return Math.min(ratio, info.swapFree / info.swapTotal);
    }
    return ratio;
  } catch {
    return 1;
  }
}

/** free-ratio → level 纯判定（阈值与 cli-governor spec R5 缺省一致）。 */
export function evaluateWarmupPressureLevel(freeMemoryRatio: number): WarmupPressureLevel | null {
  if (!Number.isFinite(freeMemoryRatio)) return null;
  if (freeMemoryRatio < WARMUP_PRESSURE_CRITICAL_RATIO) return "critical";
  if (freeMemoryRatio < WARMUP_PRESSURE_WARNING_RATIO) return "warning";
  return null;
}

const lastWarmupPressureLogAt: Record<WarmupPressureLevel, number> = { warning: 0, critical: 0 };

/** 测试隔离：清 per-level 日志抑制计时。 */
export function resetWarmupPressureLogSuppressionForTest(): void {
  lastWarmupPressureLogAt.warning = 0;
  lastWarmupPressureLogAt.critical = 0;
}

/**
 * 预热让路过滤（spec R8）：无压力/空/单 target → 原样；warning/critical →
 * 只留第 0 个（primary），其余 yield。per-level 60s 日志抑制。
 */
export function applyMemoryPressureToWarmupTargets(
  targets: readonly StartupWorkspaceWarmupTarget[] | undefined,
  deps: {
    getFreeMemoryRatio?: () => number;
    logger?: StartupWorkspaceLogger;
    now?: () => number;
  } = {},
): readonly StartupWorkspaceWarmupTarget[] | undefined {
  if (targets === undefined) return undefined;
  if (targets.length <= 1) return targets;
  const ratio = (deps.getFreeMemoryRatio ?? getDesktopFreeMemoryRatio)();
  const level = evaluateWarmupPressureLevel(ratio);
  if (level === null) return targets;
  const now = (deps.now ?? Date.now)();
  if (now - lastWarmupPressureLogAt[level] >= WARMUP_PRESSURE_LOG_SUPPRESSION_MS) {
    lastWarmupPressureLogAt[level] = now;
    deps.logger?.warn?.(
      `[startup-workspace] memory pressure (${level}, free ratio ${ratio.toFixed(3)}): yielding ${targets.length - 1} warmup target(s), keeping primary`,
    );
  }
  // noUncheckedIndexedAccess：length 守卫不能收窄下标类型，解构后显式判空。
  const [primary] = targets;
  if (primary === undefined) return targets;
  return [primary];
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
      sessions,
      settings.lastActiveTabIndex,
    );
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // 被动 sessions-index 全量恢复不能再启动全部 workspace，但只预热当前一个又让
      // 用户在最近项目间切换重新承担完整冷启动。Main 在唯一启动边界固定选出最近 3 个，
      // Host 仍走原 initializeWorkspace 路径；失败不继续扫描第 4 个补位。
      const agentWarmupTargets = resolveStartupAgentWarmupTargets(settings, {
        workspacePath: activeSession.workspacePath,
      });
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 ACodeProject。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
