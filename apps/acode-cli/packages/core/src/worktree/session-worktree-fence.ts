import { isAbsolute, normalize } from "node:path";
import {
  SESSION_WORKTREE_ENV_KEY,
  SESSION_WORKTREE_FENCE_ENV_KEY,
  SESSION_WORKTREE_FENCE_OFF_ENV_KEY,
  type SessionWorktreeFenceMode,
} from "@acode/contracts";
import { CoreErrorType, createCoreError } from "@acode/contracts";
import { normalizeForCompare } from "./session-worktree-paths.js";

/**
 * 会话 worktree 写围栏（specs/session-worktree-lifecycle.md R4）。
 *
 * 进程内注册表：enter 成功后绑定（worktree 路径 → 会话/仓库事实），path-policy 在
 * write 解析后查它做收敛判定，adapters 的执行缝经 buildSessionWorktreeFenceEnv 把
 * 边界 env 注入子进程。注册表按**归一化 worktree 路径**键控：多会话进程里各 runtime
 * 的 workingDirectory 天然分流，无需会话 id 参与查找（path-policy 拿不到会话身份）。
 *
 * 档位裁决（spec R4）：缺省 **warn + 遥测**（有界环形缓冲，不 console 刷屏）；
 * enforce 只在 env 显式选择时生效，拒绝走既有 permission 语义（PermissionDenied
 * CoreError，recoverable），不另造审批面。`ACODE_SESSION_WORKTREE_FENCE_OFF` 是
 * E2E/测试逃生舱：只停围栏判定，不停绑定事实（lookup 仍回答「这是受管 worktree」，
 * enter/merge/reap 的生命周期不受影响）。
 */

export interface SessionWorktreeFenceBinding {
  sessionId: string;
  repoFingerprint: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  /** enter 时用户 checkout 所在的分支（detached 起源缺席）；merge 的 source_branch 用。 */
  sourceBranch?: string;
  boundAt: number;
  lastActivityAt: number;
}

interface FenceRegistryEntry extends SessionWorktreeFenceBinding {
  lastFlushedAt: number;
  canonicalWorktree: string;
  canonicalRepoRoot: string;
  lexicalWorktree: string;
  lexicalRepoRoot: string;
  timer?: ReturnType<typeof setInterval>;
  flushTouch?: () => Promise<void>;
}

export interface SessionWorktreeFenceViolation {
  worktreePath: string;
  repoRoot: string;
  targetPath: string;
  fenceMode: "warn" | "enforce";
  at: number;
}

export type SessionWorktreeFenceWarnSink = (
  message: string,
  details: Record<string, unknown>,
) => void;

const MAX_VIOLATION_RECORDS = 64;
const DEFAULT_TOUCH_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

const entries: FenceRegistryEntry[] = [];
const violations: SessionWorktreeFenceViolation[] = [];
let violationCount = 0;
let warnSink: SessionWorktreeFenceWarnSink | undefined;

