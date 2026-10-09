// 脚本工作流「取消链」与结果回传的守护。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12 与验收场景 17 / 31。
//
// 这一组缺陷全部是**真实跑一遍才发现**的，单测与 typecheck 一个都没拦住，所以每条断言旁边
// 都写清了它在真实面上原本表现成什么样子：
//
// 1) TaskStop 停不掉脚本工作流。`stopBackgroundTask` 的分派是显式列举 taskType 的，
//    列举之外一律落进兜底 unsupported；`local_workflow` 不在列举里。于是端口上明明有 cancel、
//    background-tasks.ts 也照实把 cancellable 报成 true，TaskStop 却回答
//    "Task wf_… cannot be stopped"（reason=background_task_cancel_not_supported）。
//    报得出能力、走不到能力。
// 2) 取消会把宿主进程打死。TaskStop 打通之后子进程被 kill，而在飞的 agent 请求此时正要回写
//    响应——往对端已关闭的管道写 → EPIPE → stdin 上没有 'error' 监听器 → Node 抛成未捕获异常
//    → 整个 CLI 退出码 1，run 没有结算、用户连一句错误都看不到。
// 3) headless 下 RunWorkflow 必然被拒。createHeadlessPermissionBroker 只按名放行
//    CreateWorkflow / AmendWorkflow，而 RunWorkflow 同样带 alwaysAsk，于是 -p 下退到
//    deny broker，错误文案 "No permission client configured for RunWorkflow"。
// 4) 脚本的 return 值从不回传。run 记录没有 result 列，值只落在 workflow_completed 事件里，
//    而 formatScriptWorkflowRun 不印它——技能 §2 却明写「return 是 run 交回结果的方式」。
//    真实跑一遍时模型确实什么值都收不到，只能靠读脚本源码去猜。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatScriptWorkflowRun } from "../packages/cli-workflow/src/script-workflow-format.ts";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 只留代码行：注释里逐字引用了被修掉的写法来解释这次修复，不排除就会把「记录了 bug」误判成「bug 还在」。 */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const RUN = {
  budgetSpent: 0,
  createdAt: 0,
  cwd: "/tmp",
  id: "wf_fmt-test",
  kind: "script",
  name: "fmt",
  scriptHash: "h",
  status: "completed",
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// 4) 结果回传（纯函数，行为级断言）
// ---------------------------------------------------------------------------

test("脚本的 return 值回传进 run 响应", () => {
  const text = formatScriptWorkflowRun({
    activities: [],
    result: { firstLine: "packages:", ok: true },
    run: RUN,
  });
  assert.match(text, /^result: /m, "结果必须自成一节，别与 stats 挤在一行");
  // JSON.stringify 保留插入序，所以键序跟对象字面量一致——不要按字母序去断言它。
  assert.match(text, /result: \{"firstLine":"packages:","ok":true\}/);
});

test("没有 return 值时不印 result 节（缺席与 undefined 是同一件事，不编造）", () => {
  const without = formatScriptWorkflowRun({ activities: [], run: RUN });
  assert.equal(/^result: /m.test(without), false);
  const explicit = formatScriptWorkflowRun({ activities: [], result: undefined, run: RUN });
  assert.equal(
    explicit,
    without,
    "显式传 undefined 必须与不传逐字节相同——事后 status() 查历史 run 走的就是这条路",
  );
});

test("超长结果截断且**明说**被截断（静默截断会让调用方以为拿到的就是全部）", () => {
  const huge = { blob: "x".repeat(20_000) };
  const text = formatScriptWorkflowRun({ activities: [], result: huge, run: RUN });
  const line = text.split("\n").find((entry) => entry.startsWith("result: "));
  assert.ok(line.length < 9_000, `结果节必须有界，实际 ${line.length} 字符`);
  assert.match(line, /\(truncated from \d+ chars\)$/);
});

test("结果格式化失败不得拖垮整条响应（循环引用退到 String()）", () => {
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  const text = formatScriptWorkflowRun({ activities: [], result: cyclic, run: RUN });
  assert.match(text, /^workflow completed · fmt$/m, "状态行必须还在");
  assert.match(text, /^result: /m, "格式化失败也要给出一节，而不是整条响应消失");
});

// ---------------------------------------------------------------------------
// 1) 取消分派
// ---------------------------------------------------------------------------

