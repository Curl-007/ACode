// 结构守护测试，非行为验证：ui 测试无 jsdom 套件，组件不真渲染，以下断言全部落在源码字符串上，
// 钉住 JSX/接线不被回归改动，不驱动 React 树或验证运行时行为（登记见 god-component-split-plan.md 测试债清单）。
// 对话行事实面三件小改的源码级守护（packages/ui/specs/chat-row-facts.md）。
// 形态对照 toolSearchSurface.test.ts：ui 测试无 jsdom 套件，组件不真渲染，
// 用「源码契约」钉住：①动作行常驻（hover 透明门控清零、占位几何不动）；
// ②用户行时间戳接线；③速率标签的数据接线（turnHeader.stats → 轮尾动作行）；
// ④session-debug 共享轮询（会话级 Map + 末位退订即停）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ROW_VIEW = "../src/v4/ConversationRowView.tsx";
const TURN_GROUP = "../src/v4/ConversationTurnGroup.tsx";
const SESSION_DEBUG_HOOK = "../src/hooks/useSessionDebug.ts";

test("① 动作行常驻：三处 hover 透明门控类清零（用户行/assistant 内联/轮尾）", () => {
  const rowView = readSource(ROW_VIEW);
  const turnGroup = readSource(TURN_GROUP);
  assert.doesNotMatch(rowView, /group-hover\/user-row:opacity-100/);
  assert.doesNotMatch(rowView, /group-hover\/assistant-row:opacity-100/);
  assert.doesNotMatch(turnGroup, /group-hover\/assistant-turn:opacity-100/);
  // 轮尾 hook 兜底动作行同样常驻（无 className 门控残留）。
  assert.doesNotMatch(turnGroup, /opacity-0 transition-opacity/);
});

test("① 占位几何不动：用户行动作行仍是 mt-1 的 MessageActions（只删透明度类）", () => {
  const rowView = readSource(ROW_VIEW);
  // 常驻注释与几何锚：MessageActions className="mt-1"（原先 mt-1 + opacity 门控同层）。
  assert.match(rowView, /<MessageActions className="mt-1">/);
  // assistant 内联完成态动作行保留 mt-1 占位。
  assert.match(rowView, /className="mt-1"\s*\/>\s*\) : null\}/);
});

test("② 用户行时间戳：row.createdAt 经 formatMessageTimeLabel 派生并渲染 subtlest 标签", () => {
  const rowView = readSource(ROW_VIEW);
  assert.match(rowView, /formatMessageTimeLabel\(row\.createdAt, locale, intl\)/);
  // 用户行 MessageActions 内的时间标签与 assistant 行同形态。
  const userRowSection = rowView.slice(
    rowView.indexOf("<MessageActions className=\"mt-1\">"),
    rowView.indexOf("</MessageActions>"),
  );
  assert.match(
    userRowSection,
    /\{timeLabel \? \(\s*<span className="select-none text-ui-sm text-foreground-subtlest">\{timeLabel\}<\/span>/,
  );
});

test("③ 速率展示：动作行消费 turnHeader.stats，↑prefill/↓decode 独立隐藏", () => {
  const rowView = readSource(ROW_VIEW);
  const turnGroup = readSource(TURN_GROUP);
  // 纯函数接线：stats prop（optional，缺席=隐藏）+ formatSpeedLabels。
  assert.match(rowView, /stats\?: TurnHeaderStats \| null;/);
  assert.match(rowView, /formatSpeedLabels\(/);
  assert.match(rowView, /↑\{prefillLabel\}/);
  assert.match(rowView, /↓\{decodeLabel\}/);
  // 轮尾调用点把原生轮次事实接进来（与 TurnRateLine 同一数据源 unit.header?.stats）。
  assert.match(turnGroup, /stats=\{unit\.header\?\.stats \?\? null\}/);
});

test("④ session-debug 共享轮询：会话级 Map、useSyncExternalStore、末位退订即停", () => {
  const hook = readSource(SESSION_DEBUG_HOOK);
  assert.match(hook, /const sharedLoops = new Map<string, SharedLoop>\(\)/);
  assert.match(hook, /useSyncExternalStore\(subscribe, getSnapshot, getSnapshot\)/);
  // 末位退订即停：listeners 清零 → stopped + clearTimeout + 按值删除 Map 条目。
  assert.match(hook, /loop\.listeners\.size === 0/);
  assert.match(hook, /sharedLoops\.delete\(key\)/);
  // 失败保留最近一次成功快照，仅置 error 标记。
  assert.match(hook, /error: true/);
});

test("单位键双语成对（复用既有 chat.usageStatusbar.unit.tokensPerSecond，无新键）", async () => {
  const enUS = (await import("../src/i18n/locales/en-US.js")).default;
  const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default;
  const key = "chat.usageStatusbar.unit.tokensPerSecond";
  assert.ok(enUS[key]?.length > 0, `en-US missing ${key}`);
  assert.ok(zhCN[key]?.length > 0, `zh-CN missing ${key}`);
});
