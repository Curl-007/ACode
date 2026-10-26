// U07 目录面板的源码契约守护（specs/conversation-index-navigation.md）。
//
// ⚠ 诚实标注：本文件的组件层断言是**结构性**的，不是行为性的。
// ui 包没有 jsdom/testing-library 基建，且 minimal-dom-shim 不实现 radix Portal
// （PopoverContent 经 Portal 渲染，shim 下不会出现），因此目录面板无法真渲染。
// 这里只守护「源码里确实存在这些接线」，交互级行为需运行时/E2E 验证。
// 与 test/modelProviderDiscovery.test.ts 同一口径。
//
// 真正的行为断言在 tests/conversation-index-navigation.test.mjs（纯函数）与
// tests/conversation-index-focus-store.test.mjs（store 级，含请求计数与预算）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string => readFileSync(resolve(__dirname, relative), "utf8");

/**
 * 断言一律跑在**剥离注释后**的源码上（正/负向都是）。
 *
 * 负向断言的必要性：面板顶部注释正写着「不读 renderUnits」「不产生任何 rowsRange 请求」，
 * 裸字符串匹配会把「声明不做」当成「做了」。
 * 正向断言同样需要：注释里提到某个标识符也会让 `includes` 假通过。
 * 这类假阳性/假阴性正是仓库先前评审批评的字符串匹配债，故统一剥离。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const PANEL = stripComments(readSource("../src/v4/ConversationIndexDirectoryPanel.tsx"));
const BRIDGE = stripComments(readSource("../src/v4/ConversationIndexFocusBridge.tsx"));
const HOOK = stripComments(readSource("../src/hooks/useConversationIndexFocus.ts"));
const TIMELINE = stripComments(readSource("../src/v4/ConversationTimeline.tsx"));
const SESSION_PANE = stripComments(readSource("../src/v4/SessionPane.tsx"));

// ── DESIGN.md 合规（结构性，但可机械验证）──

test("DESIGN.md: 面板不使用硬编码字号 text-[Npx]", () => {
  assert.equal(/text-\[\d+px\]/.test(PANEL), false, "业务 UI 禁止 text-[Npx]，须用 text-ui-*");
  assert.ok(PANEL.includes("text-ui-base"), "应使用 text-ui-* 语义尺度");
  assert.ok(PANEL.includes("text-ui-sm") || PANEL.includes("text-ui-xs"));
});

test("DESIGN.md: 面板不使用裸 <button>，一律走 Button 组件", () => {
  assert.equal(/<button[\s>]/.test(PANEL), false, "禁止裸 <button>");
  assert.ok(PANEL.includes('import { Button } from "@/components/ui/button.js"'));
  const buttonUsages = PANEL.match(/<Button/g) ?? [];
  assert.ok(buttonUsages.length >= 3, `Button 用量 ${buttonUsages.length} 应覆盖触发器/条目/动作`);
});

test("DESIGN.md: 焦点态可见——无 focus-visible:ring-0 / 无 outline-none 替代缺失", () => {
  assert.equal(PANEL.includes("focus-visible:ring-0"), false, "不得移除焦点环而不给替代");
  assert.equal(
    PANEL.includes("focus-visible:outline-none"),
    false,
    "Button 已自带焦点样式，不得覆盖掉",
  );
});

test("DESIGN.md: 不使用 bg-white / text-black 硬编码颜色", () => {
  for (const [name, source] of [
    ["面板", PANEL],
    ["桥接", BRIDGE],
  ]) {
    assert.equal(source.includes("bg-white"), false, `${name} 不得用 bg-white`);
    assert.equal(source.includes("text-black"), false, `${name} 不得用 text-black`);
  }
});

// ── 产品规则接线（结构性）──

test("规则 1: 面板只读 focusApi.directory，不自行合并正文、不直接调 store", () => {
  assert.ok(PANEL.includes("focusApi"));
  assert.equal(
    PANEL.includes("conversationProjectionStore"),
    false,
    "面板不得直接 import store（须经 hook，AGENTS.md：组件通过 hooks 访问服务）",
  );
  assert.equal(PANEL.includes("rowsRange"), false, "面板不得自行发起正文请求");
});

test("规则 1: 面板不调用 loadAllOlder（目录不扫描正文）", () => {
  assert.equal(PANEL.includes("loadAllOlder"), false);
  assert.equal(PANEL.includes("renderUnits"), false, "目录数据源是轻量索引，不是 renderUnits");
});

test("规则 6: 淘汰可识别——isPartial 驱动可见提示并暴露淘汰数", () => {
  assert.ok(PANEL.includes("directory.isPartial"));
  assert.ok(PANEL.includes("directory.evictedCount"));
  assert.ok(PANEL.includes("chat.indexDirectory.partial"), "必须有部分覆盖的 i18n 文案");
});

test("规则 3: 超范围只经用户显式动作（continueOlder 按钮门控 nextAction）", () => {
  assert.ok(PANEL.includes('focus.nextAction === "continue-older"'));
  assert.ok(PANEL.includes("continueOlder"));
  assert.ok(PANEL.includes("chat.indexDirectory.continueOlder"));
  // 不存在自动续拉的定时器/循环。
  assert.equal(PANEL.includes("setInterval"), false, "不得自动轮询续拉");
  assert.equal(/setTimeout[\s\S]{0,80}continueOlder/.test(PANEL), false, "不得定时自动续拉");
});

test("规则 5: 返回最新入口仅在焦点正文非空时出现", () => {
  assert.ok(PANEL.includes("focus.rows.length > 0"));
  assert.ok(PANEL.includes("returnToLive"));
  assert.ok(PANEL.includes("chat.indexDirectory.returnToLive"));
});

test("U07-A2: 面板在浏览历史期间保持运行状态可见", () => {
  assert.ok(PANEL.includes("isRunning"));
  assert.ok(PANEL.includes("chat.indexDirectory.running"));
});

test("U07-A5: 选择后关闭面板，手机窄屏正文可独立操作（非常驻遮挡）", () => {
  assert.ok(PANEL.includes("setOpen(false)"), "点击目录项后必须关闭面板");
  assert.equal(PANEL.includes("modal={true}"), false, "不得用 modal 语义（modal 会阻断正文操作）");
});

test("U07-A5: 面板条目有界渲染，不把 8000 项全量铺进 DOM", () => {
  assert.ok(PANEL.includes("DIRECTORY_VISIBLE_MAX_ITEMS"));
  assert.ok(PANEL.includes("slice(-DIRECTORY_VISIBLE_MAX_ITEMS)"));
  assert.ok(PANEL.includes("chat.indexDirectory.hiddenOlder"), "隐藏更早条目必须可见提示");
});

test("可访问性: 目录项带 aria-posinset/aria-setsize/aria-current 与 aria-label", () => {
  assert.ok(PANEL.includes("aria-posinset"));
  assert.ok(PANEL.includes("aria-setsize"));
  assert.ok(PANEL.includes('aria-current={active ? "location" : undefined}'));
  assert.ok(PANEL.includes("chat.indexDirectory.jumpToQuery"));
});

// ── 桥接：滚动落点归属 timeline ──

test("桥接: 滚动经 timeline 暴露的 scrollToRowIdActionRef，不自造第二套滚动写入路径", () => {
  assert.ok(BRIDGE.includes("scrollToRowIdRef"));
  assert.equal(BRIDGE.includes("scrollTo("), false, "桥接不得直接操作滚动位置");
  assert.equal(BRIDGE.includes("scrollTop"), false);
});

test("桥接: 同一目标只抢一次滚动（避免反复拉回用户）", () => {
  assert.ok(BRIDGE.includes("scrolledTargetRef"));
  assert.ok(BRIDGE.includes("focus.targetFound"));
  assert.ok(BRIDGE.includes("scrolledTargetRef.current === focus.targetRowId"));
});

test("桥接: 面板由 focusApi 派生，桥接不另建状态副本", () => {
  assert.ok(BRIDGE.includes("<ConversationIndexDirectoryPanel"));
  assert.equal(BRIDGE.includes("useState"), false, "桥接不持有自己的 useState 副本");
  // panelApi 必须是 focusApi 的浅派生（覆盖 returnToLive），而非第二份状态拷贝。
  assert.match(BRIDGE, /\{\s*\.\.\.focusApi,\s*returnToLive: handleReturnToLive\s*\}/);
});

test("桥接: 返回最新显式滚回尾部（定位路径 commitFollowing(false) 后不会自动回底）", () => {
  assert.ok(BRIDGE.includes("handleReturnToLive"));
  assert.ok(BRIDGE.includes("returnToLive();"), "必须先调 store 的 returnToLive 清焦点");
  assert.ok(
    BRIDGE.includes("scrollToBottomRef?.current?.()"),
    "释放焦点后必须显式滚回尾部，恢复尾部滚动意图（spec 规则 5）",
  );
});

// ── hook：订阅 + 转发，不复制状态 ──

test("hook: 焦点态走独立订阅通道，避免历史浏览触发整棵 timeline 重渲染", () => {
  assert.ok(HOOK.includes("subscribeIndexFocus"));
  assert.ok(HOOK.includes("useSyncExternalStore"));
});

test("hook: 定位目标由 store 原子捕获（sessionId+generation+logEpoch 同一次读取）", () => {
  assert.ok(
    HOOK.includes("captureIndexFocusTarget"),
    "不得在 hook 里分别读 generation 与 snapshot",
  );
  assert.equal(HOOK.includes(".generation"), false, "hook 不应自行读取/拼装代际");
});

test("hook: 返回对象必须 memo（否则 memo 化面板在流式期间被高频重渲染）", () => {
  assert.ok(HOOK.includes("useMemo"));
  assert.equal(
    /if \(!store\) return IDLE_API/.test(HOOK),
    false,
    "不得在 useMemo 之前早退（条件调用 hooks 违规）",
  );
});

test("hook: 不直接调用 window.acode，服务访问经 store（AGENTS.md 平台边界）", () => {
  assert.equal(HOOK.includes("window.acode"), false);
});

test("hook: 目录求值被 open 门控——面板关闭时不在流式热路径上重算目录", () => {
  // 实测依据：目录冷求值与索引规模成正比（8000 项 ≈2ms），而索引 size/bytes
  // 在流式输出期间每个 delta 都变 → 控制器缓存必然未命中 → 每帧重算。
  // 因此「关闭时零成本」必须由门控保证，不能依赖缓存。
  assert.ok(HOOK.includes("useState(false)"), "open 状态由 hook 单一拥有");
  assert.match(
    HOOK,
    /open \? \(store\?\.getIndexDirectory\(\) \?\? EMPTY_INDEX_DIRECTORY\) : EMPTY_INDEX_DIRECTORY/,
    "目录必须在 open 为真时才求值，关闭时返回稳定空目录引用",
  );
  const memoDeps = HOOK.match(/\[open, store, projectionState, fallbackSummary\]/);
  assert.ok(memoDeps, "目录 useMemo 必须把 open 列为依赖");
});

test("hook: open/setOpen 随 API 暴露，面板不再自持第二份 open 状态", () => {
  assert.ok(HOOK.includes("setOpen,"), "hook 必须把 setOpen 交给面板");
  assert.equal(
    PANEL.includes("useState"),
    false,
    "面板不得自持 useState —— open 的唯一所有者是 hook（避免两条写入路径）",
  );
  assert.match(PANEL, /const \{ open, setOpen,[\s\S]*?\} =\s*focusApi;/);
});

// ── timeline / SessionPane 接线 ──

test("timeline: 暴露 scrollToRowIdActionRef，unitIndex 由 timeline 自行解析", () => {
  assert.ok(TIMELINE.includes("scrollToRowIdActionRef"));
  assert.ok(TIMELINE.includes("resolveUnitIndexForRowId"));
  assert.ok(
    TIMELINE.includes("unitsRef.current"),
    "unitIndex 必须从 timeline 自己的 renderUnits 解析（派生事实不外泄）",
  );
});

test("timeline: 目标未挂载时不猜测性跳转（返回而非兜底滚到顶部）", () => {
  assert.ok(TIMELINE.includes("if (unitIndex === null) return;"));
});

test("SessionPane: 焦点正文前插到权威尾部之前合成 rows（派生视图不入权威状态）", () => {
  assert.ok(SESSION_PANE.includes("useConversationIndexFocus"));
  assert.ok(SESSION_PANE.includes("[...timelineFocusRows, ...tailRows]"));
  assert.ok(SESSION_PANE.includes("rows={timelineRows}"));
  assert.ok(
    SESSION_PANE.includes("EMPTY_TIMELINE_ROWS"),
    "空 rows 必须是稳定引用，避免每帧新建数组击穿 memo",
  );
});

test("SessionPane: 目录入口只对正式会话挂载（草稿/只读/副屏不给目录）", () => {
  assert.ok(SESSION_PANE.includes("!isDraft && !readOnly && !selectionSideChat"));
  assert.ok(SESSION_PANE.includes("<ConversationIndexFocusBridge"));
});

test("SessionPane: store 仅在 lease 就绪后交给 hook（避免跨会话串号）", () => {
  // 断言语义而非逐字文本：oxfmt 会在 `lease?.store ?? null` 外加括号
  // （实测加过一次就打断过本用例），故对可选括号与空白容错。
  const gated =
    /useConversationIndexFocus\(\s*sessionLeaseReady\s*\?\s*\(?\s*lease\?\.store\s*\?\?\s*null\s*\)?\s*:\s*null\s*,?\s*\)/;
  assert.match(SESSION_PANE, gated, "store 必须由 sessionLeaseReady 门控后才交给 hook");
});

// ── i18n key 完整性（两个 locale 都必须补齐；此处守护 key 面）──

test("i18n: 面板/hook 用到的目录 key 集合固定（lead 合并两 locale 时对照）", () => {
  const keys = new Set<string>();
  for (const source of [PANEL, HOOK]) {
    for (const match of source.matchAll(/id: "(chat\.indexDirectory\.[a-zA-Z]+)"/g)) {
      keys.add(match[1] as string);
    }
  }
  const expected = [
    "chat.indexDirectory.continueOlder",
    "chat.indexDirectory.count",
    "chat.indexDirectory.empty",
    "chat.indexDirectory.emptySummary",
    "chat.indexDirectory.hiddenOlder",
    "chat.indexDirectory.inWindow",
    "chat.indexDirectory.jumpToQuery",
    "chat.indexDirectory.label",
    "chat.indexDirectory.noBudget",
    "chat.indexDirectory.notIndexed",
    "chat.indexDirectory.partial",
    "chat.indexDirectory.rangeExhausted",
    "chat.indexDirectory.retryableFailure",
    "chat.indexDirectory.returnToLive",
    "chat.indexDirectory.running",
    "chat.indexDirectory.targetMissing",
    "chat.indexDirectory.unknownTime",
  ];
  for (const key of expected) {
    assert.ok(keys.has(key), `缺少 i18n key: ${key}`);
  }
  assert.equal(
    keys.size,
    expected.length,
    `意外多出 key: ${[...keys].filter((k) => !expected.includes(k)).join(", ")}`,
  );
});
