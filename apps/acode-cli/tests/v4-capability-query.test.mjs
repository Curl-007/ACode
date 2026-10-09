import assert from "node:assert/strict";
import { test } from "node:test";
import { queryV4Capability } from "../packages/bootstrap/src/acode-protocol-v4/capabilities.ts";

test("CLI v4 capability route returns the declared Plan capability", () => {
  assert.deepEqual(queryV4Capability({ capability: "independentPlanState" }), {
    capability: "independentPlanState",
    supported: true,
  });
});

test("CLI v4 capability route rejects missing, extra, and unknown keys", () => {
  assert.throws(() => queryV4Capability({}), /capability/);
  assert.throws(
    () => queryV4Capability({ capability: "independentPlanState", extra: true }),
    /Unrecognized key/,
  );
  assert.throws(() => queryV4Capability({ capability: "futureCapability" }), /expected/);
});
