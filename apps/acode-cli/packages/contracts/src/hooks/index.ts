import { z } from "zod";
import type { ToolCallId } from "../interfaces/shared.js";
import { HookSpecificOutputSchema } from "./hook-event-io.js";
import type { HookSpecificOutput } from "./hook-event-io.js";
import type { HookEventName, HookOutcome, HookSourceKind } from "./hook-event-names.js";

// 事件名/词汇枚举与事件 payload 契约拆分在两个叶子文件里（oxlint max-lines 门禁 +
// 避免 index ↔ io 值循环）；公开 API 不变，全部经这里原样再导出。
export * from "./hook-event-names.js";
export * from "./hook-event-io.js";

/** Runtime-only provenance attached after user/plugin config validation. */
export interface HookConfigSource {
  kind: "user" | "project" | "internal";
  path?: string;
}

/** Client-safe metadata. Unredacted commands and execution IO must never be added here. */
export interface HookExecutionDescriptor {
  clientVisible: boolean;
  sourceKind: HookSourceKind;
  sourcePath?: string;
  pluginId?: string;
  pluginName?: string;
  statusMessage?: string;
  executionType: "process" | "command";
  executionMode: "foreground" | "background";
  commandDisplay: string;
  timeoutMs: number;
}

export interface HookJSONOutput {
  additionalContext?: string;
  additional_context?: string;
  continue?: boolean;
  decision?: "approve" | "block";
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
}

export const HookJSONOutputSchema = z.object({
  additionalContext: z.string().optional(),
  additional_context: z.string().optional(),
  continue: z.boolean().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
});

export interface HookPluginContext {
  dataPath: string;
  id: string;
  name: string;
  rootPath: string;
  /** Actual hooks.json/manifest source. Other plugin consumers may omit it. */
  sourcePath?: string;
}

export interface HookCommandConfig {
  async?: boolean;
  command: string;
  enabled?: boolean;
  plugin?: HookPluginContext;
  shell?: true | string;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command";
}

export interface HookProcessConfig {
  args?: string[];
  command: string;
  enabled?: boolean;
  plugin?: HookPluginContext;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "process";
}

export type HookConfig = HookCommandConfig | HookProcessConfig;

export interface HookMatcherConfig {
  hooks: HookConfig[];
  matcher?: string;
}

export interface HooksRuntimeConfig {
  enabled: boolean;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface HooksRuntimeConfigPatch {
  enabled?: boolean;
  events?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface HookRunLifecyclePayload {
  agentName?: string;
  /** New events always carry this; optional keeps old persisted events replayable. */
  descriptor?: HookExecutionDescriptor;
  /** Sanitized human-readable reason when the Hook itself blocked execution. */
  blockReason?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hookEventName: HookEventName;
  hookIndex: number;
  hookCount?: number;
  hookInvocationId?: string;
  hookRunId: string;
  hookSource?: string;
  matcher?: string;
  outcome?: HookOutcome;
  outputBytes?: number;
  requestId?: string;
  startedAt?: number;
  stderrPreview?: string;
  stdoutPreview?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  truncated?: boolean;
}

export const HookProcessConfigSchema = z.object({
  type: z.literal("process"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

export const HookCommandConfigSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  async: z.boolean().optional(),
  shell: z.union([z.literal(true), z.string().min(1)]).optional(),
  timeout: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

export const HookConfigSchema = z.discriminatedUnion("type", [
  HookProcessConfigSchema,
  HookCommandConfigSchema,
]);

export const HookMatcherConfigSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookConfigSchema).min(1),
});

export const HooksRuntimeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  events: z
    .object({
      SessionStart: z.array(HookMatcherConfigSchema).optional(),
      UserPromptSubmit: z.array(HookMatcherConfigSchema).optional(),
      PreToolUse: z.array(HookMatcherConfigSchema).optional(),
      PermissionRequest: z.array(HookMatcherConfigSchema).optional(),
      PostToolUse: z.array(HookMatcherConfigSchema).optional(),
      PostToolUseFailure: z.array(HookMatcherConfigSchema).optional(),
      PostToolBatch: z.array(HookMatcherConfigSchema).optional(),
      Stop: z.array(HookMatcherConfigSchema).optional(),
      StopFailure: z.array(HookMatcherConfigSchema).optional(),
      PreCompact: z.array(HookMatcherConfigSchema).optional(),
      PostCompact: z.array(HookMatcherConfigSchema).optional(),
      PreModelSwitch: z.array(HookMatcherConfigSchema).optional(),
      PostModelSwitch: z.array(HookMatcherConfigSchema).optional(),
      SessionEnd: z.array(HookMatcherConfigSchema).optional(),
      TaskCreated: z.array(HookMatcherConfigSchema).optional(),
      TaskCompleted: z.array(HookMatcherConfigSchema).optional(),
      CwdChanged: z.array(HookMatcherConfigSchema).optional(),
    })
    .strict()
    .optional(),
});

export const DefaultHooksRuntimeConfig: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32768,
  timeoutMs: 60000,
};

export * from "./workspace-hook-trust.js";
export * from "./workspace-hook-trust-store.js";
