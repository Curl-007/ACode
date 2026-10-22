/**
 * 用量状态栏的展示投影（apps/acode-cli/specs/usage-statusbar-port.md §2）。
 *
 * 数字全部来自 snapshot / CLI 投影或本地 AppUsage 聚合；这里只做可见性、语气和格式化，
 * 不重算指标、不估算、不从 row 窗口挑轮次。纯函数、无 React 与 i18n provider 依赖，
 * 文案通过 `formatMessage` 注入，便于单测。
 *
 * 主模型只留「类型 + 开关解析 + 编排」；段构造在 `usageBarSegments.ts`（速度/本轮）与
 * `usageBarSessionSegments.ts`（会话/工具/今日/子智能体），容量判据在 `usageBarCapacity.ts`，
 * 面板行在 `usageBarSubagents.ts`。
 */
import type { TurnMetricsMessageFormat } from "@/chat-input-toolbar/turnMetrics.js";
import type { TurnMetrics } from "@acode/shared/acode-protocol-v4";
import { buildContextSegment, type ContextCapacityInput } from "./usageBarCapacity.js";
import {
  buildSpeedSegment,
  buildTurnUsageSegment,
  type ToolStatsInput,
} from "./usageBarSegments.js";
import {
  buildSessionSegment,
  buildSubagentsSegment,
  buildTodaySegment,
  buildToolsSegment,
} from "./usageBarSessionSegments.js";

export type UsageBarSegmentId =
  | "speed"
  | "turnUsage"
  | "context"
  | "session"
  | "tools"
  | "today"
  | "subagents";

/**
 * 语气词表。绿有两种语义，由 data-tone 区分：
 * `live` = 正在生成（实时估算）；`success` = 档位达标 / 正向读数。
 */
export type UsageBarTone = "default" | "success" | "live" | "warning" | "error" | "estimated";

/** 错误徽标（感叹号 + 数字，destructive 14% 胶囊）。 */
export interface UsageBarErrorBadge {
  count: number;
  /** 可访问文案（徽标是装饰元素，数字由 aria-label 读出）。 */
  label: string;
}

export interface UsageBarDetailRow {
  label: string;
  value: string;
  tone?: "default" | "error" | "success" | "live" | "warning";
  /** 有值时该行渲染为错误徽标（值本身仍保留给 aria 与测试）。 */
  badge?: UsageBarErrorBadge;
}

export interface UsageBarSegment {
  id: UsageBarSegmentId;
  label: string;
  value: string;
  tone: UsageBarTone;
  /** 详细弹层的行；最后一行口径说明放 note。 */
  detailRows: UsageBarDetailRow[];
  note: string | null;
  /** 段值形状：容量段用环形进度替代前置图标（16×16 / stroke 3 / pathLength=100）。 */
  ring?: { ratio: number };
  /** 超限闪烁（prefers-reduced-motion 下由 CSS 静止）。 */
  blink?: boolean;
  /** 段值右侧的错误徽标（工具段；0 错误时不存在）。 */
  badge?: UsageBarErrorBadge;
  /** 段值右侧的运行点（子智能体段有任务在跑时）。 */
  dot?: "live";
}

/** 开关字段。缺省一律「开」。 */
export interface UsageBarSettings {
  /** 总开关：关闭后整条状态栏与回答末尾速率行都不渲染（子开关保持原样、只记偏好）。 */
  enabled: boolean;
  speed: boolean;
  turnUsage: boolean;
  context: boolean;
  session: boolean;
  tools: boolean;
  today: boolean;
  subagents: boolean;
  answerFooter: boolean;
}

/**
 * 折叠顺序：宽度不够时先收上下文容量，再收今日、本轮，然后子智能体、工具
 * （容器查询断点 639px / 479px）。生成速度、会话累计与齿轮永不收起。
 */
