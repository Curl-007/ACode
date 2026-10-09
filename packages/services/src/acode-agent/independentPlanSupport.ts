import type { ACodeProtocolClient } from "./acodeProtocolClient.js";
import {
  V4_CAPABILITY_KEYS,
  V4_METHODS,
  v4CapabilityQueryParamsSchema,
  v4CapabilityQueryResultSchema,
} from "@acode/shared/acode-protocol-v4";

const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<ACodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(
      V4_METHODS.capabilitiesQuery,
      v4CapabilityQueryParamsSchema.parse({ capability: V4_CAPABILITY_KEYS.independentPlanState }),
      v4CapabilityQueryResultSchema,
    )
    .then((result) => {
      if (
        result.capability !== V4_CAPABILITY_KEYS.independentPlanState ||
        result.supported !== true
      ) {
        throw new Error("proto.independentPlanUnsupported");
      }
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}
