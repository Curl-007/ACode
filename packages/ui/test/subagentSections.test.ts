// SubagentsSection 批次 2（SubagentList / SubagentForm + 5 个纯展示子组件外迁）的接缝内测试。
//
// 形态对照 automationPickers.test.ts：renderToStaticMarkup + createElement，无 jsdom。
// 拆出的 5 个纯展示子组件（FormFieldLabel/AgentColorDot/AgentBadge/ToolCheckbox/
// BatchRowCheckbox）不依赖 hooks / store / service，可在静态渲染下锁定 DOM 契约
// （class 名、aria、data-testid、disabled、危险工具标记点）。
//
// SubagentList 与 SubagentForm 自身使用 useStartPlanRecommendation / useACodeIntl /
// useConfirmDialogStore 等带 store/service 的 hooks，renderToStaticMarkup 跑不通
// （effect 不触发、zustand 需 provider 树、service mocks 体量大）。按 split-plan
// 「每批拆分的固定验收」第 4 条与批次 1 的登记口径，这两个组件以**结构守护测试**
// （readFileSync 钉 import 接线 + 受控 props 签名）+ **typecheck** 作接缝内测试替代，
// 行为验证留给后续 jsdom/E2E 环境。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentBadge,
  AgentColorDot,
  BatchRowCheckbox,
  FormFieldLabel,
  ToolCheckbox,
} from "../src/settings/subagents/primitives.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECTION_PATH = resolve(__dirname, "../src/settings/SubagentsSection.tsx");
const LIST_PATH = resolve(__dirname, "../src/settings/subagents/SubagentList.tsx");
const OVERRIDE_PATH = resolve(
  __dirname,
  "../src/settings/subagents/SubagentModelOverrideControl.tsx",
);
const FORM_PATH = resolve(__dirname, "../src/settings/subagents/SubagentForm.tsx");
const VALIDATE_PATH = resolve(__dirname, "../src/settings/subagents/subagentFormValidate.ts");
const PRIMITIVES_PATH = resolve(__dirname, "../src/settings/subagents/primitives.tsx");

const render = (node: React.ReactNode): string => renderToStaticMarkup(node);

const readSource = (path: string): string => readFileSync(path, "utf8");

// ────────────────────────────────────────────────────────────────────────────
// 5 个纯展示子组件的 DOM 契约
// ────────────────────────────────────────────────────────────────────────────

test("FormFieldLabel：渲染为 label，带 mb-1.5 与 text-ui-base 基线样式", () => {
  const html = render(createElement(FormFieldLabel, { children: "名称" }));
  assert.match(html, /^<label/);
  assert.match(html, /mb-1\.5/);
  assert.match(html, /text-ui-base/);
  assert.match(html, /font-medium/);
  assert.match(html, /text-foreground-subtle/);
  assert.match(html, />名称</);
});

test("AgentColorDot：已知 color 走 COLOR_DOT_CLASS 映射，未知 color 走默认灰点", () => {
  // 已知色（yellow）应出现在 className 里；测试只锁定「有 color 与无 color 走两条路径」，
  // 具体色值由 subagentColors.ts 单一来源持有。
  const withColor = render(createElement(AgentColorDot, { color: "yellow" }));
  assert.match(withColor, /^<span/);
  assert.match(withColor, /aria-hidden="true"/);
  assert.match(withColor, /inline-flex/);
  assert.match(withColor, /size-2/);
  assert.match(withColor, /rounded-full/);
  assert.doesNotMatch(withColor, /bg-foreground-subtlest/);

  const withoutColor = render(createElement(AgentColorDot, {}));
  assert.match(withoutColor, /bg-foreground-subtlest/);
});

test("AgentBadge：渲染容器基线类与 children，className 透传覆盖", () => {
  const html = render(createElement(AgentBadge, { children: "gpt-5" }));
  assert.match(html, /^<span/);
  assert.match(html, /inline-flex/);
  assert.match(html, /min-h-5/);
  assert.match(html, /bg-surface/);
  assert.match(html, /text-ui-sm/);
  assert.match(html, /ring-1/);
  assert.match(html, />gpt-5</);

  const custom = render(
    createElement(AgentBadge, { children: "x", className: "text-destructive" }),
  );
  assert.match(custom, /text-destructive/);
});

test("ToolCheckbox：checked/disabled 透传到 aria 与样式，RISKY_TOOLS 加危险标记点", () => {
  // Bash 在 RISKY_TOOLS 集合内，应渲染 bg-destructive 小圆点。
  const risky = render(
    createElement(ToolCheckbox, {
      checked: true,
      disabled: false,
      label: "Bash",
      onToggle: () => undefined,
    }),
  );
  assert.match(risky, /role="checkbox"/);
  assert.match(risky, /aria-checked="true"/);
  assert.match(risky, /bg-destructive/);
  assert.match(risky, />Bash</);

  // Read 不在 RISKY_TOOLS 内，不应渲染危险标记点。
  const safe = render(
    createElement(ToolCheckbox, {
      checked: false,
      disabled: true,
      label: "Read",
      onToggle: () => undefined,
    }),
  );
  assert.match(safe, /aria-checked="false"/);
  assert.match(safe, /disabled=""/);
  assert.match(safe, /cursor-not-allowed/);
  assert.doesNotMatch(safe, /bg-destructive/);
});

