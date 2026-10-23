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
 * 合法引擎 id（当前 "glm" / "jcode"，见 ACODE_AGENT_ENGINE_IDS）原样通过；其余归一为
 * undefined，由消费方回退缺省 native。
 *
 * 曾是 `value === ACODE_AGENT_PROVIDER ? ... : undefined`（只放行 glm）——那会让 jcode
 * 会话持久化后重载时静默退回 glm（用户以为在用 jcode，实际是 native）。改为与下方
 * normalizeAgentProviderToACodeAgent 同一口径的 isAgentEngineId 判定
 * （spec: agent-engine-jcode-slot.md R6）。
 *
 * 已下线的空槽位 codex/opencode/gemini 不在 IDS 里，仍归一为 undefined——
 * packages/ui/test/nonCliAcpRetirement.test.ts:33-39 守护这条，勿把它们加回 IDS。
 */
export const acodeAgentProviderSchema = z
  .string()
  .optional()
  .transform((value) => (isAgentEngineId(value) ? value : undefined));

export const ACODE_COMMAND_AGENT_SOURCES = [
  ACODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

/**
 * 引擎归一：合法引擎 id（"glm" / "jcode"，见 ACODE_AGENT_ENGINE_IDS）原样透传；
 * 空值/未知值（含已下线的空槽位 codex/opencode/gemini 旧值）回退 native。
 * 这是旧持久化数据无需迁移的唯一归口。
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
