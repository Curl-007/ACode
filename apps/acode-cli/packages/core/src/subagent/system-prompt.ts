import type { EnvInfo, Model } from "@acode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";

export interface SubagentEnvironmentContextOptions {
  agentPrompt: string;
  envInfo: EnvInfo;
  model?: Model;
  /** 产品 scratch 暂存区根（R5.3）：在场渲染目录行与指引；缺席零渲染。 */
  scratchDir?: string;
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
    // 汇报契约（specs/subagent-report-contract.md R1）：先证据后一句话可转述 summary，
    // 区分「验证过的」与「打算做的」；good/bad 对照示例是契约的一部分。
    "- Structure your final response for the parent agent: first what you did or found, with specifics (file paths, line numbers, commands you ran and what they printed); then one sentence the parent can relay to the user as-is. Describe what you verified, not what you intended — if you did not run the tests, say so.",
    '  Good: "Added the null check in src/auth/validate.ts:42; the 12 auth tests pass, committed as abc1234." Bad: "I looked at the files and made the changes we discussed."',
  ].join("\n");
}

export function buildSubagentEnvironmentContext(
  options: SubagentEnvironmentContextOptions,
): string {
  const { envInfo, model, scratchDir } = options;
  const modelLine = model
    ? [`You are powered by the model named ${model.providerId}/${model.modelId}.`]
    : [];
  // R5.3（spec managed-policy-floor-and-bypass-immune-breakers.md）：scratch 引导行仅在
  // 事实在场时渲染（文本自撰英文，prompt-language-policy.md R7；子代理是临时文件的主要
  // 使用方，与主会话 env-info 段同一引导语义）。
  const scratchDirectory = typeof scratchDir === "string" ? scratchDir.trim() : "";
  const scratchLines =
    scratchDirectory.length > 0
      ? [
          `Scratch directory (temporary files): ${scratchDirectory}`,
          "Use it for temporary and intermediate files instead of writing to arbitrary paths outside the workspace; writes inside it and inside the system temporary directory do not trigger the workspace-escape confirmation.",
        ]
      : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${isEnvInfoGitRepository(envInfo) ? "Yes" : "No"}`,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    ...scratchLines,
    "</env>",
    ...modelLine,
  ].join("\n");
}
