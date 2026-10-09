import type { DynamicWorkflowRunStopReason } from "@acode/contracts";
import type { TaskNotificationInput } from "./types.js";
import {
  escapeXml,
  escapeLocalBashXml,
  truncateTaskNotification,
} from "./notification-primitives.js";
export { escapeXml, truncateTaskNotification } from "./notification-primitives.js";
import { formatWorkflowProviderStopError } from "./workflow-notification-copy.js";

export {
  formatWorkflowEscalationNotification,
  formatWorkflowProviderStopError,
  formatWorkflowStallNotification,
  type WorkflowEscalationNotificationInput,
  type WorkflowStallNotificationInput,
} from "./workflow-notification-copy.js";

export function formatTaskNotification(input: TaskNotificationInput): string {
  if (input.taskType === "local_agent") {
    return formatLocalAgentTaskNotification(input);
  }
  if (input.taskType === "local_bash") {
    return formatLocalBashTaskNotification(input);
  }
  if (input.taskType === "local_workflow") {
    return formatLocalWorkflowTaskNotification(input);
  }

  const lines = ["<task-notification>", `  <task-id>${escapeXml(input.taskId)}</task-id>`];

  if (input.toolUseId) lines.push(`  <tool-use-id>${escapeXml(input.toolUseId)}</tool-use-id>`);
  lines.push(`  <task-type>${escapeXml(input.taskType)}</task-type>`);
  if (input.agentId) lines.push(`  <agent-id>${escapeXml(input.agentId)}</agent-id>`);
  if (input.subagentType) {
    lines.push(`  <subagent-type>${escapeXml(input.subagentType)}</subagent-type>`);
  }
  if (input.outputFile) lines.push(`  <output-file>${escapeXml(input.outputFile)}</output-file>`);
  if (input.stdoutFile) lines.push(`  <stdout-file>${escapeXml(input.stdoutFile)}</stdout-file>`);
  if (input.stderrFile) lines.push(`  <stderr-file>${escapeXml(input.stderrFile)}</stderr-file>`);
  lines.push(`  <status>${escapeXml(input.status)}</status>`);
  if (input.description) {
    lines.push(`  <description>${escapeXml(input.description)}</description>`);
  }
  lines.push(`  <summary>${escapeXml(input.summary)}</summary>`);
  if (input.result !== undefined) lines.push(`  <result>${escapeXml(input.result)}</result>`);
  if (input.error !== undefined) lines.push(`  <error>${escapeXml(input.error)}</error>`);
  const usage = formatUsage(input.usage);
  if (usage.length > 0) {
    lines.push("  <usage>", ...usage.map((line) => `    ${line}`), "  </usage>");
  }
  lines.push("</task-notification>");

  return truncateTaskNotification(lines.join("\n"));
}

function formatLocalBashTaskNotification(input: TaskNotificationInput): string {
  const lines = ["<task-notification>", `<task-id>${escapeLocalBashXml(input.taskId)}</task-id>`];
  if (input.toolUseId) {
    lines.push(`<tool-use-id>${escapeLocalBashXml(input.toolUseId)}</tool-use-id>`);
  }
  if (input.outputFile) {
    lines.push(`<output-file>${escapeLocalBashXml(input.outputFile)}</output-file>`);
  }
  lines.push(`<status>${escapeLocalBashXml(input.status)}</status>`);
  lines.push(`<summary>${escapeLocalBashXml(input.summary)}</summary>`);
  lines.push("</task-notification>");

  return lines.join("\n");
}

function formatLocalAgentTaskNotification(input: TaskNotificationInput): string {
  const lines = ["<task-notification>", `<task-id>${escapeXml(input.taskId)}</task-id>`];
  if (input.toolUseId) lines.push(`<tool-use-id>${escapeXml(input.toolUseId)}</tool-use-id>`);
  if (input.outputFile) lines.push(`<output-file>${escapeXml(input.outputFile)}</output-file>`);
  lines.push(`<status>${escapeXml(input.status)}</status>`);
  lines.push(`<summary>${escapeXml(input.summary)}</summary>`);
  if (input.result !== undefined) lines.push(`<result>${escapeXml(input.result)}</result>`);
  if (input.error !== undefined) lines.push(`<error>${escapeXml(input.error)}</error>`);

  const usage = formatLocalAgentUsage(input.usage);
  if (usage) lines.push(usage);
  lines.push("</task-notification>");

  return truncateTaskNotification(lines.join("\n"));
}

