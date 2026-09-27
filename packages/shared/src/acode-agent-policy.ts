import type { CommandAgentSource } from "./command-types.js";
import type { ACodeProvider } from "./acode-task-types-core.js";
import {
  ACODE_NATIVE_AGENT_ENGINE,
  acodeAgentEngineIdSchema,
  isAgentEngineId,
  type ACodeAgentEngineId,
} from "./acode-agent-registry.js";

export const ACODE_AGENT_PROVIDER = ACODE_NATIVE_AGENT_ENGINE satisfies ACodeProvider;
export const ACODE_AGENT_PROVIDER_LABEL = "ACode Agent";
export const ACODE_COMMAND_AGENT_SOURCE = "acodeAgent" satisfies CommandAgentSource;

/**
 * provider 现在覆盖整个引擎联合（native + codex/opencode/gemini）。
 * 旧持久化数据 provider:"glm" 仍是合法缺省，无需迁移。
 */
export const acodeAgentProviderSchema = acodeAgentEngineIdSchema;

export const ACODE_COMMAND_AGENT_SOURCES = [
  ACODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

/**
 * 引擎感知归一：合法引擎 id 原样透传；空值/未知值回退 native。
 *
 * 旧实现无条件返回 "glm"。现在 native 仍是缺省，但 codex/opencode/gemini 这类已注册引擎
 * 不再被吞掉——这是 task meta.provider / bot 配置承载引擎选择的前提。
 */
export function normalizeAgentProviderToACodeAgent(
  provider?: ACodeProvider | string | null,
): ACodeProvider {
  return isAgentEngineId(provider) ? provider : ACODE_AGENT_PROVIDER;
}

export function isACodeAgentProvider(
  provider: ACodeProvider | null | undefined,
): provider is ACodeAgentEngineId {
  return isAgentEngineId(provider);
}
