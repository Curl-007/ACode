import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 统一明细面板稳定性契约（specs/usage-statusbar.md「Tooltip 稳定性与统一明细面板」节，
// 2026-10-19 重写，替代原胶囊级 tooltipStability 契约）：
// 六个胶囊级 Tooltip 全部退役，明细合并为锚定整条 bar 的受控 Popover 统一面板。
//
// 核心不变量（运行时复现确证，CDP 静止指针录证 repro-streaming-run2/proof-run2）：
// 流式期间 composer 高度变化会把 bar 在静止指针下纵向推移，元素级 mouseleave 与
// Radix Tooltip 的 trigger 命中一样会误杀面板。因此关闭判定只允许一条路径——
// window 级 mousemove 对 bar ∪ 面板的当前 getBoundingClientRect 做点内命中测试，
// 指针落在两者之外才启动 ~150ms 关闭宽限；**指针静止 = 无 mousemove = 面板保持
// 打开**。任何元素级 mouseleave 关闭路径都是本契约的违例。
//
// 本测试是源码契约（非 DOM 交互测试）——ui 包无 jsdom/happy-dom/testing-library，
// 无法做真实 pointer 事件级断言；交互级验证走运行时验收（spec 验收场景 7）。
//
// 契约源面 = 组件 + open 状态 hook 的**联合源码**（2026-10-19 收尾修正）：受控 open
// 逻辑抽到 useUsageDetailPanelOpen.ts（400 行 ratchet：内联回 UsageStatusbar.tsx 会
// 超限），不变量本身不变——断言对「panel-open 路径」两文件联合判定，宿主接线允许
// `panel.` 命名空间前缀（hook API 对象）。任何逻辑回迁/再拆分只要不变量在联合源面
// 中成立即视为满足契约。

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_STATUSBAR_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbar.tsx");
const PANEL_OPEN_HOOK_PATH = resolve(
  __dirname,
  "../src/v4/usage-statusbar/useUsageDetailPanelOpen.ts",
);
const CAPSULE_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbarCapsule.tsx");
const FORMAT_PATH = resolve(__dirname, "../src/v4/usage-statusbar/usageStatusbarFormat.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

/** panel-open 路径联合源码：组件（接线）+ hook（open 状态机与命中测试）。 */
function readPanelOpenSource(): { statusbar: string; hook: string; combined: string } {
  const statusbar = readSource(USAGE_STATUSBAR_PATH);
  const hook = readSource(PANEL_OPEN_HOOK_PATH);
  return { statusbar, hook, combined: `${statusbar}\n${hook}` };
}

// ── bar 级 hover 锚点：胶囊级 Tooltip 退役 ──

test("统一面板：bar 级 hover 锚点——胶囊级 Tooltip 全部退役（不得回退）", () => {
  const { statusbar, hook, combined } = readPanelOpenSource();
  const capsule = readSource(CAPSULE_PATH);
  // 退役判据：panel-open 路径与胶囊都不得再引入 Radix Tooltip 面（原局部
  // TooltipProvider 修复随胶囊级 tooltip 一并退役；统一面板不依赖任何 Tooltip
  // 隐性关闭路径）。
  assert.ok(
    !statusbar.includes("@/components/ui/tooltip.js"),
    "UsageStatusbar 不得再引入 Tooltip（胶囊级 tooltip 已退役）",
  );
  assert.ok(
    !capsule.includes("@/components/ui/tooltip.js"),
    "UsageStatusbarCapsule 不得再引入 Tooltip（胶囊不再各自包 Tooltip）",
  );
  assert.ok(
    !hook.includes("@/components/ui/tooltip.js"),
    "useUsageDetailPanelOpen 不得引入 Tooltip（open 状态机与 Tooltip 面无关）",
  );
  assert.ok(!/tooltip\?:/.test(capsule), "Capsule 不得保留 tooltip prop");
  // bar 是唯一 hover 触发器：mouseenter 打开受控面板（宿主接线 + hook 内开语义）。
  assert.match(statusbar, /onMouseEnter=\{(?:panel\.)?handleBarMouseEnter\}/);
  assert.match(combined, /setHoverOpen\(true\)/);
});

test("统一面板：位置关闭只走 window 级 mousemove 命中测试，禁止元素级 mouseleave（核心不变量）", () => {
  const { statusbar, hook, combined } = readPanelOpenSource();
  // 不变量钉法：panel-open 路径（组件 + hook）不得出现元素级 onMouseLeave——指针
  // 静止（无 mousemove）时面板必须保持打开，几何推移不误杀；关闭判定唯一来源 =
  // mousemove 对当前 rect 的点内命中测试。
  for (const [name, source] of [
    ["UsageStatusbar", statusbar],
    ["useUsageDetailPanelOpen", hook],
  ] as const) {
    assert.ok(
      !source.includes("onMouseLeave"),
      `${name} 禁止元素级 mouseleave 关闭路径（纵向推移误杀与 tooltip 闪断同机制）`,
    );
  }
  assert.match(
    hook,
    /window\.addEventListener\("mousemove", handleMouseMove\)/,
    "面板打开期间必须挂 window 级 mousemove 监听",
  );
  assert.match(hook, /getBoundingClientRect\(\)/, "命中测试必须对 bar ∪ 面板的当前 rect 现取判定");
  // 命中测试覆盖 bar 与面板两个 ref。
  assert.match(hook, /\[barRef\.current, panelRef\.current\]/);
  // 受控 open + 150ms 关闭宽限 + 监听/timer 清理。
  assert.match(hook, /const PANEL_CLOSE_GRACE_MS = 150;/);
  assert.match(statusbar, /open=\{(?:panel\.)?panelOpen\}/);
  assert.match(hook, /window\.removeEventListener\("mousemove", handleMouseMove\)/);
  assert.match(hook, /window\.clearTimeout\(closeTimerRef\.current\)/);
  // 钉住后忽略位置关闭；Esc/点击外部走常规 Popover 语义解除钉住。
  assert.match(hook, /if \(!panelOpen \|\| pinned\) return;/);
  assert.match(combined, /setPinned\(false\);\s*\n\s*setHoverOpen\(false\);/);
});

test("统一面板：点击钉住豁免齿轮与自带 Popover 的胶囊；与子代理面板互斥", () => {
  const { statusbar, hook, combined } = readPanelOpenSource();
  const capsule = readSource(CAPSULE_PATH);
  // 钉住豁免标记：齿轮容器与 popover 胶囊 button 都带 data-usage-statusbar-no-pin。
  assert.match(statusbar, /data-usage-statusbar-no-pin/);
  assert.match(capsule, /data-usage-statusbar-no-pin/);
  assert.match(hook, /closest\(PANEL_PIN_EXEMPT_SELECTOR\)/);
  // 互斥：panelOpen 含 !subagentOpen 门；打开子代理面板时关统一面板。
  assert.match(hook, /const panelOpen = \(hoverOpen \|\| pinned\) && !subagentOpen;/);
  const subagentHandler = hook.slice(hook.indexOf("const handleSubagentOpenChange"));
  assert.ok(subagentHandler.length > 0, "hook 必须定义 handleSubagentOpenChange");
  assert.match(subagentHandler, /setHoverOpen\(false\);/);
  assert.match(subagentHandler, /setPinned\(false\);/);
  // 子代理 Popover 受控接线（宿主持有 open 状态才能做互斥）。
  assert.match(statusbar, /popoverOpen=\{(?:panel\.)?subagentOpen\}/);
  assert.match(statusbar, /onPopoverOpenChange=\{(?:panel\.)?handleSubagentOpenChange\}/);
  // 宿主消费的是 hook 的互斥面板 open（联合源面收口，防两侧各持一份 open 状态）。
  assert.match(combined, /const panel = useUsageDetailPanelOpen\(\);/);
});

// ── 布局稳定规则（视觉 calm；流式几何突变治理）──

test("布局稳定：每胶囊稳定 key = 项 id（条件渲染不依赖数组位置）", () => {
  const statusbar = readSource(USAGE_STATUSBAR_PATH);
  for (const itemId of [
    "generationSpeed",
    "turnUsage",
    "sessionCumulative",
    "toolCalls",
    "todayTotal",
    "subagents",
  ]) {
    assert.match(
      statusbar,
      new RegExp(`key="${itemId}"`),
      `胶囊 ${itemId} 必须带稳定 key（= USAGE_STATUSBAR_ITEM_IDS 项 id）`,
    );
  }
});

test("布局稳定：每胶囊固定 min-w 槽位（微标签+典型值宽度档），值 tick 不推挤邻居", () => {
  const statusbar = readSource(USAGE_STATUSBAR_PATH);
  // 六档 min-w 常量集中定义（档位预算见组件内注释）。
  for (const itemId of [
    "generationSpeed",
    "turnUsage",
    "sessionCumulative",
    "toolCalls",
    "todayTotal",
    "subagents",
  ]) {
    assert.match(
      statusbar,
      new RegExp(`${itemId}: "min-w-\\[`),
      `CAPSULE_MIN_WIDTH 必须有 ${itemId} 档`,
    );
    // 每胶囊 className 组合了隐藏层级与自身 min-w 槽位。
    const capsuleStart = statusbar.indexOf(`key="${itemId}"`);
    assert.ok(capsuleStart > 0);
    const block = statusbar.slice(capsuleStart, capsuleStart + 400);
    assert.match(
      block,
      new RegExp(`CAPSULE_MIN_WIDTH\\.${itemId}`),
      `胶囊 ${itemId} 的 className 必须挂自身 min-w 槽位`,
    );
  }
  // 数值区等宽数字（tabular-nums）仍在胶囊基类上。
  assert.match(readSource(CAPSULE_PATH), /tabular-nums/);
});

test("布局稳定：脉冲点常驻槽位——固定尺寸 span 恒渲染，opacity 切换显隐，绝不条件插拔", () => {
  const capsule = readSource(CAPSULE_PATH);
  // 槽位由 pulseSlot 声明（哪些胶囊有脉冲语义），span 恒渲染、显隐只切 opacity。
  assert.match(capsule, /pulseSlot\?: boolean/);
  assert.match(
    capsule,
    /\{pulseSlot \? \(/,
    "脉冲槽渲染门必须是 pulseSlot（常驻），不得是 pulse（插拔）",
  );
  assert.match(
    capsule,
    /pulse \? "opacity-100 animate-pulse motion-reduce:animate-none" : "opacity-0"/,
    "显隐只允许 opacity 切换（占位不变）",
  );
  // 旧的条件插拔形态（{pulse ? <span …dot…/> : null} 直接以 pulse 门控 span 存在）不得回退：
  // 点 span 的类名组合里 size-1.5 恒在（不受 pulse 三元影响）。
  assert.match(capsule, /"size-1\.5 shrink-0 rounded-full bg-success",/);
  // 三个脉冲胶囊（速度/本轮/工具）都声明常驻槽位。
  const statusbar = readSource(USAGE_STATUSBAR_PATH);
  const pulseSlotCount = statusbar.match(/pulseSlot/g)?.length ?? 0;
  assert.ok(pulseSlotCount >= 3, "速度/本轮/工具三胶囊必须声明 pulseSlot 常驻槽位");
});

test("布局稳定：值变更 160ms 淡入 keyed span 保留（固定槽内重挂载）", () => {
  const capsule = readSource(CAPSULE_PATH);
  assert.match(
    capsule,
    /key=\{typeof value === "string" \? value : undefined\}\s*\n\s*className="usage-statusbar-value-swap/,
    "值 span 必须以值字符串为 key（真实变更才重挂载/重放动画）",
  );
  assert.match(capsule, /usage-statusbar-value-swap min-w-0 truncate/);
});

// ── 原契约保留项：format 占位（value 永不为 null）──

test("usageStatusbarFormat：null 输入恒返回非空字符串占位（value 永不为 null/undefined）", () => {
  // 守护"value 永不为 null"不变量：formatUsageTokenCount 等在 null 输入时返回
  // "—"（USAGE_NO_DATA_PLACEHOLDER），绝不返回 null/undefined。这保证 Capsule 的
  // <span>{value}</span> 子节点恒为 string，React 不会因 null 子节点触发
  // reconciliation 的 null↔string 切换。
  const source = readSource(FORMAT_PATH);
  assert.ok(
    source.includes("return USAGE_NO_DATA_PLACEHOLDER;"),
    "format 函数须对 null 输入返回 USAGE_NO_DATA_PLACEHOLDER（非 null/undefined）",
  );
  // 确认每个 format 函数都有 null 早返回（结构性守护）
  const formatFns = [
    "formatTokensPerSecond",
    "formatUsageDurationMs",
    "formatUsageTokenCount",
    "formatUsagePercent",
    "formatUsageCount",
  ];
  for (const fn of formatFns) {
    assert.ok(
      new RegExp(`export function ${fn}\\([\\s\\S]*?return USAGE_NO_DATA_PLACEHOLDER;`).test(
        source,
      ),
      `${fn} 须对 null 输入返回占位符`,
    );
  }
});
