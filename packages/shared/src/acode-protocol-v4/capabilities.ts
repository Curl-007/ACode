import { z } from "zod";

/**
 * v4 runtime capability keys. The key set is deliberately closed: a caller
 * must opt into a schema-backed capability before it can be queried.
 */
export const V4_CAPABILITY_KEYS = {
  independentPlanState: "independentPlanState",
} as const;

export const v4CapabilityKeySchema = z.enum([V4_CAPABILITY_KEYS.independentPlanState]);
export type V4CapabilityKey = z.infer<typeof v4CapabilityKeySchema>;

/** Strict, single-capability query. Unknown or misspelled keys are rejected. */
export const v4CapabilityQueryParamsSchema = z
  .object({ capability: v4CapabilityKeySchema })
  .strict();
export type V4CapabilityQueryParams = z.infer<typeof v4CapabilityQueryParamsSchema>;

/**
 * The response repeats the queried key so a stale/misrouted response cannot be
 * interpreted as the answer to another capability. `supported` is the sole
 * affirmative bit; consumers must use `=== true` and otherwise fail closed.
 */
export const v4CapabilityQueryResultSchema = z
  .object({
    capability: v4CapabilityKeySchema,
    supported: z.boolean(),
  })
  .strict();
export type V4CapabilityQueryResult = z.infer<typeof v4CapabilityQueryResultSchema>;
