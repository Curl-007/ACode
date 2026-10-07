import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reduceWorkflowRunsState } from "../../shared/src/acode-protocol-v4/workflow-runs-reducer.js";
import type { WorkflowRunState, WorkflowRunsState } from "../../shared/src/acode-protocol-v4/workflow-runs.js";
import { isWorkflowRunCancellable, isWorkflowRunResumable } from "../src/app-shell/workflowRunPanel.js";
import { isWorkflowRunConfigurable } from "../src/components/workflow-timeline/workflowRunSettings.js";

/**
 * 两套工作流系统共用一个投影之后，按钮门控的方言判别。
 *
 * 背景（apps/acode-cli/specs/script-workflow-revival.md R12）：脚本工作流的 run 现在经
 * 适配器流进 dwf 的同一个 `workflowRuns` 投影，于是同一批 UI 组件会同时渲染两套 run。
 * 但 `resumeWorkflowRun` 与 `amendWorkflowRunSettings` 是 **dwf 专属**命令——打到 `wf_`
 * 前缀的 run 上必然被拒（两套各有自己的存储、端口与 run 语义）。
 *
 * 被钉住的缺陷：方言门原先只叠在 `WorkflowRunSidePane` 一个调用方里，而会话里的轮尾摘要卡
 * （ConversationWorkflowDigests）走的是裸的 `isWorkflowRunConfigurable(run)`——一条**正在跑的**
 * 脚本 run 于是拿到「配置」按钮，点下去发 dwf 命令、必然报错。摘要卡是内联在对话里的那一面，
 * 比侧栏更常被看见。修复把门搬进谓词本身，让调用方无从漏叠。
 *
 * run 一律用**真的 reducer** 从信封铸出来，不手搓对象：手搓的 fixture 会与 schema 漂移，
 * 而这里要证的恰恰是「投影里真实存在的那种 run」过不过门。
 */

const RUN_ID = "wf_predicate-test";

function reduce(envelopes: readonly Record<string, unknown>[]): WorkflowRunState {
  let state: WorkflowRunsState | undefined;
  for (const [index, envelope] of envelopes.entries()) {
    const next = reduceWorkflowRunsState(state, { ...envelope, runId: RUN_ID, sequence: index + 1 });
    state = next ?? state;
  }
  const run = state?.runs.find((entry) => entry.runId === RUN_ID);
  assert.ok(run, "reducer 必须真的铸出这条 run，否则后面每条断言都是空转");
  return run;
}

/** 一条起跑了的 run；`dialect` 缺席即 dwf（schema 记明的约定）。 */
function startedRun(dialect?: "dwf" | "script") {
  return reduce([
    {
      eventType: "run-started",
      ...(dialect === undefined ? {} : { payload: { dialect } }),
    },
  ]);
}

test("脚本工作流的 run 恒不可配置——哪怕它正在跑", () => {
  // 这是缺陷本体：`running` 在 dwf 侧是可配置的主场景（节流 / 换模型），
  // 谓词原先只看 status，于是一条在跑的脚本 run 也亮「配置」。
  assert.equal(isWorkflowRunConfigurable(startedRun("script")), false);
  assert.equal(isWorkflowRunConfigurable(startedRun("dwf")), true);
  // 缺席即 dwf：所有既有 run 都没有这个键，而它们全是 dwf 的。翻错这一位会让
  // 全仓库已有的 run 一起失去「配置」。
  assert.equal(isWorkflowRunConfigurable(startedRun()), true);
});

test("脚本工作流的 run 不可 Resume——命令是 dwf 专属的", () => {
  const settle = (dialect?: "dwf" | "script") =>
    reduce([
      {
        eventType: "run-started",
        ...(dialect === undefined ? {} : { payload: { dialect } }),
      },
      // dwf 的 CLI 在 run-settled 载荷上算好 resumable 位；这里直接给它，
      // 为的是单独验方言门，不与「谁算 resumable」这件事纠缠。
      { eventType: "run-settled", payload: { resumable: true, status: "stopped", stopReason: "user" } },
    ]);

  assert.equal(isWorkflowRunResumable(settle("dwf")), true);
  assert.equal(isWorkflowRunResumable(settle()), true);
  assert.equal(
    isWorkflowRunResumable(settle("script")),
    false,
    "即便 resumable 位在场，方言门也必须拦住：按钮发的那条命令续不了这条 run",
  );
});

