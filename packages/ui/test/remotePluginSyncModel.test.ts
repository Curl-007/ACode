// RemotePluginSyncDialog helper 外迁的**接缝内测试**（god-component-split-plan.md
// settings/RemotePluginSyncDialog 批次的前置条件）。
//
// 覆盖 src/settings/remote-plugin-sync/remotePluginSyncModel.ts 27 个纯函数的关键路径：
// 同步行构建矩阵 × 默认选择解析 × portable option 值判定 × stopped 错误形态 ×
// marketplace source 序列化 × install 诊断格式化。逐字迁移的行为安全网。
import assert from "node:assert/strict";
import test from "node:test";
import type { PluginSyncCandidate, PluginSyncImportResult, PluginSyncRemoteStatus } from "@acode/shared";
import { type V4PluginInfo, type V4PluginMarketplaceSummary, type V4PluginUserConfigOption, type V4PluginsOverviewResult } from "@acode/shared/acode-protocol-v4";
import {
  RemotePluginSyncStoppedError,
  applyPluginInfoToRemoteSyncCandidate,
  arePluginOptionsEqual,
  buildMarketplaceRemotePluginStatuses,
  buildMarketplaceRemotePluginSyncCandidates,
  buildMarketplaceSourceSyncInfo,
  buildPortablePluginOptionsSyncPlan,
  buildRemotePluginSyncPluginOptions,
  buildRemotePluginSyncRows,
  buildRemotePluginSyncRowsForCandidates,
  buildSelectedMarketplacePluginNames,
  buildStoppedRemotePluginResult,
  componentTypesFromPluginInfo,
  createInlineStatusKey,
  createRemotePluginSyncOperationId,
  enrichRemotePluginSyncCandidatesWithPluginInfo,
  filterRemotePluginSyncRows,
  formatInstallError,
  isPathPluginOption,
  isPortablePluginOptionValue,
  isRemotePluginSyncStoppedError,
  resolveDefaultRemotePluginSyncSelection,
  serializeMarketplaceSourceInput,
  shouldAllowRemotePluginSyncDialogOpenChange,
  shouldFinishRemotePluginSyncRun,
  summarizeLocalPluginOptionsForDisplay,
  toInlineRemotePluginSyncCandidate,
  type RemotePluginSyncCandidate,
  type RemotePluginSyncRow,
} from "../src/settings/remote-plugin-sync/remotePluginSyncModel.js";

// ── 最小 fixture ──

function inlineCandidate(overrides: Partial<PluginSyncCandidate> = {}): PluginSyncCandidate {
  return {
    id: "c1",
    name: "alpha",
    pluginId: "com.acode.alpha",
    directoryName: "alpha",
    path: "/plugins/alpha",
    sizeBytes: 128,
    enabled: true,
    componentTypes: ["skill"],
    ...overrides,
  };
}

function marketplaceCandidate(
  overrides: Partial<RemotePluginSyncCandidate> = {},
): RemotePluginSyncCandidate {
  return {
    id: "marketplace:com.acode.beta",
    kind: "marketplace",
    name: "beta",
    pluginId: "com.acode.beta",
    marketplace: "acode-official",
    enabled: true,
    componentTypes: [],
    marketplacePlugin: { pluginName: "beta" },
    ...overrides,
  };
}

function rowFor(
  candidate: RemotePluginSyncCandidate,
  overrides: Partial<RemotePluginSyncRow> = {},
): RemotePluginSyncRow {
  return { candidate, exists: false, ...overrides };
}

function marketplaceSummary(
  source: Record<string, unknown>,
  overrides: Partial<V4PluginMarketplaceSummary> = {},
): V4PluginMarketplaceSummary {
  return {
    id: "acode-official",
    name: "Official",
    pluginCount: 1,
    source,
    ...overrides,
  };
}

function overviewResult(
  overrides: Partial<V4PluginsOverviewResult> = {},
): V4PluginsOverviewResult {
  return {
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
    ...overrides,
  } as V4PluginsOverviewResult;
}

function pluginInfo(overrides: Partial<V4PluginInfo> = {}): V4PluginInfo {
  return {
    id: "com.acode.alpha",
    name: "alpha",
    enabled: true,
    source: "marketplace",
    marketplace: "acode-official",
    skillRootCount: 0,
    commandRootCount: 0,
    ...overrides,
  } as V4PluginInfo;
}

