// ============================================================
// Skill Tool Handler
// ============================================================

import {
  CoreErrorType,
  SkillInputJsonSchema,
  SkillInputSchema,
  SkillOutputJsonSchema,
  SkillOutputSchema,
  createCoreError,
  type SkillRuntimeInput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { injectLiveBuildSection, LIVE_BUILD_PLACEHOLDER } from "./skill-live-build.js";
// disable-model-invocation 硬门（R6 消费接线）：用户指名标记的唯一消费点。
import { consumeUserInvokedSkillMarker } from "../../agent/skill-user-invocation.js";

const MAX_SKILL_BYTES = 100_000;
/** 受门技能被拒的业务失败码（handler 本地闭集，非契约面）。 */
const SKILL_USER_INVOCATION_ONLY_ERROR_CODE = 1;

const skillHandler: ToolHandler = async (input, context) => {
  const { skill } = SkillInputSchema.parse(input) as SkillRuntimeInput;
  const skillPort = context.skillPort;

  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for Skill tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Skill",
        },
        recoverable: false,
      },
    );
  }

  const loaded = await skillPort.loadSkill(
    {
      name: skill,
      workingDirectory: context.workingDirectory,
      maxBytes: MAX_SKILL_BYTES,
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      },
    },
    { signal: context.abortSignal },
  );

  // disable-model-invocation 硬门（specs/skill-frontmatter-governance.md R6 消费接线）：
  // 仅用户可敲的技能，无用户指名标记时拒绝模型面调用（业务失败 + 指位文案，不抛
  // 配置错——这是可预期的权限性拒绝）。标记唯一写入点 = CLI 手动 /skill 提交路径
  //（markUserInvokedSkillForTurn），唯一消费点 = 本处，按名匹配一次性消费；
  // 生命周期与残余窗口见 skill-user-invocation.ts 头注。
  if (
    loaded.metadata.governance?.disableModelInvocation === true &&
    !consumeUserInvokedSkillMarker(context.sessionId, [
      skill,
      loaded.metadata.name,
      ...(loaded.metadata.qualifiedName ? [loaded.metadata.qualifiedName] : []),
    ])
  ) {
    return {
      result: false,
      errorCode: SKILL_USER_INVOCATION_ONLY_ERROR_CODE,
      message:
        `Skill "${loaded.metadata.name}" is reserved for explicit user invocation ` +
        "(disable-model-invocation) and the user did not request it here. It was NOT loaded. " +
        `Do not call it again on your own initiative; tell the user this skill exists so they ` +
        `can invoke it themselves with /skill ${loaded.metadata.name}.`,
    };
  }

  context.recordSkillTelemetryMetadata?.({
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  // T2-c2「Current Build」实时自知（specs/guide-live-build-section.md R1）：正文含
  // {{ACODE_CURRENT_BUILD}} 占位符的技能，在装配点把占位符替换为运行中 CLI 生成的快照节；
  // 无占位符的技能零成本透传。注入自身永不抛错（失败落降级节），不影响 Skill 调用成败。
  const expandedContent = expandSkillContextVariables(loaded.content, loaded.baseDirectory);
  // 宿主事实投影（spec「宿主接线登记」①②③）：仅占位符在场才查询 MCP 连接态
  //（保持无占位符零成本透传）；查询失败降级回磁盘「已配置」面（R3），不影响调用成败。
  const liveBuildPort = context.liveBuildSnapshotPort;
  const mcpConnectionStates = expandedContent.includes(LIVE_BUILD_PLACEHOLDER)
    ? await liveBuildPort?.getMcpConnectionStates?.().catch(() => undefined)
    : undefined;
  const body = await injectLiveBuildSection(expandedContent, {
    sessionId: context.sessionId,
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    toolNames: context.providerVisibleToolNames,
    skillPort: context.skillPort,
    signal: context.abortSignal,
    ...(liveBuildPort?.version ? { version: liveBuildPort.version } : {}),
    ...(liveBuildPort?.builtInCommandNames
      ? { builtInCommandNames: liveBuildPort.builtInCommandNames }
      : {}),
    ...(liveBuildPort?.hostAgentNames ? { hostAgentNames: liveBuildPort.hostAgentNames } : {}),
    ...(mcpConnectionStates ? { mcpConnectionStates } : {}),
  });

  return [
    `<skill_content name="${loaded.metadata.name}">`,
    `# Skill: ${loaded.metadata.name}`,
    "",
    body,
    "",
    `Base directory for this skill: ${loaded.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    loaded.truncated ? "[Skill content truncated]" : "",
    "</skill_content>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

function expandSkillContextVariables(content: string, baseDirectory: string): string {
  // 只有 Skill 工具加载后才有明确的当前 skill 目录，因此变量替换限定在这里完成。
  return content.replace(/\$\{(CLAUDE_SKILL_DIR|ACODE_SKILL_DIR)\}/gu, baseDirectory);
}

export const skillToolEntry: ToolEntry = {
  capability: "Load local skill instructions into the current session context",
  metadata: {
    name: "Skill",
    description: `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>", they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Set \`skill\` to the exact name of an available skill (no leading slash). For plugin-namespaced skills use the fully qualified \`plugin:skill\` form.
- Set \`args\` to pass optional arguments.

Important:
- Available skills are listed in system-reminder messages in the conversation
- Only invoke a skill that appears in that list, or one the user explicitly typed as \`/<name>\` in their message. Never guess or invent a skill name from training data; otherwise do not call this tool
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_SKILL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: skillHandler,
  inputSchema: SkillInputJsonSchema,
  outputSchema: SkillOutputJsonSchema,
  runtimeInputSchema: SkillInputSchema,
  runtimeOutputSchema: SkillOutputSchema,
  permission: {
    permission: "skill",
    reason: "Skill loads local instructions into session context",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SKILL_BYTES,
    maxModelBytes: MAX_SKILL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SKILL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill loading was cancelled before content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
