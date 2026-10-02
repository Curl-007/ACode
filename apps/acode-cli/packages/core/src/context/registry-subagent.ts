// ============================================================
// Subagent Section Registry - 子代理组装路径的声明序注册表（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md R7：子代理路径与主路径**共享 descriptor
// 实例**（cli_prefix / request_user_context / current_date / skills 四段引用
// registry-shared.ts 的同一对象），但**保留独立组装器**（subagent/context-builder.ts：
// 每段各自一条 system message、各自带 ephemeral breakpoint——刻意的 cache 设计，
// 不得「统一」成主路径的 3-block 形态，R4）。
//
// boundary 由子代理组装器施加、不进 descriptor 文本（R7）：agent_prompt 用 "\n"
// （相对 CLI prefix 的单换行左边界），其余 system 段用 "\n\n"。
// 声明序与注册表化前 buildSubagentContextSections 的 push 顺序逐位对应：
// cli_prefix → agent_prompt → notes → environment → request_user_context →
// current_date → skills。

import {
  buildSubagentCommonNotes,
  buildSubagentEnvironmentContext,
} from "../subagent/system-prompt.js";
import { createRegistrySection, type SectionDescriptor } from "./section-descriptors.js";
import {
  CLI_PREFIX_SECTION,
  CURRENT_DATE_SECTION,
  REQUEST_USER_CONTEXT_SECTION,
  SKILLS_LISTING_SECTION,
} from "./registry-shared.js";

const OWNER_PREFIX = "apps/acode-cli/packages/core/src";

/**
 * 子 agent 专属身份/任务 prompt（作者数据 → persistable false）。
 * 空 prompt 不是语义段：trimEnd 后为空则整段缺席，不能让左边界单独成为 system block。
 */
const SUBAGENT_AGENT_PROMPT_SECTION: SectionDescriptor = {
  id: "subagent.agent_prompt",
  source: "subagent_agent_prompt",
  group: "system-stable",
  boundary: "\n",
  channel: "any",
  persistable: false,
  owner: `${OWNER_PREFIX}/context/registry-subagent.ts`,
  enabled: (ctx) => Boolean(ctx.subagent?.agentPrompt.trimEnd()),
  build: (ctx) => {
    const agentPrompt = ctx.subagent?.agentPrompt.trimEnd();
    if (!agentPrompt) return null;
    return createRegistrySection({
      name: "Subagent Agent Prompt",
      source: "subagent_agent_prompt",
      group: "system-stable",
      content: agentPrompt,
    });
  },
};

/** 子 agent 通用操作提醒（静态文本 → persistable true；owner 是文本的归属文件）。 */
const SUBAGENT_NOTES_SECTION: SectionDescriptor = {
  id: "subagent.notes",
  source: "subagent_notes",
  group: "system-stable",
  boundary: "\n\n",
  channel: "any",
  persistable: true,
  owner: `${OWNER_PREFIX}/subagent/system-prompt.ts`,
  enabled: () => true,
  build: () =>
    createRegistrySection({
      name: "Subagent Notes",
      source: "subagent_notes",
      group: "system-stable",
      content: buildSubagentCommonNotes(),
    }),
};

/** 子 agent 环境和模型上下文（cwd/git/OS/model 行，运行期数据 → persistable false）。 */
const SUBAGENT_ENVIRONMENT_SECTION: SectionDescriptor = {
  id: "subagent.environment",
  source: "subagent_environment",
  group: "system-dynamic",
  boundary: "\n\n",
  channel: "any",
  persistable: false,
  owner: `${OWNER_PREFIX}/subagent/system-prompt.ts`,
  enabled: () => true,
  build: (ctx) =>
    createRegistrySection({
      name: "Subagent Environment",
      source: "subagent_environment",
      group: "system-dynamic",
      content: buildSubagentEnvironmentContext({
        agentPrompt: ctx.subagent?.agentPrompt ?? "",
        envInfo: ctx.config.envInfo,
        model: ctx.config.model,
      }),
    }),
};

/** 子代理路径注册表（声明序）。共享段与主路径是同一实例（R6：manifest 里只有一条）。 */
export const SUBAGENT_SECTION_REGISTRY: readonly SectionDescriptor[] = Object.freeze([
  CLI_PREFIX_SECTION,
  SUBAGENT_AGENT_PROMPT_SECTION,
  SUBAGENT_NOTES_SECTION,
  SUBAGENT_ENVIRONMENT_SECTION,
  REQUEST_USER_CONTEXT_SECTION,
  CURRENT_DATE_SECTION,
  SKILLS_LISTING_SECTION,
]);
