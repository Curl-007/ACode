import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tooltip 稳定性修复（specs/usage-statusbar.md「Tooltip 稳定性」节）的源码契约守护：
// 对话流式输出/思考进行中悬停胶囊 tooltip 闪断的根因是全局 TooltipProvider
// (delayDuration=0 + 默认 skipDelayDuration=300) 下 Radix Tooltip hoverable content
// 机制（grace area pointer 追踪）在高频 re-render 下误判指针离开 → onClose() 关闭。
// 修复：UsageStatusbar 外包局部 TooltipProvider 设 disableHoverableContent。
//
// 本测试是源码契约（非 DOM 交互测试）——ui 包无 jsdom/happy-dom/testing-library，
// 无法做真实 pointer 事件级断言。交互级行为验证依赖运行时（见 verify 字段说明）。
// 此处守护：修复配置不被回退、分支结构稳定、value 永不为 null（排除"分支切换
// 导致触发器重挂载"候选根因）。

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_STATUSBAR_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbar.tsx");
const CAPSULE_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbarCapsule.tsx");
const FORMAT_PATH = resolve(__dirname, "../src/v4/usage-statusbar/usageStatusbarFormat.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("UsageStatusbar 局部 TooltipProvider 配置 disableHoverableContent（根因修复契约）", () => {
  const source = readSource(USAGE_STATUSBAR_PATH);
  // 修复点：局部 TooltipProvider 必须显式设 disableHoverableContent，禁用导致
  // grace area 抖动的 hoverable content 机制。若有人回退此配置，本断言失败。
  assert.ok(
    /<TooltipProvider[^>]*disableHoverableContent/.test(source),
    "UsageStatusbar 必须外包局部 TooltipProvider 并设 disableHoverableContent（根因修复点，不得回退）",
  );
  // delayDuration=0 保留：不改变首次悬停的零延迟体验（与全局 Provider 一致）。
  assert.ok(
    /<TooltipProvider[^>]*delayDuration=\{0\}/.test(source),
    "局部 TooltipProvider 须显式 delayDuration={0} 保留零延迟体验",
  );
});

test("UsageStatusbarCapsule 非 popover 分支结构稳定：tooltipContent 恒非 null 时不走裸 span 分支", () => {
  const source = readSource(CAPSULE_PATH);
  // 分支结构：!tooltipContent 时返回裸 span（无 Tooltip 包裹），非 null 时包 Tooltip。
  // UsageStatusbar 的所有非 popover 胶囊恒传 tooltip（ReactNode，非 null），
  // 因此 tooltipContent 恒非 null，分支稳定——排除"流式中 null↔非 null 切换导致
  // 触发器 span↔Tooltip 重挂载"作为候选根因。
  assert.ok(
    source.includes("if (!tooltipContent) return staticBody;"),
    "Capsule 须保留 !tooltipContent 裸 span 分支（结构契约）",
  );
});

test("usageStatusbarFormat：null 输入恒返回非空字符串占位（value 永不为 null/undefined）", () => {
  // 守护"value 永不为 null"不变量：formatUsageTokenCount 等在 null 输入时返回
  // "—"（USAGE_NO_DATA_PLACEHOLDER），绝不返回 null/undefined。这保证 Capsule 的
  // <span>{value}</span> 子节点恒为 string，React 不会因 null 子节点触发
  // reconciliation 的 null↔string 切换（排除另一候选根因）。
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