function formatLocalWorkflowTaskNotification(input: TaskNotificationInput): string {
  const lines = ["<task-notification>", `<task-id>${escapeXml(input.taskId)}</task-id>`];
  if (input.toolUseId) lines.push(`<tool-use-id>${escapeXml(input.toolUseId)}</tool-use-id>`);
  if (input.outputFile) lines.push(`<output-file>${escapeXml(input.outputFile)}</output-file>`);
  // dwf 的三个终态词优先于追踪器的通用词（legacy `Workflow` 不带 runStatus，逐字节不变）。
  lines.push(`<status>${escapeXml(input.runStatus ?? input.status)}</status>`);
  if (input.stopReason !== undefined) {
    lines.push(`<stop-reason>${escapeXml(input.stopReason)}</stop-reason>`);
  }
  if (input.description) {
    lines.push(`<description>${escapeXml(input.description)}</description>`);
  }
  lines.push(`<summary>${escapeXml(input.summary)}</summary>`);
  if (input.result !== undefined) lines.push(`<result>${escapeXml(input.result)}</result>`);
  // provider 停下：`<error>` 是一整块表驱动文案（多行）；其余终态照旧一句 message。
  const providerStopError =
    input.failure?.providerStop === undefined
      ? undefined
      : formatWorkflowProviderStopError(input.failure, input.taskId);
  if (providerStopError !== undefined) {
    // 块里有要让模型照抄的 `run_id="…"`：只转义 <>&，引号原样（与 bash 通知同一策略）。
    lines.push(`<error>\n${escapeLocalBashXml(providerStopError)}\n</error>`);
  } else if (input.error !== undefined) {
    lines.push(`<error>${escapeXml(input.error)}</error>`);
  }
  // 渐进产物排在 result / error **之后**：run 的收场是模型首先要读的，产物是补充材料。
  // 顺序也决定了 120k 总截断先斩谁——被斩掉的应该是这一节，而不是 run 的结果。
  if (input.reports !== undefined) {
    const shown =
      input.reports.shown < input.reports.count ? ` shown="${input.reports.shown}"` : "";
    lines.push(
      `<reports count="${input.reports.count}"${shown}>`,
      escapeXml(input.reports.preview),
      "</reports>",
    );
  }
  // 产物排在 `<reports>` **之后**：
  // 过程产物是正文，交付物清单是索引——用户已经在屏幕上看到卡片了，模型只需要知道有哪些、
  // 叫什么。这个顺序也决定了 120k 总截断先斩谁：先斩这一节。
  if (input.artifacts !== undefined) {
    const shown =
      input.artifacts.shown < input.artifacts.count ? ` shown="${input.artifacts.shown}"` : "";
    lines.push(
      `<artifacts count="${input.artifacts.count}"${shown}>`,
      escapeXml(input.artifacts.preview),
      "</artifacts>",
    );
  }
  lines.push("</task-notification>");
  // 呈现指引排在最后：120k 总截断先斩指引再斩
  // 产物——指引是补充材料，产物是正文。
  if (input.deliveryGuidance) {
    lines.push(
      "",
      workflowDeliveryGuidance({
        status: input.runStatus ?? input.status,
        stopReason: input.stopReason,
        hasArtifacts: input.artifacts !== undefined,
        runId: input.taskId,
        scriptPath: input.scriptPath,
      }),
    );
  }

  return truncateTaskNotification(lines.join("\n"));
}

