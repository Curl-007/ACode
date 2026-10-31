import {
  LOCAL_DIAGNOSTIC_MAX_BYTES,
  LOCAL_DIAGNOSTIC_MAX_EVENTS,
  LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
  parseLocalDiagnosticReport,
  type LocalDiagnosticAvailability,
  type LocalDiagnosticEvent,
  type LocalDiagnosticFacts,
  type LocalDiagnosticProviderEntry,
  type LocalDiagnosticReport,
  type SaveDiagnosticReportResult,
} from "@acode/shared";

/**
 * U12 本地诊断报告**组合器**（纯函数）。
 * 契约真源：packages/shared/specs/local-diagnostic-report.md；UI 本地不变量见
 * packages/ui/specs/local-diagnostic-report-ui.md。
 *
 * 职责边界：只做 DTO 组合 + 可用性判定 + 大小/条目上限强制。**不采集**（采集是各端
 * platform.collectLocalDiagnostics 的职责）、**不脱敏**（schema 结构性排除敏感字段，
 * 各端只上报白名单事实）、**不持有状态**。
 *
 * 两条承重不变量：
 * 1. 可用性准确（契约产品规则 3）：未采集的组标 not-collected 且**缺席**；该端无法提供的标
 *    unavailable 且缺席。绝不把未检查的组标 collected（「缺失不伪造健康」）。
 * 2. 输出恒过 schema（契约 U12-A6）：结尾自校验 parseLocalDiagnosticReport，fail-loud。
 */

/** 用户可勾选的导出范围。默认最小集：build + connection + performance（spec 事件顺序）。 */
export interface DiagnosticScope {
  build: boolean;
  connection: boolean;
  performance: boolean;
  provider: boolean;
  events: boolean;
}

export const DEFAULT_DIAGNOSTIC_SCOPE: DiagnosticScope = {
  build: true,
  connection: true,
  performance: true,
  // provider 与 events 默认不选入：前者含用户 provider 配置摘要（需显式同意），
  // 后者是事件流摘要（体积最大）。spec 事件顺序：默认最小集。
  provider: false,
  events: false,
};

/** 组合器的输入事实（全部由调用方从各自所有者读取后传入）。 */
export interface ComposeDiagnosticReportInput {
  /** 各端 platform.collectLocalDiagnostics() 的返回。 */
  facts: LocalDiagnosticFacts;
  /** renderer 内存计数，来自 uiMemoryDiagnosticsRegistry.collect()；null = 不可得。 */
  memoryCounts: Record<string, number> | null;
  /** 内存指标是否可得（Web 无 performance.memory → false）。 */
  memoryAvailable: boolean;
  /** provider 诊断摘要；仅在 scope.provider 为真时使用。null = 无既有结果。 */
  providerEntries: LocalDiagnosticProviderEntry[] | null;
  /** 事件摘要；仅在 scope.events 为真时使用。 */
  events: LocalDiagnosticEvent[];
  scope: DiagnosticScope;
  generatedAt: string;
  /** 字节长度计算（可注入以便测试）；默认 TextEncoder。 */
  byteLength?: (text: string) => number;
}

/** 超上限时的丢弃优先级：先丢体积最大且默认不选的组，核心最小集（build/connection）永不丢。 */
const SIZE_DROP_ORDER = ["events", "provider", "performance"] as const;
type DroppableGroup = (typeof SIZE_DROP_ORDER)[number];

function defaultByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  // 无 TextEncoder 的环境（极老 Node）：按 UTF-16 保守上估，宁可判超限也不产出超大文件。
  return text.length * 2;
}

/**
 * 决定某组的可用性。规则（契约产品规则 3 + §接口契约判定规则）：
 * - 用户未选入 → not-collected（组缺席）
 * - 该端明确报 unavailable，或本地事实不可得 → unavailable（组缺席）
 * - 采集到但被大小上限丢弃 → truncated（组缺席，但标记说明「有数据只是没放进去」）
 * - 否则 → collected（组在场）
 */
function resolveAvailability(
  selected: boolean,
  available: boolean,
  droppedForSize: boolean,
): LocalDiagnosticAvailability {
  if (!selected) {
    return "not-collected";
  }
  if (droppedForSize) {
    return "truncated";
  }
  return available ? "collected" : "unavailable";
}

