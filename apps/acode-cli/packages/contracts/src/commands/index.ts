// ============================================================
// Custom Command Contracts - user-defined slash prompt commands
// ============================================================

import type { HookPluginContext } from "../hooks/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type CustomCommandScope = "project" | "user" | "system" | "admin";

export type CustomCommandSource = "agents" | "acode" | "plugin";

export type CustomCommandDiagnosticSeverity = "warning" | "error";

export type CustomCommandDiagnosticCode =
  | "custom_command_duplicate_name"
  | "custom_command_invalid_frontmatter"
  | "custom_command_invalid_name"
  | "custom_command_read_failed"
  | "custom_command_root_not_found"
  | "custom_command_scan_failed"
  | "custom_command_too_large"
  | "custom_command_unknown_frontmatter"
  | "custom_command_unsupported_dynamic_syntax";

export interface CustomCommandRoot {
  path: string;
  plugin?: HookPluginContext;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  priority: number;
}

/**
 * `!` 块执行的 shell 选择（specs/skill-frontmatter-governance.md R7 ×
 * specs/powershell-tool.md 交叉登记）：闭集，缺席 = bash（跨平台一致缺省）。
 */
export type CustomCommandShellPreference = "bash" | "powershell";

export interface CustomCommandMetadata {
  allowedTools: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
  model?: string;
  name: string;
  path: string;
  plugin?: HookPluginContext;
  rootPath: string;
  scope: CustomCommandScope;
  shell?: CustomCommandShellPreference;
  skills: string[];
  source: CustomCommandSource;
}

export interface CustomCommandDiagnostic {
  code: CustomCommandDiagnosticCode;
  severity: CustomCommandDiagnosticSeverity;
  message: string;
  path?: string;
  commandName?: string;
}

export interface CustomCommandLoadOutcome {
  commands: CustomCommandMetadata[];
  diagnostics: CustomCommandDiagnostic[];
  totalDiscovered: number;
}

