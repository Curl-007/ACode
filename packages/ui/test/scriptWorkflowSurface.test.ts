// 脚本工作流管理面 UI 落点：i18n 键位成对性（E1）、组件引用键存在性、挂载点与
// 「disabled 档照常渲染」语义的源码级钉住。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §7.4/§7.5/§9 E1/E3。
//
// ui 测试无 jsdom 先例（appearancePreferences.test.ts 头注）：组件不真渲染，文案完整性
// 用「源码里引用的每个 i18n 键必须双语成对存在」来验——裸键名（E1 的失败形态）在
// 运行时才会露馅，这里提前到文本层拦住。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeScriptWorkflowMode } from "../../shared/src/script-workflow-feature.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ZH = "../src/i18n/locales/zh-CN.ts";
const EN = "../src/i18n/locales/en-US.ts";

function extractKeys(source: string, prefix: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(new RegExp(`"(${prefix}\\.[a-zA-Z0-9.]+)"`, "gu"))) {
    keys.add(match[1]!);
  }
  return keys;
}

test("E1：scriptWorkflow 两组文案键 zh-CN 与 en-US 成对存在、零缺失", () => {
  for (const prefix of ["settings.scriptWorkflow", "workflows.scriptHub"]) {
    const zhKeys = extractKeys(readSource(ZH), prefix);
    const enKeys = extractKeys(readSource(EN), prefix);
    assert.ok(zhKeys.size > 0, `${prefix} 组必须有键`);
    assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), `${prefix} 键集必须双语一致`);
  }
});

test("E1：组件源码引用的每个 scriptHub/scriptWorkflow 键都在双语表里（防裸键名）", () => {
  const zh = readSource(ZH);
  const en = readSource(EN);
  const sources = [
    "../src/settings/ScriptWorkflowSection.tsx",
    "../src/settings/ScriptWorkflowsGroup.tsx",
  ];
  for (const relative of sources) {
    const source = readSource(relative);
    for (const match of source.matchAll(
      /"((?:settings\.scriptWorkflow|workflows\.scriptHub)\.[a-zA-Z0-9.]+)"/gu,
    )) {
      const key = match[1]!;
      assert.ok(zh.includes(`"${key}"`), `${relative} 引用的 ${key} 缺 zh-CN`);
      assert.ok(en.includes(`"${key}"`), `${relative} 引用的 ${key} 缺 en-US`);
    }
  }
});

test("E1：必改项 6——五个非复用状态键显式存在（pending/running/paused/cancelled/interrupted）", () => {
  const en = readSource(EN);
  // 现有 chat.toolCall.scriptWorkflow.* 不含这五个状态（评审实测），必须用 scriptHub.status.*。
  for (const status of ["pending", "running", "paused", "cancelled", "interrupted"]) {
    assert.ok(
      en.includes(`"workflows.scriptHub.status.${status}"`),
      `status.${status} 必须是新键，不能指望复用 chat.toolCall 键组`,
    );
  }
  // completed/failed 复用现有键（注明键名），确认它们仍在。
  assert.ok(en.includes('"chat.toolCall.scriptWorkflow.status.completed"'));
  assert.ok(en.includes('"chat.toolCall.scriptWorkflow.status.failed"'));
});

test("必改项 7——settings.dynamicWorkflow.description 增补句同时覆盖两卡分工", () => {
  const zh = readSource(ZH);
  const en = readSource(EN);
  assert.match(
    zh,
    /settings\.dynamicWorkflow\.description[\s\S]{0,200}脚本工作流/,
    "zh 增补句必须点名脚本工作流",
  );
  assert.match(
    en,
    /settings\.dynamicWorkflow\.description[\s\S]{0,300}script workflows/i,
    "en 增补句必须点名 script workflows",
  );
});

test("归一化：settings 回显对非法落盘值落缺省档（C7 的 UI 侧）", () => {
  assert.equal(normalizeScriptWorkflowMode("bogus"), undefined);
  // ScriptWorkflowSection 的 props.mode 传 normalize 结果（undefined → 组件内落 onDemand）。
  const section = readSource("../src/settings/ScriptWorkflowSection.tsx");
  assert.match(section, /mode \?\? DEFAULT_SCRIPT_WORKFLOW_MODE/);
});

