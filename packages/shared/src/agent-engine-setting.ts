// ============================================================
// Agent 引擎选择的 App 设置档位归一化（spec: agent-engine-jcode-slot.md R6/R7）
// ============================================================
// 与 tool-search-feature.ts / script-workflow-feature.ts 同形态的**本机产品开关**：
// 只读 AppSettings，没有远端下发 key、没有环境变量覆盖（jcode 二进制路径走独立的
// jcodeBinaryPath 设置字段 + spawn env，见 R5，刻意不走 ACODE_AGENT_SERVER_COMMAND——
// 那条通道打包态被 agent-command-env-gate.md R1 禁用）。
//
// 取值域**复用** acode-agent-registry 的 ACODE_AGENT_ENGINE_IDS + isAgentEngineId，
// 不另立一份（避免引擎清单在两处漂移）：当前 ["glm","jcode"]，缺省 glm。

import {
  ACODE_AGENT_ENGINE_IDS,
  ACODE_NATIVE_AGENT_ENGINE,
  isAgentEngineId,
  type ACodeAgentEngineId,
} from "./acode-agent-registry.js";

/** 引擎设置的取值域（= 注册表 IDS，单一事实源）。 */
export const AGENT_ENGINE_SETTING_MODES = ACODE_AGENT_ENGINE_IDS;
export type AgentEngineSettingMode = ACodeAgentEngineId;

/**
 * 缺省 = native glm（spec R6）：未设置/非法值一律回退 native，与
 * normalizeAgentProviderToACodeAgent / acodeAgentProviderSchema 同口径。
 * 与 toolSearchMode 一样**刻意不给 schema `.default()`**——避免把某档冻结进用户配置、
 * 将来改默认救不回；缺席即回退由本函数在读取侧兜。
 */
export const DEFAULT_AGENT_ENGINE_SETTING: AgentEngineSettingMode = ACODE_NATIVE_AGENT_ENGINE;

/**
 * 归一化引擎设置：合法引擎 id 原样通过，非法/形状错误/空值归一为 undefined，
 * 由调用方落 DEFAULT_AGENT_ENGINE_SETTING（与 normalizeToolSearchAppMode 同构）。
 */
export function normalizeAgentEngineSetting(value: unknown): AgentEngineSettingMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isAgentEngineId(trimmed) ? trimmed : undefined;
}

/** 归一化并落缺省：读取设置时的便捷入口（缺省 glm）。 */
export function resolveAgentEngineSetting(value: unknown): AgentEngineSettingMode {
  return normalizeAgentEngineSetting(value) ?? DEFAULT_AGENT_ENGINE_SETTING;
}
