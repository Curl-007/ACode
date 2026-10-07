// 脚本工作流的取消语义与用量计数的并发正确性。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12（实时进度投影）。
//
// 这是**源码级**断言，不是行为断言，理由与隔壁 script-workflow-agent-cap.test.mjs 逐字同一条：
// 要行为级复现需要桩掉 ScriptWorkflowStorePort 的 11 个方法 + AgentRuntime facade，并真的
// spawn 子进程跑一段调用 agent() 的脚本。投影那一半（事件 → dwf 信封 → reducer）是纯函数，
// 已经在 script-workflow-progress-projection.test.mjs 里做了行为级验证；这里只钉 runtime
// 侧那两个「结构性不变量」——发哪个事件名、写哪个状态词、以及那笔读改写有没有被串行化。
//
// 被钉住的两个缺陷：
//
// 1) 用户取消被记成脚本故障。catch 块原先无条件写 `status: "failed"` 并发 `workflow_failed`，
//    而适配器把它翻成 `run-settled { status: "errored" }`。后果是一次 TaskStop / Esc 在每一条
//    读面上都显示成「脚本崩了」（TUI 是 danger 红的错误卡，桌面侧栏是错误面板），而词表里
//    本来就有 `cancelled`（SCRIPT_WORKFLOW_RUN_STATUSES），tool port 的 workflowTaskStatus 与
//    终态判定也早就认它——只是从来没被写过。dwf 侧对同一件事走 settleStopped(state, "user")。
//
// 2) `addRunStats` 是「读 run → 加 delta → 写回」三步、中间夹两个 await，而 `parallel()` /
//    `pipeline()` 下多个 agent 会并发走到这里：两次调用读到同一个旧值，后写的把先写的增量
//    整个覆盖掉，budgetSpent 与 stats 双双少计。少计本身已经是错，而这个总量现在还要经
//    workflow_usage 投影到卡片上，用户于是会看见 token 数**往回跳**。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RUNTIME = "../packages/bootstrap/src/app/script-workflow-runtime.ts";
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

test("用量计数按 run 串行化，不再是一笔裸的读改写", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /private readonly statsWrites = new Map<string, Promise<void>>\(\);/);
  // 真正落库的那步必须与公开入口分开：入口只负责排队，否则串行化无从谈起。
  assert.match(code, /private addRunStats\(runId: string, delta: ScriptWorkflowRunStats\): Promise<void> \{/);
  assert.match(code, /private async writeRunStats\(runId: string, delta: ScriptWorkflowRunStats\): Promise<void> \{/);
  assert.match(
    code,
    /const next = previous\.then\(\(\) => this\.writeRunStats\(runId, delta\)\);/,
    "后到的写必须挂在前一笔之后",
  );
  // 链上存的是吞掉失败的版本：一次写失败不该把这条 run 后续所有的写都堵死。
  assert.match(code, /this\.statsWrites\.set\(\s*runId,\s*next\.then\(/);
});

test("用量事件发的是累计总量（reducer 直接覆写，发增量会让读数翻倍）", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /const spentTokens = \(run\?\.budgetSpent \?\? 0\) \+ delta\.tokens\.total;/);
  assert.match(code, /await this\.appendEvent\(runId, "workflow_usage", \{ spentTokens \}\);/);
  // 先落库再投影：这条纪律与 appendEvent 自己的注释同源，顺序反了就会出现
  // 「投影里有的数字还没 durable」。按单行标记定位，不锁缩进。
  const writeAt = code.indexOf("budgetSpent: spentTokens,");
  const emitAt = code.indexOf('await this.appendEvent(runId, "workflow_usage"');
  assert.ok(writeAt > -1, "落库那一步必须在场");
  assert.ok(emitAt > -1, "投影那一步必须在场");
  assert.ok(writeAt < emitAt, "落库必须排在投影之前");
});

test("两张按 run 建键的 Map 都在结算点清项（runtime 实例活整个会话）", () => {
  const code = codeLines(readSource(RUNTIME));
  assert.match(code, /this\.agentCallCounts\.delete\(run\.id\);/);
  assert.match(code, /this\.statsWrites\.delete\(run\.id\);/);
  assert.match(code, /this\.deps\.progressAdapter\?\.forgetRun\(run\.id\);/);
});
