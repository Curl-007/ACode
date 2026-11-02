import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { TEAM_ID_PATTERN, TeamError, nowIso } from "../state/helpers.js";
import { resolveAcceptanceAnchor } from "../state/acceptance-anchor.js";
import { describeGitFailure, runGit } from "../worktree/git.js";

/**
 * `agent_teams_review_member_diff`（R1.1，队长专属）：钉住「成员分支 base..head」的提交对，
 * 返回已解析的绝对 SHA + 有界文件清单 / 统计 / 补丁文本。
 *
 * 锚定：base 缺省 = 建树时的 `worktree.baseCommit`（**不用主仓库当前 HEAD 冒充**）；head
 * 缺省 = 成员分支当前 tip。成员 review 之后再提交 → head 变化；显式传旧 `headRef` → 可对
 * 「已固定的那次交付」复核，`headIsBranchTip: false` 告知审的不再是当前 tip（EI-1 不静默）。
 *
 * 上界（EI-97）：任意段超限即**整段丢弃 + 失步标记**，绝不从中间截断结构化流。
 * 全部 git 调用走既有 `worktree/git.ts` 的 runGit（execFile、无 shell、60s 超时）。
 */

/** 补丁文本上限（超出整段丢弃）。 */
export const MAX_DIFF_BYTES = 256 * 1024;
/** 文件清单条数上限（超出整段丢弃）。 */
export const MAX_DIFF_FILES = 1000;
/** 统计文本上限（超出整段丢弃）。 */
export const MAX_STAT_BYTES = 64 * 1024;

const reviewDiffSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    member: z.string().min(1).max(31),
    baseRef: z.string().min(1).max(256).optional(),
    headRef: z.string().min(1).max(256).optional(),
    statOnly: z.boolean().default(false),
    /** 显式锚定 attempt（OQ-2 additive）；缺省按状态优先级现算当前锚定。 */
    attemptId: z.string().min(1).max(256).optional(),
  })
  .strict();

export interface DiffFileChange {
  /** `git diff --name-status` 的状态码（M/A/D/R100/C75…）。 */
  status: string;
  path: string;
  originalPath?: string;
}

/** 按 `--name-status` 输出解析文件条目（R/C 有旧路径列的则带上）。 */
export function parseNameStatus(stdout: string): DiffFileChange[] {
  const changes: DiffFileChange[] = [];
  for (const line of stdout.replace(/\r\n/gu, "\n").split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (parts.length >= 3) {
      changes.push({ status, path: parts[2] ?? "", originalPath: parts[1] ?? "" });
    } else if (parts.length === 2) {
      changes.push({ status, path: parts[1] ?? "" });
    }
  }
  return changes;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 解析 ref 为绝对 commit SHA；失败返回原因（调用方报 invalid_input）。 */
async function resolveCommit(
  repoRoot: string,
  ref: string,
): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
  const resolved = await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || sha.length === 0) {
    return { ok: false, reason: describeGitFailure(`git rev-parse --verify ${ref}`, resolved) };
  }
  return { ok: true, sha };
}