test("Cancel 对两套都成立，不受方言影响", () => {
  // 取消走 cancelBackgroundWork（workId ≡ runId），对两套 run 都是同一条路。
  // 把它一起门掉会重新弄坏「脚本 run 停不下来」那个缺陷。
  assert.equal(isWorkflowRunCancellable(startedRun("script")), true);
  assert.equal(isWorkflowRunCancellable(startedRun("dwf")), true);
});

test("completed 的 run 两套都不可配置（既有规则未被方言门改动）", () => {
  const completed = (dialect?: "dwf" | "script") =>
    reduce([
      {
        eventType: "run-started",
        ...(dialect === undefined ? {} : { payload: { dialect } }),
      },
      { eventType: "run-settled", payload: { status: "completed" } },
    ]);
  assert.equal(isWorkflowRunConfigurable(completed("dwf")), false);
  assert.equal(isWorkflowRunConfigurable(completed("script")), false);
});

test("不在投影里的 run 一律不可配置、不可 Resume、不可 Cancel", () => {
  assert.equal(isWorkflowRunConfigurable(undefined), false);
  assert.equal(isWorkflowRunResumable(undefined), false);
  assert.equal(isWorkflowRunCancellable(undefined), false);
});

/**
 * 状态头的方言徽标是源码级断言：`packages/ui/test` 没有组件渲染装置（全部用例都是纯逻辑或
 * 源码级），为十行 JSX 搭一套 jsdom 不成比例。钉住的是两件容易被改坏的事——徽标只在
 * `script` 上出现，以及它挂在状态头里（那是「配置」与 Resume 缺席的唯一解释位）。
 */
test("状态头按 run.dialect 挂徽标，且只挂在脚本工作流上", () => {
  const source = readFileSync(
    new URL("../src/app-shell/WorkflowRunSidePaneSections.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /run\?\.dialect === "script" \? \(/, "徽标必须以方言为条件");
  assert.match(source, /data-testid="workflow-run-dialect-badge"/);
  assert.match(
    source,
    /id: "chat\.toolCall\.workflow\.run\.dialect\.script"/,
    "徽标词走 i18n，不硬编码",
  );
  assert.match(
    source,
    /id: "chat\.toolCall\.workflow\.run\.dialect\.scriptHint"/,
    "tooltip 要解释那两个按钮为什么缺席",
  );

  // 两个 locale 都得有这两个键：缺一个，那一种语言下面板会渲染出键名原文。
  for (const locale of ["en-US", "zh-CN"]) {
    const copy = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [
      "chat.toolCall.workflow.run.dialect.script",
      "chat.toolCall.workflow.run.dialect.scriptHint",
    ]) {
      assert.ok(copy.includes(`"${key}":`), `${locale} 缺 ${key}`);
    }
  }
});

test("方言门只有一个所有者：侧栏不再自己重推导一遍", () => {
  const source = readFileSync(
    new URL("../src/app-shell/WorkflowRunSidePane.tsx", import.meta.url),
    "utf8",
  );
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  // 门搬进谓词之后，侧栏再叠一道就是第二个所有者：两处会各自漂移，
  // 而摘要卡那处漏叠正是这次要修的缺陷。
  assert.equal(code.includes("isScriptDialect"), false, "侧栏不该再有自己的方言判断");
  assert.match(code, /const resumable = isWorkflowRunResumable\(run\) && dynamicWorkflowEnabled;/);
  assert.match(code, /enabled: dynamicWorkflowEnabled,/);
});
