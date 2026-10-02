import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ACodeProvider } from "./acode-task-types-core.js";
import { ACODE_NATIVE_AGENT_ENGINE, isAgentEngineId } from "./acode-agent-registry.js";

export const ACODE_AGENT_PROVIDER = ACODE_NATIVE_AGENT_ENGINE satisfies ACodeProvider;
export const ACODE_AGENT_PROVIDER_LABEL = "ACode Agent";
export const ACODE_COMMAND_AGENT_SOURCE = "acodeAgent" satisfies CommandAgentSource;

/**
 * 持久化/协议层的 provider 解析：宽容入参 + 归一出参。
 *
 * 外部引擎槽位（codex/opencode/gemini）已下线（spec: agent-engine-external-slots-removal.md），
 * 但旧持久化 meta_json / 索引行仍可能携带这些值——parse 不能失败，读取时归一：
 * 仅 "glm" 原样通过，其余（含空值与未知值）归一为 undefined，由消费方回退缺省。
 */
export const acodeAgentProviderSchema = z
  .string()
  .optional()
  .transform((value) => (value === ACODE_AGENT_PROVIDER ? ACODE_AGENT_PROVIDER : undefined));

export const ACODE_COMMAND_AGENT_SOURCES = [
  ACODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

/**
 * 引擎归一：合法引擎 id（即 "glm"）原样透传；空值/未知值（含已下线的外部引擎槽位
 * codex/opencode/gemini 旧值）回退 native。这是旧持久化数据无需迁移的唯一归口。
 */
export function normalizeAgentProviderToACodeAgent(
  provider?: ACodeProvider | string | null,
): ACodeProvider {
  return isAgentEngineId(provider) ? provider : ACODE_AGENT_PROVIDER;
}

export function isACodeAgentProvider(
  provider: ACodeProvider | null | undefined,
): provider is ACodeProvider {
  return isAgentEngineId(provider);
}
