// /usage 命令族的公共类型面（specs/usage-statusbar.md「/usage 命令族」节）。
// 本模块是零 token 本地命令的实现基座：只依赖 contracts 类型，不 import
// cli/bootstrap/ui，不触模型；cli command-center 与 bootstrap v4 handler 均为薄宿主。
import type {
  AppUsageQueryResult,
  ListSessionsInput,
  SessionId,
  SessionInfo,
  UsageStorePort,
} from "@acode/contracts";

/** 报表文案语言（宿主把 app locale 归一化后注入；见 normalizeUsageQueryLocale）。 */
export type UsageQueryLocale = "zh" | "en";

/** 参数解析闭集（非法输入不产生 scope，走 UsageQueryParseError）。 */
export type UsageQueryScope =
  /** today / week / days:N（days = 覆盖的本地日数，today=1、week=7）。 */
  | { kind: "range"; range: "today" | "week" | "days"; days: number }
  /** models[:N]：近 N 个本地日的按天模型细分（N 的语义 = 天数，见 parse.ts 头注）。 */
  | { kind: "models"; days: number }
  /** sessions[:N]：最近 N 个根会话（子会话消耗合并进根，避免重复计算）。 */
  | { kind: "sessions"; limit: number }
  /** workspace:关键词（目录/路径/workspace 标识的大小写不敏感子串匹配）。 */
  | { kind: "workspace"; keyword: string }
  /** session:ID前缀（大小写不敏感前缀匹配）。 */
  | { kind: "session"; prefix: string }
  /** current：最近 CURRENT_WINDOW_MINUTES 分钟内有请求活动的会话。 */
  | { kind: "current" };

export type UsageQueryParseErrorCode =
  | "unknownScope"
  | "multipleArgs"
  | "invalidNumber"
  | "outOfRange"
  | "emptyKeyword"
  | "emptyPrefix";

export interface UsageQueryParseError {
  code: UsageQueryParseErrorCode;
  /** 触发错误的原始片段（回执中如实回显）。 */
  value: string;
  field?: "days" | "limit";
  min?: number;
  max?: number;
}

export type UsageQueryParseResult =
  | { ok: true; scope: UsageQueryScope }
  | { ok: false; error: UsageQueryParseError };

/** 取数依赖：UsageStorePort 的只读查询面 + 会话枚举（结构取自 SessionStorePort，不改 port）。 */
export interface UsageQueryDeps {
  usageStore: Pick<UsageStorePort, "queryAppUsage" | "queryTaskUsage">;
  /** 实际 store 同时实现 SessionStorePort（父子关系用 SessionInfo.parentID，port 面已有）。 */
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /** 调用端时区相对 UTC 的固定偏移（ms），与 AppUsageQueryInput.tzOffsetMs 同语义。 */
  tzOffsetMs: number;
  /** 可注入时钟（测试确定性）；缺省 Date.now()。 */
  now?: number;
}

/** 会话累计口径（queryTaskUsage 各数值字段的合并求和；totalTokens 沿用 producer 事实）。 */
export interface UsageTokenTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
}

/** 一条会话报表行：展示根 + 已合并的后代（mergedChildIds 不含自身）。 */
export interface UsageSessionEntry {
  session: SessionInfo;
  mergedChildIds: SessionId[];
  usage: UsageTokenTotals;
}

/** 本地日窗口事实（渲染层用它标注范围，不再自行推算）。 */
export interface UsageQueryWindow {
  since: number;
  until: number;
  tzOffsetMs: number;
  dayCount: number;
}

export type UsageQueryReport =
  | { kind: "range"; range: "today" | "week" | "days"; window: UsageQueryWindow; result: AppUsageQueryResult }
  | { kind: "models"; window: UsageQueryWindow; result: AppUsageQueryResult }
  | { kind: "sessions"; limit: number; tzOffsetMs: number; entries: UsageSessionEntry[] }
  | { kind: "workspace"; keyword: string; tzOffsetMs: number; entries: UsageSessionEntry[] }
  | { kind: "session"; prefix: string; tzOffsetMs: number; entries: UsageSessionEntry[] }
  | {
      kind: "current";
      windowMinutes: number;
      windowStart: number;
      tzOffsetMs: number;
      entries: UsageSessionEntry[];
    }
  | { kind: "invalid"; args: string; error: UsageQueryParseError };

export interface UsageQueryExecutionResult {
  /** false = 非法参数或取数失败（text 为可读回执，绝不抛裸异常）。 */
  ok: boolean;
  text: string;
  scope: UsageQueryScope | null;
}

export const USAGE_QUERY_DAY_MS = 86_400_000;
