import { existsSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { TEAM_ID_PATTERN, TeamError, nowIso } from "../state/helpers.js";
import type { TaskCheckResult, TaskStatus } from "../state/types.js";
import { resolveAcceptanceAnchor } from "../state/acceptance-anchor.js";
import {
  CHECK_TIMEOUT_MS,
  MAX_CHECK_OUTPUT_BYTES,
  argvEquals,
  hasForbiddenTokenChars,
  normalizeArgv,
  parseVerifyDeclarations,
  resolveCommand,
  runBoundedCommand,
  type BoundedCommandResult,
  type ResolvedCommand,
} from "../worktree/exec.js";

/**
 * `agent_teams_run_checks`（R1.2，队长专属）：执行成员在 `verify` 中用 `$ ` 声明行
 * **精确声明过**的命令。声明与执行分离：命令必须在声明集内且逐项精确匹配，否则
 * `verify_required` 拒绝、**不执行**（fail-closed，负向断言可证）。
 *
 * 执行面：`execFile`（无 shell；Windows `.cmd`/`.bat` 走 exec.ts 的唯一 hop）、cwd 钉在成员
 * worktree 根、硬上限 600s / 实跑 480s、单流输出 ≤256KiB（超限整段丢弃 + 失步标记）。
 * 超时返回 `ok:true + timedOut:true`，**不是错误**（对齐 wait_for_work 的 ready:false）。
 *
 * 并发：声明 `manageOwnLock`（同 member-wait）——锁内解析 + 校验 + 计数 → 解锁执行 →
 * 再入锁写回结果。**绝不在持锁期等待命令**（否则卡死所有工具调用）。
 */

/** summary 有界文本上限（插件侧已截断并自标）。 */
const MAX_CHECK_SUMMARY_CHARS = 2000;

const runChecksSchema = z
  .object({
    teamId: z.string().regex(TEAM_ID_PATTERN).optional(),
    member: z.string().min(1).max(31),
    command: z.string().min(1).max(4000),
    /** 显式锚定 attempt（OQ-2 additive）；缺省按状态优先级现算当前锚定。 */
    attemptId: z.string().min(1).max(256).optional(),
  })
  .strict();

interface PreparedCheck {
  teamId: string;
  member: string;
  command: string;
  cwd: string;
  resolved: ResolvedCommand;
  attemptId: string;
  taskId: string;
  taskStatus: TaskStatus;
}

/** 有界、人读的检查摘要（exitCode + 输出尾部；超限自标）。 */
function buildCheckSummary(result: BoundedCommandResult): string {
  const head = [`exit ${result.exitCode}`, ...(result.timedOut ? ["timed out"] : [])].join(", ");
  const body = [result.stdout, result.stderr]
    .filter((stream): stream is string => typeof stream === "string")
    .join("\n")
    .trim();
  let text = body.length > 0 ? `${head}\n${body}` : head;
  if (result.truncated) {
    text = `${text}\n[output dropped: a stream exceeded ${MAX_CHECK_OUTPUT_BYTES} bytes]`;
  }
  if (text.length > MAX_CHECK_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_CHECK_SUMMARY_CHARS - 1)}…`;
  }
  return text;
}

/**
 * 锁内准备：解析团队 / 成员 / worktree / 锚点，校验声明匹配与命令字符集，解析可执行文件，
 * 并把调用计数 +1 落盘。任何不满足前置的分支都在这里 fail-closed（抛 TeamError，不执行）。
 */
function prepareCheck(
  context: import("./registry.js").ToolContext,
  parsed: { teamId?: string; member: string; command: string; attemptId?: string },
): PreparedCheck {
  const team = context.resolveTeamContext(parsed.teamId);
  context.requireCaptain(team);
  const isolation = team.worktreeIsolation;
  if (!isolation?.enabled) {
    throw new TeamError(
      "worktree_disabled",
      `Team ${team.teamId} was created without worktree isolation; there is no member worktree to run checks in.`,
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
  if (!existsSync(handle.path)) {
    throw new TeamError(
      "worktree_not_found",
      `Member ${member.name}'s worktree directory ${handle.path} does not exist.`,
    );
  }
  const tasks = context.store.readTasks(team.teamId);
  const anchor = resolveAcceptanceAnchor(tasks, member.name, parsed.attemptId);
  if (!anchor) {
    throw new TeamError(
      "stale_attempt",
      `Member ${member.name} holds no live task to check; the delivery you are holding is stale.`,
      { member: member.name },
    );
  }

  const declared = parseVerifyDeclarations(anchor.task.verify);
  const commandTokens = normalizeArgv(parsed.command);
  if (commandTokens.length === 0) {
    throw new TeamError("invalid_input", "The command is empty after normalization.", {
      requested: parsed.command,
    });
  }
  if (hasForbiddenTokenChars(commandTokens)) {
    throw new TeamError(
      "invalid_input",
      "The command contains shell metacharacters or wildcards, which the declared-command channel rejects.",
      { requested: parsed.command },
    );
  }
  const declaredText = declared.map((tokens) => tokens.join(" "));
  if (declared.length === 0) {
    throw new TeamError(
      "verify_required",
      `Task ${anchor.task.taskId} declares no runnable commands; verify must contain "$ <command>" lines.`,
      { declared: [], requested: parsed.command },
    );
  }
  const matches = declared.filter((tokens) => argvEquals(tokens, commandTokens));
  if (matches.length !== 1) {
    throw new TeamError(
      "verify_required",
      `Command "${parsed.command}" is not exactly one of the commands declared in verify. Run only declared commands, or have the member add the declaration.`,
      { declared: declaredText, requested: parsed.command },
    );
  }
  const resolved = resolveCommand(commandTokens);
  if (!resolved) {
    throw new TeamError(
      "invalid_input",
      `Executable "${commandTokens[0]}" could not be resolved on PATH (or as a given path).`,
      { requested: parsed.command },
    );
  }

  // 计数在解锁执行前落盘：命令即使卡死 / 崩溃也已消耗一次调用（EI-142 数据完整性）。
  context.store.writeTeam(team.teamId, (current) => {
    const runs = current.checkRuns ?? { total: 0, byMember: {} };
    runs.total += 1;
    runs.byMember[member.name] = (runs.byMember[member.name] ?? 0) + 1;
    current.checkRuns = runs;
  });

  return {
    teamId: team.teamId,
    member: member.name,
    command: parsed.command,
    cwd: handle.path,
    resolved,
    attemptId: anchor.attempt.id,
    taskId: anchor.task.taskId,
    taskStatus: anchor.task.status,
  };
}

