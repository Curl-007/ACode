// 验收场景 2（specs/lsp-diagnostics-loop.md §7）：deferred 注入单测——
// late 到达 → 队列 → drain 产出 reminder 文本；同文件再变更 → stale 丢弃；
// 去重后空结果不入队。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DeferredDiagnostics,
  DeferredDiagnosticsQueue,
  FileMutationVersions,
  formatDeferredDiagnosticsReminder,
} from "../src/lsp/deferred-diagnostics.js";
import { DiagnosticsLedger } from "../src/lsp/diagnostics-ledger.js";

function makeOwner() {
  const ledger = new DiagnosticsLedger();
  const versions = new FileMutationVersions();
  const queue = new DeferredDiagnosticsQueue();
  const deferred = new DeferredDiagnostics({ ledger, versions, queue });
  return { ledger, versions, queue, deferred };
}

function result(messages: string[]) {
  return { server: "stub", messages, summary: "1 error(s)", errored: true };
}

test("late diagnostics flow through begin -> onDeferredDiagnostics -> queue", () => {
  const owner = makeOwner();
  const handle = owner.deferred.begin("/repo/a.ts");
  // 内联没拿到结果：挂起句柄。
  handle.finalize(undefined);
  handle.onDeferredDiagnostics(result(["a.ts:3:1 [error] boom"]));
  assert.equal(owner.queue.size, 1);

  const entries = owner.queue.drain();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.path, "/repo/a.ts");
  assert.deepEqual(entries[0]!.messages, ["a.ts:3:1 [error] boom"]);
});

test("stale deferred entries are dropped at drain time", () => {
  const owner = makeOwner();
  const handle = owner.deferred.begin("/repo/a.ts");
  handle.finalize(undefined);
  // 送达前同文件又发生一次变更 → 版本前进。
  const handle2 = owner.deferred.begin("/repo/a.ts");
  assert.notEqual(handle, handle2);
  handle.onDeferredDiagnostics(result(["a.ts:3:1 [error] boom"]));

  const entries = owner.queue.drain();
  assert.deepEqual(entries, [], "被更新变更超越的迟到诊断必须丢弃");
});

test("deduplicated-empty results do not enqueue", () => {
  const owner = makeOwner();
  // 第一轮把身份记进 ledger。
  owner.ledger.reduce("/repo/b.ts", result(["b.ts:3:1 [error] boom"]));
  const handle = owner.deferred.begin("/repo/b.ts");
  handle.finalize(undefined);
  handle.onDeferredDiagnostics(result(["b.ts:3:1 [error] boom"]));
  assert.equal(owner.queue.size, 0, "ledger 去重后无新增 → 不入队");
});

test("drain returns reminder text and clears the queue", () => {
  const owner = makeOwner();
  const handle = owner.deferred.begin("/repo/c.ts");
  handle.finalize(undefined);
  handle.onDeferredDiagnostics(result(["c.ts:5:5 [error] late arrival"]));

  const entries = owner.queue.drain();
  const text = formatDeferredDiagnosticsReminder(entries);
  assert.match(text, /Deferred diagnostics/);
  assert.match(text, /c\.ts:5:5 \[error\] late arrival/);
  assert.equal(owner.queue.size, 0);
});

test("finalize with inline result aborts the deferred fetch", () => {
  const owner = makeOwner();
  const handle = owner.deferred.begin("/repo/d.ts");
  // 内联已拿到结果：句柄完成、signal 终止——writethrough 调用方按
  // `!deferred.signal.aborted` 守门后才送达（omp 同契约）。
  handle.finalize(result(["d.ts:1:1 [error] inline"]));
  assert.equal(handle.signal.aborted, true, "finalize 有结果 → signal 终止");
  if (!handle.signal.aborted) {
    handle.onDeferredDiagnostics(result(["d.ts:2:2 [error] late"]));
  }
  assert.equal(owner.queue.size, 0);
});
