import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 结构守护测试，非行为验证：本文件的接线断言落在源码字符串上，不驱动 React 树
// （登记见 god-component-split-plan.md 测试债清单）；纯逻辑（应用集/写路径/载荷构造）
// 已由 subagentModelBatchApply.test.ts 做真实行为单测，此处只钉「主接线未被回归改动」。
// 子智能体批量编辑主接线（packages/ui/specs/subagent-batch-edit.md）的源码契约守护。
// ui 测试无 jsdom（appearancePreferences.test.ts 头注）：接线事实按源码文本断言，
// 纯逻辑（应用集/写路径/载荷构造）由 subagentModelBatchApply.test.ts 直接单测。

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECTION_PATH = resolve(__dirname, "../src/settings/SubagentsSection.tsx");
const BAR_PATH = resolve(__dirname, "../src/settings/SubagentModelBatchBar.tsx");
const DIALOG_PATH = resolve(__dirname, "../src/settings/SubagentModelBatchDialog.tsx");
const APPLY_PATH = resolve(__dirname, "../src/settings/SubagentModelBatchApply.ts");
const TEST_IDS_PATH = resolve(__dirname, "../../shared/src/test-ids.ts");
const ZH = resolve(__dirname, "../src/i18n/locales/zh-CN.ts");
const EN = resolve(__dirname, "../src/i18n/locales/en-US.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function sectionBetween(section: string, start: string, end: string): string {
  const startIndex = section.indexOf(start);
  assert.ok(startIndex >= 0, `缺少锚点：${start}`);
  const endIndex = section.indexOf(end, startIndex);
  assert.ok(endIndex > startIndex, `缺少结束锚点：${end}`);
  return section.slice(startIndex, endIndex);
}

// ── R1/R4：应用写路径唯一执行点，只走既有 service 方法 ──

