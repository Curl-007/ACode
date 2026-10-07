// ============================================================
// Agent Tool Handler
// ============================================================

import {
  AgentErrorCode,
  AgentInputJsonSchema,
  AgentInputSchema,
  AgentOutputSchema,
  AgentType,
  CoreErrorType,
  createCoreError,
  type AgentInput,
  type AgentOutput,
  type TraceContext,
} from "@acode/contracts";
import { TASK_TOOL_NAME } from "../compat.js";
import type { ToolEntry, ToolHandler } from "../types.js";
import { formatAgentProfilesForPrompt, type AgentProfile } from "../../subagent/profile.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

const AGENT_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed", type: "string" },
        agentId: { type: "string" },
        agentType: { type: "string" },
        prompt: { type: "string" },
        content: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { const: "text", type: "string" },
              text: { type: "string" },
            },
            required: ["type", "text"],
            additionalProperties: false,
          },
        },
        totalToolUseCount: { type: "integer", minimum: 0 },
        totalDurationMs: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 },
        usage: { type: "object", additionalProperties: true },
      },
      required: ["status", "agentId", "prompt", "content", "totalToolUseCount", "totalDurationMs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "async_launched", type: "string" },
        agentId: {
          type: "string",
          description: "The ID of the async agent",
        },
        description: {
          type: "string",
          description: "The description of the task",
        },
        prompt: {
          type: "string",
          description: "The prompt for the agent",
        },
        outputFile: {
          type: "string",
          description: "Path to the output file for checking agent progress",
        },
        canReadOutputFile: {
          type: "boolean",
          description: "Whether the calling agent has Read/Bash tools to check progress",
        },
      },
      required: ["status", "agentId", "description", "prompt", "outputFile"],
      additionalProperties: false,
    },
  ],
};

/**
 * 动态工作流灰度门也管**工具描述**：
 * 关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着「CreateWorkflow
 * 是强制的」，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found。
 * 缺省 true：未显式传该选项的调用方（TUI、headless）行为不变，只有显式 false 才抹掉这一行。
 *
 * 去烘焙（spec dispatch-discipline-prompt.md R4）：本函数曾在模块加载期求值成常量
 * AGENT_PROVIDER_DESCRIPTION，被静态 agentToolEntry/taskToolEntry 的 metadata.description
 * 直接引用——任何依赖运行期配置的描述分支（profiles / embeddedSearchEnabled /
 * dynamicWorkflowEnabled）在静态路径上永远拿到缺省值，上面那次灰度事故正是这个坑的发作。
 * 现在描述只在**装配期**产出：createAgentToolEntry / createTaskToolEntry 是唯一产出点
 * （装配点 tool/handlers/index.ts 的 resolveBuiltInToolEntryForBranch，出口是
 * tool/registry.ts 的 toContracts），静态条目不再携带 description。
 */
function buildAgentProviderDescription(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    dynamicWorkflowEnabled?: boolean;
  } = {},
): string {
  const agentList = formatAgentProfilesForPrompt(options.profiles ?? [], {
    embeddedSearchEnabled: options.embeddedSearchEnabled,
  });

  return [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "",
    agentList,
    "",
    "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
    "",
    "## When to use",
    "",
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
    "- A new Agent call starts fresh, so the prompt must be self-contained.",
    "- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes. Omit it to follow the agent's own default; pass `false` to force foreground execution even for an agent that defaults to background.",
    "- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
    // 只保留「用户点名工作流」这一种情形：工作流一律由用户显式请求触发，与系统提示词其余
    // 部分一致。不能把「结果层层喂给下一步的多代理编排」也划给 CreateWorkflow，
    // 那等于让模型在用户没开口时自行选择工作流。
    ...(options.dynamicWorkflowEnabled === false
      ? []
      : [
          '- If the user explicitly asks for a workflow ("use a workflow", "使用 workflow", "用工作流", or any phrasing naming workflow/工作流 as the means), the CreateWorkflow tool is mandatory: do not use this tool instead, however small the task.',
        ]),
  ].join("\n");
}

