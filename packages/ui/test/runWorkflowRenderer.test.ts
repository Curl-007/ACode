import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRunWorkflowToolCall } from "../src/lib/workflowToolNames.js";
import {
  ACODE_KNOWN_TOOL_NAMES,
  getACodeToolFamilyForName,
} from "../../shared/src/tool-identity.js";

/**
 * RunWorkflow（脚本工作流）聊天卡的分流守护。
 *
 * 核心不变量（apps/acode-cli/specs/script-workflow-revival.md R3 补注）：RunWorkflow 必须
 * 按名字在 family 分流**之前**认领自己的卡，且**不得**被登记进 tool-identity 的 workflow
 * family。两条一起才成立——`resolveRenderer.ts` 的 `case "workflow"` 除 submit_result 外
 * 一律返回 CreateWorkflow 卡，而那张卡画的是因果图与 dwf run 投影，脚本工作流一个都没有。
 * 登记 = 落 family = 一张长着别人器官的说谎卡。
 */

test("isRunWorkflowToolCall 认得 RunWorkflow 的几种 wire 写法", () => {
  assert.equal(isRunWorkflowToolCall({ toolName: "RunWorkflow" }), true);
  assert.equal(isRunWorkflowToolCall({ toolName: "run_workflow" }), true, "分隔符与大小写被归一");
  assert.equal(isRunWorkflowToolCall({ toolName: "runworkflow" }), true);
  // 旧 ACode 快照把工具名放在 kind / title 上，raw 里还可能是 tool_name / name。
  assert.equal(isRunWorkflowToolCall({ kind: "RunWorkflow" }), true);
  assert.equal(isRunWorkflowToolCall({ title: "RunWorkflow" }), true);
  assert.equal(isRunWorkflowToolCall({ raw: { tool_name: "RunWorkflow" } }), true);
  assert.equal(isRunWorkflowToolCall({ raw: { name: "RunWorkflow" } }), true);
});

test("isRunWorkflowToolCall 不误认另一套系统的工具，也不误认死名", () => {
  for (const name of [
    "CreateWorkflow",
    "AmendWorkflow",
    "SaveWorkflow",
    "ResumeWorkflowRun",
    "ListWorkflowRuns",
    // 死名：它曾是这套系统的工具名，但条目已移出 builtInTools。若哪天它被误认成
    // RunWorkflow，旧会话 rollout 里的历史调用就会被画成新卡，掩盖它当时的真实形态。
    "Workflow",
  ]) {
    assert.equal(isRunWorkflowToolCall({ toolName: name }), false, name);
  }
  assert.equal(isRunWorkflowToolCall({}), false);
  assert.equal(isRunWorkflowToolCall({ toolName: null }), false);
  assert.equal(isRunWorkflowToolCall({ toolName: 42 }), false);
});

test("RunWorkflow 刻意不登记进 tool-identity（登记会让它落 workflow family 兜底）", () => {
  assert.ok(
    !ACODE_KNOWN_TOOL_NAMES.includes("RunWorkflow" as never),
    "登记进已知工具表 = identity 回 workflow family = 渲染成 CreateWorkflow 卡",
  );
  assert.equal(getACodeToolFamilyForName("RunWorkflow"), null);
  // 对照：dwf 的创建入口是登记了的。这条不是「忘了登记」，而是两套系统的刻意区分。
  assert.equal(getACodeToolFamilyForName("CreateWorkflow"), "workflow");
});

test("resolveRenderer 里 RunWorkflow 的按名分流排在 family 分流之前", () => {
  // 顺序就是这条不变量的全部：排在 family switch 之后等于没排——identity 对未登记的名字
  // 回 unknown，会先落 raw JSON 兜底卡；而一旦有人日后把它登记进 family，就会落
  // CreateWorkflow 卡。两种都不是我们要的。
  const source = readFileSync(new URL("../src/ToolCallBlocks/resolveRenderer.ts", import.meta.url), "utf8");
  const byNameIndex = source.indexOf("isRunWorkflowToolCall(context.toolCallNode.toolCall)");
  const familySwitchIndex = source.indexOf("switch (identity.family)");
  assert.ok(byNameIndex > 0, "resolveRenderer 必须按名认领 RunWorkflow");
  assert.ok(familySwitchIndex > 0, "family 分流点没找到——本断言的前提变了，请重新核对");
  assert.ok(
    byNameIndex < familySwitchIndex,
    "按名分流必须排在 family 分流之前，否则会被兜底卡吞掉",
  );
  // 渲染器本身也要真的接上，光有判定没有卡等于还是兜底。
  assert.match(source, /import \{ RunWorkflowToolCallBlock \}/);
  assert.match(source, /return RunWorkflowToolCallBlock;/);
});