export const USAGE_BAR_COLLAPSE_ORDER: readonly UsageBarSegmentId[] = [
  "context",
  "today",
  "turnUsage",
  "subagents",
  "tools",
];

/**
 * 每个可折叠段挂在哪个断点档：`wideTier` = 639px 起就收起，`narrowTier` = 479px 起才收起。
 * 视图用它算「+N」到底代表哪几段。
 */
export const USAGE_BAR_COLLAPSE_TIER: Partial<
  Record<UsageBarSegmentId, "wideTier" | "narrowTier">
> = {
  context: "wideTier",
  today: "wideTier",
  turnUsage: "wideTier",
  subagents: "narrowTier",
  tools: "narrowTier",
};

/** 行内子开关的键（不含挂在分组标题上的总开关 `enabled`）。 */
export type UsageBarSubToggleKey = Exclude<keyof UsageBarSettings, "enabled">;

/** 开关顺序：七段在上，「回答末尾速率行」在下（齿轮弹层与设置页共用）。 */
export const USAGE_BAR_TOGGLE_ORDER: readonly UsageBarSubToggleKey[] = [
  "speed",
  "turnUsage",
  "context",
  "session",
  "tools",
  "today",
  "subagents",
  "answerFooter",
];

/**
 * 开关展示名复用状态栏段名，保证齿轮弹层与设置页文案一致。
 * 只覆盖行内子开关：总开关 `enabled` 挂在设置分组标题上，用分组标题文案。
 */
export const USAGE_BAR_TOGGLE_LABEL_ID: Record<UsageBarSubToggleKey, string> = {
  speed: "chat.usageStatusbar.speed.label",
  turnUsage: "chat.usageStatusbar.turnUsage.label",
  context: "chat.usageStatusbar.context.label",
  session: "chat.usageStatusbar.session.label",
  tools: "chat.usageStatusbar.tools.label",
  today: "chat.usageStatusbar.today.label",
  subagents: "chat.usageStatusbar.subagents.label",
  answerFooter: "chat.usageStatusbar.settings.answerFooter",
};

export interface UsageBarInput {
  /** snapshot.composerTurnMetrics（CLI 权威下发，当前轮）。 */
  turnMetrics: { metrics: TurnMetrics; streaming: boolean } | null;
  /**
   * 会话当前是否在跑（snapshot.control.phase 为 running/prewarming）。
   * composerTurnMetrics 在轮开始即被清空、首个请求完成前都是 null，不能只靠它判断「流式中」。
   */
  turnLive: boolean;
  /** 主会话累计（含子会话合计前的自身部分）；null = 无数据。 */
  mainTokenTotal: number | null;
  /** 主会话累计的输入 / 输出分项；null = 分项不可用。 */
  mainInputTokens: number | null;
  mainOutputTokens: number | null;
  /** 主会话累计 + 子代理累计；null = 无数据。 */
  sessionTokenTotal: number | null;
  /** 有子代理用量读不到（会话累计显示 ≥）。 */
  incompleteTotal: boolean;
  /** 上下文容量（snapshot.usage.contextWindow）；null = 无窗口信息，容量段不渲染。 */
  contextCapacity: ContextCapacityInput | null;
  /** 主会话可见输出速度（估算），仅流式期非 null。 */
  liveOutputRate: number | null;
  /** 子代理可见输出速度（估算）。 */
  childLiveOutputRate: number | null;
  /** 子代理数量（0 = 不渲染子智能体段）。 */
  childCount: number;
  /** 子代理累计 token（含未落账估算）。 */
  childTokenTotal: number;
  /** 子代理本次请求的可见输出（估算）；null = 没有子代理在输出。 */
  childCurrentOutputTokens: number | null;
  /** 主会话平均缓存命中率（0~1，contextWindow.cache.hitRate）；null = provider 未上报。 */
  cacheHitRate: number | null;
  /** snapshot.sessionToolStats；null = 旧 CLI 或冷恢复无数据。缺失字段对应明细行隐藏。 */
  toolStats: ToolStatsInput | null;
  /** 子代理分组：运行中 / 已结束数量、主会话自身累计，以及「只算运行中任务」的 token 合计。 */
  subagentGroups: {
    running: number;
    ended: number;
    mainTokenTotal: number | null;
    /** 运行中任务的 tokens 之和；null = 这些任务的用量都读不到（段值省略 tokens 部分）。 */
    runningTokenTotal: number | null;
  };
  /** 本机今日合计；null = 未加载或查询失败。 */
  todayUsage: {
    totalTokens: number;
    turnCount: number;
    toolCallCount: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitRate?: number;
    requestCount?: number;
  } | null;
  /** 会话累计预估费用文本；null = 不可用。 */
  estimatedCostLabel: string | null;
  settings: UsageBarSettings;
  formatMessage: TurnMetricsMessageFormat;
  locale: string;
}

