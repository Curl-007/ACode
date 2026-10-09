import assert from "node:assert/strict";
import { test } from "node:test";
import {
  V4_CAPABILITY_KEYS,
  V4_METHODS,
  v4CapabilityQueryParamsSchema,
  v4CapabilityQueryResultSchema,
} from "@acode/shared/acode-protocol-v4";
import { ensureIndependentPlanSupport } from "../src/acode-agent/independentPlanSupport.js";

type Response = { capability: string; supported: boolean };

function createClient(respond: (params: unknown) => Response | Promise<Response> | never): {
  calls: Array<{ method: string; params: unknown }>;
  request: (
    method: string,
    params: unknown,
    resultSchema: typeof v4CapabilityQueryResultSchema,
  ) => Promise<Response>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request(method, params, resultSchema) {
      calls.push({ method, params });
      return resultSchema.parse(await respond(params));
    },
  };
}

test("capability query uses strict v4 method and shares concurrent requests", async () => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = createClient(() => response);

  const first = ensureIndependentPlanSupport(client);
  const second = ensureIndependentPlanSupport(client);
  assert.strictEqual(first, second, "concurrent checks must share one promise");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.method, V4_METHODS.capabilitiesQuery);
  assert.deepEqual(v4CapabilityQueryParamsSchema.parse(client.calls[0]?.params), {
    capability: V4_CAPABILITY_KEYS.independentPlanState,
  });

  release({ capability: V4_CAPABILITY_KEYS.independentPlanState, supported: true });
  await Promise.all([first, second]);
  await ensureIndependentPlanSupport(client);
  assert.equal(client.calls.length, 1, "successful result remains cached");
});

test("false or malformed capability results fail closed and can retry", async () => {
  const responses: Array<Response | Promise<Response>> = [
    { capability: V4_CAPABILITY_KEYS.independentPlanState, supported: false },
    { capability: V4_CAPABILITY_KEYS.independentPlanState, supported: true },
  ];
  const client = createClient(() => responses.shift()!);

  await assert.rejects(ensureIndependentPlanSupport(client), (error: unknown) => {
    assert.equal((error as Error).message, "proto.independentPlanUnsupported");
    return true;
  });
  await ensureIndependentPlanSupport(client);
  assert.equal(client.calls.length, 2, "unsupported result must be retriable");

  const malformed = createClient(
    () => ({ capability: V4_CAPABILITY_KEYS.independentPlanState }) as Response,
  );
  await assert.rejects(
    ensureIndependentPlanSupport(malformed),
    /proto\.independentPlanUnsupported/,
  );
  await assert.rejects(
    ensureIndependentPlanSupport(malformed),
    /proto\.independentPlanUnsupported/,
  );
  assert.equal(malformed.calls.length, 2, "schema failure must clear the cache");
});

test("method-not-found is unsupported and retries after a later CLI becomes capable", async () => {
  let attempt = 0;
  const client = createClient(() => {
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("Method not found: v4/capabilities/query") as Error & {
        code?: number;
      };
      error.code = -32601;
      throw error;
    }
    return { capability: V4_CAPABILITY_KEYS.independentPlanState, supported: true };
  });

  await assert.rejects(ensureIndependentPlanSupport(client), /proto\.independentPlanUnsupported/);
  await ensureIndependentPlanSupport(client);
  assert.equal(client.calls.length, 2);
});

test("v4 schemas reject unknown and extra capability fields", () => {
  assert.throws(() => v4CapabilityQueryParamsSchema.parse({}), /capability/);
  assert.throws(
    () =>
      v4CapabilityQueryParamsSchema.parse({
        capability: V4_CAPABILITY_KEYS.independentPlanState,
        extra: true,
      }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      v4CapabilityQueryResultSchema.parse({
        capability: "futureCapability",
        supported: true,
      }),
    /independentPlanState/,
  );
});
