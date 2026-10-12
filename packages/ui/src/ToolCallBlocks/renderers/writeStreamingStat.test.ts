import assert from "node:assert/strict";
import test from "node:test";
import { buildZCodeStreamingToolInputPreview } from ""@acode/shared";
import { readWritePhase, readWriteStreamingChangeStat } from "./writeStreamingStat.js";

test("Write generation is distinct from finalized input, approval and execution", () => {
  assert.equal(readWritePhase({ v4Status: "inputStreaming" }, "pending"), "generating");
  assert.equal(
    readWritePhase({ v4Status: "inputStreaming", inputPreviewComplete: true }, "pending"),
    "waiting",
  );
  assert.equal(readWritePhase({ v4Status: "pendingApproval" }, "pending"), "waiting");
  assert.equal(readWritePhase({ v4Status: "running" }, "pending"), "writing");
});

test("only successful Write is shown as written", () => {
  assert.equal(readWritePhase({ v4Status: "success" }, "completed"), "written");
  assert.equal(readWritePhase({ v4Status: "error" }, "completed"), "failed");
  assert.equal(readWritePhase({ v4Status: "cancelled" }, "completed"), "stopped");
  assert.equal(readWritePhase({ v4Status: "unknown" }, "completed"), "waiting");
  assert.equal(readWritePhase({ v4Status: "success" }, "completed", true), "failed");
});

test("legacy Write statuses preserve phase and do not infer success from a path", () => {
  assert.equal(readWritePhase(undefined, "pending"), "generating");
  assert.equal(readWritePhase({ inputPreviewComplete: true }, "pending"), "waiting");
  assert.equal(readWritePhase(undefined, "in_progress"), "writing");
  assert.equal(readWritePhase(undefined, "completed"), "written");
  assert.equal(readWritePhase(undefined, "failed"), "failed");
  assert.equal(readWritePhase(undefined, "stopped"), "stopped");
  assert.equal(readWritePhase({ file_path: "example.ts" }, "unknown"), "waiting");
});

test("streaming Write counts content before the file path arrives", () => {
  const preview = buildZCodeStreamingToolInputPreview('{"content":"first\\nsecond');
  assert.deepEqual(readWriteStreamingChangeStat(preview.input), { added: 2, removed: 0 });
});

test("streaming Write follows the current body as it grows", () => {
  for (const [content, added] of [["first", 1], ["first\nsecond", 2], ["first\nsecond\nthird", 3]] as const) {
    assert.deepEqual(readWriteStreamingChangeStat({ content }), { added, removed: 0 });
  }
});

test("streaming Write uses logical lines without counting a final newline twice", () => {
  assert.deepEqual(readWriteStreamingChangeStat({ content: "first\r\nsecond\r\n" }), {
    added: 2,
    removed: 0,
  });
});

test("missing or empty body does not invent a line count", () => {
  for (const input of [undefined, null, [], {}, { file_path: "example.ts" }, { content: "" }]) {
    assert.equal(readWriteStreamingChangeStat(input), undefined);
  }
});

test("compatible body fields use the same count without requiring a file summary", () => {
  assert.deepEqual(readWriteStreamingChangeStat({ new_text: "first\nsecond" }), {
    added: 2,
    removed: 0,
  });
  assert.deepEqual(readWriteStreamingChangeStat({ fileContent: "first" }), {
    added: 1,
    removed: 0,
  });
});