/** 再入锁写回最近检查结果（团队计数 + 锚定任务 lastCheck）。写入失败不吞掉命令结果。 */
function writeBackCheck(
  context: import("./registry.js").ToolContext,
  prepared: PreparedCheck,
  executed: BoundedCommandResult,
): string[] {
  const notes: string[] = [];
  const check: TaskCheckResult = {
    attemptId: prepared.attemptId,
    command: prepared.command,
    exitCode: executed.exitCode,
    passed: executed.exitCode === 0 && !executed.timedOut && !executed.truncated,
    ...(executed.truncated ? { truncated: true } : {}),
    summary: buildCheckSummary(executed),
    ranAt: nowIso(),
  };
  try {
    context.store.writeTeam(prepared.teamId, (current) => {
      const runs = current.checkRuns ?? { total: 0, byMember: {} };
      runs.lastAt = check.ranAt;
      runs.lastExitCode = executed.exitCode;
      current.checkRuns = runs;
    });
  } catch {
    notes.push("The team disappeared before the check result could be recorded.");
  }
  try {
    const task = context.store.readTask(prepared.teamId, prepared.taskId);
    if (task && task.activeAttemptId === prepared.attemptId) {
      context.store.writeTask(prepared.teamId, prepared.taskId, (target) => {
        target.lastCheck = check;
      });
    } else if (task) {
      notes.push(
        "The anchored attempt is no longer active; the check result was not recorded on the task.",
      );
    }
  } catch {
    notes.push("The task could not be updated with the check result.");
  }
  return notes;
}

export const runChecksTools: readonly ToolDefinition[] = [
  {
    name: "agent_teams_run_checks",
    description:
      "Captain only. Run one command the member declared in the task's verify field as a \"$ <command>\" line. The command must match exactly one declared line token-for-token (case-sensitive; no wildcards); otherwise it is refused with verify_required and never executed. Runs shell-free with cwd pinned to the member's worktree, an 8-minute timeout, and a 256KiB per-stream output cap (over-limit output is dropped whole with truncated/desync). A timeout returns ok:true + timedOut:true, not an error. Call counts and the latest result are recorded on the team state (the latest result is what the panel projects as the review's check). Anchors the member's task awaiting acceptance (in_review); fails with stale_attempt when it holds none.",
    schema: runChecksSchema,
    memberAllowed: false,
    manageOwnLock: true,
    async handler(input, context): Promise<ToolResult> {
      const parsed = runChecksSchema.parse(input);
      const prepared = await context.store.withLock(() => prepareCheck(context, parsed));
      const executed = await runBoundedCommand({
        command: prepared.resolved,
        cwd: prepared.cwd,
        timeoutMs: CHECK_TIMEOUT_MS,
        maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
      });
      const notes = await context.store.withLock(() =>
        writeBackCheck(context, prepared, executed),
      );
      if (executed.timedOut) {
        notes.push(
          `The command exceeded the ${CHECK_TIMEOUT_MS} ms limit and was killed; this is not an error. Rerun or narrow the declaration.`,
        );
      }
      if (executed.desync) {
        notes.push(
          "A stream exceeded the size limit and its output was dropped whole; exitCode is reported as observed.",
        );
      }
      if (prepared.resolved.viaShellHop) {
        notes.push(
          `Ran ${prepared.resolved.resolvedPath} via the cmd.exe /d /s /c hop (Windows script shim).`,
        );
      }
      return {
        ok: true,
        teamId: prepared.teamId,
        member: prepared.member,
        command: prepared.command,
        cwd: prepared.cwd,
        exitCode: executed.exitCode,
        timedOut: executed.timedOut,
        stdout: executed.stdout,
        stderr: executed.stderr,
        truncated: executed.truncated,
        desync: executed.desync,
        durationMs: executed.durationMs,
        task: {
          taskId: prepared.taskId,
          attemptId: prepared.attemptId,
          status: prepared.taskStatus,
        },
        notes,
        ...context.identityWarning(),
      };
    },
  },
];