/**
 * 组合报告。返回的对象保证通过 parseLocalDiagnosticReport。
 *
 * 大小上限处理（契约量化门槛 ≤1 MiB）：先按范围组装完整报告，若超限则按 SIZE_DROP_ORDER
 * 逐组丢弃并把该组标 truncated，直到满足上限；核心最小集（build/connection）不丢——
 * 若丢掉可丢组后仍超限，说明 build/connection 本身异常庞大，此时 fail-loud 抛错而非静默产出
 * 超大文件（静默截断会让维护者拿到一份看似完整的报告）。
 */
export function composeLocalDiagnosticReport(
  input: ComposeDiagnosticReportInput,
): LocalDiagnosticReport {
  const byteLength = input.byteLength ?? defaultByteLength;
  const { facts, scope } = input;

  // events 条目上限（契约产品规则 6）：超出则裁到上限并标 truncated。
  const rawEvents = scope.events ? input.events : [];
  const eventsTruncatedByCount = rawEvents.length > LOCAL_DIAGNOSTIC_MAX_EVENTS;
  const cappedEvents = eventsTruncatedByCount
    ? rawEvents.slice(0, LOCAL_DIAGNOSTIC_MAX_EVENTS)
    : rawEvents;

  // 各组「本地可得性」（与用户选择无关，只反映事实是否存在）。
  const buildAvailable = facts.buildAvailability === "collected" && facts.build !== undefined;
  const connectionAvailable =
    facts.connectionAvailability === "collected" && facts.connection !== undefined;
  const performanceAvailable = input.memoryCounts !== null;

  /** 按给定「因大小被丢弃的组集合」组装一份报告。 */
  const build = (dropped: ReadonlySet<DroppableGroup>): LocalDiagnosticReport => {
    // build/connection 是核心最小集，不在丢弃候选内（SIZE_DROP_ORDER 只含 events/provider/
    // performance），故它们的可用性只取决于事实是否存在，不受 dropped 影响。
    const includeBuild = scope.build;
    const includeConnection = scope.connection;
    const includePerformance = scope.performance && !dropped.has("performance");
    const includeProvider = scope.provider && !dropped.has("provider");
    const includeEvents = scope.events && !dropped.has("events");

    const report: LocalDiagnosticReport = {
      schemaVersion: LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
      platformType: facts.platformType,
      generatedAt: input.generatedAt,
      fieldAvailability: {
        build: resolveAvailability(scope.build, buildAvailable, false),
        connection: resolveAvailability(scope.connection, connectionAvailable, false),
        performance: resolveAvailability(
          scope.performance,
          performanceAvailable,
          dropped.has("performance"),
        ),
        provider: resolveAvailability(
          scope.provider,
          input.providerEntries !== null,
          dropped.has("provider"),
        ),
        // events：条目超限 或 因大小被丢弃，都算 truncated（都是「有数据但没全放进去」）。
        events: resolveAvailability(
          scope.events,
          true,
          eventsTruncatedByCount || dropped.has("events"),
        ),
      },
    };

    // 组缺席（未选入 / 不可得 / 被丢弃）时**不写该字段**，而不是写空对象——
    // 「缺席 + 对应 availability」才是契约要求的表达，空对象会被误读为「查过且为空」。
    if (includeBuild && buildAvailable && facts.build) {
      report.build = facts.build;
    }
    if (includeConnection && connectionAvailable && facts.connection) {
      report.connection = facts.connection;
    }
    if (includePerformance && performanceAvailable && input.memoryCounts) {
      report.performance = {
        counts: input.memoryCounts,
        memoryAvailable: input.memoryAvailable,
      };
    }
    if (includeProvider && input.providerEntries) {
      report.provider = { entries: input.providerEntries };
    }
    if (includeEvents && cappedEvents.length > 0) {
      report.events = cappedEvents;
    }
    return report;
  };

  // build/connection 不在丢弃候选内（核心最小集，体积小且最有诊断价值）。
  let dropped = new Set<DroppableGroup>();
  let report = build(dropped);
  let serialized = JSON.stringify(report);

  for (const group of SIZE_DROP_ORDER) {
    if (byteLength(serialized) <= LOCAL_DIAGNOSTIC_MAX_BYTES) {
      break;
    }
    dropped = new Set(dropped).add(group);
    report = build(dropped);
    serialized = JSON.stringify(report);
  }

  if (byteLength(serialized) > LOCAL_DIAGNOSTIC_MAX_BYTES) {
    // 丢弃全部可选组后仍超限 = 核心组异常庞大（如 capabilities 被塞入超长值）。
    // fail-loud 而非静默截断：静默产出超大文件会让维护者误以为报告完整。
    throw new Error("local-diagnostic-report-too-large");
  }

  // 自校验：契约 U12-A6 要求输出恒过 schema；失败即本组合器有 bug，fail-loud 不吞。
  return parseLocalDiagnosticReport(JSON.parse(serialized));
}