test("BatchRowCheckbox：data-testid 钉住 subagent-batch-row-checkbox 契约，disabled 置灰", () => {
  const html = render(
    createElement(BatchRowCheckbox, {
      checked: true,
      label: "切换 agent-alpha",
      agentName: "agent-alpha",
      disabled: false,
      onToggle: () => undefined,
    }),
  );
  // data-testid 字面量与 shared/test-ids.ts 的 TID_SUBAGENT_BATCH_ROW_CHECKBOX 契约一致；
  // 源仓 test-ids 是 packages/shared 拥有，本包用字面量保持同一契约（见 SubagentsSection 头注）。
  assert.match(html, /data-testid="subagent-batch-row-checkbox-agent-alpha"/);
  assert.match(html, /aria-label="切换 agent-alpha"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /role="checkbox"/);

  const disabled = render(
    createElement(BatchRowCheckbox, {
      checked: false,
      label: "x",
      agentName: "a",
      disabled: true,
      onToggle: () => undefined,
    }),
  );
  assert.match(disabled, /disabled=""/);
  assert.match(disabled, /cursor-not-allowed/);
});

// ────────────────────────────────────────────────────────────────────────────
// SubagentList / SubagentForm 结构守护（readFileSync 钉 import 接线和受控 props 签名）
//
// 这两个组件消费 useStartPlanRecommendation / useACodeIntl / useConfirmDialogStore /
// useBaseWorkspaceServices 等带 store 的 hooks，无 jsdom 环境无法静态渲染；
// 按 split-plan 第 4 条登记为结构守护，行为验证属 jsdom/E2E 债。
// ────────────────────────────────────────────────────────────────────────────

test("结构：SubagentList 从 agentModel 与 primitives 取共享 API，不再本地定义", () => {
  const list = readSource(LIST_PATH);
  // 从 agentModel 复用纯函数（不重复定义能力判定 / 工具合并）。
  assert.match(list, /from "@\/settings\/subagents\/agentModel\.js"/u);
  // 从 primitives 复用展示子组件。
  assert.match(list, /from "@\/settings\/subagents\/primitives\.js"/u);
  // SubagentList.tsx 必须 export 3 个组件供主文件消费：批量菜单 / 分组三态全选 /
  // 行组件。SubagentModelOverrideControl 因 oxlint max-lines 400 限制单独成文件
  // （SubagentModelOverrideControl.tsx），但经 SubagentList re-export 路径不变。
  assert.match(list, /export function SubagentGroupBatchMenu/u);
  assert.match(list, /export function SubagentGroupSelectAll/u);
  assert.match(list, /export function AgentListRow/u);
  // 行内覆盖控件经 import 接入 SubagentList，由 AgentListRow 内部消费。
  assert.match(list, /from "@\/settings\/subagents\/SubagentModelOverrideControl\.js"/u);
});

test("结构：SubagentForm 从 agentModel 与字段子组件取共享 API", () => {
  const form = readSource(FORM_PATH);
  assert.match(form, /from "@\/settings\/subagents\/agentModel\.js"/u);
  // 批次 2 辅助拆分（满足 oxlint max-lines 400 物理行上限）：
  //  - 7 个纯受控字段子组件按职责拆为 SubagentFormIdentityFields.tsx（身份组：
  //    Scope/Name/Color/Description）与 SubagentFormCapabilityFields.tsx（能力组：
  //    Model/Tools/SystemPrompt/InjectAgentsMd）；
  //  - validate 函数抽为纯函数 subagentFormValidate.ts（60 行）。
  assert.match(form, /from "@\/settings\/subagents\/SubagentFormIdentityFields\.js"/u);
  assert.match(form, /from "@\/settings\/subagents\/SubagentFormCapabilityFields\.js"/u);
  assert.match(form, /from "@\/settings\/subagents\/subagentFormValidate\.js"/u);
  assert.match(form, /export (function|const) SubagentForm/u);
  // 表单草稿态核心 state 落在此文件（不在主文件）。
  assert.match(form, /useState\(initialFormState\.name\)/u);
  assert.match(form, /useState\(initialFormState\.systemPrompt\)/u);
});

test("结构：primitives.tsx 集中导出 5 个纯展示子组件", () => {
  const primitives = readSource(PRIMITIVES_PATH);
  for (const name of [
    "FormFieldLabel",
    "AgentColorDot",
    "AgentBadge",
    "ToolCheckbox",
    "BatchRowCheckbox",
  ]) {
    assert.match(
      primitives,
      new RegExp(`export function ${name}`, "u"),
      `primitives 缺 export ${name}`,
    );
  }
});

