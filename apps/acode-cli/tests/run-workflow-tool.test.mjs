// RunWorkflow（脚本工作流）工具入口的注册门、技能门与遗留面接线。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R2/R3/R7/R8。
//
// 两类断言混在一起，各自标了理由：
//   - 行为断言：直接 import 源码 TS 调函数（仓库既有风格，见 ambient-budget-scheduler.test.mjs）。
//   - 源码断言：被测函数是模块私有的（background.ts 的两个映射、background-task-registry 的
//     runtimeTaskTypeForToolCall），没有导出面可测。这类断言钉的是「文案/分支还在不在」，
//     先例见 dispatch-discipline-prompt.test.mjs:172-188 的源码级防漂移。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CORE = "../packages/core/src";
const BOOTSTRAP = "../packages/bootstrap/src";
// W1-R3：workflow 引擎族已迁入 @acode/cli-workflow（specs/cli-workflow-package-boundary.md）。
const CLI_WORKFLOW = "../packages/cli-workflow/src";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function makeRegistry() {
  const entries = new Map();
  return {
    entries,
    registry: { register: (entry) => entries.set(entry.metadata.name, entry) },
  };
}

const DWF_TEN = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "ListModels",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
];

// ---------------------------------------------------------------------------
// R2 条目存在与形状
// ---------------------------------------------------------------------------

test("R2: builtInTools 含 RunWorkflow，且条目形状是「执行整块代码」那一档", async () => {
  const { builtInTools } = await import(`${CORE}/tool/handlers/index.ts`);
  const entry = builtInTools.find((candidate) => candidate.metadata.name === "RunWorkflow");
  assert.ok(entry, "RunWorkflow 必须在 builtInTools 里——它是这套系统唯一的模型入口");

  // 执行语义：只读声明必须翻面，且任何权限模式都要先问。
  assert.equal(entry.metadata.readOnly, false);
  assert.equal(entry.metadata.needsApproval, true);
  assert.equal(entry.permission.needsApproval, true);
  assert.equal(entry.permission.alwaysAsk, true, "yolo 也不能跳：这是一整块代码执行");
  assert.deepEqual(entry.permission.askOptions, { allowAlways: "session" });
  assert.equal(entry.permission.permission, "runWorkflow");

  // 描述必须把「两套系统不可互换」说穿，否则模型会在 CreateWorkflow 与 RunWorkflow 之间乱选。
  const description = entry.metadata.description;
  assert.match(description, /export const meta/, "描述必须点名脚本头部契约");
  assert.match(description, /CreateWorkflow/, "描述必须点名另一套系统以做区分");
  assert.match(description, /script-workflows/, "描述必须点名配套技能");
  // 不许再指向不存在的命令（端口 response 里那句 /workflows 就是这么来的）。
  assert.doesNotMatch(description, /\/workflows\b/, "ACode 没有 /workflows 命令");
});

test("R2: 契约常量与自指文案已随改名同步", async () => {
  const contracts = await import("../packages/contracts/src/index.ts");
  assert.equal(contracts.RUN_WORKFLOW_TOOL_NAME, "RunWorkflow");
  assert.equal(contracts.RUN_WORKFLOW_SKILL_NAME, "script-workflows");

  const source = readSource("../packages/contracts/src/tools/workflow.ts");
  // 三处自指（resumeFromRunId / scriptPath / superRefine 消息）都必须说 RunWorkflow，
  // 否则模型读到的工具名与它实际能调的名字不一致。
  assert.doesNotMatch(
    source,
    /a prior Workflow invocation|re-invoke Workflow with|"Workflow requires/,
    "契约里不应再有指向旧工具名的自指文案",
  );
});

// ---------------------------------------------------------------------------
// R7 两道注册门（能力门 includeWorkflow × 可用性门 includeDynamicWorkflow）
// ---------------------------------------------------------------------------

test("R7: 端口门——只有 includeWorkflow === true 才注册", async () => {
  const { registerBuiltInTools } = await import(`${CORE}/tool/handlers/index.ts`);

  const absent = makeRegistry();
  registerBuiltInTools(absent.registry, {});
  assert.ok(!absent.entries.has("RunWorkflow"), "端口缺席即不注册：没有能启动 run 的东西");

  const explicitFalse = makeRegistry();
  registerBuiltInTools(explicitFalse.registry, { includeWorkflow: false });
  assert.ok(!explicitFalse.entries.has("RunWorkflow"));

  const present = makeRegistry();
  registerBuiltInTools(present.registry, { includeWorkflow: true });
  assert.ok(present.entries.has("RunWorkflow"), "端口在场即注册");
});