/**
 * 终态通知末尾的呈现指引：告诉主代理把 run 的结果当交付物呈现，而不是转述 JSON。completed 走
 * 「结论 → 发现与证据 → 已验证 / 仅判断 → 未覆盖」的顺序；其余终态先呈现抢救出的 reports，再讲
 * 失败与下一步。顺序是对呈现的要求，不是对 result 结构的要求——脚本返回别的形态时指引仍成立。
 *
 * 三终态 × stopped 的五个 reason 各一支：
 * 下一步动作在每一支里都写死——`stopped` 里 `user` 是「不要动」、`superseded` 是「等后继」，
 * 其余三支都指向 `ResumeWorkflowRun`；`errored` 指向 `AmendWorkflow`。
 */
function workflowDeliveryGuidance(input: {
  status: string;
  stopReason: DynamicWorkflowRunStopReason | undefined;
  hasArtifacts: boolean;
  runId: string;
  scriptPath: string | undefined;
}): string {
  const { status, stopReason, hasArtifacts, scriptPath } = input;
  // 产物那一句只在 `<artifacts>` 节真的在场时追加：文案说的是「上面列出的产物」，一个没有
  // 产物的 run 收到它，等于被告知去引用一份不存在的清单。
  const artifactsSentence = hasArtifacts
    ? [
        "Artifacts listed above are already in front of the user as cards; refer to them by title and do not paste their contents. The one marked primary is the deliverable: point the user to it first.",
      ]
    : [];
  const artifactsShort = hasArtifacts
    ? ["Artifacts listed above are already in front of the user."]
    : [];
  if (status === "completed") {
    return [
      "The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.",
      "The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.",
      ...artifactsSentence,
      "Do not restate the phase graph or the script.",
    ].join("\n");
  }
  // 用户停的 run：这是一个决定，不是一次
  // 意外。对所有未完成态一律说「resumable as-is」会让模型把用户刚停的 run
  // 又续上了。
  if (stopReason === "user") {
    return [
      "The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.",
      "Present what it finished before it was stopped: the reported items above are finished findings — show them individually with their evidence. Then stop and wait for the user to say what happens next.",
      ...artifactsShort,
    ].join("\n");
  }
  if (stopReason === "model") {
    return [
      // 为改脚本而停的 run 要当场修订续跑：这句话不能只说
      // 「等用户开口再续」，模型把自己为修而停的 run 也搁下了——而缓存关门规则下，停得越早重付越少。
      // 有文件时多一句「编辑它、传 `path`」：这一支的整个论证就是「你是为改脚本才停的」，
      // 而改脚本最便宜的做法是 Edit 那个文件，不是把整份脚本再贴一遍。
      `You stopped this workflow with TaskStop. If you stopped it to fix the script, do that now: call AmendWorkflow with this run's ID and the corrected script — everything that settled before the stop is imported as cache, and the sooner the fix runs the less it re-pays. (Next time, amend the running run directly: AmendWorkflow stops it for you.)${
        scriptPath === undefined
          ? ""
          : ` Its script is at ${scriptPath}: edit that file and pass \`path\`.`
      }`,
      "Otherwise present what it finished: the reported items above are finished findings — show them individually with their evidence. Resume it unchanged only if that is what the user wants.",
      ...artifactsShort,
    ].join("\n");
  }
  if (stopReason === "provider") {
    return [
      "A provider-side error stopped this run; the <error> block above names the cause and the fix. Present what the run finished: the reported items above are finished findings — show them individually with their evidence.",
      `Then resolve the cause with the user before calling ResumeWorkflowRun with run_id="${input.runId}" — finished steps replay from the journal. Do not rebuild the workflow.`,
      ...artifactsShort,
    ].join("\n");
  }
  if (stopReason === "interrupted") {
    return [
      "The process that owned this run exited before it finished. Present what it finished: the reported items above are finished findings — show them individually with their evidence.",
      `Then call ResumeWorkflowRun with run_id="${input.runId}" — finished steps replay from the journal and only the unfinished ones run again.`,
      ...artifactsShort,
    ].join("\n");
  }
  if (stopReason === "superseded") {
    // 正常情况下到不了：superseded 的终态通知在 coordinator 处被压下。留这一支是为了老端口 /
    // stub 万一送达时不说错话——尤其不能说「resume it」。
    return [
      "This run was stopped because you amended it: a newer run supersedes it and is already running. Do not resume this run and do not amend it again; wait for the successor's notification.",
      ...artifactsShort,
    ].join("\n");
  }
  if (status === "stopped") {
    // reason 缺席（老端口 / stub）：只说「停了、可续」，不猜是谁停的。
    return [
      "This workflow was stopped before it finished. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence.",
      `It can be continued with ResumeWorkflowRun (run_id="${input.runId}"); ask the user before resuming a run you did not stop yourself.`,
      ...artifactsShort,
    ].join("\n");
  }
  if (status === "errored") {
    return [
      "The workflow script failed. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user's request.",
      ...artifactsShort,
      // 有文件就直接把那次编辑说清楚（路径 + `path` 参数 + 不要内联），没有文件才退回旧话。
      // 两句共用同一条 ResumeWorkflowRun 拒绝的交代——那与有没有文件无关。
      scriptPath === undefined
        ? `Fix the script and submit it with AmendWorkflow (run_id="${input.runId}") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way.`
        : `The run's script is at ${scriptPath}. Edit that file in place, then call AmendWorkflow (run_id="${input.runId}", path="${scriptPath}") so finished work is reused — do not paste the script inline. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way.`,
    ].join("\n");
  }
  // 兜底（legacy `Workflow` 工具的 failed / killed，或未知词）：沿用旧的通用指引。
  return [
    "The workflow did not complete. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user's request.",
    ...artifactsShort,
    "If the script itself was wrong, a corrected script submitted with AmendWorkflow re-uses the finished work; if the process died (error code Interrupted), the run is resumable as-is.",
  ].join("\n");
}

