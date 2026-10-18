import { join } from "node:path";
import { parseOvernightDuration } from "@acode/core";
import type { CustomCommandInvocationMeta } from "@acode/contracts";
import {
  BUILTIN_ULTRACODE_COMMAND_NAME,
  expandBuiltinUltracodeCommandPrompt,
} from "./builtin-ultracode-command.js";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";
export const OVERNIGHT_COMMAND_NAME = "overnight";
const USAGE_COMMAND_NAME = "usage";
const AUTO_RESUME_COMMAND_NAME = "auto-resume";

/**
 * 内置「宿主动作命令」：解析结果不是 prompt 文本，而是触发宿主侧结构化动作的指令
 * （K3 `/overnight`，specs/overnight-execution.md R1）。
 *
 * 为什么不放进 resolveACodeBuiltinPromptCommand：那个通道的返回值会作为模型输入
 * （input-facade 的 customCommandPromptResolver → runtimePromptText），而 /overnight
 * 不应把指令文本发给模型——它要 fork 隐藏 coordinator 并启动 supervisor。既有消费方
 * （create-app 的 resolver 接线）只认 prompt 文本，因此宿主动作走本函数的判别联合，
 * 由 bootstrap 装配处（create-app → overnight-controller）消费，/overnight 在
 * resolveACodeBuiltinPromptCommand 里刻意不设分支（保持返回 undefined，不展开）。
 */
export type ACodeBuiltinHostCommand =
  | { kind: "overnight-start"; durationMs: number }
  | { kind: "overnight-cancel" }
  | { kind: "overnight-invalid"; error: string }
  // 零 token 本地命令的文本落盘面（desktop sendText 汇入 sendInput、TUI busy 态）：
  // 与 typed v4 command（usage / autoResumeCommand）同一结论——宿主直接执行，不进模型
  //（apps/acode-cli/specs/usage-statusbar.md、specs/turn-auto-resume.md）。
  | { kind: "usage-query"; args: string }
  | { kind: "auto-resume-command"; args: string };

/** overnight 族子集（overnight-controller.handleHostCommand 的消费面；零 token
 * 命令变体由 create-app 拦截器直接消费，不进 controller）。 */
export type ACodeOvernightHostCommand = Extract<
  ACodeBuiltinHostCommand,
  { kind: "overnight-start" | "overnight-cancel" | "overnight-invalid" }
>;

/**
 * 解析宿主动作命令。识别 `/overnight` 族与零 token 本地命令（/usage、/auto-resume）；
 * 其余输入返回 undefined（调用方按普通输入继续）。时长解析复用第一段
 * parseOvernightDuration（含 1 分钟–12 小时硬限与可读错误）；`cancel` 走取消面。
 */
export function resolveACodeBuiltinHostCommand(input: string): ACodeBuiltinHostCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }
  if (invocation.name === USAGE_COMMAND_NAME) {
    return { kind: "usage-query", args: invocation.args };
  }
  if (invocation.name === AUTO_RESUME_COMMAND_NAME) {
    return { kind: "auto-resume-command", args: invocation.args };
  }
  if (invocation.name !== OVERNIGHT_COMMAND_NAME) {
    return undefined;
  }
  if (invocation.args.toLowerCase() === "cancel") {
    return { kind: "overnight-cancel" };
  }
  if (invocation.args === "") {
    return { kind: "overnight-invalid", error: "缺少时长参数。用法 /overnight <duration>，例如 8h、45m；取消用 /overnight cancel" };
  }
  const duration = parseOvernightDuration(invocation.args);
  if (!duration.ok) {
    return { kind: "overnight-invalid", error: duration.error };
  }
  return { kind: "overnight-start", durationMs: duration.durationMs };
}

interface ResolveACodeBuiltinPromptCommandOptions {
  /**
   * 动态工作流开关（dwf 总闸）：只有显式 false 才禁止展开 `/workflow` 与 `/ultracode`。
   * TUI 使用默认开启策略；headless 按本次 `--enable-workflow` 显式传入 true/false，默认 false。
   * 关闭时返回 undefined；两个命令名都是保留名，自定义命令解析也不会展开它们，原文作为普通
   * prompt 交给模型。这与命令目录隐藏这两个入口的规则一致。
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * 脚本工作流开关（spec script-workflow-management-surface.md §4.5）：只有显式 false 才
   * 禁止展开 `/ultracode`（与 dynamicWorkflowEnabled **合取**）。工具面不注册 RunWorkflow
   * 时命令还能展开正文，等于把模型引向不存在的工具。
   */
  scriptWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export function resolveACodeBuiltinPromptCommand(
  input: string,
  options: ResolveACodeBuiltinPromptCommandOptions = {},
): string | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return buildInitAgentsPrompt({
      args: invocation.args,
      targetPath: join(workingDirectory, "AGENTS.md"),
      workingDirectory,
    });
  }

  // `/workflow` 与 `/ultracode` 是两套工作流系统各自的入口。可用性门是**合取的两道**
  // （spec script-workflow-management-surface.md §4.5，评审必改项 2 后的表述）：
  // dwf 总闸（dynamicWorkflowEnabled）管两套——它关时工具面 GATED_WORKFLOW_TOOL_NAMES
  // 全下架，命令面必须同结论；脚本工作流开关（scriptWorkflowEnabled）只补
  // `/ultracode` 的另一半。理由见 core/src/tool/handlers/workflow-tool-names.ts：
  // 工具面与命令面必须同结论，否则会出现「命令能展开、工具不存在」。
  if (
    invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME ||
    invocation.name === BUILTIN_ULTRACODE_COMMAND_NAME
  ) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    if (
      invocation.name === BUILTIN_ULTRACODE_COMMAND_NAME &&
      options.scriptWorkflowEnabled === false
    ) {
      return undefined;
    }
    return invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME
      ? expandBuiltinWorkflowCommandPrompt(invocation.args)
      : expandBuiltinUltracodeCommandPrompt(invocation.args);
  }

  return undefined;
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

/**
 * 内置 prompt 命令的回显元数据（specs/slash-command-echo.md）：与展开共用同一个解析器，
 * 杜绝两处解析漂移。scope 固定 "builtin"（contracts 允许 CustomCommandScope | "builtin"）；
 * 内置命令没有 frontmatter 描述，description/source 缺席。调用方只在展开成功时使用它。
 */
export function builtinPromptCommandEchoMeta(
  input: string,
): CustomCommandInvocationMeta | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }
  return { name: invocation.name, scope: "builtin" };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? ["", "Additional user instructions supplied with /init:", "```text", params.args, "```"].join(
        "\n",
      )
    : "";

  return [
    "You are running ACode's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ACode agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".acode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.acode/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .acode/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future ACode agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}
