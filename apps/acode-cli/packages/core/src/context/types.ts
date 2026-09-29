// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Logger,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@acode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { PromptSectionFlags } from "./section-flags.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@acode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI / 产品身份前缀
  | "identity" // Agent 基础描述
  | "env_info" // 环境信息 (cwd, platform, git repo boolean)
  | "system_context" // git snapshot context
  | "skills" // 可用 skills
  | "tools" // 工具定义
  | "request_user_context" // request-level user context provider-visible 组合块
  | "memory" // 长期 memory read path
  | "current_date" // 当前日期
  | "custom_system_prompt" // 自定义 stable system body
  | "workflow_actor_identity" // 动态工作流子代理身份：契约 + persona 叠加
  | "subagent_agent_prompt" // 子 agent 专属身份/任务 prompt
  | "subagent_notes" // 子 agent 通用操作提醒
  | "subagent_environment" // 子 agent 环境和模型上下文
  | "dynamic_behavior" // 动态行为边界
  | "session_guidance" // 当前可用内置能力指导
  | "output_style" // 输出风格
  | "context_management" // 长上下文管理提示
  | "desktop_context"; // ACode Desktop 渲染与交互协议

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "acode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: ContextInjectionTarget; // 注入位置
  cacheHint: ContextCacheHint; // 缓存稳定性提示
  chars: number; // 字符数
  tokens: number; // 估算 token 数
  content: string; // 完整内容
  preview: string; // 前 100 字符预览
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder 只组装 system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // 未包裹 <system-reminder> 的 meta user body
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  envInfo: EnvInfo;
  /** 当前步骤的执行对象，不进入 Context Source 或持久化环境快照。 */
  model?: Model;
  presentationSurface?: PresentationSurface;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * 动态工作流子代理（workflow child）的身份输入。在场即走 builder 的第三条路径：
   * 基座段（CLI prefix、安全行、Harness、memory）+ 工作流子代理契约 + persona 叠加，
   * 而不是像 `customSystemPrompt` 那样整段替换。与 `customSystemPrompt` 互斥。
   */
  workflowActor?: WorkflowActorContext;
  /**
   * **悬空配置：当前没有任何提示词消费方**——没有 section builder、工具描述构建函数或
   * reminder 读它，`ContextBuilder.build()` / `buildAsync()` 全程不引用本字段
   * （只活在 `runtime/methods/config.ts` 的 patch 写入 → `runtime/methods/context.ts`
   * 的透传 → 本声明这条链上）。
   *
   * 按 `specs/prompt-language-policy.md` R1/R4，它**永远不该有**模型面消费方：送给模型的
   * 文本恒英文，不随 locale 分叉（cache 前缀命中、指令遵循一致性、快照/parity 成本三条理由）。
   * 不要把它接进任何段构建；确有需要先改 spec 再改码。
   *
   * 它也**不是** locale：类型是裸 `string`，与 `UiLocale`（`SupportedLocale | "auto"`，
   * `contracts/src/config/index.ts:306-307`）不是同一个类型。UI 语言的唯一真实所有者是
   * `RuntimeConfig.ui.locale`（`contracts/src/config/index.ts:281-283`），本字段不是它的别名，
   * 也不得成为第二个语言所有者。
   */
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
  /**
   * P2 注册表本地诊断旗标的显式覆盖位（ACODE_PROMPT_SECTIONS_DISABLED /
   * ACODE_PROMPT_MANIFEST_TRACE，specs/system-prompt-section-registry.md R3）。
   * 缺席时由管线入口（context/registry.ts）按 spec 的名称/默认值/错误行为解析 env；
   * 在场时优先——这是 RuntimeConfig.prompt 接线落地前的 config 通道。
   */
  prompt?: PromptSectionFlags;
  /** 可选诊断出口：组装管线的 warn（段失败/未知旗标 id）与 manifest trace debug 走它；缺席时静默。 */
  logger?: Logger;
}

/**
 * 工作流子代理的身份输入：有效名（匿名缺席）、作者写的 persona system prompt（可缺席）。
 * 没有工具档位：每个子代理都有完整工作工具集，契约只有一份文本。
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