test("确认窗按名认领 RunWorkflow，且早于文件摘要启发式", () => {
  // 两条顺序都承重：
  //   1. 早于 rawFileSummaries —— RunWorkflow 的入参带 scriptPath（一个路径）与完整 script，
  //      「看起来像写文件」的启发式会把它吸进 edit 块，而 edit 块讲的是改哪几个文件、
  //      diff 长什么样，对「批准运行这段编排脚本」是错的语言。SaveWorkflow 早已因此排在最前。
  //   2. 不落 fallback —— fallback 把整包 toolCall JSON 摊开，脚本变成 JSON 转义串。
  //      RunWorkflow 是 alwaysAsk，而确认门正是 spec R4 里「沙箱没有全关」那句论证的落点；
  //      一个读不了脚本的确认窗等于那道控制形同虚设。
  const source = readFileSync(new URL("../src/PermissionDialog.tsx", import.meta.url), "utf8");
  const runWorkflowIndex = source.indexOf('if (isRunWorkflowToolCall(toolCall))');
  const fileSummaryIndex = source.indexOf("rawFileSummaries.length > 0");
  const fallbackIndex = source.indexOf('return "fallback";');
  assert.ok(runWorkflowIndex > 0, "确认窗必须按名认领 RunWorkflow");
  assert.ok(fileSummaryIndex > 0, "文件摘要启发式没找到——本断言的前提变了，请重新核对");
  assert.ok(
    runWorkflowIndex < fileSummaryIndex,
    "按名判定必须早于文件摘要启发式，否则会被吸进 edit 块",
  );
  assert.ok(runWorkflowIndex < fallbackIndex, "必须早于 fallback");
  assert.match(source, /return "scriptWorkflow";/);
  // 专用块要真的接上渲染，光有 kind 没有块等于还是 fallback。
  assert.match(source, /<ScriptWorkflowPermissionBlock request=\{request\} \/>/);
  // 块自己给问句，所以协议 reason 不该再念一遍（那条 reason 是诊断用的内部字符串）。
  assert.match(source, /!shouldUseScriptWorkflowBlock &&/);
});

test("reducer 把 dialect 从 run-started 载荷搬进投影，缺席即 dwf", async () => {
  // 这条是「两套 run 共用一个投影」的支点：没有 dialect，侧栏无法知道该门掉哪些按钮。
  const { reduceWorkflowRunsState } = await import(
    "../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts"
  );
  const scriptRun = reduceWorkflowRunsState(undefined, {
    eventType: "run-started",
    payload: { dialect: "script" },
    runId: "wf_a",
    sequence: 1,
  });
  assert.equal(scriptRun.runs[0].dialect, "script");

  // 老 CLI 与 journal 冷回放都不发这个键，而那些 run 全是 dwf 的——缺席必须保持缺席，
  // 不能被归一化成显式的 "dwf"，否则「旧客户端发的帧」与「新客户端明说 dwf」就分不开了。
  const legacyRun = reduceWorkflowRunsState(undefined, {
    eventType: "run-started",
    payload: {},
    runId: "dwfrun_b",
    sequence: 1,
  });
  assert.equal(legacyRun.runs[0].dialect, undefined);

  // 闭集之外的值当没说：一个拼错的字符串不该让侧栏按未知方言门掉全部动作。
  const bogusRun = reduceWorkflowRunsState(undefined, {
    eventType: "run-started",
    payload: { dialect: "scriptt" },
    runId: "wf_c",
    sequence: 1,
  });
  assert.equal(bogusRun.runs[0].dialect, undefined);
});

test("方言门只有一个所有者：两个读面都经谓词，谁都不自己判 dialect", () => {
  // resumeWorkflowRun 与 amendWorkflowRunSettings 都是 dwf 专属命令，打到脚本工作流的 run 上
  // 必然失败。摆出点了报错的按钮比不显示更坏——它读起来像「这里能恢复」。
  //
  // 门原先只叠在侧栏一个调用方里，于是会话里的轮尾摘要卡（内联在对话里、比侧栏更常被看见）
  // 走裸的 isWorkflowRunConfigurable(run)，一条正在跑的脚本 run 拿到了「配置」按钮。
  // 修复把门搬进谓词本身，这条断言随之从「侧栏叠了几道」改成「谁都不许再自己叠」——
  // 谓词是唯一所有者，新增读面就不会重演同一次漏叠。
  // 门本身的**行为**（含 Cancel 对两套都成立）由 workflowRunDialectGate.test.ts 用真 reducer
  // 铸出的 run 逐条验证，这里只钉「调用方没有绕开它」。
  const readSurfaces = [
    "../src/app-shell/WorkflowRunSidePane.tsx",
    "../src/v4/ConversationWorkflowDigests.tsx",
  ];
  for (const relative of readSurfaces) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !/^\s*\{\/\*/.test(line))
      .join("\n");
    assert.equal(
      /dialect/.test(code),
      false,
      `${relative} 的代码里不该再出现 dialect 判断（注释里解释裁决不算）；门在谓词里`,
    );
  }
  // 摘要卡的「配置」必须经谓词，否则它就是那条漏叠的路。
  const digests = readFileSync(
    new URL("../src/v4/ConversationWorkflowDigests.tsx", import.meta.url),
    "utf8",
  );
  assert.match(digests, /isWorkflowRunConfigurable\(summary\?\.run\)/);
});

test("确认窗的脚本不折叠：长脚本走段内滚动，而不是让用户点开才看见要批准什么", () => {
  // 与聊天卡的刻意差别：那边脚本放 <details> 里（历史留档，折叠合理），这边不折叠——
  // 脚本是这个权限请求里唯一需要用户读的东西，而确认窗的既有纪律就是
  // 「不提供收起/展开交互，避免用户把关键内容藏起来」。
  const source = readFileSync(
    new URL("../src/ScriptWorkflowPermissionBlock.tsx", import.meta.url),
    "utf8",
  );
  // 断言写成「`<details` 只允许出现在注释里」而不是简单的 doesNotMatch：解释这条裁决的
  // 注释本身就要提到聊天卡那个 <details>，否则下一个人不知道差别在哪。
  const foldInCode = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => line.includes("<details"));
  assert.deepEqual(foldInCode, [], "确认块的代码里不得出现折叠元素（注释里提到不算）");
  assert.match(source, /max-h-72 overflow-auto/, "长脚本用段内滚动承接");
  assert.match(source, /data-script-workflow-script="true"/, "留一个稳定的 E2E 定位点");
  // 按 scriptPath 批准时必须说明「批的是文件当前内容、之后还可能变」——
  // 与 dwf 的 alwaysAsk 论证同一条理由。
  assert.match(source, /scriptPathNotice/);
});
