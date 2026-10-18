// 验收场景 1（specs/lsp-diagnostics-loop.md §7）：ledger 去重单测——
// 同一诊断第二轮不重复；新增一条只报新增；全消失后条目删除；身份去位置。
import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticsLedger, diagnosticIdentity } from "../src/lsp/diagnostics-ledger.js";
import type { FileDiagnosticsResult } from "../src/lsp/types.js";

function result(messages: string[]): FileDiagnosticsResult {
  return { server: "stub", messages, summary: messages.length > 0 ? "1 error(s)" : "no issues", errored: messages.length > 0 };
}

test("diagnosticIdentity strips location prefix (severity tag stays, omp 同语义)", () => {
  // omp 的身份 = 消息剥掉 `path:line:col ` 前缀；[severity] 与正文保留，
  // 让 summarizeDiagnosticMessages 能从身份消息恢复计数。
  assert.equal(diagnosticIdentity("src/a.ts:3:5 [error] foo is not defined (2304)"), "[error] foo is not defined (2304)");
  assert.equal(diagnosticIdentity("C:\\repo\\a.tsx:12:1 [error] bar (2345)"), "[error] bar (2345)");
  // 无位置前缀的身份保持原样。
  assert.equal(diagnosticIdentity("bare message"), "bare message");
});

test("ledger reports fresh diagnostics only", () => {
  const ledger = new DiagnosticsLedger();
  const first = ledger.reduce("/repo/a.ts", result(["a.ts:1:1 [error] alpha", "a.ts:2:2 [error] beta"]));
  assert.deepEqual(first.messages, ["a.ts:1:1 [error] alpha", "a.ts:2:2 [error] beta"]);

  // 第二轮同样两条：全部已见 → messages 空、summary 归零。
  const second = ledger.reduce("/repo/a.ts", result(["a.ts:1:1 [error] alpha", "a.ts:2:2 [error] beta"]));
  assert.deepEqual(second.messages, []);
  assert.equal(second.summary, "no issues");
  assert.equal(second.errored, false);
});

test("ledger reports only the delta when one diagnostic is new", () => {
  const ledger = new DiagnosticsLedger();
  ledger.reduce("/repo/b.ts", result(["b.ts:1:1 [error] alpha"]));
  const delta = ledger.reduce("/repo/b.ts", result(["b.ts:1:1 [error] alpha", "b.ts:9:9 [error] gamma"]));
  assert.deepEqual(delta.messages, ["b.ts:9:9 [error] gamma"]);
  assert.equal(delta.errored, true);
});

test("ledger deletes the entry when identities become empty", () => {
  const ledger = new DiagnosticsLedger();
  ledger.reduce("/repo/c.ts", result(["c.ts:1:1 [error] alpha"]));
  assert.equal(ledger.seenIdentitiesFor("/repo/c.ts").size, 1);
  ledger.reduce("/repo/c.ts", result([]));
  assert.equal(ledger.seenIdentitiesFor("/repo/c.ts").size, 0);

  // 清空后同样的诊断再次出现视为新增。
  const again = ledger.reduce("/repo/c.ts", result(["c.ts:1:1 [error] alpha"]));
  assert.equal(again.messages.length, 1);
});

test("ledger keys are per file", () => {
  const ledger = new DiagnosticsLedger();
  ledger.reduce("/repo/d.ts", result(["d.ts:1:1 [error] alpha"]));
  const other = ledger.reduce("/repo/e.ts", result(["d.ts:1:1 [error] alpha"]));
  assert.equal(other.messages.length, 1, "相同身份在不同文件各自记账");
});
