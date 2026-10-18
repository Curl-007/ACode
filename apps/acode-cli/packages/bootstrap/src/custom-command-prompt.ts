import {
  expandCustomCommandPrompt,
  expandCustomCommandTemplate,
  formatCustomCommandPrompt,
  toCustomCommandInvocationMeta,
  type ExecutionPort,
  type ResolvedCustomCommandPrompt,
  type SessionId,
  type TraceContext,
} from "@acode/contracts";
import { loadACodeCustomCommand, type ListACodeCustomCommandsOptions } from "./custom-commands.js";
import { expandCustomCommandShellSyntax } from "./custom-command-shell-expansion.js";
import { isReservedACodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveACodeCustomCommandPromptOptions extends ListACodeCustomCommandsOptions {
  executionPort?: ExecutionPort;
  sessionId?: SessionId;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

/**
 * 解析自定义 slash 命令（specs/slash-command-echo.md）。返回值自 f3ab0e6 起从裸 prompt
 * 字符串改为 { command, prompt }：prompt 照旧进模型输入，command 是「已触发命令」的展示
 * 元数据，随 ExecuteTurnOptions.customCommand 进 TurnStarted/用户消息 metadata。命令不存在
 * 或保留名命中时返回 undefined（与普通输入同形）。
 */
export async function resolveACodeCustomCommandPrompt(
  input: string,
  options: ResolveACodeCustomCommandPromptOptions = {},
): Promise<ResolvedCustomCommandPrompt | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // 保留名（含内置 `workflow`）在这里直接返回 undefined，与「命令不存在」同形：内置命令由
  // builtin-prompt-command.ts 先行展开，这里拒绝的是借同名自定义命令绕过内置语义（或功能开关）的路径。
  if (!invocation || isReservedACodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadACodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    // 展示元数据在展开前构造：展开只改 prompt 文本，不改命令身份。
    const meta = toCustomCommandInvocationMeta(command.metadata);
    if (options.executionPort) {
      // 调用 slash command 时先执行并替换输出，避免 unsupported error
      // 在 turn 创建前抛出后让 UI 长时间停在“正在思考”。
      //
      // 复用 contracts 的底层 template/format 函数，而非 expandCustomCommandPrompt：
      // 后者内部 detectUnsupportedDynamicSyntax 会对 `!` 语法直接抛错，而本路径
      // 恰恰要支持 shell 展开，只能在 expandCustomCommandTemplate 与
      // formatCustomCommandPrompt 之间插入 expandCustomCommandShellSyntax。
      const expanded = expandCustomCommandTemplate({
        args: invocation.args,
        command,
      });
      const body = await expandCustomCommandShellSyntax({
        command,
        content: expanded.body,
        executionPort: options.executionPort,
        sessionId: options.sessionId,
        signal: options.signal,
        traceContext: options.traceContext,
        workingDirectory: options.workingDirectory ?? process.cwd(),
      });
      return {
        command: meta,
        prompt: formatCustomCommandPrompt({
          argumentCount: expanded.argumentCount,
          body,
          command,
          usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
        }).prompt,
      };
    }
    return {
      command: meta,
      prompt: expandCustomCommandPrompt({
        args: invocation.args,
        command,
      }).prompt,
    };
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
