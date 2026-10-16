import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceHookTimeoutMs } from "@acode/shared/workspace-hook-discovery";
import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookConfig,
  type HookInput,
  type HookPluginContext,
} from "@acode/contracts";

export async function createCompatibleHookStdin(input: HookInput): Promise<{
  cleanup: () => Promise<void>;
  value: string;
}> {
  const compatible: Record<string, unknown> = {
    ...input,
    agent_type: input.agentName,
    hook_event_name: input.hookEventName,
    permission_mode: input.mode,
    session_id: input.sessionId,
  };
  const tempDir = await mkdtemp(join(tmpdir(), "acode-hook-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  await writeFile(transcriptPath, formatTranscript(input), "utf8");
  compatible.transcript_path = transcriptPath;
  compatible.transcriptPath = transcriptPath;

  if ("toolName" in input) {
    // 这里只补无损 alias，继续保留 ACode camelCase 字段作为内部主契约。
    compatible.tool_name = input.toolName;
    compatible.tool_use_id = input.toolCallId;
    // TaskCreated/TaskCompleted 只携带 toolName/toolCallId，没有 toolInput 事实，
    // 不能为凑 alias 形状合成空对象。
    if ("toolInput" in input) {
      compatible.tool_input = input.toolInput;
    }
  }

  switch (input.hookEventName) {
    case HookEventName.PermissionRequest:
      compatible.permission_suggestions = input.permissionSuggestions;
      break;
    case HookEventName.PostToolUse:
      compatible.tool_response = input.toolResponse;
      break;
    case HookEventName.PostToolUseFailure:
      compatible.error_details = input.error;
      compatible.error = input.error.message;
      compatible.is_interrupt = input.isInterrupt;
      break;
    case HookEventName.PostToolBatch:
      compatible.tool_results = input.toolResults;
      compatible.success_count = input.successCount;
      compatible.error_count = input.errorCount;
      break;
    case HookEventName.PreCompact:
      compatible.trigger = input.trigger;
      compatible.custom_instructions = input.customInstructions;
      compatible.pre_compact_token_count = input.preCompactTokenCount;
      break;
    case HookEventName.PostCompact:
      compatible.trigger = input.trigger;
      compatible.pre_compact_token_count = input.preCompactTokenCount;
      compatible.post_compact_token_count = input.postCompactTokenCount;
      break;
    case HookEventName.PreModelSwitch:
    case HookEventName.PostModelSwitch:
      compatible.previous_model = input.previousModel;
      compatible.next_model = input.nextModel;
      break;
    case HookEventName.SessionEnd:
      compatible.reason = input.reason;
      break;
    case HookEventName.StopFailure:
      compatible.error = input.errorMessage;
      compatible.error_details = { message: input.errorMessage, type: input.errorType };
      compatible.cancelled = input.cancelled;
      break;
    case HookEventName.TaskCreated:
    case HookEventName.TaskCompleted:
      compatible.task_id = input.taskId;
      compatible.task_kind = input.taskKind;
      compatible.task_description = input.description;
      if (input.hookEventName === HookEventName.TaskCompleted) {
        compatible.task_status = input.taskStatus;
      }
      break;
    case HookEventName.CwdChanged:
      compatible.previous_cwd = input.previousCwd;
      compatible.new_cwd = input.newCwd;
      break;
    case HookEventName.Stop:
      compatible.last_assistant_message = input.responseText ?? input.responsePreview;
      compatible.stop_hook_active = input.stopHookActive;
      break;
    case HookEventName.SessionStart:
    case HookEventName.UserPromptSubmit:
    case HookEventName.PreToolUse:
      break;
  }

  return {
    value: `${JSON.stringify(compatible)}\n`,
    cleanup: async () => {
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}

export function resolveHookTimeoutMs(hook: HookConfig, defaultTimeoutMs: number): number {
  return resolveWorkspaceHookTimeoutMs(hook, defaultTimeoutMs);
}

export function createPluginEnvOverlay(
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
) {
  const set: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ACODE_PROJECT_DIR: input.cwd || workingDirectory,
    ACODE_SESSION_ID: input.sessionId,
  };
  if (!plugin) return { set };
  return {
    set: {
      ...set,
      CLAUDE_PLUGIN_DATA: plugin.dataPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
      ACODE_PLUGIN_DATA: plugin.dataPath,
      ACODE_PLUGIN_ID: plugin.id,
      ACODE_PLUGIN_NAME: plugin.name,
      ACODE_PLUGIN_ROOT: plugin.rootPath,
    },
  };
}

export function expandPluginVariables(
  value: string,
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
): string {
  const replacements: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ACODE_PROJECT_DIR: input.cwd || workingDirectory,
    ACODE_SESSION_ID: input.sessionId,
  };
  if (plugin) {
    replacements.CLAUDE_PLUGIN_DATA = plugin.dataPath;
    replacements.CLAUDE_PLUGIN_ROOT = plugin.rootPath;
    replacements.ACODE_PLUGIN_DATA = plugin.dataPath;
    replacements.ACODE_PLUGIN_ROOT = plugin.rootPath;
  }
  return value.replace(
    /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ACODE_PLUGIN_DATA|ACODE_PLUGIN_ROOT|ACODE_PROJECT_DIR|ACODE_SESSION_ID|ACODE_SKILL_DIR)\}/gu,
    (_match, key: string) => {
      if (key === "CLAUDE_SKILL_DIR" || key === "ACODE_SKILL_DIR") {
        // hook 运行时没有“当前 skill”语义，不能把该变量交给 shell 展开为空字符串。
        // 这里提前报错，插件诊断/日志能看到明确的上下文缺失原因。
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          `Hook variable requires a skill context: ${key}`,
          {
            context: {
              hookEventName: input.hookEventName,
              variable: key,
            },
            recoverable: true,
          },
        );
      }
      return replacements[key] ?? _match;
    },
  );
}

function formatTranscript(input: HookInput): string {
  if (input.hookEventName === HookEventName.Stop) {
    return formatMessageLine("assistant", input.responseText ?? input.responsePreview);
  }
  if (input.hookEventName === HookEventName.UserPromptSubmit) {
    return formatMessageLine("user", input.prompt);
  }
  return "";
}

function formatMessageLine(role: "assistant" | "user", text: string): string {
  return `${JSON.stringify({
    message: {
      content: [{ text, type: "text" }],
      role,
    },
  })}\n`;
}