function lexicalNormalize(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isInsideOrEqualLexical(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(`${parent}${pathSeparator()}`);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  const explicit = value?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

/** 围栏档位解析：off 开关 > 显式 enforce > 缺省 warn（spec R4）。 */
export function resolveSessionWorktreeFenceMode(
  env: NodeJS.ProcessEnv = process.env,
): SessionWorktreeFenceMode {
  if (isTruthyEnvValue(env[SESSION_WORKTREE_FENCE_OFF_ENV_KEY])) return "off";
  const explicit = env[SESSION_WORKTREE_FENCE_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "enforce") return "enforce";
  return "warn";
}

export interface BindSessionWorktreeFenceOptions {
  /** 心跳落台账的异步回调（enter 接 ledger.touch）；缺席则只更新进程内活动时刻。 */
  flushTouch?: () => Promise<void>;
  flushIntervalMs?: number;
  now?: () => number;
}

export function bindSessionWorktreeFence(
  binding: Omit<SessionWorktreeFenceBinding, "boundAt" | "lastActivityAt">,
  options: BindSessionWorktreeFenceOptions = {},
): SessionWorktreeFenceBinding {
  const now = options.now ?? Date.now;
  unbindSessionWorktreeFence({ worktreePath: binding.worktreePath });
  const at = now();
  const entry: FenceRegistryEntry = {
    ...binding,
    boundAt: at,
    lastActivityAt: at,
    lastFlushedAt: at,
    canonicalWorktree: normalizeForCompare(binding.worktreePath),
    canonicalRepoRoot: normalizeForCompare(binding.repoRoot),
    lexicalWorktree: lexicalNormalize(binding.worktreePath),
    lexicalRepoRoot: lexicalNormalize(binding.repoRoot),
    ...(options.flushTouch ? { flushTouch: options.flushTouch } : {}),
  };
  if (entry.flushTouch) {
    const flushTouch = entry.flushTouch;
    const timer = setInterval(() => {
      // 心跳节流（spec R3）：只有活动时刻推进过才落 touch；失败只走 warn sink，
      // 绝不让心跳故障打断工具链路。
      if (entry.lastActivityAt <= entry.lastFlushedAt) return;
      entry.lastFlushedAt = entry.lastActivityAt;
      void flushTouch().catch((error: unknown) => {
        warnSink?.("session worktree touch flush failed", {
          error: error instanceof Error ? error.message : String(error),
          module: "core.worktree",
        });
      });
    }, options.flushIntervalMs ?? DEFAULT_TOUCH_FLUSH_INTERVAL_MS);
    timer.unref?.();
    entry.timer = timer;
  }
  entries.push(entry);
  return toPublicBinding(entry);
}

export function unbindSessionWorktreeFence(selector: {
  worktreePath?: string;
  sessionId?: string;
}): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const matchesPath =
      selector.worktreePath !== undefined &&
      (entry.lexicalWorktree === lexicalNormalize(selector.worktreePath) ||
        entry.canonicalWorktree === normalizeForCompare(selector.worktreePath));
    const matchesSession =
      selector.sessionId !== undefined && entry.sessionId === selector.sessionId;
    if (!matchesPath && !matchesSession) continue;
    if (entry.timer) clearInterval(entry.timer);
    entries.splice(index, 1);
  }
}

function toPublicBinding(entry: FenceRegistryEntry): SessionWorktreeFenceBinding {
  return {
    sessionId: entry.sessionId,
    repoFingerprint: entry.repoFingerprint,
    repoRoot: entry.repoRoot,
    worktreePath: entry.worktreePath,
    branch: entry.branch,
    ...(entry.sourceBranch === undefined ? {} : { sourceBranch: entry.sourceBranch }),
    boundAt: entry.boundAt,
    lastActivityAt: entry.lastActivityAt,
  };
}

function lookupEntry(workingDirectory: string): FenceRegistryEntry | undefined {
  if (entries.length === 0) return undefined;
  const lexical = lexicalNormalize(workingDirectory);
  const lexicalHit = entries.find((entry) =>
    isInsideOrEqualLexical(lexical, entry.lexicalWorktree),
  );
  if (lexicalHit) return lexicalHit;
  // 词法未命中且注册表非空时才付 realpath 成本（8.3 短名/junction 形态差异，
  // 与 workflow 域 normalizeForCompare 同一实证依据）。
  const canonical = normalizeForCompare(workingDirectory);
  return entries.find((entry) => isInsideOrEqualLexical(canonical, entry.canonicalWorktree));
}

/**
 * 绑定事实查询（**不受 off 开关影响**——spec R4：关闭只停围栏判定，不停生命周期
 * 事实；merge/reap 用它在进程重启后从台账领养回绑定）。命中即推进活动时刻。
 */
export function lookupSessionWorktreeFenceBinding(
  workingDirectory: string,
): SessionWorktreeFenceBinding | undefined {
  const entry = lookupEntry(workingDirectory);
  if (!entry) return undefined;
  entry.lastActivityAt = Date.now();
  return toPublicBinding(entry);
}

/** cwd/路径是否恰为某个受管 worktree（enter 的 already-in 判定、reap 的在绑保护）。 */
export function isSessionWorktreeFencedPath(path: string): boolean {
  if (entries.length === 0) return false;
  const lexical = lexicalNormalize(path);
  const canonical = normalizeForCompare(path);
  return entries.some(
    (entry) =>
      entry.lexicalWorktree === lexical ||
      entry.canonicalWorktree === canonical ||
      isInsideOrEqualLexical(lexical, entry.lexicalWorktree) ||
      isInsideOrEqualLexical(canonical, entry.canonicalWorktree),
  );
}

/**
 * path-policy 的写围栏判定（同步、纯内存 + 至多一次 realpath）：
 * 未绑定 → 放行；off → 放行；违规（目标在绑定 repoRoot 内且不在 worktree 内）→
 * warn 记录放行 / enforce 抛 PermissionDenied（recoverable，既有权限语义）。
 * 围栏只保护用户 checkout（spec R4 违规边界裁决），repoRoot 外维持现状语义。
 */
