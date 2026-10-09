import test from "node:test";
import assert from "node:assert/strict";

const { countPhysicalLines } = await import("../../../scripts/architecture/ratchet.mjs");

test("architecture ratchet counts terminal LF/CRLF consistently", () => {
  assert.equal(countPhysicalLines("a"), 1);
  assert.equal(countPhysicalLines("a\n"), 1);
  assert.equal(countPhysicalLines("a\r\nb\r\n"), 2);
});

test("architecture ratchet observes a real extra line", () => {
  const atLimit = `${"x\n".repeat(400)}`;
  const overLimit = `${atLimit}x\n`;
  assert.equal(countPhysicalLines(atLimit), 400);
  assert.equal(countPhysicalLines(overLimit), 401);
});
