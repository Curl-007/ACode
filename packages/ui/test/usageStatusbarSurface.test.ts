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
const PANEL_PATH = resolve(__dirname, "../src/v4/usage-statusbar/UsageStatusbarDetailPanel.tsx");
// 面板内容契约源面 = 装配文件 + 请求作用域分组姊妹文件（400 行 ratchet 拆分，行内容
// 零改写；断言对两者联合源码判定，分组再搬家只要契约在联合源面成立即满足）。
const PANEL_GROUPS_PATH = resolve(
  __dirname,
  "../src/v4/usage-statusbar/UsageStatusbarDetailRequestGroups.tsx",
);
const RATE_LINE_PATH = resolve(__dirname, "../src/v4/usage-statusbar/TurnRateLine.tsx");
const STYLES_PATH = resolve(__dirname, "../src/styles.css");
const ZH = resolve(__dirname, "../src/i18n/locales/zh-CN.ts");
const EN = resolve(__dirname, "../src/i18n/locales/en-US.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

/** 统一面板联合源面：装配文件（分组门控/序）+ 请求作用域分组姊妹文件。 */
function readPanelSurface(): string {
  return `${readSource(PANEL_PATH)}\n${readSource(PANEL_GROUPS_PATH)}`;
}

// ── 排版一致性 ──

test("排版：面板标题/速率行 tooltip 标题统一 text-ui-sm（DESIGN.md Tooltip 行），不再用 text-ui-base", () => {
  for (const [name, source] of [
    // 2026-10-19：胶囊级 tooltip 退役，明细标题面在统一面板（UsageStatusbarDetailPanel）。
    ["UsageStatusbarDetailPanel", readSource(PANEL_PATH)],
    ["TurnRateLine", readSource(RATE_LINE_PATH)],
  ] as const) {
    assert.match(source, /text-ui-sm font-medium/, `${name} 的明细标题应为 text-ui-sm font-medium`);
    assert.ok(
      !source.includes("text-ui-base font-medium"),
      `${name} 不得再用 text-ui-base 做明细标题`,
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
    // 2026-10-19 重设计：微标签 ×6、统一面板、秒表降级文案、live 口径脚注与行标签。
    "chat.usageStatusbar.speed.shortLabel",
    "chat.usageStatusbar.turnUsage.shortLabel",
    "chat.usageStatusbar.session.shortLabel",
    "chat.usageStatusbar.tools.shortLabel",
    "chat.usageStatusbar.today.shortLabel",
    "chat.usageStatusbar.subagents.shortLabel",
    "chat.usageStatusbar.speed.generating",
    "chat.usageStatusbar.panel.title",
    "chat.usageStatusbar.panel.inFlight",
    "chat.usageStatusbar.panel.inProgress",
    "chat.usageStatusbar.panel.inFlightNote",
    "chat.usageStatusbar.detail.elapsed",
    "chat.usageStatusbar.detail.liveOutput",
    "chat.usageStatusbar.detail.liveSpeed",
    "chat.usageStatusbar.detail.announcedInput",
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`"${key}"`), `${key} 缺 zh-CN`);
    assert.ok(en.includes(`"${key}"`), `${key} 缺 en-US`);
  }
  // 单位双语同值（specs/usage-statusbar.md「排版一致性」节）。
  assert.ok(zh.includes('"chat.usageStatusbar.unit.tokensPerSecond": "tok/s"'));
  assert.ok(en.includes('"chat.usageStatusbar.unit.tokensPerSecond": "tok/s"'));
});

// ── 微标签形态与统一面板分组（2026-10-19 重设计）──

test("微标签：胶囊 = icon + 微标签 + 值；shortLabel 走 *.shortLabel i18n 键、text-ui-xs 弱化色", () => {
  const capsule = readSource(CAPSULE_PATH);
  assert.match(capsule, /shortLabel: string;/, "shortLabel 是必填 prop");
  assert.match(
    capsule,
    /text-ui-xs font-normal text-foreground-subtlest">\{shortLabel\}/,
    "微标签必须 text-ui-xs + foreground-subtlest 级弱化色（DESIGN.md 弱元数据）",
  );
  // aria-label 仍用全名 label（微标签只是视觉短形式）。
  assert.match(capsule, /aria-label=\{label\}/);
  const statusbar = readSource(STATUSBAR_PATH);
  for (const item of ["speed", "turnUsage", "session", "tools", "today", "subagents"]) {
    assert.match(
      statusbar,
      new RegExp(`chat\\.usageStatusbar\\.${item}\\.shortLabel`),
      `${item} 胶囊必须接 shortLabel i18n 键`,
    );
  }
});

