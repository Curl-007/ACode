import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { WorkspaceHookReviewTrustState } from "./acode-protocol-v4/workspace-hook-review.js";

/**
 * Hook 事件面全集（apps/acode-cli/specs/hook-event-surface.md F9）：与 CLI contracts
 * 的 HookEventName 词汇叶子同步（17 成员，顺序一致）。这是展示/审查面的类型——
 * 用户配置文件（acode.json hooks）的可写事件面仍由 workspace-hook-config.ts 的
 * strict schema 钉在存量 7 事件（D1/F2 裁决：信任 digest 演进策略未定前不扩），
 * 新事件当前经插件 hooks.json 与程序化配置面（HooksRuntimeConfigPatch）可达。
 */
export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact"
  | "PreModelSwitch"
  | "PostModelSwitch"
  | "SessionEnd"
  | "TaskCreated"
  | "TaskCompleted"
  | "CwdChanged";

export type HookType = "command" | "process";

export interface HookConfiguredState {
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  sourcePath: string;
}

export interface WorkspaceHookDiscoveryState extends HookConfiguredState {
  reviewItemId: string;
  workspaceIdentity: string;
  bundleDigest: string;
  hookDeclarationDigest: string;
  sourceFileIndex: number;
  /** Read-only Settings evaluation; a live Runtime review projection overrides this value. */
  trustState?: WorkspaceHookReviewTrustState;
}

export interface Hook {
  id: string;
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled: boolean;
  editable?: boolean;
  configuredState?: HookConfiguredState;
  workspaceHook?: WorkspaceHookDiscoveryState;
  custom?: Record<string, unknown>;
  location?: SettingsDirectoryLocation;
}

export interface HookConfig {
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled?: boolean;
  custom?: Record<string, unknown>;
  storageLevel?: "user" | "project";
}

/**
 * Metadata for hook identification in tool calls.
 * Used in both chat-panel.types.ts and conversationStore.ts.
 */
export interface ToolCallHookMeta {
  isHook?: boolean;
  hookEvent?: string;
  hookCommand?: string;
  hookMatcher?: string;
  hookToolName?: string;
  hookExitCode?: number | null;
  hookError?: string;
  hookStdout?: string;
  hookName?: string;
  hookFeedback?: string;
  hookStderr?: string;
  /** Skill-related metadata */
  "acode/isSkill"?: boolean;
  "acode/skillName"?: string;
  [key: string]: unknown;
}
