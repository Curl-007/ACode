import {
  V4_CAPABILITY_KEYS,
  v4CapabilityQueryParamsSchema,
  v4CapabilityQueryResultSchema,
  type V4CapabilityQueryResult,
} from "@acode/shared/acode-protocol-v4";

/**
 * Resolve the v4 capability query at the CLI protocol boundary. Parsing is
 * intentionally strict so malformed or future capability keys cannot become
 * an accidental opt-in.
 */
export function queryV4Capability(rawParams: unknown): V4CapabilityQueryResult {
  const params = v4CapabilityQueryParamsSchema.parse(rawParams);
  return v4CapabilityQueryResultSchema.parse({
    capability: params.capability,
    supported: params.capability === V4_CAPABILITY_KEYS.independentPlanState,
  });
}