export const reviewDiffTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_review_member_diff",
    description:
      "Captain only. Review a member's delivered commits between a pinned base and head. base defaults to the worktree's creation commit (never the main workspace's current HEAD); head defaults to the member branch's current tip, and an explicit headRef lets you re-review an earlier delivery. Returns resolved absolute SHAs plus a bounded file list, --stat summary and patch text (statOnly:true skips the patch). Any section over its limit is dropped whole with truncated/desync set (never cut mid-stream). Anchors the member's task awaiting acceptance (in_review) and fails with stale_attempt when it holds none.",
    schema: reviewDiffSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = reviewDiffSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const isolation = team.worktreeIsolation;
      if (!isolation?.enabled) {
        throw new TeamError(
          "worktree_disabled",
          `Team ${team.teamId} was created without worktree isolation; there is no member branch to review.`,
        );
      }
      const member = team.members.find(
        (item) => item.name === parsed.member && item.status !== "removed",
      );
      if (!member) {
        throw new TeamError("member_not_found", `Member ${parsed.member} is not in the roster.`);
      }
      const handle = member.worktree;
      if (!handle) {
        throw new TeamError(
          "worktree_not_found",
          `Member ${member.name} has no recorded worktree. Add the member after enabling isolation.`,
        );
      }
      // 锚点从磁盘现算：成员被 reassign / 任务已终结 / 成员持有活 attempt 之外 → stale_attempt。
      const tasks = context.store.readTasks(team.teamId);
      const anchor = resolveAcceptanceAnchor(tasks, member.name, parsed.attemptId);
      if (!anchor) {
        throw new TeamError(
          "stale_attempt",
          `Member ${member.name} holds no live task to review; the delivery you are holding is stale.`,
          { member: member.name },
        );
      }

      const repoRoot = isolation.repoRoot;
      const notes: string[] = [];
      const baseRef = parsed.baseRef ?? handle.baseCommit;
      const baseResolved = await resolveCommit(repoRoot, baseRef);
      if (!baseResolved.ok) {
        throw new TeamError(
          "invalid_input",
          `baseRef "${baseRef}" cannot be resolved to a commit.`,
          { baseRef, reason: baseResolved.reason },
        );
      }
      const branchRef = `refs/heads/${handle.branch}`;
      const branchResolved = await resolveCommit(repoRoot, branchRef);
      const branchHeadCommit = branchResolved.ok ? branchResolved.sha : "";
      const headRef = parsed.headRef ?? branchRef;
      const headResolved = headRef === branchRef ? branchResolved : await resolveCommit(repoRoot, headRef);
      if (!headResolved.ok) {
        throw new TeamError(
          "invalid_input",
          `headRef "${headRef}" cannot be resolved to a commit.`,
          { headRef, reason: headResolved.reason },
        );
      }
      const baseCommit = baseResolved.sha;
      const headCommit = headResolved.sha;
      const headIsBranchTip = branchHeadCommit.length > 0 && headCommit === branchHeadCommit;
      if (!branchResolved.ok) {
        notes.push(
          `The member branch ${handle.branch} no longer exists; branchHeadCommit is empty.`,
        );
      }
      if (!headIsBranchTip) {
        notes.push(
          "headCommit is not the member branch's current tip; you are reviewing a pinned earlier delivery.",
        );
      }

      let truncated = false;
      let desync = false;

      let files: DiffFileChange[] | null = null;
      const statusResult = await runGit(repoRoot, [
        "diff",
        "--name-status",
        baseCommit,
        headCommit,
      ]);
      if (statusResult.exitCode !== 0) {
        throw new TeamError(
          "invalid_input",
          describeGitFailure(`git diff --name-status ${baseCommit} ${headCommit}`, statusResult),
        );
      }
      const parsedFiles = parseNameStatus(statusResult.stdout);
      if (parsedFiles.length > MAX_DIFF_FILES) {
        truncated = true;
        desync = true;
        notes.push(
          `File list has ${parsedFiles.length} entries, over the ${MAX_DIFF_FILES} limit; dropped entire file list (desync).`,
        );
      } else {
        files = parsedFiles;
      }

      let stat: string | null = null;
      const statResult = await runGit(repoRoot, ["diff", "--stat", baseCommit, headCommit]);
      if (statResult.exitCode !== 0) {
        notes.push(describeGitFailure(`git diff --stat ${baseCommit} ${headCommit}`, statResult));
      } else if (byteLength(statResult.stdout) > MAX_STAT_BYTES) {
        truncated = true;
        desync = true;
        notes.push(`Diff stat exceeds ${MAX_STAT_BYTES} bytes; dropped entire stat (desync).`);
      } else {
        stat = statResult.stdout;
      }

      let diff: string | null = null;
      if (!parsed.statOnly) {
        const diffResult = await runGit(repoRoot, ["diff", baseCommit, headCommit]);
        if (diffResult.exitCode !== 0) {
          notes.push(describeGitFailure(`git diff ${baseCommit} ${headCommit}`, diffResult));
        } else if (byteLength(diffResult.stdout) > MAX_DIFF_BYTES) {
          truncated = true;
          desync = true;
          notes.push(`Patch exceeds ${MAX_DIFF_BYTES} bytes; dropped entire patch (desync).`);
        } else {
          diff = diffResult.stdout;
        }
      } else {
        notes.push("statOnly:true; the patch text was not fetched.");
      }

      // 落盘本次钉住的坐标（面板 reviews[] 的 base/head 来源；panel-state 无 git IO，
      // 只能复用这里已解析的绝对 SHA）。仅在锚定 attempt 仍有效时写回（同锁段内恒有效，
      // 防御性校验避免把坐标贴到新交付上）。
      const recheck = context.store.readTask(team.teamId, anchor.task.taskId);
      if (recheck && recheck.activeAttemptId === anchor.attempt.id) {
        context.store.writeTask(team.teamId, anchor.task.taskId, (target) => {
          target.lastReview = {
            baseCommit,
            headCommit,
            ...(branchHeadCommit ? { branchHeadCommit } : {}),
            reviewedAt: nowIso(),
          };
        });
      }

      return {
        ok: true,
        teamId: team.teamId,
        member: member.name,
        branch: handle.branch,
        baseCommit,
        headCommit,
        branchHeadCommit,
        headIsBranchTip,
        files,
        stat,
        diff,
        truncated,
        desync,
        task: {
          taskId: anchor.task.taskId,
          attemptId: anchor.attempt.id,
          status: anchor.task.status,
        },
        notes,
        ...context.identityWarning(),
      };
    },
  },
];