export function evaluateSessionWorktreeWriteFence(input: {
  workingDirectory: string;
  targetPath: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const entry = lookupEntry(input.workingDirectory);
  if (!entry) return;
  entry.lastActivityAt = Date.now();
  const mode = resolveSessionWorktreeFenceMode(input.env);
  if (mode === "off") return;
  if (!isFenceViolation(entry, input.targetPath)) return;
  const violation: SessionWorktreeFenceViolation = {
    worktreePath: entry.worktreePath,
    repoRoot: entry.repoRoot,
    targetPath: input.targetPath,
    fenceMode: mode,
    at: Date.now(),
  };
  violationCount += 1;
  violations.push(violation);
  if (violations.length > MAX_VIOLATION_RECORDS) violations.shift();
  warnSink?.("session worktree write fence violation", {
    fenceMode: mode,
    targetPath: violation.targetPath,
    worktreePath: violation.worktreePath,
    module: "core.worktree",
  });
  if (mode === "enforce") {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      `Session worktree write fence: this session is isolated in a managed worktree, so writes to the main checkout are refused (target: ${input.targetPath}). Write inside the worktree (${entry.worktreePath}) instead.`,
      {
        context: {
          fence: "session-worktree",
          fenceMode: mode,
          worktreePath: entry.worktreePath,
          repoRoot: entry.repoRoot,
          targetPath: input.targetPath,
        },
        recoverable: true,
      },
    );
  }
}

function isFenceViolation(entry: FenceRegistryEntry, targetPath: string): boolean {
  const lexicalTarget = lexicalNormalize(targetPath);
  const insideWorktree = isInsideOrEqualLexical(lexicalTarget, entry.lexicalWorktree);
  if (insideWorktree) return false;
  if (isInsideOrEqualLexical(lexicalTarget, entry.lexicalRepoRoot)) return true;
  if (!isAbsolute(targetPath)) return false;
  // 词法判「不在 repoRoot 内」时再做一次真实路径比对（8.3 短名/junction 可能让
  // 词法失配漏判）；realpath 失败回退词法结论（normalizeForCompare 内部已兜底）。
  const canonicalTarget = normalizeForCompare(targetPath);
  if (isInsideOrEqualLexical(canonicalTarget, entry.canonicalWorktree)) return false;
  return isInsideOrEqualLexical(canonicalTarget, entry.canonicalRepoRoot);
}

/**
 * adapters 执行缝的 provider 载荷（spec R4-2/R7-5）：cwd 命中绑定且围栏未关闭 →
 * 注入边界标记 + 档位；未命中或关闭 → 空对象（缝会删除名单内缺席键，防父进程
 * env 里的陈旧值漏给未绑定会话）。
 */
export function buildSessionWorktreeFenceEnv(
  workingDirectory: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!workingDirectory) return {};
  const mode = resolveSessionWorktreeFenceMode(env);
  if (mode === "off") return {};
  const entry = lookupEntry(workingDirectory);
  if (!entry) return {};
  entry.lastActivityAt = Date.now();
  return {
    [SESSION_WORKTREE_ENV_KEY]: entry.worktreePath,
    [SESSION_WORKTREE_FENCE_ENV_KEY]: mode === "enforce" ? "enforce" : "warn",
  };
}

/** warn 档遥测面：有界快照（诊断/后续设置面读取；键名避开保留闭集键 status）。 */
export function snapshotSessionWorktreeFenceViolations(): {
  total: number;
  recent: readonly SessionWorktreeFenceViolation[];
} {
  return { total: violationCount, recent: [...violations] };
}

/** 装配层可把 warn sink 接到 service logger（缺省 no-op，不 console 刷屏，spec R8）。 */
export function setSessionWorktreeFenceWarnSink(
  sink: SessionWorktreeFenceWarnSink | undefined,
): void {
  warnSink = sink;
}

/** 测试缝：立即结算所有到期心跳（不等 interval）。 */
export async function flushSessionWorktreeFenceTouchesForTest(): Promise<void> {
  for (const entry of entries) {
    if (!entry.flushTouch || entry.lastActivityAt <= entry.lastFlushedAt) continue;
    entry.lastFlushedAt = entry.lastActivityAt;
    await entry.flushTouch();
  }
}

/** 测试缝：清空注册表与遥测缓冲。 */
export function resetSessionWorktreeFenceForTest(): void {
  for (const entry of entries) {
    if (entry.timer) clearInterval(entry.timer);
  }
  entries.length = 0;
  violations.length = 0;
  violationCount = 0;
  warnSink = undefined;
}
