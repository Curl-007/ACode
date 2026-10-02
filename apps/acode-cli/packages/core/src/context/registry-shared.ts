// ============================================================
// Shared Section Descriptors - 主/子代理双路径共享实例（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md R7：主路径与子代理路径共享
// **同一个 SectionDescriptor 对象**（消除 cli_prefix / request_user_context /
// current_date / skills 四段的双路径重复维护），但各自保留组装器。
// 共享段文本不含 boundary（两条路径的 boundary 由各自组装器施加，R7），
// 因此同一份文本在两条路径上 hash 一致（R6：manifest 里共享段只有一条）。

import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildSkillsSection } from "./sections/skills.js";
import { skillToolAvailable, type SectionDescriptor } from "./section-descriptors.js";

/**
 * CLI / product prefix：短身份前导块，单独占第 1 个 system block（R4）。
 * 工作流子代理通道跳过（「You are ACode, an interactive coding agent」对一个
 * 只对脚本说话、可能连读文件工具都没有的子代理是错的身份，且走在正确身份段前面）；
 * 普通子代理路径保留（channel 判定在子代理 ctx 里恒为 "default"）。
 */
export const CLI_PREFIX_SECTION: SectionDescriptor = {
  id: "prefix.cli",
  source: "cli_prefix",
  group: "system-stable",
  channel: ["default", "custom"],
  persistable: true,
  // R6：共享段的 manifest owner 指向**共享 descriptor 定义文件**（本文件）——
  // 「一份文本一处所有」的机器化表达；文本构建函数在 sections/cli-prefix.ts。
  owner: "apps/acode-cli/packages/core/src/context/registry-shared.ts",
  enabled: () => true,
  build: () => buildCliPrefixSection(),
};

/**
 * Skills 清单：meta_user 投递（skills_listing attachment），匹配 provider block 布局。
 * guidanceToolNames 是 runtime 当下的工具表；一个 Skill 工具未注册的工作流子代理
 * 被告知「以下技能可经 Skill 工具使用」，只会让它相信自己有一个没有的工具。
 * 表缺席（测试 / 旧调用方 / 子代理路径）时保持既有行为：视为可用。
 */
export const SKILLS_LISTING_SECTION: SectionDescriptor = {
  id: "skills.listing",
  source: "skills",
  group: "meta_user-dynamic",
  channel: "any",
  persistable: false,
  owner: "apps/acode-cli/packages/core/src/context/sections/skills.ts",
  enabled: (ctx) => Boolean(ctx.config.skills) && skillToolAvailable(ctx.config.guidanceToolNames),
  build: (ctx) => {
    const outcome = ctx.config.skills;
    if (!outcome) return null;
    return buildSkillsSection({ outcome, metadataBudget: ctx.config.skillMetadataBudget });
  },
};

/**
 * request 级用户上下文（agentsMd / 项目 memory 索引）：meta_user context_prefix
 * attachment 的第一段。子代理路径的 ctx 只有 userInstructions（memory 字段缺席），
 * 与既有 buildRequestUserContextSection({ userInstructions }) 行为一致。
 */
export const REQUEST_USER_CONTEXT_SECTION: SectionDescriptor = {
  id: "request.user_context",
  source: "request_user_context",
  group: "meta_user-dynamic",
  channel: "any",
  persistable: false,
  owner: "apps/acode-cli/packages/core/src/context/sections/request-user-context.ts",
  enabled: () => true,
  build: (ctx) =>
    buildRequestUserContextSection({
      userInstructions: ctx.config.userInstructions,
      memoryIndexContent: ctx.config.memoryIndexContent,
      memoryRoot: ctx.config.memoryRoot,
    }),
};

/** 当前日期：meta_user context_prefix attachment 的第二段（workspace 指令在前、日期在后）。 */
export const CURRENT_DATE_SECTION: SectionDescriptor = {
  id: "date.current",
  source: "current_date",
  group: "meta_user-dynamic",
  channel: "any",
  persistable: false,
  owner: "apps/acode-cli/packages/core/src/context/sections/current-date.ts",
  enabled: () => true,
  build: (ctx) => buildCurrentDateSection(ctx.config.currentDate),
};