test("stopBackgroundTask 显式列举了 local_workflow 这一支", () => {
  const code = codeLines(readSource("../packages/core/src/runtime/methods/background.ts"));
  // 分派是显式列举 + 兜底 unsupported；少一支就静默落进兜底，报成「不支持取消」。
  assert.match(code, /if \(target\.taskType === "local_workflow"\) \{/);
  assert.match(code, /return stopScriptWorkflowBackgroundTask\.call\(this, target, unsupportedBackgroundStopResult\);/);
  assert.match(code, /import \{ stopScriptWorkflowBackgroundTask \} from "\.\/background-stop-script-workflow\.js";/);
});

test("脚本工作流的停止分支走 WorkflowPort.cancel，且端口没有 cancel 时诚实报不支持", () => {
  const code = codeLines(
    readSource("../packages/core/src/runtime/methods/background-stop-script-workflow.ts"),
  );
  assert.match(code, /const port = this\.workflowPort;/);
  // cancel 在契约上是**可选**方法：缺席时必须落到 unsupported，不能答应一件做不到的事。
  assert.match(code, /if \(!port \|\| typeof port\.cancel !== "function"\) \{/);
  assert.match(code, /const cancelled = await port\.cancel\(target\.taskId\);/);
  // 两套系统的任务类型词不同，写错一个 TaskOutput 就认不出这条任务。
  assert.equal(code.split('type: "local_workflow"').length - 1, 2, "成功与 not_found 两条都要报 local_workflow");
  assert.equal(/local_dynamic_workflow/.test(code), false, "这一支不得混用 dwf 的任务类型词");
});

test("workflowPort 真的挂到了 runtime 实例上（否则分派拿到了也是 undefined）", () => {
  const internal = codeLines(readSource("../packages/core/src/runtime/internal.ts"));
  assert.match(internal, /workflowPort\?: WorkflowPort;/, "internal 必须暴露它，runtime 方法面才拿得到");

  const runtime = codeLines(readSource("../packages/core/src/runtime/agent-runtime.ts"));
  assert.match(runtime, /private workflowPort\?: WorkflowPort;/);
  assert.match(runtime, /this\.workflowPort = deps\.workflowPort;/);
});

// ---------------------------------------------------------------------------
// 2) EPIPE 不得打死宿主
// ---------------------------------------------------------------------------

test("子进程 stdin 挂了 error 监听器，且写入走回调形式", () => {
  const code = codeLines(readSource("../packages/cli-workflow/src/script-workflow-process.ts"));
  // 这两条缺一不可：只挂监听器，同步的写失败仍可能抛；只用回调，流上异步 emit 的
  // 'error' 仍然没有接收者，Node 会把它抛成未捕获异常。
  assert.match(code, /child\.stdin\?\.on\("error", \(\) => undefined\);/);
  assert.match(code, /child\.stdin\.destroyed \|\| child\.stdin\.writableEnded/);
  assert.match(
    code,
    /child\.stdin\.write\(`\$\{JSON\.stringify\(\{ kind: "response", \.\.\.message \}\)\}\\n`, \(\) => undefined\);/,
  );
});

// ---------------------------------------------------------------------------
// 3) headless 审批旁路
// ---------------------------------------------------------------------------

test("headless 旁路放行 RunWorkflow（否则 -p 下第二套系统必然被拒）", () => {
  const code = codeLines(readSource("../packages/cli/src/headless-workflow.ts"));
  assert.match(code, /RUN_WORKFLOW_TOOL_NAME,/);
  assert.match(code, /request\.toolName !== RUN_WORKFLOW_TOOL_NAME/);
  // 旁路只认这三个带 alwaysAsk 的工作流入口，其余工具必须仍委托回同一个 deny broker——
  // 名单放宽就等于把 headless 变成无审批面。
  const allows = code.match(/request\.toolName !== [A-Z_]+/g) ?? [];
  assert.deepEqual(
    allows.sort(),
    [
      "request.toolName !== AMEND_WORKFLOW_TOOL_NAME",
      "request.toolName !== CREATE_WORKFLOW_TOOL_NAME",
      "request.toolName !== RUN_WORKFLOW_TOOL_NAME",
    ],
    "放行名单必须恰好是这三个，多一个都是 headless 审批面的漏口",
  );
});
