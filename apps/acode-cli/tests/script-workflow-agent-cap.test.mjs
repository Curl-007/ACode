// 脚本工作流的 agent 调用上限：计数必须按 run 而不是按 runtime 实例。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R9（fail-loud）与技能 §5。
//
// 这是**源码级**断言，不是行为断言，理由如实写在这里：要行为级复现需要桩掉
// ScriptWorkflowStorePort 的 11 个方法 + AgentRuntime facade，并且真的 spawn 子进程跑一段
// 调用 agent() 的脚本——为钉一个作用域错误付这个代价不成比例。仓库对这类「结构性不变量」
// 有源码级断言的先例（dispatch-discipline-prompt.test.mjs:172-188 的去烘焙断言）。
//
// 被钉住的 bug：`callIndex` 曾是 ScriptWorkflowRuntime 的实例字段，而 runtime 实例按**会话**
// memoize（script-workflow-methods.ts 的 `runtime ??= new ScriptWorkflowRuntime(...)`），
// 上限却是**每 run** 1000 的语义。后果是一个会话里累计跑满 1000 次 agent 之后，此后每次
// agent() 都抛 "Workflow agent call limit exceeded"，脚本工作流在该会话里永久失效直到重启；
// 并发的两个 run 还会互相吃对方的额度。另一半 bug 是 validate() 里的 `this.callIndex = 0`——
// validate 根本不派生 agent，它去归零只会清掉某个在飞 run 的计数，让那个 run 的上限形同不存在。
// 这个缺陷在工具条目被摘掉的休眠期不可达，是复活 RunWorkflow 之后才变成活的。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RUNTIME = "../packages/cli-workflow/src/script-workflow-runtime.ts";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("上限常量与技能文档一致（1000），且超限是 throw 而不是静默截断", () => {
  const source = readSource(RUNTIME);
  assert.match(source, /const MAX_WORKFLOW_AGENT_CALLS = 1000;/);
  // fail-loud：静默截断会让 Promise.all 等一个永不结算的 promise，脚本挂死而不是报错。
  assert.match(
    source,
    /if \(used >= MAX_WORKFLOW_AGENT_CALLS\) \{\s*\n\s*throw new Error\(/,
    "超限必须抛错，不得静默返回 null",
  );
});

test("计数按 runId 分桶，不再是单个实例字段", () => {
  const source = readSource(RUNTIME);
  assert.match(source, /private readonly agentCallCounts = new Map<string, number>\(\);/);
  // 旧的实例字段一个都不许剩：留一个就等于把跨 run 累加重新引回来。
  // 只查代码行——字段注释里逐字引用了被删掉的 `this.callIndex = 0` 来解释这次修复，
  // 不排除注释行就会把「记录了 bug」误判成「bug 还在」。
  const codeLines = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const offenders = codeLines.filter((line) => /this\.callIndex|private callIndex/.test(line));
  assert.deepEqual(
    offenders.map((line) => line.trim()),
    [],
    "不得再有实例级 callIndex 字段（注释里提到不算）",
  );
  // 读写都必须以 run.id 为键。
  assert.match(source, /this\.agentCallCounts\.get\(run\.id\)/);
  assert.match(source, /this\.agentCallCounts\.set\(run\.id, callIndex\)/);
});

test("run 结算即清计数，否则长会话里每个 run 漏一条 Map 项", () => {
  const source = readSource(RUNTIME);
  assert.match(source, /this\.agentCallCounts\.delete\(run\.id\)/);
  // 清理必须在读回 finalRun 之前、且在 catch 之后——也就是成功与失败两条路都要经过。
  const deleteIndex = source.indexOf("this.agentCallCounts.delete(run.id)");
  const finalRunIndex = source.indexOf("const finalRun = ");
  // 失败分支的锚点是那条终态事件。它现在是三元（取消 / 失败各发各的事件名，见
  // script-workflow-cancel-and-usage.test.mjs），所以锚在三元本身上而不是某一个事件名：
  // 锚单个名字的话，下一次给终态再加一个词就会又把这条断言弄成空转。
  const catchIndex = source.indexOf('cancelled ? "workflow_cancelled" : "workflow_failed"');
  assert.ok(deleteIndex > 0 && finalRunIndex > 0 && catchIndex > 0, "锚点没找到，请重新核对");
  assert.ok(catchIndex < deleteIndex, "清理必须在失败分支之后（两条路都要走到）");
  assert.ok(deleteIndex < finalRunIndex, "清理必须在返回之前");
});

test("validate() 不再重置任何计数（那是同一个 bug 的另一半）", () => {
  const source = readSource(RUNTIME);
  const validateStart = source.indexOf("async validate(");
  const validateEnd = source.indexOf("async run(", validateStart);
  assert.ok(validateStart > 0 && validateEnd > validateStart, "锚点没找到，请重新核对");
  const validateBody = source.slice(validateStart, validateEnd);
  assert.doesNotMatch(
    validateBody,
    /agentCallCounts\.(set|delete|clear)/,
    "validate 不派生 agent，无权碰任何 run 的计数",
  );
});

test("技能文档不再声称「没有总量上限」——那与 1000 的实际上限矛盾", async () => {
  // 技能是模型唯一的读者。写着「没有上限」会让模型放心地写无界循环，然后在第 1001 次
  // agent() 上把整个 run 连同已积累的结果一起炸掉。
  const skill = readSource(
    "../packages/bundled-skills/skills/script-workflows/SKILL.md",
  );
  assert.doesNotMatch(skill, /no total-agent cap/i, "技能不得再声称没有总量上限");
  assert.match(skill, /1000/, "技能必须写出真实上限");
  assert.match(skill, /fails the whole run|throw/i, "技能必须说明超限的后果是整 run 失败");
});