export interface UsageBarModel {
  segments: UsageBarSegment[];
  /** 全部段都被关掉或没数据时为 false，整条不渲染。 */
  visible: boolean;
}

export const DEFAULT_USAGE_BAR_SETTINGS: UsageBarSettings = {
  enabled: true,
  speed: true,
  turnUsage: true,
  context: true,
  session: true,
  tools: true,
  today: true,
  subagents: true,
  answerFooter: true,
};

/** 目标设置切片（lib/usageStatusbarPreferences.ts）的只读形状；模型层不 import localStorage。 */
interface UsageBarPreferencesInput {
  enabled?: boolean;
  visibleItems?: Partial<
    Record<
      | "generationSpeed"
      | "turnUsage"
      | "contextCapacity"
      | "sessionCumulative"
      | "toolCalls"
      | "todayTotal"
      | "subagents",
      boolean
    >
  >;
  /** 新字段；旧数据只有 rateLineEnabled。 */
  answerFooter?: boolean;
  /** 旧字段（兼容既有 localStorage 与目标旧组件）。 */
  rateLineEnabled?: boolean;
}

/**
 * 目标设置切片 → 状态栏开关的唯一映射点（spec §7.1）。
 * `answerFooter` 优先，旧 `rateLineEnabled` 作为迁移回退；缺省一律「开」。
 */
export function resolveUsageBarSettings(
  preferences: UsageBarPreferencesInput | null | undefined,
): UsageBarSettings {
  const items = preferences?.visibleItems ?? {};
  return {
    enabled: preferences?.enabled ?? DEFAULT_USAGE_BAR_SETTINGS.enabled,
    speed: items.generationSpeed ?? DEFAULT_USAGE_BAR_SETTINGS.speed,
    turnUsage: items.turnUsage ?? DEFAULT_USAGE_BAR_SETTINGS.turnUsage,
    context: items.contextCapacity ?? DEFAULT_USAGE_BAR_SETTINGS.context,
    session: items.sessionCumulative ?? DEFAULT_USAGE_BAR_SETTINGS.session,
    tools: items.toolCalls ?? DEFAULT_USAGE_BAR_SETTINGS.tools,
    today: items.todayTotal ?? DEFAULT_USAGE_BAR_SETTINGS.today,
    subagents: items.subagents ?? DEFAULT_USAGE_BAR_SETTINGS.subagents,
    answerFooter:
      preferences?.answerFooter ??
      preferences?.rateLineEnabled ??
      DEFAULT_USAGE_BAR_SETTINGS.answerFooter,
  };
}

/** 齿轮弹层写入用：以当前生效值打底，合并本次改动，写成完整对象。 */
export function mergeUsageBarSettings(
  current: UsageBarSettings,
  patch: Partial<UsageBarSettings>,
): UsageBarSettings {
  return { ...current, ...patch };
}

