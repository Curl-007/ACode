import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  formatCompactTokenNumber,
  formatModelContextWindowLabel,
} from "../src/lib/tokenNumberFormat.js";
import {
  formatCodeDelta,
  formatTokensPerSecond,
} from "../src/v4/usage-statusbar/usageStatusbarFormat.js";

// 用量状态栏 UI 优化（specs/usage-statusbar.md 2026-10-18 增补五节）的源码契约守护：
// 排版一致性 / hide-on-absent / 窄屏分级隐藏 / 值过渡动画双闸 / i18n 成对性。
// ui 测试无 jsdom（appearancePreferences.test.ts 头注）：组件结构按源码文本断言，
// 纯函数（tokenNumberFormat / formatCodeDelta / formatTokensPerSecond）直接单测。

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUSBAR_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbar.tsx");
const CAPSULE_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbarCapsule.tsx");
const RATE_LINE_PATH = resolve(__dirname, "../src/v4/usage-statusbar/TurnRateLine.tsx");
const STYLES_PATH = resolve(__dirname, "../src/styles.css");
const ZH = resolve(__dirname, "../src/i18n/locales/zh-CN.ts");
const EN = resolve(__dirname, "../src/i18n/locales/en-US.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

// ── 排版一致性 ──

test("排版：tooltip 标题统一 text-ui-sm（DESIGN.md Tooltip 行），不再用 text-ui-base", () => {
  for (const [name, source] of [
    ["UsageStatusbarCapsule", readSource(CAPSULE_PATH)],
    ["TurnRateLine", readSource(RATE_LINE_PATH)],
  ] as const) {
    assert.match(
      source,
      /text-ui-sm font-medium/,
      `${name} 的 tooltip 标题应为 text-ui-sm font-medium`,
    );
    assert.ok(
      !source.includes("text-ui-base font-medium"),
      `${name} 不得再用 text-ui-base 做 tooltip 标题`,
    );
  }
});

test("排版：tok/s 后缀走 i18n 键 chat.usageStatusbar.unit.tokensPerSecond（代码零硬编码）", () => {
  const format = readSource(
    resolve(__dirname, "../src/v4/usage-statusbar/usageStatusbarFormat.ts"),
  );
  // 模板串只能引用 unitSuffix 参数；字面量 "tok/s" 仅允许出现在缺省参数位。
  assert.match(format, /unitSuffix = "tok\/s"/);
  assert.match(format, /`\$\{value\} \$\{unitSuffix\}`/);
  const statusbar = readSource(STATUSBAR_PATH);
  const rateLine = readSource(RATE_LINE_PATH);
  for (const [name, source] of [
    ["UsageStatusbar", statusbar],
    ["TurnRateLine", rateLine],
  ] as const) {
    assert.match(
      source,
      /chat\.usageStatusbar\.unit\.tokensPerSecond/,
      `${name} 调用点必须传 i18n 单位`,
    );
  }
});

test("排版：zh compact 数字单点——万/亿 + 空格（1.2 万），en K/M/B 不变，容量徽标保持 en", () => {
  assert.equal(formatCompactTokenNumber("zh-CN", 12000), "1.2 万");
  assert.equal(formatCompactTokenNumber("zh-CN", 123456789), "1.2 亿");
  // 低于万（zh compact 起点）原样，不借英文 K。
  assert.equal(formatCompactTokenNumber("zh-CN", 1200), "1200");
  assert.equal(formatCompactTokenNumber("zh-CN", 999), "999");
  assert.equal(formatCompactTokenNumber("en-US", 12000), "12K");
  // 负数同规则（数字部分原样，仅补格）。
  assert.equal(formatCompactTokenNumber("zh-CN", -12000), "-1.2 万");
  // 技术规格徽标刻意保持 en（tokenNumberFormat 头注）。
  assert.equal(formatModelContextWindowLabel(12000), "12K");
});

test("排版：代码增删 +N −N 的减号是 U+2212（MINUS SIGN），形态钉住", () => {
  const delta = formatCodeDelta("en-US", 10, 2);
  assert.equal(delta, "+10 −2");
  assert.ok(delta.includes("−"), "必须含 U+2212");
  assert.ok(!delta.includes("-"), "不得用 ASCII hyphen-minus");
  const minusIndex = delta.indexOf("−");
  assert.equal(delta.codePointAt(minusIndex), 0x2212);
  assert.equal(formatCodeDelta("zh-CN", 0, 0), "+0 −0");
});

test("格式：formatTokensPerSecond null 早返回不变（tooltipStability 契约）；单位参数生效", () => {
  assert.equal(formatTokensPerSecond("en-US", null), "—");
  assert.equal(formatTokensPerSecond("en-US", 500), "500 tok/s");
  assert.equal(formatTokensPerSecond("en-US", 500, "tok/s"), "500 tok/s");
  assert.equal(formatTokensPerSecond("en-US", 500, "T/s"), "500 T/s");
});

// ── i18n 成对性 ──

test("i18n：用量状态栏新增键 zh-CN 与 en-US 成对存在", () => {
  const zh = readSource(ZH);
  const en = readSource(EN);
  const keys = [
    "chat.usageStatusbar.unit.tokensPerSecond",
    "chat.usageStatusbar.tools.running",
    "chat.usageStatusbar.tools.more",
    "chat.usageStatusbar.tools.lastError",
    "chat.usageStatusbar.today.favoriteModel",
    "chat.usageStatusbar.settings.autoHideNote",
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`"${key}"`), `${key} 缺 zh-CN`);
    assert.ok(en.includes(`"${key}"`), `${key} 缺 en-US`);
  }
  // 单位双语同值（specs/usage-statusbar.md「排版一致性」节）。
  assert.ok(zh.includes('"chat.usageStatusbar.unit.tokensPerSecond": "tok/s"'));
  assert.ok(en.includes('"chat.usageStatusbar.unit.tokensPerSecond": "tok/s"'));
});