// ── shouldFinishRemotePluginSyncRun ──

test("shouldFinishRemotePluginSyncRun: 仅当 currentRun 就是该 run 时返回 true", () => {
  const run = new AbortController();
  const other = new AbortController();
  assert.equal(shouldFinishRemotePluginSyncRun(run, run), true);
  assert.equal(shouldFinishRemotePluginSyncRun(other, run), false);
  assert.equal(shouldFinishRemotePluginSyncRun(null, run), false);
});

// ── createRemotePluginSyncOperationId ──

test("createRemotePluginSyncOperationId: 递增计数 + pluginId 非法字符归一化", () => {
  const row = rowFor(marketplaceCandidate({ pluginId: "com.acode.alpha beta/x" }));
  const first = createRemotePluginSyncOperationId(row);
  const second = createRemotePluginSyncOperationId(row);
  assert.match(first, /^remote-plugin-sync-\d+-com\.acode\.alpha-beta-x$/);
  assert.match(second, /^remote-plugin-sync-\d+-com\.acode\.alpha-beta-x$/);
  assert.notEqual(first, second);
});

// ── toInlineRemotePluginSyncCandidate / createInlineStatusKey ──

test("toInlineRemotePluginSyncCandidate: 包装 id/inlineCandidate，缺省 description/version 不伪造", () => {
  const full = toInlineRemotePluginSyncCandidate(
    inlineCandidate({ description: "d", version: "1.2.3" }),
  );
  assert.equal(full.id, "inline:c1");
  assert.equal(full.kind, "inline");
  assert.equal(full.marketplace, "inline");
  assert.equal(full.description, "d");
  assert.equal(full.version, "1.2.3");
  assert.equal(full.inlineCandidate?.id, "c1");

  const bare = toInlineRemotePluginSyncCandidate(inlineCandidate());
  assert.equal("description" in bare, false);
  assert.equal("version" in bare, false);
});

test("createInlineStatusKey: pluginId 小写化 + NUL 分隔", () => {
  assert.equal(createInlineStatusKey("COM.Acode.Alpha", "alpha"), "com.acode.alpha\u0000alpha");
  assert.notEqual(createInlineStatusKey("a", "b"), createInlineStatusKey("a ", "b"));
});

// ── buildRemotePluginSyncRows / buildRemotePluginSyncRowsForCandidates ──

test("buildRemotePluginSyncRows: status 按 (pluginId, directoryName) 匹配，缺失时 exists=false", () => {
  const candidates = [inlineCandidate(), inlineCandidate({ id: "c2", pluginId: "com.acode.gamma" })];
  const statuses: PluginSyncRemoteStatus[] = [
    { pluginId: "com.acode.alpha", directoryName: "alpha", exists: true, path: "/remote/alpha", reason: "samePluginId" },
  ];
  const rows = buildRemotePluginSyncRows(candidates, statuses);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.exists, true);
  assert.equal(rows[0]?.path, "/remote/alpha");
  assert.equal(rows[0]?.reason, "samePluginId");
  assert.equal(rows[0]?.candidate.id, "inline:c1");
  assert.equal(rows[1]?.exists, false);
  assert.equal("path" in (rows[1] ?? {}), false);
  assert.equal("reason" in (rows[1] ?? {}), false);
});

test("buildRemotePluginSyncRowsForCandidates: 透传 remoteMarketplaceExists，仅定义时落到 row", () => {
  const candidates = [
    toInlineRemotePluginSyncCandidate(inlineCandidate()),
    marketplaceCandidate(),
  ];
  const rows = buildRemotePluginSyncRowsForCandidates(candidates, [
    { candidateId: "marketplace:com.acode.beta", exists: true, remoteMarketplaceExists: false },
  ]);
  assert.equal(rows[0]?.exists, false);
  assert.equal("remoteMarketplaceExists" in (rows[0] ?? {}), false);
  assert.equal(rows[1]?.exists, true);
  assert.equal(rows[1]?.remoteMarketplaceExists, false);
});

// ── resolveDefaultRemotePluginSyncSelection / filterRemotePluginSyncRows ──

test("resolveDefaultRemotePluginSyncSelection: 默认只选远端不存在的候选", () => {
  const rows = [
    rowFor(toInlineRemotePluginSyncCandidate(inlineCandidate()), { exists: false }),
    rowFor(marketplaceCandidate(), { exists: true }),
  ];
  assert.deepEqual([...resolveDefaultRemotePluginSyncSelection(rows)], ["inline:c1"]);
});

