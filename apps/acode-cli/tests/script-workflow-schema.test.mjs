import assert from "node:assert/strict";
import test from "node:test";

const {
  assertWorkflowOutputSchema,
  buildAgentPrompt,
  parseStructuredResponse,
} = await import("../packages/cli-workflow/src/script-workflow-utils.ts");

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    score: { type: "integer", minimum: 0, maximum: 10 },
  },
  required: ["verdict"],
  additionalProperties: false,
};

test("script workflow schema validates parsed structured output", () => {
  assert.deepEqual(
    parseStructuredResponse('prefix ```json\n{"verdict":"pass","score":8}\n```', REVIEW_SCHEMA),
    { verdict: "pass", score: 8 },
  );
  assert.throws(
    () => parseStructuredResponse('{"verdict":"unknown"}', REVIEW_SCHEMA),
    /does not conform to schema.*\$\.verdict/s,
  );
  assert.throws(
    () => parseStructuredResponse('{"verdict":"pass","extra":true}', REVIEW_SCHEMA),
    /does not conform to schema.*extra/s,
  );
});

test("script workflow rejects unsupported or malformed schema before child execution", () => {
  assert.throws(
    () => assertWorkflowOutputSchema({ type: "object", oneOf: [{ type: "string" }] }),
    /oneOf uses an unsupported keyword/i,
  );
  assert.throws(
    () => assertWorkflowOutputSchema({ type: "string", pattern: "[" }),
    /valid regular expression/i,
  );
  assert.match(
    buildAgentPrompt({
      prompt: "Review the change",
      opts: { schema: REVIEW_SCHEMA },
    }),
    /Return only JSON.*Schema/s,
  );
});
