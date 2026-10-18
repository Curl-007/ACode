import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

// ── R1/R4：应用写路径唯一执行点，只走既有 service 方法 ──

test("接线：批量应用只经 SubagentsSection 单点分流到既有三条 service 写路径", () => {
  const section = readSource(SECTION_PATH);
  // 三个模块全部被主接线消费（knip files 门禁的语义前提）。
  for (const moduleImport of [
    "@/settings/SubagentModelBatchBar.js",
    "@/settings/SubagentModelBatchDialog.js",
    "@/settings/SubagentModelBatchApply.js",
  ]) {
    assert.match(section, new RegExp(`from "${moduleImport}"`), moduleImport);
  }
  // 应用回调按 resolveBatchWritePath 分流：覆盖路径两方法 + 定义文件 updateAgent。
  assert.match(section, /resolveBatchWritePath\(target\) === "override"/u);
  assert.match(section, /setBuiltInModelOverride\(\{[^}]*agentName/u);
  assert.match(section, /setPluginAgentModelOverride\(\{[^}]*agentId: target\.id/u);
  assert.match(section, /buildUserAgentBatchConfig\(target, value\)/u);
  assert.match(section, /subagentsService\.updateAgent\(\{[^}]*agentId: target\.id/u);
  // 不存在第五条写通道：批量回调体内不得出现 createAgent/deleteAgent/setEnabled。
  const applyBody = section.slice(
    section.indexOf("const applyBatchValue"),
    section.indexOf("const handleEdit"),
  );
  assert.doesNotMatch(applyBody, /createAgent|deleteAgent|setEnabled/u);
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

// ── 速度维度剥离守护（spec 文件头）：上游 speed 面不得随取回悄然回流 ──

test("剥离：批量模块不消费 speed 维度，speed 文案与 SpeedField 不回流", () => {
  for (const [name, source] of [
    ["BatchBar", readSource(BAR_PATH)],
    ["BatchDialog", readSource(DIALOG_PATH)],
    ["BatchApply", readSource(APPLY_PATH)],
  ] as const) {
    assert.doesNotMatch(source, /SubagentSpeedField|resolveSubagentSpeedOptionState/u, name);
  }
  assert.equal(existsSync(resolve(__dirname, "../src/settings/SubagentSpeedField.tsx")), false);
  for (const [name, locale] of [
    ["en-US", readSource(EN)],
    ["zh-CN", readSource(ZH)],
  ] as const) {
    assert.doesNotMatch(
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
  assert.ok(usedIds.size >= 14, `批量文案键数异常：${usedIds.size}`);
  for (const id of usedIds) {
    assert.match(en, new RegExp(`"${id}":`), `en-US 缺 ${id}`);
    assert.match(zh, new RegExp(`"${id}":`), `zh-CN 缺 ${id}`);
  }
});

// ── testid 契约：组件引用的批量 TID 在 shared 有定义（防再次取回时缺定义） ──

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
