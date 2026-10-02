// ============================================================
// Main Section Registry - 主组装路径的声明序注册表（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md R1/R2/R5：段的启用条件唯一所有者是
// descriptor 的 channel + enabled；builder.ts 的 build() 不再出现「某段是否 push」
// 的散落 if。声明序 = 注入顺序（orderSectionsForInjection 做分组稳定排序，
// 同组内按注册序），与注册表化前 build() 的 push 顺序逐位对应：
// cli_prefix → 身份体三选一 → desktop → dynamic_behavior → guidance 两组 →
// memory → env_info → output_style → context_management → git 快照 →
// skills → request_user_context → current_date。
//
// 段文本唯一所有者是各 sections/*.ts / dynamic-sections.ts 构建函数（R1）；
// 本文件只做登记与条件，不内联文本常量（identity.custom 的换行前缀除外——
// 它是原 builder.ts createSection 的内联段，文本即用户数据，无独立 owner 文件）。

import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
import { buildMemorySection } from "./sections/memory.js";
import {
  buildContextManagementSection,
  buildDelegatingWorkGroupSection,
  buildDynamicBehaviorSection,
  buildOutputStyleSection,
  buildSessionGuidanceGroupSection,
} from "./dynamic-sections.js";
import {
  createRegistrySection,
  resolveActiveOutputStyle,
  type SectionDescriptor,
} from "./section-descriptors.js";
import {
  CLI_PREFIX_SECTION,
  CURRENT_DATE_SECTION,
  REQUEST_USER_CONTEXT_SECTION,
  SKILLS_LISTING_SECTION,
} from "./registry-shared.js";

const OWNER_PREFIX = "apps/acode-cli/packages/core/src/context";

/** custom 通道身份体：原 builder.ts 步骤 2 的 custom_system_prompt 内联段，逐字保留。 */
const IDENTITY_CUSTOM_SECTION: SectionDescriptor = {
  id: "identity.custom",
  source: "custom_system_prompt",
  group: "system-stable",
  channel: "custom",
  // 用户提供的提示词全文：含用户数据，不得进 manifest（R6）。
  persistable: false,
  critical: true,
  owner: `${OWNER_PREFIX}/registry-main.ts`,
  enabled: () => true,
  build: (ctx) => {
    const customSystemPrompt = ctx.config.customSystemPrompt?.trim();
    return createRegistrySection({
      name: "Custom System Prompt",
      source: "custom_system_prompt",
      group: "system-stable",
      content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
    });
  },
};

/** workflow_actor 通道身份体：契约 + persona 叠加（sections/workflow-actor.ts）。 */
const IDENTITY_WORKFLOW_ACTOR_SECTION: SectionDescriptor = {
  id: "identity.workflow_actor",
  source: "workflow_actor_identity",
  group: "system-stable",
  channel: "workflow_actor",
  // persona 是作者数据：整段含非静态文本，不进 manifest（R6）。
  persistable: false,
  critical: true,
  owner: `${OWNER_PREFIX}/sections/workflow-actor.ts`,
  enabled: () => true,
  build: (ctx) => {
    const actor = ctx.config.workflowActor;
    return actor === undefined ? null : buildWorkflowActorIdentitySection(actor);
  },
};

/** default 通道身份体：交互式 Agent Identity（含安全 IMPORTANT 行与 # Harness 块）。 */
const IDENTITY_DEFAULT_SECTION: SectionDescriptor = {
  id: "identity.default",
  source: "identity",
  group: "system-stable",
  channel: "default",
  persistable: true,
  critical: true,
  owner: `${OWNER_PREFIX}/sections/identity.ts`,
  enabled: () => true,
  build: (ctx) => buildIdentitySection(resolveActiveOutputStyle(ctx.config)),
};

/** ACode Desktop 渲染与交互协议：仅 desktop 呈现面 + default 通道（R5 通道过滤）。 */
const DESKTOP_SURFACE_SECTION: SectionDescriptor = {
  id: "surface.desktop",
  source: "desktop_context",
  group: "system-stable",
  channel: "default",
  persistable: true,
  owner: `${OWNER_PREFIX}/sections/desktop.ts`,
  enabled: (ctx) => ctx.config.presentationSurface === "acode_desktop",
  build: () => buildDesktopContextSection(),
};

/** 动态行为边界（沟通/确认/如实汇报纪律）：面向与用户对话的会话，default 通道专属。 */
const DYNAMIC_BEHAVIOR_SECTION: SectionDescriptor = {
  id: "behavior.dynamic",
  source: "dynamic_behavior",
  group: "system-dynamic",
  channel: "default",
  persistable: true,
  owner: `${OWNER_PREFIX}/dynamic-sections.ts`,
  enabled: () => true,
  build: () => buildDynamicBehaviorSection(),
};

/**
 * "# Session-specific guidance" 组：单工具指导 bullet（Explore 派发判据 / Skill /
 * AskUserQuestion）。文本内嵌工具面名称 → persistable false（R6）。
 * 与 guidance.delegating_work 同 source（session_guidance，R2 一 source 多 id）；
 * 拆分前后组装文本逐字节一致（两段在 dynamic block 内以 "\n\n" 连接，
 * 等价于原单段内的 groups.join("\n\n")）。
 */
const GUIDANCE_SESSION_SECTION: SectionDescriptor = {
  id: "guidance.session",
  source: "session_guidance",
  group: "system-dynamic",
  channel: "default",
  persistable: false,
  owner: `${OWNER_PREFIX}/dynamic-sections.ts`,
  enabled: () => true,
  build: (ctx) =>
    buildSessionGuidanceGroupSection(
      ctx.config.guidanceToolNames,
      (ctx.config.skills?.skills.length ?? 0) > 0,
    ),
};

