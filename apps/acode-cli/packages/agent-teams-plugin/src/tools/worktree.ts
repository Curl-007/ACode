import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { TEAM_ID_PATTERN, TeamError, nowIso } from "../state/helpers.js";
import { mergeMemberWorktree } from "../worktree/manager.js";

/**
 * 成员工作树合并（SPEC-015）。队长专属，唯一合并入口：
 * 冲突不自动解决，主工作区脏/不在基线分支时拒绝；默认保留成员树。
 */

const mergeSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    member: z.string().min(1).max(31),
    method: z.enum(["merge", "squash"]).default("merge"),
    message: z.string().min(1).max(2000).optional(),
    cleanup: z.boolean().default(false),
  })
  .strict();

export const worktreeTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_merge_member_worktree",
    description:
      "Captain only. Merge a member's isolated worktree branch back into the team's base branch (SPEC-015). Uncommitted member changes are snapshotted onto the member branch first. Refuses dirty main workspaces, wrong checked-out branch, and conflicts; conflicts are reported, never auto-resolved. Idempotent when the branch has no unique commits. Pass cleanup:true to remove the tree/branch after a clean merge (unmerged or dirty trees are always kept).",
    schema: mergeSchema,
    memberAllowed: false,
    async handler(input, context): Promise<ToolResult> {
      const parsed = mergeSchema.parse(input);
      const team = context.resolveTeamContext(parsed.teamId);
      context.requireCaptain(team);
      const isolation = team.worktreeIsolation;
      if (!isolation?.enabled) {
        throw new TeamError(
          "worktree_disabled",
          `Team ${team.teamId} was created without worktree isolation; members work in the shared workspace.`,
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
      const merged = await mergeMemberWorktree({
        repoRoot: isolation.repoRoot,
        baseBranch: isolation.baseBranch,
        handle,
        method: parsed.method,
        ...(parsed.message ? { message: parsed.message } : {}),
        cleanup: parsed.cleanup,
      });
      // 幂等：alreadyMerged 也补写记录（崩溃窗口：合并已落地但状态未写盘）。
      context.store.writeTeam(team.teamId, (current) => {
        const target = current.members.find(
          (item) => item.name === member.name && item.status !== "removed",
        );
        if (!target?.worktree) return;
        target.worktree.status = "merged";
        target.worktree.mergedAt = nowIso();
        target.worktree.lastMergedCommit = merged.commit;
        if (merged.cleanup) {
          target.worktree.lastCleanup = {
            at: nowIso(),
            removed: merged.cleanup.removed,
            branchRemoved: merged.cleanup.branchRemoved,
            ...(merged.cleanup.keptReason ? { keptReason: merged.cleanup.keptReason } : {}),
            ...(merged.cleanup.error ? { error: merged.cleanup.error } : {}),
          };
        }
      });
      return {
        ok: true,
        teamId: team.teamId,
        member: member.name,
        branch: handle.branch,
        base_branch: isolation.baseBranch,
        method: parsed.method,
        commit: merged.commit,
        no_changes: merged.noChanges,
        already_merged: merged.alreadyMerged,
        ...(merged.cleanup ? { cleanup: merged.cleanup } : {}),
        notes: merged.alreadyMerged
          ? ["The member branch had no unique commits; nothing to merge."]
          : [
              "Merged. Review the main workspace; resolve any conflicts in the member worktree and deliver again.",
            ],
        ...context.identityWarning(),
      };
    },
  },
];
