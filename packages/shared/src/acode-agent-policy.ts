import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ACodeProvider } from "./acode-task-types-core.js";

export const ACODE_AGENT_PROVIDER = "glm" satisfies ACodeProvider;
export const ACODE_AGENT_PROVIDER_LABEL = "ACode Agent";
export const ACODE_COMMAND_AGENT_SOURCE = "acodeAgent" satisfies CommandAgentSource;

export const acodeAgentProviderSchema = z.literal(ACODE_AGENT_PROVIDER);

export const ACODE_COMMAND_AGENT_SOURCES = [
  ACODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToACodeAgent(
  _provider?: ACodeProvider | null,
): ACodeProvider {
  return ACODE_AGENT_PROVIDER;
}

export function isACodeAgentProvider(
  provider: ACodeProvider | null | undefined,
): provider is typeof ACODE_AGENT_PROVIDER {
  return provider === ACODE_AGENT_PROVIDER;
}
