// 脚本工作流的取消词汇与 runtime 收尾纪律。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12（实时进度投影）。
//
// 用量幂等、并发累计、失败和取消结算改由 script-workflow-usage-settlement.test.mjs
// 使用真实 runtime、脚本子进程与 SQLite 验证；这里不再把私有方法名当作正确性的依据。
// 保留的源码约束是取消词汇与实例 Map 收尾，投影行为另见 progress-projection 测试。
//
// 取消语义的原始缺陷：
//
// 用户取消被记成脚本故障。catch 块原先无条件写 `status: "failed"` 并发 `workflow_failed`，
//    而适配器把它翻成 `run-settled { status: "errored" }`。后果是一次 TaskStop / Esc 在每一条
//    读面上都显示成「脚本崩了」（TUI 是 danger 红的错误卡，桌面侧栏是错误面板），而词表里
//    本来就有 `cancelled`（SCRIPT_WORKFLOW_RUN_STATUSES），tool port 的 workflowTaskStatus 与
//    终态判定也早就认它——只是从来没被写过。dwf 侧对同一件事走 settleStopped(state, "user")。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RUNTIME = "../packages/cli-workflow/src/script-workflow-runtime.ts";
const CONTRACTS = "../packages/contracts/src/workflow/script.ts";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 只留代码行：注释里逐字引用了被删掉的写法来解释这次修复，不排除就会把「记录了 bug」误判成「bug 还在」。 */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

test("cancelled 确实在存储的状态词表里（不是为这次修复新造的词）", () => {
  const source = readSource(CONTRACTS);
  assert.match(source, /"cancelled",/);
});

test("取消判据只认 run 级 signal，per-agent 超时不算用户取消", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(
    code,
    /const cancelled = options\?\.abortSignal\?\.aborted === true;/,
    "必须用可选链读到 run 级 signal 的 aborted 位",
  );
  // runAgent 里 per-agent 超时用的是 mergedSignal 合出来的**另一个** signal；它中止时
  // run 级 signal 仍未 aborted，那条路是货真价实的失败（activity_failed 冒上来）。
  // 判据若改读别的信号，一次 agent 超时就会被报成「你停的」。
  assert.match(code, /mergedSignal\(options\?\.abortSignal, input\.opts\?\.timeoutMs\)/);
});

test("取消与失败各自写各自的状态词与事件名", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /status: cancelled \? "cancelled" : "failed",/);
  assert.match(
    code,
    /cancelled \? "workflow_cancelled" : "workflow_failed",/,
    "适配器按事件名分流终态词，两个名字必须都在场",
  );
});

test("取消不记 failure：abort reason 恒为「被取消」，记下来只会把主动停止报成带错误的失败", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /\.\.\.\(cancelled \? \{\} : \{ failure: serializeError\(error\) \}\),/);
  // 无条件写 failure 的旧写法一个都不许剩。
  assert.equal(
    code.split("failure: serializeError(error)").length - 1,
    1,
    "failure 只该出现在那一个三元里",
  );
});

test("两张按 run 建键的 Map 都在结算点清项（runtime 实例活整个会话）", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /this\.agentCallCounts\.delete\(run\.id\);/);
  assert.match(code, /this\.statsWrites\.delete\(run\.id\);/);
  assert.match(code, /this\.deps\.progressAdapter\?\.forgetRun\(run\.id\);/);
});