test("filterRemotePluginSyncRows: showExisting=true 返回拷贝，false 滤掉已存在", () => {
  const rows = [
    rowFor(toInlineRemotePluginSyncCandidate(inlineCandidate()), { exists: false }),
    rowFor(marketplaceCandidate(), { exists: true }),
  ];
  const shown = filterRemotePluginSyncRows(rows, true);
  assert.equal(shown.length, 2);
  assert.notEqual(shown, rows);
  assert.deepEqual(
    filterRemotePluginSyncRows(rows, false).map((row) => row.candidate.id),
    ["inline:c1"],
  );
});

// ── shouldAllowRemotePluginSyncDialogOpenChange ──

test("shouldAllowRemotePluginSyncDialogOpenChange: preflighting/syncing 禁止关闭，其余放行", () => {
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("preflighting", false), false);
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("syncing", false), false);
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("loading", false), true);
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("selection", false), true);
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("complete", false), true);
  assert.equal(shouldAllowRemotePluginSyncDialogOpenChange("syncing", true), true);
});

// ── buildMarketplaceRemotePluginSyncCandidates ──

test("buildMarketplaceRemotePluginSyncCandidates: 合并 overview + pluginInfo + marketplace source", () => {
  const overview = overviewResult({
    marketplaces: [marketplaceSummary({ source: "github", repo: "acode/official" })],
    installedPlugins: [
      {
        id: "com.acode.beta",
        name: "beta",
        marketplace: "acode-official",
        enabled: true,
        scope: "user",
      },
    ],
  });
  const plugins: V4PluginInfo[] = [
    pluginInfo({
      id: "com.acode.beta",
      name: "beta",
      description: "from info",
      version: "2.0.0",
      components: [{ kind: "skill", items: [{ name: "s1" }] }],
      configuredOptions: { region: "us" },
      userConfig: { region: { type: "string" } },
    }),
  ];
  const candidates = buildMarketplaceRemotePluginSyncCandidates(overview, plugins);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate?.id, "marketplace:com.acode.beta");
  assert.equal(candidate?.kind, "marketplace");
  assert.equal(candidate?.description, "from info");
  assert.equal(candidate?.version, "2.0.0");
  assert.deepEqual(candidate?.componentTypes, ["skill"]);
  assert.deepEqual(candidate?.pluginOptions?.configuredOptions, { region: "us" });
  assert.equal(candidate?.marketplacePlugin?.pluginName, "beta");
  assert.equal(candidate?.marketplacePlugin?.marketplaceSourceInput, "acode/official");
});

test("buildMarketplaceRemotePluginSyncCandidates: installedPlugins 自带 componentTypes 时不回退 pluginInfo", () => {
  const overview = overviewResult({
    installedPlugins: [
      {
        id: "com.acode.beta",
        name: "beta",
        marketplace: "acode-official",
        enabled: true,
        scope: "user",
        componentTypes: ["agent"],
      },
    ],
  });
  const plugins: V4PluginInfo[] = [
    pluginInfo({
      id: "com.acode.beta",
      components: [{ kind: "skill", items: [{ name: "s1" }] }],
    }),
  ];
  const candidates = buildMarketplaceRemotePluginSyncCandidates(overview, plugins);
  assert.deepEqual(candidates[0]?.componentTypes, ["agent"]);
});

// ── buildMarketplaceRemotePluginStatuses ──

test("buildMarketplaceRemotePluginStatuses: exists/reason/remoteMarketplaceExists 三态", () => {
  const candidates = [
    marketplaceCandidate({ id: "marketplace:a", pluginId: "a", marketplace: "m1" }),
    marketplaceCandidate({ id: "marketplace:b", pluginId: "b", marketplace: "m2" }),
  ];
  const remote = overviewResult({
    marketplaces: [marketplaceSummary({ source: "url", url: "https://x" }, { id: "m1" })],
    installedPlugins: [
      {
        id: "a",
        name: "a",
        marketplace: "m1",
        enabled: true,
        scope: "user",
        installPath: "/remote/a",
      },
    ],
  });
  const statuses = buildMarketplaceRemotePluginStatuses(candidates, remote);
  assert.deepEqual(statuses, [
    {
      candidateId: "marketplace:a",
      exists: true,
      path: "/remote/a",
      reason: "samePluginId",
      remoteMarketplaceExists: true,
    },
    { candidateId: "marketplace:b", exists: false, remoteMarketplaceExists: false },
  ]);
});