test("接线：批量应用只经 SubagentsSection 单点分流到既有 service 写路径", () => {
  const section = readSource(SECTION_PATH);
  // 三个模块全部被主接线消费（knip files 门禁的语义前提）。
  for (const moduleImport of [
    "@/settings/SubagentModelBatchBar.js",
    "@/settings/SubagentModelBatchDialog.js",
    "@/settings/SubagentModelBatchApply.js",
  ]) {
    assert.match(section, new RegExp(`from "${moduleImport}"`), moduleImport);
  }
  // 应用回调按 resolveBatchWritePath 分流：覆盖路径委托单项编辑同一方法，
  // 定义文件路径走 updateAgent。
  assert.match(section, /resolveBatchWritePath\(agent\) === "override"/u);
  assert.match(section, /handleModelOverrideChange\(agent, \{/u);
  assert.match(section, /buildUserAgentBatchConfig\(agent, value\)/u);
  assert.match(section, /subagentsService\.updateAgent\(\{[^}]*agentId: agent\.id/u);
  // 不存在第五条写通道：批量单行落盘与批次循环体内不得出现
  // createAgent/deleteAgent/setEnabled。
  const applyTargetBody = sectionBetween(
    section,
    "const applyBatchTarget",
    "const applyBatchModelOverride",
  );
  assert.doesNotMatch(applyTargetBody, /createAgent|deleteAgent|setEnabled/u);
  const applyBatchBody = sectionBetween(
    section,
    "const applyBatchModelOverride",
    "const handleGroupBatchApply",
  );
  assert.doesNotMatch(applyBatchBody, /subagentsService\.(createAgent|deleteAgent|setEnabled)/u);
});

// ── R1/R6：批量模式选择语义与选中集裁剪 ──

test("接线：批量模式下行点击切换选中而非进编辑表单，选中集随过滤裁剪", () => {
  const section = readSource(SECTION_PATH);
  // 行交互：checkbox 可见时行点击走 onBatchCheckChange，否则才落到 onEdit。
  assert.match(
    section,
    /checkboxVisible\s*\?\s*\(\) => onBatchCheckChange\(agent, !batchChecked\)\s*:\s*rowEditable\s*\?\s*\(\) => onEdit\(agent\)/u,
  );
  // 选中集裁剪 effect 存在且只保留当前可见可批量集内的 id。
  assert.match(
    section,
    /resolveBatchApplyTargets\(filteredAgents\)\.map\(\(agent\) => agent\.id\)/u,
  );
  // 分组三态勾选消费 resolveGroupBatchCheckState。
  assert.match(section, /resolveGroupBatchCheckState\(groupAgents, selectedBatchIds\)/u);
});

// ── R1：批量应用进行中禁用行选择 ──

test("接线：batchApplying 期间行复选框与行点击均不可改选中", () => {
  const section = readSource(SECTION_PATH);
  // 复选框 disabled = applying || 不可批量；checkboxVisible 在 applying 期间为 false，
  // 行点击因此不会落到 onBatchCheckChange。
  assert.match(
    section,
    /const checkboxVisible = batchMode && isBatchApplicableAgent\(agent\) && !batchApplying;/u,
  );
  // 复选框在 applying 期间仍渲染（列不塌陷），但 disabled 置灰。
  assert.match(section, /const checkboxRendered = batchMode && isBatchApplicableAgent\(agent\);/u);
  assert.match(
    section,
    /const batchCheckboxDisabled = batchApplying \|\| !isBatchApplicableAgent\(agent\);/u,
  );
  assert.match(section, /disabled=\{batchCheckboxDisabled\}/u);
  assert.match(section, /\{checkboxRendered \? \(/u);
  // handler 入口兜底：applying 期间直接 return，选中集不变。
  const handlerBody = sectionBetween(
    section,
    "const handleBatchCheckChange",
    "const handleBatchGroupCheck",
  );
  assert.match(handlerBody, /if \(batchApplying \|\| !isBatchApplicableAgent\(agent\)\) \{/u);
  assert.match(handlerBody, /\[batchApplying\]/u);
});

// ── R1：分组批量菜单、组全选与全局全选 ──

test("接线：分组「…」菜单同时提供统一设置与本组恢复继承默认", () => {
  const section = readSource(SECTION_PATH);
  assert.match(section, /function SubagentGroupBatchMenu\(/u);
  assert.match(section, /settings\.subagents\.batch\.groupMenu\.setModels/u);
  assert.match(section, /settings\.subagents\.batch\.groupMenu\.resetInherit/u);
  assert.match(section, /onResetInherit=\{\(\) => handleGroupBatchApply\(groupAgents\)\}/u);
  // 重置继承 = 对全组可批量行应用空目标值，仍走同一 apply 入口。
  const resetBody = sectionBetween(section, "const handleGroupBatchApply", "const handleEdit");
  assert.match(resetBody, /resolveBatchApplyTargets\(groupAgents\)/u);
  assert.match(resetBody, /applyBatchModelOverride\(targets, \{\}\)/u);
});

test("接线：分组三态全选与搜索栏全局全选共用可批量判定", () => {
  const section = readSource(SECTION_PATH);
  assert.match(section, /function SubagentGroupSelectAll\(/u);
  assert.match(section, /settings\.subagents\.batch\.groupSelectAll\.label/u);
  assert.match(section, /const toggleBatchAll = useCallback/u);
  assert.match(section, /settings\.subagents\.batch\.selectAll\.label/u);
  assert.match(section, /toggleBatchAll\(checked === true\)/u);
  const groupBody = sectionBetween(
    section,
    "const handleBatchGroupCheck",
    "const applyBatchTarget",
  );
  assert.match(groupBody, /for \(const target of selectable\)/u);
});

// ── R4：thoughtLevel 合并 + 整批一次 Start Plan 推荐 ──

test("接线：批量目标值先合并 thoughtLevel，推荐在循环外只做一次", () => {
  const section = readSource(SECTION_PATH);
  assert.match(section, /const recommendBatchStartPlan = useStartPlanRecommendation/u);
  assert.match(section, /const userSelection: ModelSelection = \{/u);
  assert.match(section, /const chosen = await recommendBatchStartPlan\(userSelection\)/u);
  assert.match(section, /settings\.subagents\.batch\.declined/u);
  const applyBatchBody = sectionBetween(
    section,
    "const applyBatchModelOverride",
    "const handleGroupBatchApply",
  );
  // 推荐只调用一次，且位于逐行循环之前；循环内只调用 applyBatchTarget。
  assert.equal((applyBatchBody.match(/recommendBatchStartPlan\(/gu) ?? []).length, 1);
  assert.ok(
    applyBatchBody.indexOf("recommendBatchStartPlan(") <
      applyBatchBody.indexOf("applyBatchTarget("),
    "推荐必须位于逐行循环之前",
  );
});

// ── 速度维度守护：批量 Bar/Dialog/Apply 与文案必须与运行时校验同源 ──

test("speed：批量模块消费 speed 维度，SpeedField 与文案在位", () => {
  for (const [name, source] of [
    ["BatchBar", readSource(BAR_PATH)],
    ["BatchDialog", readSource(DIALOG_PATH)],
    ["BatchApply", readSource(APPLY_PATH)],
  ] as const) {
    assert.match(source, /SubagentSpeedField|resolveSubagentSpeedOptionState|speed/u, name);
  }
  assert.equal(existsSync(resolve(__dirname, "../src/settings/SubagentSpeedField.tsx")), true);
  for (const [name, locale] of [
    ["en-US", readSource(EN)],
    ["zh-CN", readSource(ZH)],
  ] as const) {
    assert.match(
      locale,
      /settings\.subagents\.batch\.speedRequired|settings\.subagents\.batch\.dialog\.speed|chat\.toolbar\.speed\./u,
      name,
    );
  }
});

// ── i18n 成对性：批量文案 en-US / zh-CN 逐键成对 ──

test("i18n：批量编辑全部文案在双语 locale 成对出现", () => {
  const en = readSource(EN);
  const zh = readSource(ZH);
  const usedIds = new Set<string>();
  for (const source of [readSource(BAR_PATH), readSource(DIALOG_PATH), readSource(SECTION_PATH)]) {
    for (const match of source.matchAll(/id: "(settings\.subagents\.batch\.[a-zA-Z.]+)"/gu)) {
      usedIds.add(match[1] ?? "");
    }
  }
  usedIds.delete("");
  assert.ok(usedIds.size >= 18, `批量文案键数异常：${usedIds.size}`);
  for (const id of usedIds) {
    assert.match(en, new RegExp(`"${id}":`), `en-US 缺 ${id}`);
    assert.match(zh, new RegExp(`"${id}":`), `zh-CN 缺 ${id}`);
  }
});

// ── testid 契约：共享 TID 有定义，源仓新增 TID 用局部字面量 ──

test("testid：批量 TID 在 shared test-ids.ts 有定义且与组件引用一致", () => {
  const testIds = readSource(TEST_IDS_PATH);
  for (const tid of [
    "TID_SUBAGENT_BATCH_DIALOG",
    "TID_SUBAGENT_BATCH_BAR",
    "TID_SUBAGENT_BATCH_APPLY",
    "TID_SUBAGENT_BATCH_MODEL_TRIGGER",
  ]) {
    assert.match(testIds, new RegExp(`export const ${tid} =`), tid);
  }
  const bar = readSource(BAR_PATH);
  const dialog = readSource(DIALOG_PATH);
  assert.match(bar, /TID_SUBAGENT_BATCH_BAR/u);
  assert.match(bar, /TID_SUBAGENT_BATCH_APPLY/u);
  assert.match(dialog, /TID_SUBAGENT_BATCH_DIALOG/u);
});

test("testid：源仓新增的批量入口/行勾选/组菜单 TID 以局部字面量落地", () => {
  const section = readSource(SECTION_PATH);
  for (const tid of [
    "subagent-batch-trigger",
    "subagent-batch-row-checkbox",
    "subagent-group-menu-trigger",
    "subagent-batch-select-all",
    "subagent-batch-group-select-all",
  ]) {
    assert.match(section, new RegExp(`"${tid}"`), tid);
  }
});
