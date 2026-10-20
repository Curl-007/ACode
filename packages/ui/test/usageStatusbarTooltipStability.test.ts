import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tooltip 稳定性最小修复（specs/usage-statusbar.md「Tooltip 稳定性」2026-10-19 重写节）
// 的源码契约守护。真根因（运行时录证确证）：流式期间胶囊几何突变把 trigger 从静止
// 指针下推走 → 浏览器补发 pointerleave → Radix Tooltip 关闭，而其重开只认
// pointermove（hasPointerMoveOpenedRef 门）→ 静止指针永不重开。
// 修复 = 自管 hover 生命周期（受控 Popover + 三条关闭路径）+ 布局稳定三规则。
//
// 本测试是源码契约（非 DOM 交互测试）——ui 包无 jsdom/happy-dom/testing-library。
// 交互级验证依赖运行时录证脚本（scratch/e2e-usage-statusbar-redesign/hover-repro.mjs，
// 修复前 repro-streaming-run2.jsonl / 修复后应全程 0 关闭）。

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../src/v4/usage-statusbar");
const USAGE_STATUSBAR_PATH = resolve(DIR, "UsageStatusbar.tsx");
const CAPSULE_PATH = resolve(DIR, "UsageStatusbarCapsule.tsx");
const PANEL_PATH = resolve(DIR, "UsageSubagentPanel.tsx");
const FORMAT_PATH = resolve(DIR, "usageStatusbarFormat.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("Radix Tooltip 退役：usage-statusbar 目录不再引入 Tooltip 组件/Provider", () => {
  const bar = readSource(USAGE_STATUSBAR_PATH);
  const capsule = readSource(CAPSULE_PATH);
  assert.ok(
    !bar.includes("TooltipProvider"),
    "UsageStatusbar 不得再包 TooltipProvider（自管生命周期取代 Radix Tooltip）",
  );
  assert.ok(
    !capsule.includes("components/ui/tooltip.js"),
    "Capsule 不得再引入 Radix Tooltip 包装（pointermove 重开门是闪断根因之一）",
  );
});

test("自管 hover 生命周期契约：pointerenter 开 + 位置命中测试关 + 边界事件不作关闭依据", () => {
  const bar = readSource(USAGE_STATUSBAR_PATH);
  const capsule = readSource(CAPSULE_PATH);
  // 单一 hovered 状态（单开天然）。
  assert.ok(bar.includes("hoveredCapsuleId"), "须有单一 hoveredCapsuleId 状态驱动单开");
  // 开 = 胶囊 pointerenter（布局位移把新胶囊推到静止指针下时边界事件同样触发）。
  assert.ok(/onCapsuleEnter=\{/.test(bar), "胶囊开态须由 pointerenter 驱动");
  // 关闭路径①：打开期间 window mousemove 对整条 bar 当前 rect 命中测试落在外面。
  assert.ok(
    /window\.addEventListener\("mousemove"/.test(bar),
    "关闭路径①须为打开期间 window 级 mousemove 命中测试",
  );
  assert.ok(
    /event\.clientX < rect\.left[\s\S]{0,200}event\.clientY > rect\.bottom/.test(bar),
    "命中测试须对 bar 当前 rect 四边判定（rect 每次现取，几何推移天然免疫）",
  );
  // 布局位移补发的边界事件一律不作关闭依据：胶囊不得挂 onPointerLeave。
  assert.ok(
    !capsule.includes("onPointerLeave"),
    "胶囊不得挂 onPointerLeave（位移补发的 leave 会误杀静止指针悬停，post-hoverfix-run1 实证）",
  );
  // 关闭路径②：Popover 主动关闭（Escape/外部点击）经 onTooltipDismiss 收口。
  assert.ok(/onTooltipDismiss=\{/.test(bar), "关闭路径②须经 onTooltipDismiss 收口");
  // 核心不变量注释在位：指针静止 = 明细常驻。
  assert.ok(bar.includes("指针静止 = 明细常驻"), "核心不变量注释不得删除");
});

test("Capsule 浮层契约：受控 Popover + pointer-events-none + 稳定 testid", () => {
  const capsule = readSource(CAPSULE_PATH);
  assert.ok(/<Popover\s*\n?\s*open=\{tooltipOpen\}/.test(capsule), "浮层须为受控 Popover");
  assert.ok(
    capsule.includes("pointer-events-none"),
    "浮层须 pointer-events-none（只读明细不参与命中，避免干扰自管生命周期）",
  );
  assert.ok(
    capsule.includes('data-testid="usage-statusbar-tooltip"'),
    "浮层须挂稳定 testid 供运行时录证脚本判定在场",
  );
  assert.ok(
    /onPointerEnter=\{tooltip \? onCapsuleEnter : undefined\}/.test(capsule),
    "pointerenter 仅在有明细的胶囊挂载",
  );
});

test("布局稳定三规则：稳定 key / min-w 槽位 / 脉冲点常驻槽", () => {
  const bar = readSource(USAGE_STATUSBAR_PATH);
  const capsule = readSource(CAPSULE_PATH);
  for (const id of [
    "generationSpeed",
    "turnUsage",
    "sessionCumulative",
    "toolCalls",
    "todayTotal",
    "subagents",
  ]) {
    assert.ok(bar.includes(`key="${id}"`), `胶囊须有稳定 key=${id}（不依赖数组位置）`);
  }
  assert.ok(/CAPSULE_MIN_WIDTH = \{/.test(bar), "须有每胶囊固定 min-w 槽位表");
  // 脉冲点常驻槽：固定 span 恒渲染、opacity 切换；不得条件插拔。
  assert.ok(
    capsule.includes('pulse ? "opacity-100" : "opacity-0"'),
    "脉冲点须常驻槽位 opacity 切换（插拔会造成宽度突变杀悬停）",
  );
  assert.ok(!/\{pulse \? \(/.test(capsule), "脉冲点不得条件插拔渲染");
});

test("子代理口径说明迁移：hover Tooltip 退役、note 移入点击面板", () => {
  const panel = readSource(PANEL_PATH);
  assert.ok(
    panel.includes("chat.usageStatusbar.subagents.tooltip"),
    "子代理值语义口径说明须移入点击面板（i18n key 不变）",
  );
  const bar = readSource(USAGE_STATUSBAR_PATH);
  assert.ok(
    !/tooltip=\{[\s\S]{0,80}subagents\.tooltip/.test(bar),
    "子代理胶囊不得再挂 hover tooltip",
  );
});

test("usageStatusbarFormat：null 输入恒返回非空字符串占位（value 永不为 null/undefined）", () => {
  const source = readSource(FORMAT_PATH);
  assert.ok(
    source.includes("return USAGE_NO_DATA_PLACEHOLDER;"),
    "format 函数须对 null 输入返回 USAGE_NO_DATA_PLACEHOLDER（非 null/undefined）",
  );
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