// ── componentTypesFromPluginInfo / buildRemotePluginSyncPluginOptions ──

test("componentTypesFromPluginInfo: 无 plugin/components 返回空数组", () => {
  assert.deepEqual(componentTypesFromPluginInfo(undefined), []);
  assert.deepEqual(componentTypesFromPluginInfo(pluginInfo({ components: undefined })), []);
  assert.deepEqual(
    componentTypesFromPluginInfo(
      pluginInfo({
        components: [
          { kind: "agent", items: [] },
          { kind: "mcp", items: [] },
        ],
      }),
    ),
    ["agent", "mcp"],
  );
});

test("buildRemotePluginSyncPluginOptions: 空 configuredOptions 返回 undefined；否则拷贝两个 map", () => {
  assert.equal(buildRemotePluginSyncPluginOptions(undefined), undefined);
  assert.equal(buildRemotePluginSyncPluginOptions(pluginInfo({ configuredOptions: {} })), undefined);
  const info = pluginInfo({
    configuredOptions: { region: "us" },
    userConfig: { region: { type: "string" } },
  });
  const options = buildRemotePluginSyncPluginOptions(info);
  assert.deepEqual(options?.configuredOptions, { region: "us" });
  assert.deepEqual(options?.userConfig, { region: { type: "string" } });
  assert.notEqual(options?.configuredOptions, info.configuredOptions);
  if (options) {
    options.configuredOptions.region = "eu";
  }
  assert.equal(info.configuredOptions?.region, "us");
});

// ── applyPluginInfoToRemoteSyncCandidate / enrichRemotePluginSyncCandidatesWithPluginInfo ──

test("applyPluginInfoToRemoteSyncCandidate: 有 options 才替换 candidate", () => {
  const base = toInlineRemotePluginSyncCandidate(inlineCandidate());
  const unchanged = applyPluginInfoToRemoteSyncCandidate(base, undefined);
  assert.equal(unchanged, base);
  const changed = applyPluginInfoToRemoteSyncCandidate(
    base,
    pluginInfo({ configuredOptions: { region: "us" } }),
  );
  assert.notEqual(changed, base);
  assert.deepEqual(changed.pluginOptions?.configuredOptions, { region: "us" });
});

test("enrichRemotePluginSyncCandidatesWithPluginInfo: 按 pluginId 匹配 enrich", () => {
  const candidates = [
    toInlineRemotePluginSyncCandidate(inlineCandidate({ pluginId: "com.acode.alpha" })),
    marketplaceCandidate({ pluginId: "com.acode.beta" }),
  ];
  const enriched = enrichRemotePluginSyncCandidatesWithPluginInfo(candidates, [
    pluginInfo({ id: "com.acode.alpha", configuredOptions: { k: "v" } }),
  ]);
  assert.deepEqual(enriched[0]?.pluginOptions?.configuredOptions, { k: "v" });
  assert.equal(enriched[1]?.pluginOptions, undefined);
});

// ── isPathPluginOption / isPortablePluginOptionValue / summarizeLocalPluginOptionsForDisplay ──

test("isPathPluginOption: file/directory 判定", () => {
  assert.equal(isPathPluginOption(undefined), false);
  assert.equal(isPathPluginOption({ type: "file" }), true);
  assert.equal(isPathPluginOption({ type: "directory" }), true);
  assert.equal(isPathPluginOption({ type: "string" }), false);
});

test("isPortablePluginOptionValue: 缺 schema/sensitive/path 型不可携带，类型须匹配", () => {
  const stringOption: V4PluginUserConfigOption = { type: "string" };
  const numberOption: V4PluginUserConfigOption = { type: "number" };
  const booleanOption: V4PluginUserConfigOption = { type: "boolean" };
  assert.equal(isPortablePluginOptionValue("v", undefined, stringOption), false);
  assert.equal(isPortablePluginOptionValue("v", stringOption, undefined), false);
  assert.equal(isPortablePluginOptionValue("v", { sensitive: true }, stringOption), false);
  assert.equal(isPortablePluginOptionValue("v", stringOption, { sensitive: true }), false);
  assert.equal(isPortablePluginOptionValue("v", { type: "file" }, { type: "file" }), false);
  assert.equal(isPortablePluginOptionValue("v", stringOption, stringOption), true);
  assert.equal(isPortablePluginOptionValue(1, stringOption, stringOption), false);
  assert.equal(isPortablePluginOptionValue(1, numberOption, numberOption), true);
  assert.equal(isPortablePluginOptionValue(true, booleanOption, booleanOption), true);
  // remote 缺 type 时回退 local type
  assert.equal(isPortablePluginOptionValue(1, numberOption, {}), true);
  // 两端都无 type：string/number/boolean 均可携带
  assert.equal(isPortablePluginOptionValue(true, {}, {}), true);
});