export interface CustomCommandContent {
  metadata: CustomCommandMetadata;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface CustomCommandDiscoverRequest {
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandLoadRequest {
  maxBytes?: number;
  name: string;
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface CustomCommandPort {
  discoverCommands(
    request: CustomCommandDiscoverRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome>;
  loadCommand(
    request: CustomCommandLoadRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent>;
}

export interface CustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

export interface CustomCommandTemplateExpansion {
  argumentCount: number;
  body: string;
  usedArgumentsPlaceholder: boolean;
}

// 单遍模板占位符（机制参照 oh-my-pi MIT，packages/coding-agent/src/utils/command-args.ts
// 的 substituteArgs；裁决见 apps/acode-cli/specs/slash-positional-args.md 与其 W1 登记）：
// $@[start:length] 切片 / $ARGUMENTS 整体 / $@ 聚合 / $N 位置参数。与 cli 侧
// custom-command-expand.ts 同一语义（本文件是 bootstrap resolver → desktop-agent/ACP
// 直提路径的第二展开面，W1 同步消除两遍渲染注入面）。
// 备选序：切片必须先于裸 $@，否则 $@[2] 会被 $@ 抢配。
const ARGUMENT_PLACEHOLDER_PATTERN = /\$@\[(\d+)(?::(\d*))?\]|\$ARGUMENTS|\$@|\$(\d+)/g;
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;

export function expandCustomCommandPrompt(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandExpansion {
  const expanded = expandCustomCommandTemplate(input);
  const dynamicSyntax = detectUnsupportedDynamicSyntax(expanded.body);
  if (dynamicSyntax) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported ${dynamicSyntax} expansion. Dynamic expansion is not available yet.`,
    );
  }

  return formatCustomCommandPrompt({
    body: expanded.body,
    command: input.command,
    argumentCount: expanded.argumentCount,
    usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
  });
}

export function expandCustomCommandTemplate(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandTemplateExpansion {
  const args = input.args.trim();
  const positional = splitCustomCommandArguments(args);
  let usedArgumentsPlaceholder = false;
  // 单遍渲染：一次扫描完成全部占位符替换，替换结果不再进入扫描——参数值里出现的
  // $1/$@/$ARGUMENTS 按字面文本保留，不做二次展开（防注入）。旧实现是两遍（先
  // $ARGUMENTS 后 $N），参数值内的 $N 会被第二遍展开并误置 usedArgumentsPlaceholder。
  const body = input.command.content.replace(
    ARGUMENT_PLACEHOLDER_PATTERN,
    (_match, sliceStart?: string, sliceLength?: string, positionalIndex?: string) => {
      usedArgumentsPlaceholder = true;
      if (positionalIndex !== undefined) {
        // 缺位参数渲染为空串（"$3 但只给了 2 个参数" → 空串，不报错）。
        return positional[Number(positionalIndex) - 1] ?? "";
      }
      if (sliceStart !== undefined) return expandCustomCommandArgumentSlice(positional, sliceStart, sliceLength);
      // $ARGUMENTS 与 $@ 等价：整体替换为原始 trim 参数串（ACode 既有语义，
      // 与 cli 侧同一裁决，见 spec「$ARGUMENTS/$@ 取值裁决」）。
      return args;
    },
  );

  const finalBody =
    args.length > 0 && !usedArgumentsPlaceholder
      ? `${body.trimEnd()}\n\nUser arguments:\n${args}`
      : body;

  return {
    argumentCount: positional.length,
    body: finalBody,
    usedArgumentsPlaceholder,
  };
}

/**
 * $@[start:length] 切片语义（1-based，对齐 omp substituteArgs；spec 语法表）：
 * start < 1 或起点越界 → 空串；length 省略/为空 → 取到末尾；length ≤ 0 → 空串；
 * 非数字形态不匹配占位符正则，整个片段保持字面量。
 */
function expandCustomCommandArgumentSlice(
  positional: readonly string[],
  startRaw: string,
  lengthRaw?: string,
): string {
  const start = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 1) return "";
  const startIndex = start - 1;
  if (startIndex >= positional.length) return "";
  if (lengthRaw === undefined || lengthRaw === "") {
    return positional.slice(startIndex).join(" ");
  }
  const length = Number.parseInt(lengthRaw, 10);
  if (!Number.isFinite(length) || length <= 0) return "";
  return positional.slice(startIndex, startIndex + length).join(" ");
}

export function formatCustomCommandPrompt(input: {
  argumentCount: number;
  body: string;
  command: CustomCommandContent;
  usedArgumentsPlaceholder: boolean;
}): CustomCommandExpansion {
  return {
    argumentCount: input.argumentCount,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      input.body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder: input.usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

export function detectUnsupportedDynamicSyntax(content: string): "shell" | undefined {
  if (INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content)) {
    return "shell";
  }
  return undefined;
}

/**
 * 斜杠命令已被 CLI 展开的展示元数据（spec: apps/acode-cli/specs/slash-command-echo.md）。
 * 只在展开成功时产生；GUI 以它的有无判断「命令是否触发」，不得从输入文本反推。
 * 自 anker-code@6e698ada 经 f3ab0e6 移植（0cc983f 因零消费者剔除，本次随全链接线复活）。
 */
export interface CustomCommandInvocationMeta {
  name: string;
  scope: CustomCommandScope | "builtin";
  source?: CustomCommandSource;
  description?: string;
}

export function toCustomCommandInvocationMeta(
  metadata: Pick<CustomCommandMetadata, "description" | "name" | "scope" | "source">,
): CustomCommandInvocationMeta {
  const description = metadata.description.trim();
  return {
    name: metadata.name,
    scope: metadata.scope,
    source: metadata.source,
    ...(description ? { description } : {}),
  };
}

/**
 * customCommandPromptResolver 的返回值（f3ab0e6 提交信息记载的结构改造）：prompt 进模型、
 * command 元数据随 TurnStarted/用户消息 metadata 走展示链路。undefined = 非斜杠命令或命令
 * 不存在，按普通输入处理。
 */
export interface ResolvedCustomCommandPrompt {
  command: CustomCommandInvocationMeta;
  prompt: string;
}
