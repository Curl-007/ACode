import { BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES, type ACodeSlashCommand } from "@acode/shared";
import { BUILTIN_ULTRACODE_COMMAND_NAME } from "../builtin-ultracode-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import {
  listACodeCustomCommands,
  type ListACodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS,
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedACodeSlashCommandName,
} from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListACodeCustomCommandsOptions {
  /**
   * 动态工作流开关。只有显式 false 才从目录中剔除内置 `workflow` 与 `ultracode`。
   * 未传入该字段的调用方保留默认目录；协议服务端从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
}

/**
 * 受动态工作流开关约束的内置命令：两套工作流系统各自的入口。
 * 必须与 core 的 GATED_WORKFLOW_TOOL_NAMES（工具面）和 builtin-prompt-command 的展开门
 * 三处同结论——少剔一处就会出现「目录里有入口 / 展开不出正文 / 工具不存在」这类分裂。
 */
const DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  BUILTIN_WORKFLOW_COMMAND_NAME,
  BUILTIN_ULTRACODE_COMMAND_NAME,
]);

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ACodeSlashCommand[]> {
  // 动态工作流关闭时：composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失。
  // 两个命令名都是内置且都是保留名，用户/插件的同名自定义命令在下面的 reserved 过滤里一并消失，
  // 不会在门关着时借自定义命令的身份漏回目录。
  const builtins = listAppProtocolBuiltinSlashCommands().filter(
    (command) =>
      options.dynamicWorkflowEnabled !== false ||
      !DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES.has(command.name),
  );
  let customCommands: Awaited<ReturnType<typeof listACodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listACodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }

  return [
    ...builtins,
    ...customCommands
      .filter((command) => !command.disableNonInteractive)
      .filter((command) => !isReservedACodeSlashCommandName(command.name))
      .map((command) => ({
        description: command.description,
        inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        name: command.name,
        source: "custom" as const,
      })),
  ];
}

/** App `/` 面板按本目录顺序展示；内置段的顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。 */
function listAppProtocolBuiltinSlashCommands(): ACodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...sharedBuiltins, ...APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
