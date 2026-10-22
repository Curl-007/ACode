// 结构守护测试，非行为验证（i18n 键成对性除外，那部分是真实文本层断言）：组件注册/挂载点、
// 归一化回显等断言落在源码字符串上，不驱动 React 树（登记见 god-component-split-plan.md 测试债清单）。
// 工具按需检索设置面 UI 落点：i18n 键位成对性、组件引用键存在性、注册与挂载点、
// 归一化回显与「实验性说明常驻」语义的源码级钉住。
// 依据：apps/acode-cli/specs/tool-search.md R11（设置 UI 行 + 底部常驻实验性说明）。
//
// 形态对照 scriptWorkflowSurface.test.ts：ui 测试无 jsdom 先例，组件不真渲染，
// 文案完整性用「源码里引用的每个 i18n 键必须双语成对存在」来验。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_TOOL_SEARCH_APP_MODE,
  normalizeToolSearchAppMode,
} from "../../shared/src/tool-search-feature.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ZH = "../src/i18n/locales/zh-CN.ts";
const EN = "../src/i18n/locales/en-US.ts";
const SECTION = "../src/settings/ToolSearchSection.tsx";

function extractKeys(source: string, prefix: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(new RegExp(`"(${prefix}\\.[a-zA-Z0-9.]+)"`, "gu"))) {
    keys.add(match[1]!);
  }
  return keys;
}

test("settings.toolSearch 键组 zh-CN 与 en-US 成对存在、零缺失", () => {
  const zhKeys = extractKeys(readSource(ZH), "settings.toolSearch");
  const enKeys = extractKeys(readSource(EN), "settings.toolSearch");
  assert.ok(zhKeys.size > 0, "settings.toolSearch 组必须有键");
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), "键集必须双语一致");
});

test("组件源码引用的每个 settings.toolSearch 键都在双语表里（防裸键名）", () => {
  const zh = readSource(ZH);
  const en = readSource(EN);
  const source = readSource(SECTION);
  let referenced = 0;
  for (const match of source.matchAll(/"(settings\.toolSearch\.[a-zA-Z0-9.]+)"/gu)) {
    const key = match[1]!;
    referenced += 1;
    assert.ok(zh.includes(`"${key}"`), `ToolSearchSection 引用的 ${key} 缺 zh-CN`);
    assert.ok(en.includes(`"${key}"`), `ToolSearchSection 引用的 ${key} 缺 en-US`);
  }
  assert.ok(referenced >= 10, "组件应引用标题/说明/三档标签+描述/默认徽标/保存失败/实验性说明");
});

test("注册：settingsPageConfig 分区紧邻 dynamicWorkflow，导航 id 闭集与守卫同步登记", () => {
  const config = readSource("../src/settings/settingsPageConfig.ts");
  const dwf = config.indexOf('id: "dynamicWorkflow"');
  const toolSearch = config.indexOf('id: "toolSearch"');
  assert.ok(dwf > 0 && toolSearch > dwf, "toolSearch 分区必须注册在 dynamicWorkflow 之后（相邻）");
  const nav = readSource("../src/lib/settingsNavigation.ts");
  assert.match(nav, /\| "toolSearch"/, "SettingsSectionId 联合类型必须含 toolSearch");
  assert.match(nav, /value === "toolSearch"/, "isSettingsSectionId 守卫必须同步登记（漏登记则深链回落 general）");
});

test("挂载点：SettingsPage 分支渲染 ToolSearchSection，选中态读落盘值、写入走 updateSharedSettings", () => {
  const page = readSource("../src/SettingsPage.tsx");
  const mount = page.indexOf('activeSection === "toolSearch"');
  assert.ok(mount > 0, "toolSearch 渲染分支必须存在");
  const block = page.slice(mount, mount + 800);
  assert.match(block, /<ToolSearchSection/, "分支必须渲染 ToolSearchSection");
  assert.match(
    block,
    /normalizeToolSearchAppMode\(\s*sharedSettings\?\.toolSearchMode,?\s*\)/,
    "选中态唯一来源是落盘值（归一化后缺席落 off），无 Host 快照",
  );
  assert.match(
    page,
    /updateSharedSettings\(\{ toolSearchMode: mode \}\)/,
    "写入必须走 updateSharedSettings 三合一路径（直调 settingService.update 不回读刷新，2026-10-11 实机教训）",
  );
});

test("归一化回显：非法/native 落 undefined，组件缺省档是 off（零行为变化红线）", () => {
  assert.equal(normalizeToolSearchAppMode("bogus"), undefined);
  assert.equal(normalizeToolSearchAppMode("native"), undefined, "native 是 CLI 独有档，设置面必须拒绝");
  assert.equal(DEFAULT_TOOL_SEARCH_APP_MODE, "off");
  const section = readSource(SECTION);
  assert.match(section, /mode \?\? DEFAULT_TOOL_SEARCH_APP_MODE/);
});

test("实验性说明常驻底部：不随选中档/保存状态折叠（spec R11）", () => {
  const section = readSource(SECTION);
  assert.match(section, /settings-tool-search-experimental-note/, "说明节点必须有稳定 testid");
  // 说明段落必须是无条件渲染的顶层 <p>，不得包进 saveError 或 selected 条件分支。
  const note = section.indexOf('"settings.toolSearch.experimentalNote"');
  assert.ok(note > 0);
  const before = section.slice(Math.max(0, note - 400), note);
  assert.ok(
    !before.includes("saveError ?"),
    "实验性说明不得挂在 saveError 条件里（常驻，不是错误提示）",
  );
  const zh = readSource(ZH);
  assert.match(
    zh,
    /settings\.toolSearch\.experimentalNote[\s\S]{0,300}native[\s\S]{0,300}?默认「关」/,
    "zh 文案要点：native 未实装 + 默认关=行为不变",
  );
  const en = readSource(EN);
  assert.match(
    en,
    /settings\.toolSearch\.experimentalNote[\s\S]{0,400}not implemented/i,
    "en 文案要点：native 未实装",
  );
  assert.match(
    zh,
    /settings\.toolSearch\.experimentalNote[\s\S]{0,200}工具投影/,
    "zh 文案要点：local 会改变工具投影",
  );
});