test("结构：主文件 SubagentsSection.tsx 不再本地定义批次 2 的组件与展示原子", () => {
  const section = readSource(SECTION_PATH);
  // 5 个展示子组件不应再在主文件本地定义。
  for (const name of [
    "FormFieldLabel",
    "AgentColorDot",
    "AgentBadge",
    "ToolCheckbox",
    "BatchRowCheckbox",
  ]) {
    assert.doesNotMatch(
      section,
      new RegExp(`^function ${name}\\(`, "mu"),
      `SubagentsSection.tsx 仍本地定义 ${name}`,
    );
  }
  // SubagentForm 整体外迁。
  assert.doesNotMatch(section, /^function SubagentForm\(/mu);
  // 列表渲染组件族外迁。
  assert.doesNotMatch(section, /^function AgentListRow\(/mu);
  assert.doesNotMatch(section, /^function SubagentModelOverrideControl\(/mu);
  assert.doesNotMatch(section, /^function SubagentGroupBatchMenu\(/mu);
  assert.doesNotMatch(section, /^function SubagentGroupSelectAll\(/mu);
  // 主文件改为从子模块 import。
  assert.match(section, /from "@\/settings\/subagents\/SubagentForm\.js"/u);
  assert.match(section, /from "@\/settings\/subagents\/SubagentList\.js"/u);
  // 主文件不直接用 primitives（5 个展示子组件全部经 SubagentForm/SubagentList 消费）。
  assert.doesNotMatch(section, /from "@\/settings\/subagents\/primitives\.js"/u);
});

test("结构：SubagentForm 仍按 initialFormStateKey 回灌字段（防保存后表单停留在旧值）", () => {
  const form = readSource(FORM_PATH);
  // 表单草稿态的关键回灌 effect：保存/刷新后按最新 agent 快照重置本地字段。
  assert.match(form, /previousInitialFormStateKeyRef/);
  assert.match(form, /createSubagentFormInitialStateKey\(initial\)/);
  // 回灌路径调用 setName/setModel/setSystemPrompt 等 setter。
  assert.match(form, /setName\(nextInitialState\.name\)/);
  assert.match(form, /setSystemPrompt\(nextInitialState\.systemPrompt\)/);
});

test("结构：SubagentList 持批量行交互（checkboxVisible / rowEditable 分流）", () => {
  const list = readSource(LIST_PATH);
  // 批量模式下行点击切换到 onBatchCheckChange 而不是 onEdit（specs/subagent-batch-edit.md R1）。
  assert.match(list, /checkboxVisible/);
  assert.match(list, /onBatchCheckChange\(agent, !batchChecked\)/);
  // 批量应用期间行选择一并禁用。
  assert.match(list, /batchApplying/);
});

test("结构：SubagentModelOverrideControl 保留即改即存回滚语义", () => {
  // 批次 2 因 oxlint max-lines 400 限制，行内覆盖控件单独成文件
  // SubagentModelOverrideControl.tsx；本断言指向真正的实现位置。
  const override = readSource(OVERRIDE_PATH);
  // 行内覆盖控件是「即改即存」：persistConfig 内失败时回滚到 previousConfig。
  assert.match(override, /const previousConfig = config;/);
  assert.match(override, /setConfig\(previousConfig\)/);
  // 模型变更经 Start Plan 推荐门（hasExplicitModelChanged 的覆盖控件对应版本）：
  // 选择改变触发 recommendStartPlan，用户拒绝时不写盘。
  assert.match(override, /recommendStartPlan\(selection\)/);
});

test("结构：SubagentForm 校验守护（名称字符集 / 必填 / 失效模型阻止保存）", () => {
  const form = readSource(FORM_PATH);
  // 批次 2 辅助拆分：validate 函数（行 228–287，60 行）抽为纯函数到
  // subagentFormValidate.ts，主文件满足 oxlint max-lines 400；校验规则本身
  // （名称字符集 / 必填 / 失效模型）随 validate 一并迁移。
  const validate = readSource(VALIDATE_PATH);
  // 名称 3–50 字符 + [a-zA-Z0-9-]+。
  assert.match(validate, /\^\[a-zA-Z0-9-\]\+\$\/u/);
  // description / systemPrompt 必填。
  assert.match(validate, /descriptionRequired/);
  assert.match(validate, /promptRequired/);
  // 失效模型阻止保存。
  assert.match(validate, /modelUnavailable/);
  // 主文件经 validateSubagentFormFields 调用纯函数，四项校验错误 setter 经参数透传。
  assert.match(form, /validateSubagentFormFields\(/);
  assert.match(form, /setNameError, setDescriptionError, setPromptError, setModelError/);
  // canSave 汇总所有校验项（含 thoughtLevelInvalid / speedInvalid）。
  assert.match(form, /!thoughtLevelInvalid/);
  assert.match(form, /!speedInvalid/);
});
