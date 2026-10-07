import {
  expandCustomCommandPrompt,
  RUN_WORKFLOW_SKILL_NAME,
  type CustomCommandContent,
} from "@acode/contracts";
import { BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES } from "@acode/shared";

/**
 * 内置 `/ultracode` 命令：脚本工作流（RunWorkflow）的入口。
 *
 * 与 `/workflow` 是同形不同物——那边驱动 dwf 的 CreateWorkflow（TypeScript、对着 facade
 * 类型检查、禁止 `export`），这边驱动 RunWorkflow（纯 JS、必须以 `export const meta` 开头）。
 * 两种脚本**不可互换**，所以正文必须显式点名不要走另一套，否则模型会把上一轮读到的
 * dynamic-workflows 规则套过来，写出一段在这边解析不过、在那边编译不过的脚本。
 *
 * 命令正文随 CLI 编译，与 `/init`、`/workflow` 同为代码定义的 prompt 命令，不依赖可卸载插件。
 * 命令名进入保留字表（slash-command-surface.ts 的 RESERVED_SLASH_COMMAND_NAMES 由 help 表推导），
 * 用户或插件的同名命令不会被展开。
 */
export const BUILTIN_ULTRACODE_COMMAND_NAME = "ultracode";

const helpEntry = BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_ULTRACODE_COMMAND_NAME,
);
if (!helpEntry) {
  // 共享 help 表是保留字、TUI 候选与 App 目录的唯一来源；条目缺席时命令根本不可寻址。
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_ULTRACODE_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_ULTRACODE_COMMAND_NAME} `;
export const BUILTIN_ULTRACODE_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_ULTRACODE_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/** `$ARGUMENTS` 必须在场：否则展开会把参数追加成位置不受控的 "User arguments:" 尾块。 */
const BUILTIN_ULTRACODE_COMMAND_BODY = [
  `Use the \`${RUN_WORKFLOW_SKILL_NAME}\` skill to design and launch a script workflow for this request:`,
  "",
  "$ARGUMENTS",
  "",
  "Decide the fan-out topology before writing any code: how many subagents, which of them need",
  "results from earlier ones, what each returns. Then write a plain-JavaScript script whose first",
  "statement is `export const meta = { name, description, phases }` and call the `RunWorkflow` tool.",
  "",
  "(`RunWorkflow` is the script-workflow tool. Do not use `CreateWorkflow` for this request — that is",
  "the other workflow system, it takes TypeScript checked against a facade, and it rejects `export`.",
  "Do not substitute the `Agent` tool either.)",
].join("\n");

export const BUILTIN_ULTRACODE_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(BUILTIN_ULTRACODE_COMMAND_BODY),
  content: BUILTIN_ULTRACODE_COMMAND_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_ULTRACODE_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_ULTRACODE_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint", "skills"],
    name: BUILTIN_ULTRACODE_COMMAND_NAME,
    path: `builtin:${BUILTIN_ULTRACODE_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [RUN_WORKFLOW_SKILL_NAME],
    source: "acode",
  },
  sizeBytes: Buffer.byteLength(BUILTIN_ULTRACODE_COMMAND_BODY),
  truncated: false,
};

export function expandBuiltinUltracodeCommandPrompt(args: string): string {
  return expandCustomCommandPrompt({ args, command: BUILTIN_ULTRACODE_COMMAND }).prompt;
}