// ── hide-on-absent 与子代理值语义（组件接线契约）──

test("hide-on-absent：六胶囊全部走 visible && presence 双门控；判定收进 model 纯函数", () => {
  const source = readSource(STATUSBAR_PATH);
  for (const item of [
    "generationSpeed",
    "turnUsage",
    "sessionCumulative",
    "toolCalls",
    "todayTotal",
    "subagents",
  ]) {
    assert.match(
      source,
      new RegExp(`visible\\.${item} && presence\\.${item}`),
      `${item} 胶囊必须同时受用户开关与 hide-on-absent 门控`,
    );
  }
  assert.match(source, /resolveUsageStatusbarPresence\(/, "判定必须来自 model 纯函数");
  // snapshot=null → presence 全 false → 只剩齿轮（齿轮不在门控内，恒渲染）。
  assert.match(source, /UsageStatusbarSettingsPopover/, "设置齿轮必须无条件保留");
});

test("子代理胶囊值 = 仅子累计（不再重复主代理值）", () => {
  const source = readSource(STATUSBAR_PATH);
  assert.ok(
    !source.includes("`${formatUsageTokenCount(locale, cumulative.totalTokens)} / `"),
    "不得再拼 主/子 双值",
  );
  const subagentBlock = source.slice(source.indexOf('testId="usage-statusbar-subagents"'));
  assert.match(
    subagentBlock,
    /value=\{formatUsageTokenCount\(locale, subagents\.childTotalTokens\)\}/,
    "子代理胶囊值必须只取 childTotalTokens",
  );
});

// ── 窄屏分级隐藏优先级（容器查询挂 @container/composer）──

test("容器查询：两级分级隐藏与优先级——先藏今日/子代理，再藏速度/工具/会话，本轮用量保留", () => {
  const source = readSource(STATUSBAR_PATH);
  // 常量 → 字面量映射先钉住（组件 JSX 引用常量，字面量集中在常量定义处）。
  assert.match(
    source,
    /const CAPSULE_HIDE_TIER_1 = "@max-\[520px\]\/composer:hidden";/,
    "第一级断点 520px",
  );
  assert.match(
    source,
    /const CAPSULE_HIDE_TIER_2 = "@max-\[420px\]\/composer:hidden";/,
    "第二级断点 420px（Tailwind v4 命名容器任意值语法）",
  );
  // 每胶囊的 className 提取（capsule JSX 块内）。
  const capsuleOfClass = (testId: string): string => {
    const index = source.indexOf(`testId="${testId}"`);
    assert.ok(index > 0, `${testId} 胶囊必须存在`);
    // 向前找同胶囊 JSX 开标签（<UsageStatusbarCapsule ... ）。
    const start = source.lastIndexOf("<UsageStatusbarCapsule", index);
    return source.slice(start, index);
  };
  // 第一级（先藏）：今日合计、子智能体。
  assert.ok(capsuleOfClass("usage-statusbar-today").includes("CAPSULE_HIDE_TIER_1"));
  assert.ok(capsuleOfClass("usage-statusbar-subagents").includes("CAPSULE_HIDE_TIER_1"));
  // 第二级（后藏）：生成速度、工具调用、会话累计。
  assert.ok(capsuleOfClass("usage-statusbar-speed").includes("CAPSULE_HIDE_TIER_2"));
  assert.ok(capsuleOfClass("usage-statusbar-tools").includes("CAPSULE_HIDE_TIER_2"));
  assert.ok(capsuleOfClass("usage-statusbar-session").includes("CAPSULE_HIDE_TIER_2"));
  // 本轮用量保留到最后：两级都不得隐藏。
  const turnBlock = capsuleOfClass("usage-statusbar-turn-usage");
  assert.ok(
    !turnBlock.includes("CAPSULE_HIDE_TIER_1") && !turnBlock.includes("CAPSULE_HIDE_TIER_2"),
  );
  // 优先级不倒置：第一级项不得带第二级类（避免窄屏提前消失于更宽断点）。
  assert.ok(!capsuleOfClass("usage-statusbar-today").includes("CAPSULE_HIDE_TIER_2"));
  assert.ok(!capsuleOfClass("usage-statusbar-subagents").includes("CAPSULE_HIDE_TIER_2"));
});

// ── 值过渡动画与相位指示 ──

test("动画：值淡入 CSS 双闸齐全（prefers-reduced-motion 基线 + data-acode-reduce-motion 覆盖）", () => {
  const styles = readSource(STYLES_PATH);
  const swapIndex = styles.indexOf(".usage-statusbar-value-swap {");
  assert.ok(swapIndex > 0);
  assert.match(styles, /@keyframes usage-statusbar-value-fade-in/);
  assert.match(
    styles,
    /\.usage-statusbar-value-swap \{[^}]*animation: usage-statusbar-value-fade-in 160ms ease-out;/,
  );
  // 闸一：媒体查询（取本类之后的第一处，styles.css 前部有其他组件的同名媒体查询）；
  // 闸二：应用内属性选择器。两处都必须把动画关掉。
  const gate1 = styles.indexOf("@media (prefers-reduced-motion: reduce)", swapIndex);
  assert.ok(gate1 > swapIndex);
  const gate1Block = styles.slice(gate1, gate1 + 300);
  assert.match(gate1Block, /\.usage-statusbar-value-swap \{[^}]*animation: none;/);
  assert.match(
    styles,
    /\[data-acode-reduce-motion="reduce"\] \.usage-statusbar-value-swap \{[^}]*animation: none;/,
  );
});

test("动画：胶囊值包 keyed span（key = 值字符串），running 相位走 pulse prop", () => {
  const capsule = readSource(CAPSULE_PATH);
  assert.match(
    capsule,
    /key=\{typeof value === "string" \? value : undefined\}\s*\n\s*className="usage-statusbar-value-swap/,
    "值 span 必须以值字符串为 key（真实变更才重挂载/重放动画）",
  );
  assert.match(capsule, /pulse\?: boolean/, "相位状态点必须是显式 prop");
  assert.match(capsule, /animate-pulse motion-reduce:animate-none/);
  const statusbar = readSource(STATUSBAR_PATH);
  assert.match(
    statusbar,
    /pulse=\{phaseRunning\}/,
    "生成速度胶囊的相位点来自请求边界事实（control.phase）",
  );
  assert.match(
    statusbar,
    /pulse=\{tools\.activeCount > 0\}/,
    "工具胶囊的相位点来自 activeCount 权威聚合",
  );
});
