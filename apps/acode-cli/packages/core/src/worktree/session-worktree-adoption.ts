import { normalize } from "node:path";
import { SessionWorktreeLedger, type SessionWorktreeBinding } from "./session-worktree-ledger.js";
import {
  bindSessionWorktreeFence,
  type SessionWorktreeFenceBinding,
} from "./session-worktree-fence.js";
import { normalizeForCompare } from "./session-worktree-paths.js";

/**
 * 进程重启后的领养（specs/session-worktree-lifecycle.md R5 前置）：围栏注册表是
 * 进程内存，会话 resume 后 cwd 仍在受管 worktree 里但注册表已空——merge 等工具按
 * cwd 从台账找回绑定并重新入册（含心跳回调，跨进程收割保护立即恢复）。
 * 找不到 → undefined（调用方以闭集 reason 拒绝，不猜测）。
 */
export async function adoptLedgerBindingForCwd(
  cwd: string,
  deps: {
    ledger?: SessionWorktreeLedger;
    now?: () => number;
    fenceFlushIntervalMs?: number;
  } = {},
): Promise<SessionWorktreeFenceBinding | undefined> {
  const ledger = deps.ledger ?? new SessionWorktreeLedger();
  const bindings = await ledger.load();
  const separator = process.platform === "win32" ? "\\" : "/";
  const lexical = process.platform === "win32" ? normalize(cwd).toLowerCase() : normalize(cwd);
  const canonical = normalizeForCompare(cwd);
  let best: SessionWorktreeBinding | undefined;
  for (const binding of bindings) {
    if (binding.state !== "active" || binding.worktreePath === "") continue;
    const bindLexical =
      process.platform === "win32"
        ? normalize(binding.worktreePath).toLowerCase()
        : normalize(binding.worktreePath);
    const bindCanonical = normalizeForCompare(binding.worktreePath);
    const inside =
      lexical === bindLexical ||
      lexical.startsWith(`${bindLexical}${separator}`) ||
      canonical === bindCanonical ||
      canonical.startsWith(`${bindCanonical}${separator}`);
    if (!inside) continue;
    // 多条命中取最长路径（最具体的绑定）。
    if (!best || binding.worktreePath.length > best.worktreePath.length) best = binding;
  }
  if (!best) return undefined;
  const adopted = best;
  return bindSessionWorktreeFence(
    {
      sessionId: adopted.sessionId,
      repoFingerprint: adopted.repoFingerprint,
      repoRoot: adopted.repoRoot,
      worktreePath: adopted.worktreePath,
      branch: adopted.branch,
      ...(adopted.sourceBranch === undefined ? {} : { sourceBranch: adopted.sourceBranch }),
    },
    {
      flushTouch: () => ledger.touch(adopted.sessionId, adopted.repoFingerprint),
      ...(deps.fenceFlushIntervalMs === undefined
        ? {}
        : { flushIntervalMs: deps.fenceFlushIntervalMs }),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
}