test("R7: 灰度门——显式 false 下架 RunWorkflow 与 dwf 十个；缺席全部保留", async () => {
  const { registerBuiltInTools } = await import(`${CORE}/tool/handlers/index.ts`);

  // 灰度关：十一个一起消失。两套系统共用同一道可用性开关，一开一关会让
  // 「界面有入口 / 模型没工具」的裂口重新出现。
  const off = makeRegistry();
  registerBuiltInTools(off.registry, { includeDynamicWorkflow: false, includeWorkflow: true });
  for (const name of [...DWF_TEN, "RunWorkflow"]) {
    assert.ok(!off.entries.has(name), `灰度关时 ${name} 必须下架`);
  }

  // 缺席 = 调用方不参与灰度（TUI / headless / workflow_child），必须保留全部工具面。
  // 极性搞反的后果记录在 runtime/methods/embedded-search-branch.ts:31-38。
  const absent = makeRegistry();
  registerBuiltInTools(absent.registry, { includeWorkflow: true });
  for (const name of [...DWF_TEN, "RunWorkflow"]) {
    assert.ok(absent.entries.has(name), `灰度缺席时 ${name} 必须保留（缺席即开启）`);
  }

  const on = makeRegistry();
  registerBuiltInTools(on.registry, { includeDynamicWorkflow: true, includeWorkflow: true });
  for (const name of [...DWF_TEN, "RunWorkflow"]) {
    assert.ok(on.entries.has(name), `灰度显式开时 ${name} 必须注册`);
  }
});

test("R7: 门控名单 = dwf 十个 + RunWorkflow，且 dwf 那份语义未被扩容", async () => {
  const { DYNAMIC_WORKFLOW_TOOL_NAMES, GATED_WORKFLOW_TOOL_NAMES } = await import(
    `${CORE}/tool/handlers/workflow-tool-names.ts`
  );

  assert.equal(DYNAMIC_WORKFLOW_TOOL_NAMES.size, 10, "dwf 恒为十个：多处注释按这个含义引用它");
  for (const name of DWF_TEN) assert.ok(DYNAMIC_WORKFLOW_TOOL_NAMES.has(name), name);
  assert.ok(
    !DYNAMIC_WORKFLOW_TOOL_NAMES.has("RunWorkflow"),
    "RunWorkflow 不属于 dwf 那十个（它是另一套系统）",
  );

  assert.equal(GATED_WORKFLOW_TOOL_NAMES.size, 11);
  assert.ok(GATED_WORKFLOW_TOOL_NAMES.has("RunWorkflow"));
  for (const name of DWF_TEN) assert.ok(GATED_WORKFLOW_TOOL_NAMES.has(name), name);
});

// ---------------------------------------------------------------------------
// R8 技能门
// ---------------------------------------------------------------------------

test("R8: 只有提交脚本字节才需要技能", async () => {
  const { runWorkflowNeedsSkill } = await import(`${CORE}/tool/handlers/workflow-skill-gate.ts`);

  // 需要技能：写脚本就是创作。scriptPath 也算——它的用途正是「改了那个文件再交回来」。
  assert.equal(runWorkflowNeedsSkill({ script: "export const meta = {}" }), true);
  assert.equal(runWorkflowNeedsSkill({ scriptPath: "/tmp/a.workflow.js" }), true);
  assert.equal(
    runWorkflowNeedsSkill({ resumeFromRunId: "wf_abc123", scriptPath: "/tmp/a.js" }),
    true,
    "带了脚本字节就需要技能，即使同时给了 resumeFromRunId",
  );

  // 免技能：跑既有脚本不是创作（与 dwf 的 saved / amend-settings 例外同构）。
  assert.equal(runWorkflowNeedsSkill({ name: "deep-research" }), false);
  assert.equal(runWorkflowNeedsSkill({ resumeFromRunId: "wf_abc123" }), false);

  // 形状不对（非对象）时按需技能处理：宁可多要求一次加载，也不要放行一段没法审的输入。
  assert.equal(runWorkflowNeedsSkill(undefined), true);
  assert.equal(runWorkflowNeedsSkill("nope"), true);
  assert.equal(runWorkflowNeedsSkill([]), true);
});