test("summarizeLocalPluginOptionsForDisplay: 无 options 返回 null；按 portable 分类计数", () => {
  assert.equal(summarizeLocalPluginOptionsForDisplay(undefined), null);
  assert.equal(
    summarizeLocalPluginOptionsForDisplay({ configuredOptions: {}, userConfig: {} }),
    null,
  );
  const summary = summarizeLocalPluginOptionsForDisplay({
    configuredOptions: { a: "x", b: "y", c: true },
    userConfig: {
      a: { type: "string" },
      b: { type: "file" },
      c: { type: "boolean" },
    },
  });
  assert.deepEqual(summary, { manualCount: 1, syncableCount: 2 });
});

// ── serializeMarketplaceSourceInput / buildMarketplaceSourceSyncInfo ──

test("serializeMarketplaceSourceInput: github/git 带 ref 后缀，url 直出，未知 source 返回 undefined", () => {
  assert.equal(
    serializeMarketplaceSourceInput(marketplaceSummary({ source: "github", repo: "a/b" })),
    "a/b",
  );
  assert.equal(
    serializeMarketplaceSourceInput(
      marketplaceSummary({ source: "github", repo: "a/b", ref: "v1" }),
    ),
    "a/b#v1",
  );
  assert.equal(
    serializeMarketplaceSourceInput(
      marketplaceSummary({ source: "git", url: "https://g", ref: "main" }),
    ),
    "https://g#main",
  );
  assert.equal(
    serializeMarketplaceSourceInput(marketplaceSummary({ source: "url", url: "https://u" })),
    "https://u",
  );
  assert.equal(
    serializeMarketplaceSourceInput(marketplaceSummary({ source: "github", repo: " " })),
    undefined,
  );
  assert.equal(
    serializeMarketplaceSourceInput(marketplaceSummary({ source: "file", path: "/x" })),
    undefined,
  );
});

test("buildMarketplaceSourceSyncInfo: 可序列化 source → input；file/directory/settings → archive；其余空", () => {
  assert.deepEqual(
    buildMarketplaceSourceSyncInfo(marketplaceSummary({ source: "github", repo: "a/b" })),
    { marketplaceSourceInput: "a/b" },
  );
  const fileSource = { source: "file", path: "/x" };
  assert.deepEqual(buildMarketplaceSourceSyncInfo(marketplaceSummary(fileSource)), {
    marketplaceSourceArchive: { marketplaceId: "acode-official", source: fileSource },
  });
  assert.deepEqual(
    buildMarketplaceSourceSyncInfo(marketplaceSummary({ source: "unknown-kind" })),
    {},
  );
});

// ── isRemotePluginSyncStoppedError / buildStoppedRemotePluginResult ──

test("isRemotePluginSyncStoppedError: 只识别 RemotePluginSyncStoppedError 实例", () => {
  const row = rowFor(marketplaceCandidate());
  assert.equal(isRemotePluginSyncStoppedError(new RemotePluginSyncStoppedError(row)), true);
  assert.equal(isRemotePluginSyncStoppedError(new Error("x")), false);
  assert.equal(isRemotePluginSyncStoppedError("x"), false);
});

test("buildStoppedRemotePluginResult: inline 取 directoryName，marketplace 取 marketplace/name", () => {
  const inlineRow = rowFor(toInlineRemotePluginSyncCandidate(inlineCandidate()));
  const inlineResult = buildStoppedRemotePluginResult(inlineRow);
  assert.equal(inlineResult.directoryName, "alpha");
  assert.equal(inlineResult.status, "stopped");
  assert.match(inlineResult.error ?? "", /stop requested/);

  const marketplaceRow = rowFor(marketplaceCandidate());
  const marketplaceResult = buildStoppedRemotePluginResult(marketplaceRow);
  assert.equal(marketplaceResult.directoryName, "acode-official/beta");
  assert.equal(marketplaceResult.status, "stopped");
});