/** 状态栏开关 → 设置切片键（齿轮弹层/设置页写回时使用）。 */
export const USAGE_BAR_TOGGLE_PREFERENCE_KEY: Record<
  UsageBarSubToggleKey,
  | "generationSpeed"
  | "turnUsage"
  | "contextCapacity"
  | "sessionCumulative"
  | "toolCalls"
  | "todayTotal"
  | "subagents"
  | "answerFooter"
> = {
  speed: "generationSpeed",
  turnUsage: "turnUsage",
  context: "contextCapacity",
  session: "sessionCumulative",
  tools: "toolCalls",
  today: "todayTotal",
  subagents: "subagents",
  answerFooter: "answerFooter",
};

/**
 * 生成当前可见的段。每段独立判断：开关关闭、或没有可信数字，都整段不出现
 * （不显示 0、不显示占位符）。顺序：生成速度 → 本轮用量 → 上下文容量 → 会话累计
 * → 工具调用 → 今日合计 → 子智能体。
 */
export function buildUsageBarModel(input: UsageBarInput): UsageBarModel {
  const { settings, formatMessage, locale } = input;
  // 总开关：关闭后整条不渲染，也不逐段判断（子开关的值保持不变，重新打开即恢复）。
  if (!settings.enabled) return { segments: [], visible: false };
  const segments: UsageBarSegment[] = [];
  const metrics = input.turnMetrics?.metrics ?? null;

  if (settings.speed) {
    // 轮开始时 CLI 把 composerTurnMetrics 清成 null，首个请求完成前 streaming 恒为
    // false，估算速度永远不出现，运行中「生成速度」整段消失。会话 phase 是运行态的权威事实。
    const streaming = (input.turnMetrics?.streaming ?? false) || input.turnLive;
    const segment = buildSpeedSegment({
      metrics,
      estimatedRate: input.liveOutputRate,
      measuredRate: metrics?.tokensPerSecond ?? null,
      streaming,
      locale,
      formatMessage,
    });
    if (segment !== null) segments.push(segment);
  }

  if (settings.turnUsage) {
    // 目标协议没有 inFlight：首个 ModelComplete 前本轮段隐藏（spec §12.3 允许）。
    const segment = buildTurnUsageSegment({
      metrics,
      locale,
      formatMessage,
    });
    if (segment !== null) segments.push(segment);
  }

  if (settings.context && input.contextCapacity !== null) {
    const segment = buildContextSegment({
      capacity: input.contextCapacity,
      locale,
      formatMessage,
    });
    if (segment !== null) segments.push(segment);
  }

  if (settings.session && input.sessionTokenTotal !== null) {
    segments.push(
      buildSessionSegment({
        sessionTokenTotal: input.sessionTokenTotal,
        incompleteTotal: input.incompleteTotal,
        mainInputTokens: input.mainInputTokens,
        mainOutputTokens: input.mainOutputTokens,
        cacheHitRate: input.cacheHitRate,
        childCount: input.childCount,
        childTokenTotal: input.childTokenTotal,
        toolStats: input.toolStats,
        estimatedCostLabel: input.estimatedCostLabel,
        locale,
        formatMessage,
      }),
    );
  }

  if (settings.tools && input.toolStats !== null) {
    segments.push(buildToolsSegment({ toolStats: input.toolStats, locale, formatMessage }));
  }

  if (settings.today && input.todayUsage !== null) {
    segments.push(buildTodaySegment({ todayUsage: input.todayUsage, locale, formatMessage }));
  }

  if (settings.subagents && input.childCount > 0) {
    segments.push(
      buildSubagentsSegment({
        childTokenTotal: input.childTokenTotal,
        runningTokenTotal: input.subagentGroups.runningTokenTotal,
        childLiveOutputRate: input.childLiveOutputRate,
        childCurrentOutputTokens: input.childCurrentOutputTokens,
        subagentGroups: input.subagentGroups,
        locale,
        formatMessage,
      }),
    );
  }

  return { segments, visible: segments.length > 0 };
}