test("挂载点：设置卡挂在 dynamicWorkflow 分区页内（方案 C，不新增侧栏分区）", () => {
  const page = readSource("../src/SettingsPage.tsx");
  const mount = page.indexOf('activeSection === "dynamicWorkflow"');
  assert.ok(mount > 0);
  const block = page.slice(mount, mount + 1200);
  assert.match(block, /<DynamicWorkflowSection/, "dwf 卡在前");
  assert.match(block, /<ScriptWorkflowSection/, "脚本工作流卡在后（同页两卡）");
  assert.match(
    block,
    /normalizeScriptWorkflowMode\(\s*sharedSettings\?\.scriptWorkflowMode,?\s*\)/,
  );
  const nav = readFileSync(new URL("../src/lib/settingsNavigation.ts", import.meta.url), "utf8");
  assert.ok(!nav.includes("scriptWorkflow"), "设置侧栏不得新增 scriptWorkflow 分区 id");
});

test("E3/R2：disabled 档下中枢分组照常渲染数据 + 徽标；档位读落盘设置（无 Host 快照）", () => {
  const group = readSource("../src/settings/ScriptWorkflowsGroup.tsx");
  assert.match(
    group,
    /normalizeScriptWorkflowMode\(settings\?\.scriptWorkflowMode\) === "disabled"/,
    "gated 徽标的事实来源是落盘设置",
  );
  assert.match(group, /script-workflows-gated-badge/);
  // R2：disabled 档不做「整组不渲染」的短路——徽标分支之外必须还有数据渲染路径。
  assert.ok(
    !/toolDisabled \? null :/.test(group) && !/if \(toolDisabled\) return null/.test(group),
    "disabled 档不得阻断查看",
  );
});

test("挂载点：AutomationsSection workflow tab 纵向堆叠两块，dwf 中枢原样保留", () => {
  const automations = readSource("../src/settings/AutomationsSection.tsx");
  // 锚渲染分支（`if (pageTab === "workflow")`），不是上方注释里的同名文本。
  const branch = automations.indexOf('if (pageTab === "workflow") {');
  assert.ok(branch > 0, "workflow tab 渲染分支必须存在");
  const block = automations.slice(branch, branch + 2000);
  assert.match(block, /<SavedWorkflowsSection/);
  assert.match(block, /<ScriptWorkflowsGroup/);
  assert.match(
    block,
    /SavedWorkflowsSection[\s\S]*ScriptWorkflowsGroup/,
    "dwf 中枢在前、脚本分组在其下（spec §7.1）",
  );
});

test("C8：dwf 灰度关时工作流 tab 不挂载——pageTab 收窄 + workflow 深链落回自动化", () => {
  const automations = readSource("../src/settings/AutomationsSection.tsx");
  // 收窄行（AutomationsSection.tsx:601）：dwf 未启用时 pageTab 恒为 "automation"，
  // 上一条测试锚定的 `if (pageTab === "workflow")` 分支因此永不进入——
  // SavedWorkflowsSection 与 ScriptWorkflowsGroup 都不挂载（防一帧误挂载去发查询）。
  assert.match(
    automations,
    /const pageTab: AutomationsPageTab = dynamicWorkflowEnabled \? storedPageTab : "automation";/,
    "dwf-off 必须把 pageTab 收窄到 automation（C8 UI 半边）",
  );
  // 深链守卫（:713）：灰度关时请求「工作流」落回「自动化」并消费深链——
  // 不消费会让请求一直挂着，反复把页面拉回不存在的 tab。
  const guard = automations.indexOf('openAutomationTab === "workflow" && !dynamicWorkflowEnabled');
  assert.ok(guard > 0, "workflow 深链必须受 dwf 灰度守卫");
  const guardBlock = automations.slice(guard, guard + 300);
  assert.match(guardBlock, /setPageTab\("automation"\)/, "深链落回自动化 tab");
  assert.match(guardBlock, /onOpenAutomationConsumed\?\.\(\)/, "深链必须被消费");
});

test("store：无活动会话走 noSession 引导而非伪造空态；错误态与空态分离", () => {
  const store = readSource("../src/store/scriptWorkflowStore.ts");
  assert.match(store, /noSession: true/, "锚会话缺席是独立状态");
  assert.match(store, /listScriptWorkflowRunsResultSchema\.parse/, "结果走严格 zod 校验");
  assert.match(store, /lease\.release\(\)/, "连接租约必须释放");
});