// ── buildPortablePluginOptionsSyncPlan / arePluginOptionsEqual ──

test("buildPortablePluginOptionsSyncPlan: 仅 portable 值进 options，其余计 skipped", () => {
  const plan = buildPortablePluginOptionsSyncPlan(
    {
      configuredOptions: { a: "x", b: "secret", c: 1 },
      userConfig: {
        a: { type: "string" },
        b: { type: "string", sensitive: true },
        c: { type: "number" },
      },
    },
    pluginInfo({
      userConfig: {
        a: { type: "string" },
        b: { type: "string", sensitive: true },
        c: { type: "string" },
      },
    }),
  );
  assert.deepEqual(plan.options, { a: "x" });
  assert.equal(plan.skippedCount, 2);
});

test("arePluginOptionsEqual: 键数不等或值不等即 false", () => {
  assert.equal(arePluginOptionsEqual({}, {}), true);
  assert.equal(arePluginOptionsEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(arePluginOptionsEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(arePluginOptionsEqual({ a: 1 }, {}), false);
  assert.equal(arePluginOptionsEqual({ a: 1 }, { a: 1, b: 2 }), false);
});

// ── buildSelectedMarketplacePluginNames ──

test("buildSelectedMarketplacePluginNames: 按 marketplace 聚合 pluginName，跳过 inline 与缺 marketplacePlugin", () => {
  const rows = [
    rowFor(toInlineRemotePluginSyncCandidate(inlineCandidate())),
    rowFor(marketplaceCandidate({ marketplace: "m1", marketplacePlugin: { pluginName: "p1" } })),
    rowFor(
      marketplaceCandidate({
        id: "marketplace:other",
        pluginId: "other",
        marketplace: "m1",
        marketplacePlugin: { pluginName: "p2" },
      }),
    ),
    rowFor(
      marketplaceCandidate({
        id: "marketplace:no-meta",
        pluginId: "no-meta",
        marketplace: "m2",
        marketplacePlugin: undefined,
      }),
    ),
  ];
  const result = buildSelectedMarketplacePluginNames(rows);
  assert.deepEqual(result.get("m1"), ["p1", "p2"]);
  assert.equal(result.has("m2"), false);
  assert.equal(result.has("inline"), false);
});

// ── formatInstallError ──

type InstallResult = Awaited<
  ReturnType<
    Pick<
      import("@acode/services").IACodeAgentService,
      "installPlugin"
    >["installPlugin"]
  >
>;

test("formatInstallError: warning 诊断被过滤，error 诊断带 pluginId 前缀拼接", () => {
  const base = { diagnostics: [], installedPlugins: [] } as unknown as InstallResult;
  assert.equal(formatInstallError(base, "p1"), null);
  const withWarning = {
    ...base,
    diagnostics: [{ code: "w", message: "warn", severity: "warning" as const }],
  };
  assert.equal(formatInstallError(withWarning, "p1"), null);
  const withErrors = {
    ...base,
    diagnostics: [
      { code: "e1", message: "boom", severity: "error" as const },
      { code: "e2", message: "bad", pluginId: "p2" },
    ],
  };
  assert.equal(formatInstallError(withErrors, "p1"), "p1: boom; p2: bad");
});

// ── 行构建回归：buildRemotePluginSyncRows 与 loadRemotePluginSyncCandidates 的 inline 段共用同一形状 ──

test("buildRemotePluginSyncRows 输出的 candidateId 形状与 inlineStatuses 转换兼容", () => {
  const candidates = [inlineCandidate()];
  const statuses: PluginSyncRemoteStatus[] = [
    { pluginId: "com.acode.alpha", directoryName: "alpha", exists: true, reason: "targetExists" },
  ];
  const rows = buildRemotePluginSyncRows(candidates, statuses);
  // 主文件把 row 转回 CandidateStatus：candidateId 必须等于 `inline:${candidate.id}`。
  assert.equal(rows[0]?.candidate.id, "inline:c1");
  assert.equal(rows[0]?.exists, true);
  assert.equal(rows[0]?.reason, "targetExists");
});

// 类型引用保持（PluginSyncImportResult 用于 RemotePluginSyncResultStatus 派生）
type _ImportResultStatus = PluginSyncImportResult["results"][number]["status"];