/**
 * 可用性四态 → i18n 键。抽到 lib 做纯函数（而非留在组件内）以便行为测试：
 * 四态必须**可见地区分**渲染（契约验收 U12-A4），键映射错了用户就看到错误的状态标签。
 * exhaustive switch：新增枚举值时 TypeScript 会在此报错，防止静默落到 default。
 */
export function diagnosticAvailabilityLabelId(
  state: LocalDiagnosticAvailability,
): string {
  switch (state) {
    case "collected":
      return "diagnostics.availability.collected";
    case "unavailable":
      return "diagnostics.availability.unavailable";
    case "not-collected":
      return "diagnostics.availability.notCollected";
    case "truncated":
      return "diagnostics.availability.truncated";
  }
}

/** 可用性四态 → Badge variant。只用 Badge 既有 variant（DESIGN.md：不新造样式）。 */
export function diagnosticAvailabilityBadgeVariant(
  state: LocalDiagnosticAvailability,
): "secondary" | "destructive" | "outline" {
  switch (state) {
    // collected = 正常；truncated = 警示（有数据但没全放进去）；其余 = 弱化。
    case "collected":
      return "secondary";
    case "truncated":
      return "destructive";
    case "unavailable":
    case "not-collected":
      return "outline";
  }
}

/** 报告建议文件名（含平台与时间戳，便于多份报告区分）。 */
export function diagnosticReportFileName(
  platformType: LocalDiagnosticFacts["platformType"],
  generatedAt: string,
): string {
  // 文件名只用安全字符：把 ISO 时间的冒号/点替换掉，避免跨平台非法文件名字符。
  const stamp = generatedAt.replace(/[:.]/g, "-");
  return `acode-diagnostics-${platformType}-${stamp}.json`;
}

/** 下载结果的用户可见归类（契约产品规则 7：不谎报成功）。 */
export type DownloadOutcome =
  | { kind: "saved"; path?: string }
  | { kind: "cancelled" }
  | { kind: "copied" }
  | { kind: "failed"; errorCode: string };

/**
 * 把平台保存结果 + 剪贴板可用性解析成用户可见结果。抽成纯函数以便行为测试
 * （对话框组件层在本仓无 jsdom，radix Portal 无法渲染，故决策逻辑必须可脱离组件验证）。
 *
 * 决策规则（契约产品规则 7 / 验收 U12-A5）：
 * - 用户取消 → `cancelled`（静默，不弹错误：取消是正常结果）
 * - 保存成功 → `saved`（带路径则显示路径）
 * - 平台无 saveDiagnosticReport（旧 preload / 不支持）或保存失败 → 剪贴板可用则 `copied`
 *   并如实告知「浏览器无法直接下载」，不可用则 `failed` + 稳定码
 */
export function resolveDownloadOutcome(input: {
  /** 平台保存结果；undefined = 平台未提供 saveDiagnosticReport。 */
  result: SaveDiagnosticReportResult | undefined;
  clipboardAvailable: boolean;
}): DownloadOutcome {
  const { result, clipboardAvailable } = input;
  if (result?.cancelled) {
    return { kind: "cancelled" };
  }
  if (result?.saved) {
    return { kind: "saved", ...(result.path ? { path: result.path } : {}) };
  }
  // 保存缺席或失败 → 降级剪贴板；连剪贴板都没有才报失败。
  if (clipboardAvailable) {
    return { kind: "copied" };
  }
  return { kind: "failed", errorCode: result?.error ?? "save-unavailable" };
}
