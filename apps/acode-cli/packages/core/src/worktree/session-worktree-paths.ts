import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 会话 worktree 域的路径与命名原语（specs/session-worktree-lifecycle.md R2/R3）。
 *
 * 命名惯例与 workflow 域（cli-workflow/src/workflow-worktree-manager.ts）逐字对齐：
 * 分支前缀 `acode/session/`、slug 规则、`sha256(repoRoot)[:12]` 仓库指纹、tmp 命名
 * 空间落点。两个域靠命名空间前缀分域（spec R1），词汇一致即是互通。
 *
 * 落点裁决（spec R2）：worktree 目录放 os.tmpdir() 命名空间而不是 ~/.acode——
 * breaker.pathEscapeWrite 的豁免面只认 os.tmpdir() 与 scratchRoot，落 ~/.acode 会让
 * 隔离会话里每一笔 worktree 内写入都命中熔断弹审批。tmp 的易失性由 ledger 的
 * worktree-missing tombstone 兜住（目录没了分支还在，重进重挂）。
 */

/** 分支/目录名 slug：git ref 与文件系统双安全（与 workflow 域同款规则）。 */
export function sessionWorktreeSlug(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\.lock$/i, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "session" : slug;
}

/** 会话分支名：`acode/session/<slug>`（workflow 域是 `acode/workflow/...`，分域靠这个前缀）。 */
export function buildSessionBranchName(sessionIdOrName: string): string {
  return `acode/session/${sessionWorktreeSlug(sessionIdOrName)}`;
}

/**
 * 路径比对归一：真实路径 + Windows 大小写不敏感（与 workflow 域 normalizeForCompare
 * 同一裁决与同一实证依据——git 在 .git/worktrees 登记长名，宿主 %TEMP% 可能是 8.3
 * 短名，只做词法归一会把活 worktree 误判成残骸）。路径不存在时回退纯词法 resolve。
 */
export function normalizeForCompare(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    canonical = resolve(path);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** 仓库指纹：命名空间目录名（与 workflow 域同款 sha256[:12]）。 */
export function repoFingerprint(repoRoot: string): string {
  return createHash("sha256")
    .update(normalizeForCompare(repoRoot), "utf-8")
    .digest("hex")
    .slice(0, 12);
}

/** 缺省 tmp 命名空间根（与 workflow 域的 acode-workflow-worktrees 平级、互不侵犯）。 */
export function defaultSessionWorktreeTmpRoot(): string {
  return join(tmpdir(), "acode-session-worktrees");
}

/**
 * 台账数据根（spec R3）：镜像 core/src/ambient/usage-ledger.ts 的
 * defaultAmbientDataRootDir 优先级——core 不依赖 @acode/services，无法直接引用
 * getACodeDataRootDir，只能退到 env > HOME > homedir；装配/测试应显式传 dataRootDir。
 */
export function defaultSessionWorktreeDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ACODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir();
  return join(base, ".acode");
}

/** 台账文件：`<dataRoot>/cli/session-worktrees/ledger.jsonl`（追加式，先例 usage.jsonl）。 */
export function sessionWorktreeLedgerPath(dataRootDir: string): string {
  return join(dataRootDir, "cli", "session-worktrees", "ledger.jsonl");
}

/** 某仓库的会话 worktree 命名空间目录（调用方负责 mkdir；这里只做纯路径计算）。 */
export function sessionWorktreeNamespaceDir(tmpRoot: string, repoRoot: string): string {
  return join(tmpRoot, repoFingerprint(repoRoot));
}

/** 某会话在某仓库命名空间内的 worktree 目录。 */
export function sessionWorktreeDirFor(tmpRoot: string, repoRoot: string, slug: string): string {
  return join(sessionWorktreeNamespaceDir(tmpRoot, repoRoot), sessionWorktreeSlug(slug));
}