function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }

  const data = parsed.data as AgentOutput;
  if (data.status !== "async_launched") {
    const childText = data.content.map((block) => block.text).join("\n");
    const childContent =
      childText.trim().length > 0 ? [childText] : ["(Subagent completed but returned no output.)"];
    const usageLines = [
      ...(data.totalTokens === undefined ? [] : [`subagent_tokens: ${data.totalTokens}`]),
      `tool_uses: ${data.totalToolUseCount}`,
      `duration_ms: ${data.totalDurationMs}`,
    ];
    return [
      ...childContent,
      `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`,
      `<usage>${usageLines.join("\n")}</usage>`,
    ].join("\n");
  }

  const launchLines = [
    "Async agent launched successfully.",
    `agentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ];

  if (data.canReadOutputFile) {
    return [
      ...launchLines,
      "Do not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      `output_file: ${data.outputFile}`,
      "Do NOT Read or tail this file via the shell tool. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
    ].join("\n");
  }

  return [
    ...launchLines,
    "Briefly tell the user what you launched and end your response. Do not generate any other text - agent results will arrive in a subsequent message.",
  ].join("\n");
}

const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentInputSchema.parse(input) as AgentInput;
  const agentType = parsed.subagent_type ?? AgentType.GeneralPurpose;

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for Agent tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: false,
      },
    );
  }

  const request = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    parentToolCallId: context.toolCallId,
    agentType,
    description: parsed.description,
    prompt: parsed.prompt,
    callerCanReadOutputFile: canReadBackgroundOutputFile(context.providerVisibleToolNames),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
  };
  return context.subagentPort.launch(
    {
      ...request,
      // 三态透传（subagent-background-tristate.md R1）：undefined=跟随 profile 默认、
      // true=强制后台、false=强制前台。此前 `=== true` 把显式 false 折叠成缺省，
      // 导致 profile.background=true 的成员无法被调用方拉回前台（deny 语境成死循环）。
      runInBackground: parsed.run_in_background,
    },
    {
      signal: context.abortSignal,
      ...(context.model ? { model: context.model } : {}),
      ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
    },
  );
};

export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent; background execution is runtime-configured",
  metadata: {
    name: "Agent",
    // description 刻意缺席：静态条目只是 builtInTools 成员与装配基底，描述唯一在装配期由
    // createAgentToolEntry 产出。静态携带描述 = 模块加载期烘焙，会让灰度门在静态路径上
    // 读到缺省值、指向不存在的工具（见 buildAgentProviderDescription 的注释与 R4）。
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentHandler,
  formatModelContent: formatAgentOutputForModel,
  inputSchema: AgentInputJsonSchema,
  outputSchema: AGENT_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: AgentInputSchema,
  runtimeOutputSchema: AgentOutputSchema,
  permission: {
    permission: "subagent",
    reason:
      "Agent launches a child runtime; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_AGENT_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_AGENT_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage:
      "Agent was cancelled before the subagent returned findings or background launch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function canReadBackgroundOutputFile(toolNames: readonly string[] | undefined): boolean {
  const names = new Set(toolNames ?? []);
  return names.has("Read") || names.has("Bash");
}

export const taskToolEntry: ToolEntry = {
  ...agentToolEntry,
  capability: "Claude Code-compatible alias for launching a ACode subagent",
  metadata: {
    ...agentToolEntry.metadata,
    name: TASK_TOOL_NAME,
    providerVisible: false,
    // 描述与 Agent 同款只在装配期产出（createTaskToolEntry），且必须与 Agent 出自同一次
    // buildAgentProviderDescription 调用——否则灰度门在两个工具上分叉（R4）。
  },
};

function createTaskToolEntryFromAgent(entry: ToolEntry): ToolEntry {
  return {
    ...entry,
    capability: "Claude Code-compatible alias for launching a ACode subagent",
    metadata: {
      ...entry.metadata,
      name: TASK_TOOL_NAME,
      providerVisible: false,
      description: [
        "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
        "",
        entry.metadata.description ?? "",
      ].join("\n"),
    },
  };
}

export function createAgentToolEntry(
  _options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** 见 buildAgentProviderDescription：缺省 true，只有灰度显式关闭时才去掉工作流那一行。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...agentToolEntry,
    metadata: {
      ...agentToolEntry.metadata,
      description: buildAgentProviderDescription(_options),
    },
  };
}

export function createTaskToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** Task 是 Agent 的兼容别名，描述整段内嵌 Agent 的，因此同一道门一起传下去。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return createTaskToolEntryFromAgent(createAgentToolEntry(options));
}
