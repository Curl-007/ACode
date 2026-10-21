// AgentTeams 成员工作树命名与归属判据（SPEC-015）。
//
// 与 CLI 工作流隔离（apps/acode-cli/.../isolated-worktree.ts）同源策略：
// 目录 `<repoRoot>/.acode/worktrees/<name>`、分支 `acode/wt/<name>`、不带 --force 删除。
// 只放纯函数，git 调用在 git.ts / manager.ts。
import { isAbsolute, join, relative, resolve } from "node:path";

export const WORKTREES_RELATIVE_DIR = join(".acode", "worktrees");
export const WORKTREES_EXCLUDE_PATTERN = "/.acode/worktrees/";
export const MEMBER_WORKTREE_BRANCH_PREFIX = "acode/wt/";

/** 非 [A-Za-z0-9_-] 折叠成 `-`；空串回退到 fallback。 */
function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/gu, "");
  return cleaned || fallback;
}

/** 工作树目录名与分支名共用同一段：`<teamId>-<member>-<8hex>`。 */
export function planMemberWorktreeName(teamId: string, memberName: string, suffix: string): string {
  const team = sanitizeSegment(teamId, "team");
  const member = sanitizeSegment(memberName, "member");
  const tail = sanitizeSegment(suffix, "00000000");
  return `${team}-${member}-${tail}`;
}

export function buildMemberWorktreeBranch(name: string): string {
  return `${MEMBER_WORKTREE_BRANCH_PREFIX}${name}`;
}

export function buildMemberWorktreePath(repoRoot: string, name: string): string {
  return join(repoRoot, WORKTREES_RELATIVE_DIR, name);
}

/** 归属判据用分支命名空间，不用路径代理：只有 acode/wt/ 前缀才算我们的分支。 */
export function isManagedWorktreeBranch(branch: string): boolean {
  return (
    branch.startsWith(MEMBER_WORKTREE_BRANCH_PREFIX) &&
    branch.length > MEMBER_WORKTREE_BRANCH_PREFIX.length
  );
}

function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 工作树目录必须严格位于 `<repoRoot>/.acode/worktrees/` 之下。
 * Windows 上 git 输出正斜杠、文件系统可能大小写不同，先 resolve 再折叠大小写。
 */
export function isManagedWorktreePath(repoRoot: string, path: string): boolean {
  const root = normalizeForCompare(join(repoRoot, WORKTREES_RELATIVE_DIR));
  const target = normalizeForCompare(path);
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