test("挂载必现查：分组组件自带挂载 effect 触发 refresh，target 变化即重查", () => {
  const group = readSource("../src/settings/ScriptWorkflowsGroup.tsx");
  // spec §3.3「UI 列表缓存：每次挂载/刷新现查」。此前 load 只挂在刷新/重试按钮上，
  // 首开永远渲染误导空态（评审 P1）：组件必须在挂载时自己触发加载，
  // 且 refresh 以 target 为依赖（useCallback），切 workspace 自动重查，
  // 不依赖调用点记得替我们刷新。
  const effect = group.indexOf("useEffect(() => {");
  assert.ok(effect > 0, "组件必须有挂载 useEffect");
  const effectBlock = group.slice(effect, effect + 160);
  assert.match(effectBlock, /refresh\(false\)/, "挂载 effect 必须触发 refresh（走缓存去重）");
  assert.match(
    group,
    /\[target, acodeAgentService\]/,
    "refresh 必须依赖 target 与 agentService（target 变化即重查）",
  );
  // store 的 in-flight 去重是「挂载 effect 可安全重跑」的前提，防 StrictMode 双发。
  const store = readSource("../src/store/scriptWorkflowStore.ts");
  assert.match(store, /inFlight/, "store 必须保留 in-flight 去重");
});

test("loading 被消费：刷新/重试按钮 loading 中禁用 + 图标旋转（避免「点了没反应」）", () => {
  const group = readSource("../src/settings/ScriptWorkflowsGroup.tsx");
  assert.match(group, /disabled=\{state\.loading\}/, "state.loading 必须接到按钮 disabled");
  assert.match(group, /animate-spin/, "loading 中刷新图标必须旋转，给「查询进行中」的可见反馈");
});

test("store：锚候选逐个回退——sessionNotFound 视同无活动会话，其他失败仍 error", () => {
  const store = readSource("../src/store/scriptWorkflowStore.ts");
  // 结构化 reasonCode 精确匹配（不看 message 文本——文案不是契约；2026-10-18 实机根因：
  // 持久化会话 ≠ 运行时活跃会话，单锚被 ACK 拒 reasonCode=proto.sessionNotFound 落错 error 态）。
  assert.match(
    store,
    /ack\.reasonCode === SESSION_NOT_FOUND_REASON_CODE/,
    "sessionNotFound 判定必须走结构化 reasonCode",
  );
  assert.ok(
    !/reasonCode\?*\.includes\(/.test(store),
    "不得用消息文本 includes 判定 sessionNotFound",
  );
  // 单锚选择改成候选列表：按 updatedAt 降序（回退顺序 = 最新优先），循环逐候选发送。
  assert.match(
    store,
    /const anchorCandidates = \[\.\.\.sessions\][\s\S]{0,160}\.sort\(\(left, right\) => right\.updatedAt - left\.updatedAt\);/,
    "候选列表必须保持最新优先排序",
  );
  assert.ok(
    !/updatedAt - left\.updatedAt\)\[0\]/.test(store),
    "不得再取单锚 [0]（持久化会话 ≠ 运行时活跃会话）",
  );
  const loop = store.indexOf("for (const candidate of anchorCandidates)");
  assert.ok(loop > 0, "候选回退循环必须存在");
  const loopBlock = store.slice(loop, loop + 3200);
  assert.match(loopBlock, /sessionId: candidate\.sessionId/, "循环内以候选为路由 sessionId");
  assert.match(
    loopBlock,
    /isSessionNotFoundRejection\(runsAck\) \|\| isSessionNotFoundRejection\(definitionsAck\)/,
    "任一 ACK sessionNotFound 即换下一候选",
  );
  assert.match(loopBlock, /continue;/, "sessionNotFound 候选直接跳过");
  // 候选耗尽仍全是 sessionNotFound → 与「查不到候选」同形落 noSession（error: null），不伪造错误。
  assert.match(
    loopBlock,
    /return \{ runs: \[\], truncated: false, definitions: \[\], error: null, noSession: true \}/,
    "候选耗尽必须是 noSession 引导而非 error 态",
  );
  // 非 sessionNotFound 失败（能力缺席、zod 校验等）不回退，照旧 throw → error 态。
  assert.match(loopBlock, /throw new Error\(ackFailureMessage\(/, "其他失败保持 error 上行");
  // 租约配对：循环外 acquire 一次，finally 恰好一次 release（候选回退不重复租借/不泄漏）。
  assert.match(store, /const lease = acquireWorkspaceConnection\(/);
  assert.equal(
    (store.match(/lease\.release\(\)/gu) ?? []).length,
    1,
    "lease.release 必须恰好一次（try/finally 配对）",
  );
});