/**
 * "# Delegating work" 纪律节（D1，specs/dispatch-discipline-prompt.md）：
 * 子代理派发纪律在 system 层的唯一承载点。单独 id 使其可被单独追踪与单独开关
 * （R2；ACODE_PROMPT_SECTIONS_DISABLED=guidance.delegating_work 只摘除本节）。
 * workflow_actor 通道跳过：actor 的纪律由 workflow-actor 契约段承载。
 */
const GUIDANCE_DELEGATING_WORK_SECTION: SectionDescriptor = {
  id: "guidance.delegating_work",
  source: "session_guidance",
  group: "system-dynamic",
  channel: "default",
  persistable: false,
  owner: `${OWNER_PREFIX}/dynamic-sections.ts`,
  enabled: () => true,
  build: (ctx) => buildDelegatingWorkGroupSection(ctx.config.guidanceToolNames),
};

/** 长期 memory 使用守则：需 memoryRoot。custom 通道整块跳过（R5），actor 通道保留。 */
const MEMORY_SECTION: SectionDescriptor = {
  id: "memory.persistent",
  source: "memory",
  group: "system-dynamic",
  channel: ["default", "workflow_actor"],
  // 文本内嵌 memoryRoot 路径（运行期数据）→ 不进 manifest（R6）。
  persistable: false,
  owner: `${OWNER_PREFIX}/sections/memory.ts`,
  enabled: (ctx) => Boolean(ctx.config.memoryRoot),
  build: (ctx) => buildMemorySection(ctx.config.memoryRoot),
};

/** 环境信息（cwd/platform/shell/OS/git boolean/model 行 + not-a-git 指令段）。 */
const ENV_INFO_SECTION: SectionDescriptor = {
  id: "env.info",
  source: "env_info",
  group: "system-dynamic",
  channel: ["default", "workflow_actor"],
  persistable: false,
  owner: `${OWNER_PREFIX}/sections/env-info.ts`,
  enabled: () => true,
  build: (ctx) => buildEnvInfoSection(ctx.config.envInfo, ctx.config.model),
};

/** Output Style 附加指令：仅生效 style 在场（resolveActiveOutputStyle 判定）。 */
const OUTPUT_STYLE_SECTION: SectionDescriptor = {
  id: "style.output",
  source: "output_style",
  group: "system-dynamic",
  channel: ["default", "workflow_actor"],
  // style 名称与 prompt 是用户配置数据 → 不进 manifest（R6）。
  persistable: false,
  owner: `${OWNER_PREFIX}/dynamic-sections.ts`,
  enabled: (ctx) => resolveActiveOutputStyle(ctx.config) !== undefined,
  build: (ctx) => buildOutputStyleSection(resolveActiveOutputStyle(ctx.config)),
};

/** 长上下文管理提示（含「不必提前收尾」+ 自主推进纪律）。 */
const CONTEXT_MANAGEMENT_SECTION: SectionDescriptor = {
  id: "context.management",
  source: "context_management",
  group: "system-dynamic",
  channel: ["default", "workflow_actor"],
  persistable: true,
  owner: `${OWNER_PREFIX}/dynamic-sections.ts`,
  enabled: () => true,
  build: () => buildContextManagementSection(),
};

/** git 快照上下文：仅 git 仓库在场（buildGitSystemContextSection 返回 null 过滤）。 */
const GIT_SNAPSHOT_SECTION: SectionDescriptor = {
  id: "env.git_snapshot",
  source: "system_context",
  group: "system-dynamic",
  channel: ["default", "workflow_actor"],
  persistable: false,
  owner: `${OWNER_PREFIX}/sections/env-info.ts`,
  enabled: () => true,
  build: (ctx) => buildGitSystemContextSection(ctx.config.envInfo),
};

/**
 * 主路径注册表（声明序）。addSection() 的自定义 section 不经注册表，
 * 由组装器在注册段之后追加（既有扩展位语义不变）。
 */
export const MAIN_SECTION_REGISTRY: readonly SectionDescriptor[] = Object.freeze([
  CLI_PREFIX_SECTION,
  IDENTITY_CUSTOM_SECTION,
  IDENTITY_WORKFLOW_ACTOR_SECTION,
  IDENTITY_DEFAULT_SECTION,
  DESKTOP_SURFACE_SECTION,
  DYNAMIC_BEHAVIOR_SECTION,
  GUIDANCE_SESSION_SECTION,
  GUIDANCE_DELEGATING_WORK_SECTION,
  MEMORY_SECTION,
  ENV_INFO_SECTION,
  OUTPUT_STYLE_SECTION,
  CONTEXT_MANAGEMENT_SECTION,
  // ── 可选登记位（本期不实现）────────────────────────────────
  // 「上下文余量倒计时段」：方案 §4 P2 第 5 点登记为可选，Phase 3 评估
  // （ACode 已有 context.management 的「不必提前收尾」+ rapid-refill 熔断，收益存疑）。
  // 落地时在此登记 id "budget.context_countdown"（group: system-dynamic，
  // persistable: false，channel: default），位于 context.management 之后、
  // env.git_snapshot 之前。见 system-prompt-section-registry.md「不在本项范围」。
  GIT_SNAPSHOT_SECTION,
  SKILLS_LISTING_SECTION,
  REQUEST_USER_CONTEXT_SECTION,
  CURRENT_DATE_SECTION,
]);