test("统一面板：分组存在且 hide-on-absent——无数据分组不渲染；分组不受胶囊显隐偏好影响", () => {
  const panel = readPanelSurface();
  // 分组序（spec「Tooltip 稳定性与统一明细面板」节）：本次请求（进行中）→ 速度权威 →
  // 本轮 → 会话 → 今日 → 工具 → 子代理。
  for (const groupId of ["in-flight", "speed", "turn", "session", "today", "tools", "subagents"]) {
    assert.ok(
      panel.includes(`usage-statusbar-panel-group-${groupId}`),
      `面板必须有 ${groupId} 分组`,
    );
  }
  // hide-on-absent：分组渲染全部由数据在场门控（缺席 ≠ 零值）。
  assert.match(panel, /\{inFlightActive \? <InFlightGroup/);
  assert.match(panel, /\{lastRequest \? <SpeedGroup/);
  assert.match(panel, /\{cumulative \? <SessionGroup/);
  assert.match(panel, /\{todayTotals \? <TodayGroup/);
  assert.match(panel, /\{tools \? <ToolsGroup/);
  assert.match(panel, /\{subagents \? <SubagentsGroup/);
  // 偏好只治 bar：面板组件不得引用显隐偏好（分组恒全量）。
  assert.ok(!panel.includes("useUsageStatusbarPreferences"), "面板分组不得受胶囊显隐偏好影响");
  assert.ok(!panel.includes("visibleItems"), "面板分组不得引用 visibleItems");
  // 既有 tooltip 行内容全量保留的抽样：工具 8 行封顶 + 「+N 更多」+ lastError 弱化行、
  // 今日主要模型、会话缓存读/写。
  assert.match(panel, /slice\(0, 8\)/);
  assert.match(panel, /chat\.usageStatusbar\.tools\.more/);
  assert.match(panel, /chat\.usageStatusbar\.tools\.lastError/);
  assert.match(panel, /chat\.usageStatusbar\.today\.favoriteModel/);
  assert.match(panel, /chat\.usageStatusbar\.detail\.cacheReadTokens/);
  assert.match(panel, /chat\.usageStatusbar\.detail\.cacheWriteTokens/);
});

test("统一面板：本次请求分组行 = 秒表已耗时 + live 输出/速度 + 通告输入 + 首字（在场时）+ 口径脚注", () => {
  const panel = readPanelSurface();
  assert.match(panel, /chat\.usageStatusbar\.detail\.elapsed/);
  assert.match(panel, /chat\.usageStatusbar\.detail\.liveOutput/);
  assert.match(panel, /chat\.usageStatusbar\.detail\.liveSpeed/);
  assert.match(panel, /chat\.usageStatusbar\.detail\.announcedInput/);
  assert.match(panel, /live\.timeToFirstTokenMs !== null \?/, "首字行仅在事实在场时渲染");
  assert.match(panel, /chat\.usageStatusbar\.panel\.inFlightNote/, "进行中口径脚注必须在场");
  // 秒表 hook 只在分组内消费（定时器随面板开合挂载/清理）。
  assert.match(
    panel,
    /useStopwatchElapsedMs\(\{ startedAtMs: live\.startedAtMs, active: true \}\)/,
  );
});

test("live 消费：速度胶囊三态接线（live tok/s / 生成中秒表降级 / 空闲权威值），本轮 live 合计 + 脉冲", () => {
  const statusbar = readSource(STATUSBAR_PATH);
  // 速度三态由纯函数 resolveUsageSpeedDisplayMode 单点判定。
  assert.match(statusbar, /resolveUsageSpeedDisplayMode\(\{/);
  assert.match(statusbar, /speed\.generating/, "秒表降级必须走「生成中 · {seconds}」i18n 文案");
  // 秒表定时器仅在降级档挂载（live/空闲档不挂）。
  assert.match(statusbar, /active: speedMode === "stopwatch"/);
  // live 派生事件驱动：useMemo 依赖 inFlight，严禁定时器重算速率。
  assert.match(statusbar, /deriveUsageInFlightLiveView\(\{ phaseRunning, inFlight \}\)/);
  assert.match(statusbar, /\[phaseRunning, inFlight\]/);
  // 本轮胶囊：live 合计在场才加进行中标记（复用常驻脉冲槽）。
  assert.match(statusbar, /const turnLiveActive = live\.turnToDateTotalTokens !== null;/);
  assert.match(statusbar, /pulse=\{turnLiveActive\}/);
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
  // 2026-10-19 微标签形态后阈值按 min-w 槽位预算重调（520/420 → 660/470），
  // 优先级次序不变（spec「窄屏分级隐藏优先级」节末尾 2026-10-19 注）。
  assert.match(
    source,
    /const CAPSULE_HIDE_TIER_1 = "@max-\[660px\]\/composer:hidden";/,
    "第一级断点 660px（六胶囊 min-w 全量预算 ≈658）",
  );
  assert.match(
    source,
    /const CAPSULE_HIDE_TIER_2 = "@max-\[470px\]\/composer:hidden";/,
    "第二级断点 470px（藏今日/子代理后预算 ≈470；Tailwind v4 命名容器任意值语法）",
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