function formatLocalAgentUsage(input: TaskNotificationInput["usage"]): string | undefined {
  if (!input) return undefined;
  const segments: string[] = [];
  const totalTokens = input.totalTokens ?? input.modelUsage?.totalTokens;
  if (totalTokens !== undefined) {
    segments.push(`<subagent_tokens>${totalTokens}</subagent_tokens>`);
  }
  if (input.toolUseCount !== undefined) {
    segments.push(`<tool_uses>${input.toolUseCount}</tool_uses>`);
  }
  if (input.durationMs !== undefined) {
    segments.push(`<duration_ms>${input.durationMs}</duration_ms>`);
  }
  if (segments.length === 0) return undefined;
  return `<usage>${segments.join("")}</usage>`;
}

function formatUsage(input: TaskNotificationInput["usage"]): string[] {
  if (!input) return [];
  const lines: string[] = [];
  if (input.totalTokens !== undefined) {
    lines.push(`<total-tokens>${input.totalTokens}</total-tokens>`);
  }
  if (input.toolUseCount !== undefined) {
    lines.push(`<tool-uses>${input.toolUseCount}</tool-uses>`);
  }
  if (input.durationMs !== undefined) {
    lines.push(`<duration-ms>${input.durationMs}</duration-ms>`);
  }
  if (input.modelUsage?.inputTokens !== undefined) {
    lines.push(`<input-tokens>${input.modelUsage.inputTokens}</input-tokens>`);
  }
  if (input.modelUsage?.outputTokens !== undefined) {
    lines.push(`<output-tokens>${input.modelUsage.outputTokens}</output-tokens>`);
  }
  if (input.modelUsage?.cacheReadTokens !== undefined) {
    lines.push(`<cache-read-tokens>${input.modelUsage.cacheReadTokens}</cache-read-tokens>`);
  }
  if (input.modelUsage?.cacheWriteTokens !== undefined) {
    lines.push(`<cache-write-tokens>${input.modelUsage.cacheWriteTokens}</cache-write-tokens>`);
  }
  if (input.modelUsage?.reasoningTokens !== undefined) {
    lines.push(`<reasoning-tokens>${input.modelUsage.reasoningTokens}</reasoning-tokens>`);
  }
  return lines;
}
