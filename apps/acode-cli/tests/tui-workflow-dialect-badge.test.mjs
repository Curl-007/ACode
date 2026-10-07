// TUI 工作流卡的方言透传：投影 → 镜像 → 卡片 props。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12。
//
// 为什么单独钉这一条：两套 run 现在共用同一个 `workflowRuns` 投影与同一张 TUI 卡，
// 而 `cardFromRun` 是**逐字段**搬运的（不是展开 run），所以投影里新增的键会被它静默丢掉——
// `dialect` 正是这么丢过一次。丢掉的后果不是崩溃而是「无从分辨」：卡片把脚本 run 渲染成
// 一张普通的 dwf 卡，用户看不出这是另一套系统，也就无从理解为什么 `/dwf resume` 对它不管用。
//
// 这里是行为级断言（真的过 reducer 与真的 buildTuiWorkflowCardIndex）；只有徽标的**文案**
// 落在 .tsx 视图里，那一部分用源码级断言补，因为 TUI 包没有组件渲染测试的装置。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyWorkflowProgressToMirror,
  buildTuiWorkflowCardIndex,
  EMPTY_TUI_WORKFLOW_MIRROR,
} from "../packages/tui/src/app-workflow-mirror.ts";

const RUN = "wf_tui-dialect";
const TOOL_CALL = "tc_1";

function mirrorWith(...envelopes) {
  // 归约是纯的（返回新镜像），所以共用那一个空常量不会被上一个用例污染。
  return envelopes.reduce(
    (current, envelope) => applyWorkflowProgressToMirror(current, envelope),
    EMPTY_TUI_WORKFLOW_MIRROR,
  );
}

function startedEnvelope(dialect) {
  return {
    eventType: "run-started",
    payload: dialect === undefined ? {} : { dialect },
    runId: RUN,
    sequence: 1,
    toolCallId: TOOL_CALL,
  };
}

test("脚本 run 的卡片带上 dialect，dwf 与缺席的都不带", () => {
  const script = buildTuiWorkflowCardIndex(mirrorWith(startedEnvelope("script"))).get(TOOL_CALL);
  assert.equal(script.dialect, "script");

  const dwf = buildTuiWorkflowCardIndex(mirrorWith(startedEnvelope("dwf"))).get(TOOL_CALL);
  assert.equal(dwf.dialect, "dwf");

  // 缺席即 dwf：卡片字段跟着缺席，视图据此不挂徽标。
  // 给每条既有 run 都挂一枚徽标只是噪音，也会让老 journal 冷回放出来的卡凭空变样。
  const legacy = buildTuiWorkflowCardIndex(mirrorWith(startedEnvelope(undefined))).get(TOOL_CALL);
  assert.equal(legacy.dialect, undefined);
  assert.equal("dialect" in legacy, false, "缺席时键本身不该出现");
});

test("徽标只在 script 上挂，文案走 i18n 而不是硬编码", () => {
  const card = readFileSync(
    new URL("../packages/tui/src/app-workflow-card.tsx", import.meta.url),
    "utf8",
  );
  const code = card
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.match(code, /card\.dialect === "script" \? \{ dialect: workflowCopy\.dialectScript \} : \{\}/);
  // 徽标词不许写死在视图里：两个 locale 各有自己的一份。
  assert.equal(/"ultracode"/.test(code), false, "视图里不该出现硬编码的徽标词");
});

test("两个 locale 都提供 dialectScript，且 collapsed 接受 dialect", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const source = readFileSync(
      new URL(`../packages/i18n/src/locales/${locale}.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /dialectScript: "ultracode"/, `${locale} 缺 dialectScript`);
    assert.match(
      source,
      /collapsed: \(\{ dialect, label, status, nodesSettled, nodesTotal \}\)/,
      `${locale} 的 collapsed 必须解构 dialect，否则徽标无处可放`,
    );
  }
});