test("R8: 拒绝文案点名 script-workflows，且与 dwf 的技能门互不串味", async () => {
  const { requireDynamicWorkflowSkill, requireWorkflowSkill } = await import(
    `${CORE}/tool/handlers/workflow-skill-gate.ts`
  );
  // hasLoadedSkill 一律回 false：模拟「会话里两个技能都没加载」。
  const context = { hasLoadedSkill: () => false };

  const cc = requireWorkflowSkill(context, "RunWorkflow", "script-workflows");
  assert.equal(cc.errorCode, 428, "技能门用 428，与入参级 400 分开");
  assert.match(cc.message, /script-workflows/);
  assert.doesNotMatch(
    cc.message,
    /dynamic-workflows/,
    "两套 DSL 的头部规则相反，指向错的技能只会让模型写出编不过的脚本",
  );

  const dwf = requireDynamicWorkflowSkill(context, "CreateWorkflow");
  assert.equal(dwf.errorCode, 428);
  assert.match(dwf.message, /dynamic-workflows/);

  // 探针缺席 = 放行（装配未提供技能加载检查时不设置无法满足的前提）。
  assert.equal(requireWorkflowSkill({}, "RunWorkflow", "script-workflows"), undefined);
  // 已加载对应技能 = 放行。
  assert.equal(
    requireWorkflowSkill(
      { hasLoadedSkill: (name) => name === "script-workflows" },
      "RunWorkflow",
      "script-workflows",
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// R3 遗留面接线
// ---------------------------------------------------------------------------

test("R3#1: provider-visible-order 收录 RunWorkflow 并按字母序落位", async () => {
  const { orderProviderVisibleToolContracts } = await import(
    `${CORE}/tool/provider-visible-order.ts`
  );
  const names = ["Write", "RunWorkflow", "Bash", "CreateWorkflow", "Read"];
  const ordered = orderProviderVisibleToolContracts(names.map((name) => ({ name }))).map(
    (tool) => tool.name,
  );
  // 参考段按字母序：Bash < Read < RunWorkflow < Write；CreateWorkflow 不在参考集合里，落 local 段。
  assert.deepEqual(ordered, ["Bash", "Read", "RunWorkflow", "Write", "CreateWorkflow"]);
});

test("R3#2/#3: 后台任务类型映射认 RunWorkflow，且保留死名以读旧 rollout", () => {
  const background = readSource(`${CORE}/runtime/methods/background.ts`);
  assert.match(background, /case "RunWorkflow":\s*\n\s*return "local_workflow"/);
  assert.match(background, /case "Workflow":/, "旧会话 rollout 里仍有该名字，正向映射必须保留");
  // 反向投影用活名：指向一个不存在的工具名只会误导读者。
  assert.match(
    background,
    /case "local_workflow":\s*\n(?:\s*\/\/[^\n]*\n)*\s*return "RunWorkflow"/,
  );

  const registry = readSource(`${CORE}/tool/executor/background-task-registry.ts`);
  assert.match(registry, /case "RunWorkflow":/);
  assert.match(registry, /case "Workflow":/);
});

test("R3#4: 通知格式器认 RunWorkflow，cancellable 按端口实况报而非写死", () => {
  const source = readSource(`${CORE}/tool/executor/background-tasks.ts`);
  assert.match(source, /toolCall\.name === "RunWorkflow"/);
  // 写死 false 会让 TaskStop 答应一件做不到的事；契约要求「resume 前先 TaskStop」，
  // 那句成立的前提就是端口实现了 cancel。
  assert.match(source, /cancellable: typeof port\?\.cancel === "function"/);
  assert.doesNotMatch(
    source,
    /if \(toolCall\.name === "RunWorkflow" \|\| toolCall\.name === "Workflow"\) \{[\s\S]{0,600}cancellable: false/,
    "脚本工作流分支不得再写死 cancellable: false",
  );
});

test("R3#5: 闲时轮隐藏名单只有一个所有者，两个 bootstrap 消费方都从 core 导入", async () => {
  const { OFF_PEAK_MUTATION_TOOL_NAMES } = await import(
    `${CORE}/runtime/methods/turn-loop-state.ts`
  );
  for (const name of ["OffPeakCreate", "SendMessage", "RunWorkflow"]) {
    assert.ok(OFF_PEAK_MUTATION_TOOL_NAMES.includes(name), `${name} 必须在闲时轮隐藏名单里`);
  }
  // 死名保留：这是隐藏名单，多藏一个不存在的名字没有代价，漏藏一个真能派生子会话的入口才有。
  assert.ok(OFF_PEAK_MUTATION_TOOL_NAMES.includes("Workflow"));

  // 断言的是「副本已被消掉」而不只是「值相同」。原本 bootstrap 有两份手抄
  // （v4 prompt-turn 的具名常量 + legacy server-operations 的内联字面量），加一个工具要
  // 同时改三处——RunWorkflow 落地时正是如此，漏一处就等于在派发轮里放行一个能在本轮
  // modelExecution 之外重启子 Agent 的入口。
  for (const path of [
    `${BOOTSTRAP}/acode-protocol-v4/commands/prompt-turn.ts`,
    `${BOOTSTRAP}/acode-protocol/server-operations.ts`,
  ]) {
    const source = readSource(path);
    assert.match(
      source,
      /OFF_PEAK_MUTATION_TOOL_NAMES[\s\S]{0,200}from "@acode\/core"|from "@acode\/core";/,
      `${path} 必须从 core 导入名单`,
    );
    assert.ok(
      !source.includes('"OffPeakCreate"'),
      `${path} 不得再手抄名单字面量（那正是漂移的起点）`,
    );
  }
  // 「core 的公开出口确实导出了这两份名单」不在这里断言：bootstrap 两个文件都从
  // `@acode/core` 导入它们，而 bootstrap 的 tsc 通过就是证明。这里不 import core 的 barrel
  // 是刻意的——那个 barrel 里有 type-only 再导出，tsx 运行时解析不了（既有怪癖，与本项无关）。
});

test("R3 补注: RunWorkflow 刻意不登记进 tool-identity 的 workflow family", async () => {
  // 登记进去会让它渲染成 dwf 的 CreateWorkflow 卡（resolveRenderer 的 workflow 分支
  // 除 submit_result 外一律走那张卡），长出它根本没有的因果图与 Refine 选项。
  // 这条断言钉的是「不说谎」，专用渲染器属于批次 C。
  const { ACODE_KNOWN_TOOL_NAMES, getACodeToolFamilyForName } =
    await import("../../../packages/shared/src/tool-identity.ts");
  assert.ok(!ACODE_KNOWN_TOOL_NAMES.includes("RunWorkflow"));
  assert.equal(getACodeToolFamilyForName("RunWorkflow"), null);
  // 对照：dwf 的创建入口是登记了的，所以这条不是「忘了登记」而是刻意区分。
  assert.equal(getACodeToolFamilyForName("CreateWorkflow"), "workflow");
});

// ---------------------------------------------------------------------------
// 缺口 8/9：cancel 通道与 resume 并发守卫
// ---------------------------------------------------------------------------

test("缺口8: 端口暴露 cancel，未知 taskId 回 false", async () => {
  const { createScriptWorkflowToolPort } = await import(
    `${CLI_WORKFLOW}/script-workflow-tool-port.ts`
  );
  // cancel 对未知 id 不触碰任何依赖，所以这里可以用最小桩装配。
  const port = createScriptWorkflowToolPort({
    fileSystemPort: {},
    getRuntime: () => {
      throw new Error("cancel(unknown) must not reach the runtime");
    },
    sessionId: "sess-test",
    sessionStore: {},
    storageRoot: "/tmp",
    traceContext: { traceId: "trace-test" },
    workingDirectory: "/tmp",
  });
  assert.equal(typeof port.cancel, "function", "没有 cancel 就没有任何通道能停掉在飞的 run");
  assert.equal(await port.cancel("wf_does-not-exist"), false);
});

test("缺口9: resume 并发守卫与 cancel 通道在源码里成对存在", () => {
  const source = readSource(`${CLI_WORKFLOW}/script-workflow-tool-port.ts`);
  // 守卫的判据必须复用 completionSnapshots（run promise 未结算即在飞），不另立第二份运行态。
  assert.match(source, /if \(completionSnapshots\.has\(runId\)\)/);
  assert.match(source, /has not exited yet/);
  assert.match(source, /runAbortControllers\.set\(runId, runAbortController\)/);
  // 清理只有一处：run 结算路径的 finally。
  assert.match(source, /runAbortControllers\.delete\(runId\)/);
  // 启动回执不许再指向不存在的 /workflows 命令。
  // 断言写成「该字样只允许出现在注释行」而不是简单的 doesNotMatch：解释这条裁决的注释
  // 本身就要逐字引用旧文案，否则下一个人不知道被删掉的是什么。
  const offending = source
    .split("\n")
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line.includes("/workflows"))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(
    offending.map(({ index, line }) => `L${index + 1}: ${line.trim()}`),
    [],
    "/workflows 只能出现在注释里，不能出现在任何会被返回给模型的代码行",
  );
  // 回执由具名函数产出，而不是内联模板字符串——内联的那份正是旧文案藏身的地方。
  assert.match(source, /response: runWorkflowLaunchResponse\(runId, source\.scriptPath\)/);
});

test("P1 SWF-08: resume 在读取脚本前拒绝 foreign owner，且不触碰 runtime", async () => {
  const { createScriptWorkflowToolPort } = await import(
    `${CLI_WORKFLOW}/script-workflow-tool-port.ts`
  );
  let runtimeCalls = 0;
  let sessionLookupCalls = 0;
  const sessionStore = {
    createScriptWorkflowActivity: () => undefined,
    createScriptWorkflowRun: () => undefined,
    getScriptWorkflowRun: async () => ({
      cwd: "/workspace/other",
      id: "wf_foreign1",
      kind: "script",
      name: "foreign",
      parentSessionId: "sess-other",
      scriptPath: "/workspace/other/secret.workflow.js",
    }),
    getSession: async () => {
      sessionLookupCalls += 1;
      return null;
    },
  };
  const port = createScriptWorkflowToolPort({
    fileSystemPort: {},
    getRuntime: () => {
      runtimeCalls += 1;
      throw new Error("foreign resume must not start runtime");
    },
    sessionId: "sess-current",
    sessionStore,
    storageRoot: "/tmp",
    traceContext: { traceId: "trace-test" },
    workingDirectory: "/workspace/current",
    workspaceIdentity: "workspace-current",
  });

  await assert.rejects(
    port.start(
      {
        parentToolCallId: "tool-1",
        resumeFromRunId: "wf_foreign1",
        sessionId: "sess-current",
        trace: { traceId: "trace-test" },
        workingDirectory: "/workspace/current",
        workspaceRoot: "/workspace/current",
        workspaceIdentity: "workspace-current",
      },
      undefined,
    ),
    (error) => error?.context?.ownerMismatch === true,
  );
  assert.equal(runtimeCalls, 0);
  assert.equal(sessionLookupCalls, 0, "parent session mismatch must fail before workspace lookup");
});

test("P1 SWF-08: resume 与 scriptPath 的组合先过 owner gate，且不会走 scriptPath 优先级", async () => {
  const { createScriptWorkflowToolPort } = await import(
    `${CLI_WORKFLOW}/script-workflow-tool-port.ts`
  );
  let runtimeCalls = 0;
  let scriptReads = 0;
  const sessionStore = {
    createScriptWorkflowActivity: () => undefined,
    createScriptWorkflowRun: () => undefined,
    getScriptWorkflowRun: async () => ({
      cwd: "/workspace/other",
      id: "wf_foreign_combo",
      kind: "script",
      name: "foreign",
      parentSessionId: "sess-other",
      scriptPath: "/workspace/other/secret.workflow.js",
    }),
    getSession: async () => {
      throw new Error("workspace lookup must not happen after parent mismatch");
    },
  };
  const port = createScriptWorkflowToolPort({
    fileSystemPort: {
      async readTextFile() {
        scriptReads += 1;
        throw new Error("foreign script must not be read");
      },
    },
    getRuntime: () => {
      runtimeCalls += 1;
      throw new Error("foreign resume must not start runtime");
    },
    sessionId: "sess-current",
    sessionStore,
    storageRoot: "/tmp",
    traceContext: { traceId: "trace-test" },
    workingDirectory: "/workspace/current",
    workspaceIdentity: "workspace-current",
  });

  await assert.rejects(
    port.start({
      parentToolCallId: "tool-1",
      resumeFromRunId: "wf_foreign_combo",
      scriptPath: "./edited.workflow.js",
      sessionId: "sess-current",
      trace: { traceId: "trace-test" },
      workingDirectory: "/workspace/current",
      workspaceRoot: "/workspace/current",
      workspaceIdentity: "workspace-current",
    }),
    (error) => error?.context?.ownerMismatch === true,
  );
  assert.equal(runtimeCalls, 0);
  assert.equal(scriptReads, 0);
});

test("P1 SWF-08: schema 明确拒绝 resumeFromRunId 与其他 source 的组合", async () => {
  const { WorkflowInputSchema } = await import("../packages/contracts/src/tools/workflow.ts");
  const parsed = WorkflowInputSchema.safeParse({
    resumeFromRunId: "wf_abc123",
    scriptPath: "./edited.workflow.js",
  });
  assert.equal(parsed.success, false);
  assert.match(parsed.error.issues[0].message, /cannot combine resumeFromRunId/);
});
