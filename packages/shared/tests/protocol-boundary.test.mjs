import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const shared = await import("../src/acode-protocol-shared.ts");
const legacy = await import("../src/acode-protocol/index.ts");
const legacyTypes = await import("../src/acode-protocol-legacy-types.ts");
const v4 = await import("../src/acode-protocol-v4/command.ts");
const v4Transport = await import("../src/acode-protocol-v4/transport.ts");
const v4Inbound = await import("../src/acode-protocol-v4/inbound-interaction.ts");

const mcpServer = {
  name: "local",
  command: "node",
  args: ["server.mjs"],
  env: [],
};

test("legacy and v4 consume the neutral MCP/browser schema without changing validation", () => {
  assert.equal(shared.acodeProtocolMcpServerSchema.safeParse(mcpServer).success, true);
  assert.equal(legacy.acodeProtocolMcpServerSchema.safeParse(mcpServer).success, true);
  assert.equal(
    v4.commandPayloadSchemas.createSession.safeParse({
      workspaceId: "workspace-1",
      mcpServers: [mcpServer],
    }).success,
    true,
  );

  const ambient = { tabCount: 1, currentUrl: "https://example.test/" };
  assert.equal(shared.acodeBrowserAmbientContextSchema.safeParse(ambient).success, true);
  assert.equal(legacy.acodeBrowserAmbientContextSchema.safeParse(ambient).success, true);
  assert.equal(
    v4.commandPayloadSchemas.sendText.safeParse({ text: "hello", browserAmbientContext: ambient })
      .success,
    true,
  );
});

test("v4 command has no reverse import into the legacy protocol barrel", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-v4/command.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acode-protocol\/index(?:\.js|\.ts)?/);
  assert.match(source, /acode-protocol-shared\.js/);
});

test("neutral schema module has no protocol-directory dependency", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-shared.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acode-protocol(?:-v4)?[\\/]/);
});

test("session subscription dual-delivery contract keeps legacy replay separate from v4 frames", () => {
  // Legacy session/subscribe returns an event-seq cursor and optionally embeds a snapshot in
  // the response. Its delivery kind names the old stream selector, even though the strings
  // happen to match the v4 client profiles.
  const legacyOnline = legacy.acodeSessionSubscribeParamsSchema.parse({
    sessionId: "session-1",
    deliveryKind: "desktop-continuous",
    afterSeq: 7,
    includeSnapshot: false,
  });
  const legacyReplayable = legacy.acodeSessionSubscribeParamsSchema.parse({
    sessionId: "session-1",
    deliveryKind: "web-remote-replayable",
    includeSnapshot: true,
  });
  assert.equal(legacyOnline.deliveryKind, "desktop-continuous");
  assert.equal(legacyReplayable.includeSnapshot, true);

  // v4 uses a topic/logEpoch/seq watermark and an attachment-owned connection. Both
  // desktop-continuous and web-remote-replayable use the same request shape; the trusted host
  // injects clientMode and connectionId before forwarding it to the CLI.
  const v4Desktop = v4Transport.v4ConversationSubscribeParamsSchema.parse({
    topic: "conversation/session-1",
    connectionId: "connection-desktop",
    clientMode: "desktop-continuous",
    base: { logEpoch: "epoch-1", seq: 7 },
    visibility: "foreground",
  });
  const v4Remote = v4Transport.v4ConversationSubscribeParamsSchema.parse({
    topic: "conversation/session-1",
    connectionId: "connection-mobile",
    clientMode: "web-remote-replayable",
    visibility: "background",
  });
  assert.equal(v4Desktop.clientMode, "desktop-continuous");
  assert.equal(v4Remote.clientMode, "web-remote-replayable");

  // The response boundary is intentionally different: v4 ACK is followed by an owned
  // conversation/frame notification. Embedding legacy events in the ACK would violate the
  // v4 response schema and lose the post-response ordering guarantee.
  const ack = {
    ack: { subscriptionId: "subscription-1", mode: "resume", logEpoch: "epoch-1" },
  };
  assert.deepEqual(v4Transport.v4ConversationSubscribeResultSchema.parse(ack), ack);
  assert.equal(
    v4Transport.v4ConversationSubscribeResultSchema.safeParse({
      ...ack,
      sessionId: "session-1",
      eventSeq: 7,
      events: [],
    }).success,
    false,
    "v4 subscribe ACK must stay separate from legacy event replay payload",
  );
  assert.equal(
    legacy.acodeSessionSubscribeResultSchema.safeParse(ack).success,
    false,
    "legacy session/subscribe consumers must not be handed a v4 ACK",
  );
});

// M2-1 裁决（2026-10-28，默认裁决产品可推翻，见 docs/reviews/2026-10-28/m2-scoping.md §6.3）：
// ① switchCollaborationMode 值域补 auto——legacy session/setMode 接受 auto
//    （acodeSessionModeSchema 含 auto），v4 刻意排除会收窄 legacy 能力；补值 = 放宽，向后兼容。
// ② compact payload 加可选 instructions——不丢 legacy session/compact 的 instructions 字段。
test("v4 switchCollaborationMode accepts auto alongside the user-switchable modes", () => {
  for (const mode of ["build", "edit", "plan", "yolo", "dontAsk", "auto"]) {
    assert.equal(
      v4.commandPayloadSchemas.switchCollaborationMode.safeParse({ mode }).success,
      true,
      `mode=${mode} must parse`,
    );
  }
  // 值域与 legacy acodeSessionModeSchema 逐字一致：session/setMode → switchCollaborationMode
  // 迁移（M2-1）不丢任何 legacy 可表达值。
  assert.deepEqual(
    [...legacyTypes.acodeSessionModeSchema.options].sort(),
    ["auto", "build", "dontAsk", "edit", "plan", "yolo"],
  );
  assert.deepEqual(
    [...v4.commandPayloadSchemas.switchCollaborationMode.shape.mode.options].sort(),
    [...legacyTypes.acodeSessionModeSchema.options].sort(),
    "v4 switchCollaborationMode 值域必须与 legacy acodeSessionModeSchema 逐字一致",
  );
  assert.equal(
    v4.commandPayloadSchemas.switchCollaborationMode.safeParse({ mode: "unknown-mode" }).success,
    false,
    "unknown modes must stay rejected",
  );
  assert.equal(
    v4.commandPayloadSchemas.switchCollaborationMode.safeParse({}).success,
    false,
    "mode is required",
  );
});

test("v4 compact payload carries optional instructions without losing the empty form", () => {
  assert.equal(v4.commandPayloadSchemas.compact.safeParse({}).success, true);
  const withInstructions = v4.commandPayloadSchemas.compact.parse({
    instructions: "保留与 TODO 相关的上下文",
  });
  assert.equal(withInstructions.instructions, "保留与 TODO 相关的上下文");
  assert.equal(
    v4.commandPayloadSchemas.compact.safeParse({ instructions: 42 }).success,
    false,
    "instructions must be a string when present",
  );
});

// ── M2-2 session 控制面（specs/m2-2-session-control.md）──
test("v4 closeSession payload carries the expectedPersistence assertion equivalent", () => {
  // 缺省/两值全收（值域与 legacy acodeSessionPersistenceSchema 逐字一致）。
  assert.equal(v4.commandPayloadSchemas.closeSession.safeParse({}).success, true);
  for (const expectedPersistence of ["immediate", "deferred"]) {
    assert.equal(
      v4.commandPayloadSchemas.closeSession.safeParse({ expectedPersistence }).success,
      true,
    );
  }
  assert.deepEqual(
    [...legacy.acodeSessionPersistenceSchema.options].sort(),
    ["deferred", "immediate"],
  );
  assert.equal(
    v4.commandPayloadSchemas.closeSession.safeParse({ expectedPersistence: "unknown" }).success,
    false,
    "unknown persistence must stay rejected",
  );
});

test("v4 clearGoal payload is the empty command form", () => {
  assert.equal(v4.commandPayloadSchemas.clearGoal.safeParse({}).success, true);
});

const v4SessionControl = await import("../src/acode-protocol-v4/session-control.ts");

test("goalControl result variant carries the legacy goal receipt equivalents", () => {
  const wire = {
    sessionId: "s1",
    targetId: "t1",
    objective: "ship it",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  const parsed = v4SessionControl.goalControlResultSchema.parse({
    type: "goalControl",
    action: "set",
    hadTarget: false,
    target: wire,
    startedTurn: true,
    planContinuationSkipped: true,
  });
  assert.equal(parsed.target?.objective, "ship it");
  // ACK 判别联合同形验收（回放缓存按本 schema 再校验）。
  assert.equal(
    v4.commandResultSchema.safeParse({
      type: "goalControl",
      action: "clear",
      hadTarget: true,
      target: null,
      startedTurn: false,
    }).success,
    true,
  );
  assert.equal(
    v4.commandResultSchema.safeParse({ type: "goalControl", action: "unknown" }).success,
    false,
  );
});

test("closeSession result variant pins the expectedPersistence verdict", () => {
  assert.equal(
    v4.commandResultSchema.safeParse({ type: "closeSession", closed: false }).success,
    true,
  );
  assert.equal(
    v4.commandResultSchema.safeParse({ type: "closeSession" }).success,
    false,
    "closed is required",
  );
});

test("v4 session goal/debug query schemas are strict and reuse the neutral debug snapshot", async () => {
  const transport = v4Transport;
  assert.equal(
    transport.v4SessionGoalQueryParamsSchema.safeParse({ sessionId: "s1" }).success,
    true,
  );
  assert.equal(
    transport.v4SessionGoalQueryParamsSchema.safeParse({ sessionId: "s1", extra: 1 }).success,
    false,
    "strict params reject unknown keys",
  );
  assert.equal(
    transport.v4SessionGoalQueryResultSchema.safeParse({ supported: false }).success,
    true,
  );
  assert.equal(
    transport.v4SessionGoalQueryResultSchema.safeParse({ supported: true, target: null }).success,
    true,
  );
  assert.equal(
    transport.v4SessionDebugParamsSchema.safeParse({ sessionId: "" }).success,
    false,
  );
  // debug result 复用中立叶 sessionDebugSnapshotSchema（零新建词汇）。
  const debugLeaf = await import("../src/session-debug.ts");
  assert.equal(transport.v4SessionDebugResultSchema, debugLeaf.sessionDebugSnapshotSchema);
});

// ── M2-5：plugins 域 16 方法迁 v4（specs/m2-5-plugins.md）──
// v4 schema 与 legacy 逐字 parity（同字段、同 strict、同值域），消费者语义零变化；
// cancelOperation 保留 legacy 词不进 v4（spec §4）。域分三叶：plugins（零件）/
// plugins-queries（读六法）/plugins-commands（写十法）——max-file-lines 门禁分流。
const v4Plugins = {
  ...(await import("../src/acode-protocol-v4/plugins.ts")),
  ...(await import("../src/acode-protocol-v4/plugins-queries.ts")),
  ...(await import("../src/acode-protocol-v4/plugins-commands.ts")),
};

test("v4 plugins method names occupy the v4/plugins namespace and exclude cancelOperation", () => {
  const expected = {
    pluginsList: "v4/plugins/list",
    pluginsOverview: "v4/plugins/overview",
    pluginsDescribe: "v4/plugins/describe",
    pluginsValidate: "v4/plugins/validate",
    pluginsReferenceCatalog: "v4/plugins/referenceCatalog",
    pluginsResolveSuggestedReference: "v4/plugins/resolveSuggestedReference",
    pluginsSetEnabled: "v4/plugins/setEnabled",
    pluginsMarketplaceAdd: "v4/plugins/marketplace/add",
    pluginsMarketplaceRemove: "v4/plugins/marketplace/remove",
    pluginsMarketplaceUpdate: "v4/plugins/marketplace/update",
    pluginsInstall: "v4/plugins/install",
    pluginsUninstall: "v4/plugins/uninstall",
    pluginsUpdate: "v4/plugins/update",
    pluginsRestoreBuiltin: "v4/plugins/restoreBuiltin",
    pluginsConfigure: "v4/plugins/configure",
    pluginsResetConfig: "v4/plugins/resetConfig",
  };
  for (const [key, name] of Object.entries(expected)) {
    assert.equal(v4Transport.V4_METHODS[key], name, `V4_METHODS.${key} 必须逐字等于 ${name}`);
  }
  assert.equal(
    "pluginsCancelOperation" in v4Transport.V4_METHODS,
    false,
    "cancelOperation 保留 legacy 词（中止注册表与协议代际无关），不进 v4 面",
  );
});

test("v4 plugins params schemas keep verbatim parity with legacy", () => {
  const workspace = { workspacePath: "/repo", workspaceKey: "wk-1" };
  const parityPairs = [
    [v4Plugins.v4PluginsListParamsSchema, legacy.acodePluginsListParamsSchema, { workspace, configScope: "user" }],
    [v4Plugins.v4PluginsOverviewParamsSchema, legacy.acodePluginsOverviewParamsSchema, { workspace }],
    [v4Plugins.v4PluginsDescribeParamsSchema, legacy.acodePluginsDescribeParamsSchema, { workspace, pluginName: "p", marketplace: "m" }],
    [v4Plugins.v4PluginsValidateParamsSchema, legacy.acodePluginsValidateParamsSchema, { workspace, source: "gh:acode/p" }],
    [v4Plugins.v4PluginsReferenceCatalogParamsSchema, legacy.acodePluginsReferenceCatalogParamsSchema, { workspace, sessionId: "s-1" }],
    [v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema, legacy.acodePluginsResolveSuggestedReferenceParamsSchema, { workspace, stableId: "p@m", operationId: "op-1", clientMode: "desktop-continuous", deliveryKind: "web-remote-replayable" }],
    [v4Plugins.v4PluginsSetEnabledParamsSchema, legacy.acodePluginsSetEnabledParamsSchema, { workspace, pluginId: "p@m", enabled: true, operationId: "op-1", scope: "workspace" }],
    [v4Plugins.v4PluginsMarketplaceAddParamsSchema, legacy.acodePluginsMarketplaceAddParamsSchema, { workspace, source: "gh:acode/m", dryRun: true, operationId: "op-1" }],
    [v4Plugins.v4PluginsMarketplaceRemoveParamsSchema, legacy.acodePluginsMarketplaceRemoveParamsSchema, { workspace, marketplace: "m" }],
    [v4Plugins.v4PluginsMarketplaceUpdateParamsSchema, legacy.acodePluginsMarketplaceUpdateParamsSchema, { workspace, operationId: "op-1" }],
    [v4Plugins.v4PluginsInstallParamsSchema, legacy.acodePluginsInstallParamsSchema, { workspace, pluginName: "p", marketplace: "m", scope: "user", dryRun: false, operationId: "op-1" }],
    [v4Plugins.v4PluginsUninstallParamsSchema, legacy.acodePluginsUninstallParamsSchema, { workspace, pluginId: "p@m", removeCache: true }],
    [v4Plugins.v4PluginsUpdateParamsSchema, legacy.acodePluginsUpdateParamsSchema, { workspace, marketplace: "m" }],
    [v4Plugins.v4PluginsRestoreBuiltinParamsSchema, legacy.acodePluginsRestoreBuiltinParamsSchema, { workspace, pluginId: "p@m" }],
    [v4Plugins.v4PluginsConfigureParamsSchema, legacy.acodePluginsConfigureParamsSchema, { workspace, pluginId: "p@m", options: { k: 1 }, clearOptionKeys: ["x"], scope: "user", dryRun: true }],
    [v4Plugins.v4PluginsResetConfigParamsSchema, legacy.acodePluginsResetConfigParamsSchema, { workspace, pluginId: "p@m", scope: "workspace" }],
  ];
  for (const [v4Schema, legacySchema, payload] of parityPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    const legacyParsed = legacySchema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 payload：${JSON.stringify(payload)}`);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 payload：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy parse 产出必须逐字一致");
    // strict parity：未知键两侧同拒。
    const widened = { ...payload, unexpectedM2Probe: true };
    assert.equal(v4Schema.safeParse(widened).success, false, "v4 strict 必须拒未知键");
    assert.equal(legacySchema.safeParse(widened).success, false, "legacy strict 必须拒未知键");
  }
  // workspace ref 缺 workspaceKey 两侧同拒（中性 schema 共用）。
  const noKey = { workspace: { workspacePath: "/repo" } };
  assert.equal(v4Plugins.v4PluginsListParamsSchema.safeParse(noKey).success, false);
  assert.equal(legacy.acodePluginsListParamsSchema.safeParse(noKey).success, false);
});

test("v4 plugins result schemas keep verbatim parity with legacy", () => {
  const diagnostic = { code: "c", message: "m", severity: "error", pluginId: "p@m" };
  const hookDetail = {
    event: "PreToolUse",
    type: "command",
    command: "run.sh",
    sourcePath: "/repo/plugins/p/hooks.json",
    runnable: true,
  };
  const info = {
    id: "p@m",
    name: "p",
    enabled: true,
    source: "marketplace",
    marketplace: "m",
    skillRootCount: 1,
    commandRootCount: 0,
    components: [{ kind: "skill", items: [{ name: "s", description: "d" }] }],
    mcpServerNames: [],
    rootPath: "/repo/plugins/p",
    packageStatus: "missing",
    rootSource: "workspace",
    hookDetails: [hookDetail],
  };
  const listing = { displayName: "P", category: "tools", requiresPaidPlan: false };
  const marketplaceSummary = { id: "m", name: "M", source: { type: "github" }, pluginCount: 1 };
  const available = { id: "p@m", name: "p", marketplace: "m", installed: false, listing };
  // installedPluginSummary 没有 installed 键（已安装集合内在语义），不能与 available 混形。
  const installed = { id: "p@m", name: "p", marketplace: "m", enabled: true, scope: "user", listing };
  const catalogEntry = {
    category: "tools",
    pluginId: "p@m",
    name: "p",
    marketplace: "m",
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: ["p@s"],
    mcpServerNames: [],
  };
  const resultPairs = [
    [v4Plugins.v4PluginsListResultSchema, legacy.acodePluginsListResultSchema, { plugins: [info], diagnostics: [diagnostic] }],
    [v4Plugins.v4PluginsOverviewResultSchema, legacy.acodePluginsOverviewResultSchema, { marketplaces: [marketplaceSummary], availablePlugins: [available], installedPlugins: [installed], restorableBuiltins: [], diagnostics: [], capability: { supported: true } }],
    [v4Plugins.v4PluginsDescribeResultSchema, legacy.acodePluginsDescribeResultSchema, { components: [{ kind: "mcp", items: [{ name: "srv" }] }], metadata: { version: "1.0.0" } }],
    [v4Plugins.v4PluginsValidateResultSchema, legacy.acodePluginsValidateResultSchema, { ok: false, diagnostics: [diagnostic], compatibility: { runnable: ["skills"], diagnosticOnly: ["agents"], unsupported: ["mcpb"] } }],
    [v4Plugins.v4PluginsReferenceCatalogResultSchema, legacy.acodePluginsReferenceCatalogResultSchema, { authority: "session", plugins: [catalogEntry] }],
    [v4Plugins.v4PluginsSetEnabledResultSchema, legacy.acodePluginsSetEnabledResultSchema, { plugin: info, enabled: false }],
    [v4Plugins.v4PluginsMarketplaceMutationResultSchema, legacy.acodePluginsMarketplaceMutationResultSchema, { marketplaces: [marketplaceSummary], diagnostics: [diagnostic] }],
    [v4Plugins.v4PluginsInstallResultSchema, legacy.acodePluginsInstallResultSchema, { installedPlugins: [installed], dependencyClosure: ["p@m"], diagnostics: [] }],
    [v4Plugins.v4PluginsUninstallResultSchema, legacy.acodePluginsUninstallResultSchema, { removedPlugin: installed, diagnostics: [] }],
    [v4Plugins.v4PluginsRestoreBuiltinResultSchema, legacy.acodePluginsRestoreBuiltinResultSchema, { pluginId: "p@m", diagnostics: [] }],
    [v4Plugins.v4PluginsConfigureResultSchema, legacy.acodePluginsConfigureResultSchema, { pluginId: "p@m", diagnostics: [diagnostic] }],
  ];
  for (const [v4Schema, legacySchema, payload] of resultPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    const legacyParsed = legacySchema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload).slice(0, 80)}`);
    assert.equal(legacyParsed.success, true, "legacy 必须接受同一 result");
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy parse 产出必须逐字一致");
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM2Probe: 1 }).success, false);
  }
  // catalog entry 的 subagentNames default([]) 两侧同形（缺省补齐一致）。
  const noSubagents = { ...catalogEntry };
  delete noSubagents.subagentNames;
  assert.deepEqual(
    v4Plugins.v4PluginReferenceCatalogEntrySchema.parse(noSubagents),
    legacy.acodePluginReferenceCatalogEntrySchema.parse(noSubagents),
  );
});

test("v4 referenceCatalog merges the legacy pair: category always available", () => {
  // legacy 拆两词仅因 additive 演进（WithCategory 后加）；entry.category 本就 optional，
  // v4 单方法恒带 category 是超集，旧解析方读无 category payload 不受影响。
  const entry = {
    pluginId: "p@m",
    name: "p",
    marketplace: "m",
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: [],
    mcpServerNames: [],
    subagentNames: [],
  };
  assert.equal(
    v4Plugins.v4PluginsReferenceCatalogResultSchema.safeParse({
      authority: "workspace",
      plugins: [{ ...entry, category: "tools" }],
    }).success,
    true,
    "带 category 的 entry 必须解析（WithCategory 语义）",
  );
  assert.equal(
    v4Plugins.v4PluginsReferenceCatalogResultSchema.safeParse({
      authority: "workspace",
      plugins: [entry],
    }).success,
    true,
    "无 category 的 entry 也必须解析（旧 CLI payload 兼容）",
  );
  assert.equal(
    v4Plugins.v4PluginsReferenceCatalogResultSchema.safeParse({
      authority: "workspace",
      plugins: [{ ...entry, category: "" }],
    }).success,
    false,
    "category 是 nonEmptyString，空串必须拒绝",
  );
});

test("v4 resolveSuggestedReference keeps the actionable-identity superRefine", () => {
  const base = { stableId: "p@acode-plugins-official", diagnostics: [] };
  for (const status of ["ready", "disabled", "missing"]) {
    const incomplete = { ...base, status };
    assert.equal(
      v4Plugins.v4PluginsResolveSuggestedReferenceResultSchema.safeParse(incomplete).success,
      false,
      `${status} 缺 marketplace/pluginName/sourceTrust 必须拒绝`,
    );
    assert.equal(
      legacy.acodePluginsResolveSuggestedReferenceResultSchema.safeParse(incomplete).success,
      false,
      "legacy 同款 superRefine 必须同拒",
    );
    const complete = {
      ...base,
      status,
      marketplace: "acode-plugins-official",
      pluginName: "p",
      sourceTrust: "official",
    };
    assert.equal(
      v4Plugins.v4PluginsResolveSuggestedReferenceResultSchema.safeParse(complete).success,
      true,
    );
  }
  for (const status of ["conflict", "unavailable"]) {
    assert.equal(
      v4Plugins.v4PluginsResolveSuggestedReferenceResultSchema.safeParse({ ...base, status })
        .success,
      true,
      `${status} 非 actionable，不带安装身份`,
    );
  }
  assert.equal(
    v4Plugins.v4PluginsResolveSuggestedReferenceResultSchema.safeParse({
      ...base,
      status: "unknown-status",
    }).success,
    false,
  );
});

test("v4 plugins schema leaves have no reverse import into the legacy protocol barrel", async () => {
  for (const leaf of ["plugins.ts", "plugins-queries.ts", "plugins-commands.ts"]) {
    const source = await readFile(
      new URL(`../src/acode-protocol-v4/${leaf}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /acode-protocol\/index(?:\.js|\.ts)?/);
  }
  // v4-imports-legacy-protocol 白名单纪律：两叶只许引 acodeWorkspaceRefSchema 一个幸存符号
  // （architecture 门禁实测会拦未登记符号——acodeDeliveryKindSchema 因此被本地再声明）。
  for (const leaf of ["plugins-queries.ts", "plugins-commands.ts"]) {
    const source = await readFile(
      new URL(`../src/acode-protocol-v4/${leaf}`, import.meta.url),
      "utf8",
    );
    const legacyTypesImport = source.match(
      /import \{([^}]*)\} from "\.\.\/acode-protocol-legacy-types\.js"/,
    );
    assert.ok(legacyTypesImport, `${leaf} 应从 legacy-types 取 workspace ref`);
    assert.deepEqual(
      legacyTypesImport[1].split(",").map((name) => name.trim()),
      ["acodeWorkspaceRefSchema"],
      `${leaf} 不得从 legacy-types 引白名单外符号`,
    );
  }
  // 本地再声明的 deliveryKind 值域与 legacy acodeDeliveryKindSchema 逐字一致。
  assert.deepEqual(
    v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema.shape.clientMode.options,
    [...legacyTypes.acodeDeliveryKindSchema.options],
    "v4 deliveryKind 本地再声明必须与 legacy 值域逐字一致",
  );
  assert.deepEqual(
    v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema.shape.deliveryKind.options,
    [...legacyTypes.acodeDeliveryKindSchema.options],
  );
});

// ── M2-6：workflows + skills + mcp 域 8 方法迁 v4 ──
// （apps/acode-cli/specs/m2-6-workflows-skills-mcp.md）
// v4 面在 acode-protocol-v4/workflows.ts / skills.ts / mcp.ts 结构化再声明，
// 与 legacy 逐字 parity；两侧形状由以下用例互相钉住，漂移即红。
const v4Workflows = await import("../src/acode-protocol-v4/workflows.ts");
const v4Skills = await import("../src/acode-protocol-v4/skills.ts");
const v4Mcp = await import("../src/acode-protocol-v4/mcp.ts");

const m26Workspace = { workspacePath: "F:/repo", workspaceKey: "wk-1" };

test("M2-6 v4 method names land in V4_METHODS with v4/ prefix", () => {
  assert.deepEqual(
    {
      workflowsList: v4Transport.V4_METHODS.workflowsList,
      workflowsGet: v4Transport.V4_METHODS.workflowsGet,
      workflowsUpdateMeta: v4Transport.V4_METHODS.workflowsUpdateMeta,
      workflowsDelete: v4Transport.V4_METHODS.workflowsDelete,
      workflowsRuns: v4Transport.V4_METHODS.workflowsRuns,
      workflowsMove: v4Transport.V4_METHODS.workflowsMove,
      skillsReferenceCatalog: v4Transport.V4_METHODS.skillsReferenceCatalog,
      mcpList: v4Transport.V4_METHODS.mcpList,
    },
    {
      workflowsList: "v4/workflows/list",
      workflowsGet: "v4/workflows/get",
      workflowsUpdateMeta: "v4/workflows/updateMeta",
      workflowsDelete: "v4/workflows/delete",
      workflowsRuns: "v4/workflows/runs",
      workflowsMove: "v4/workflows/move",
      skillsReferenceCatalog: "v4/skills/referenceCatalog",
      mcpList: "v4/mcp/list",
    },
  );
});

test("M2-6 workflows params/result schemas keep verbatim parity with legacy", () => {
  // params 六法：同一输入两侧 parse 结果 deep-equal（strict 形状一致）。
  const paramPairs = [
    ["acodeWorkflowsListParamsSchema", "v4WorkflowsListParamsSchema", { workspace: m26Workspace }],
    [
      "acodeWorkflowsListParamsSchema",
      "v4WorkflowsListParamsSchema",
      { workspace: m26Workspace, scope: "global" },
    ],
    [
      "acodeWorkflowsGetParamsSchema",
      "v4WorkflowsGetParamsSchema",
      { workspace: m26Workspace, name: "daily" },
    ],
    [
      "acodeWorkflowsUpdateMetaParamsSchema",
      "v4WorkflowsUpdateMetaParamsSchema",
      {
        workspace: m26Workspace,
        name: "daily",
        meta: {
          description: "日报",
          whenToUse: "每天早上",
          args: { date: { type: "string", required: true } },
        },
      },
    ],
    [
      "acodeWorkflowsDeleteParamsSchema",
      "v4WorkflowsDeleteParamsSchema",
      { workspace: m26Workspace, name: "daily", scope: "project" },
    ],
    [
      "acodeWorkflowsRunsParamsSchema",
      "v4WorkflowsRunsParamsSchema",
      { workspace: m26Workspace, name: "daily", limit: 20, scope: "global" },
    ],
    [
      "acodeWorkflowsMoveParamsSchema",
      "v4WorkflowsMoveParamsSchema",
      { workspace: m26Workspace, name: "daily" },
    ],
  ];
  for (const [legacyKey, v4Key, input] of paramPairs) {
    assert.deepEqual(
      v4Workflows[v4Key].parse(input),
      legacy[legacyKey].parse(input),
      `${v4Key} 必须与 ${legacyKey} parse 同形`,
    );
    // strict：未知键两侧同拒。
    assert.equal(
      v4Workflows[v4Key].safeParse({ ...input, bogus: 1 }).success,
      false,
      `${v4Key} 必须拒绝未知键`,
    );
  }

  // runs limit 界：1/50 收，0/51/非整数两侧同拒。
  for (const limit of [1, 50]) {
    assert.equal(
      v4Workflows.v4WorkflowsRunsParamsSchema.safeParse({ workspace: m26Workspace, limit }).success,
      true,
    );
  }
  for (const limit of [0, 51, 1.5]) {
    assert.equal(
      v4Workflows.v4WorkflowsRunsParamsSchema.safeParse({ workspace: m26Workspace, limit }).success,
      false,
      `limit=${limit} must stay rejected`,
    );
    assert.equal(
      legacy.acodeWorkflowsRunsParamsSchema.safeParse({ workspace: m26Workspace, limit }).success,
      false,
    );
  }
  assert.equal(v4Workflows.V4_WORKFLOWS_RUNS_MAX_LIMIT, legacy.ACODE_WORKFLOWS_RUNS_MAX_LIMIT);

  // result 六法：代表性 fixture 两侧 parse 同形。
  const resultPairs = [
    [
      "acodeWorkflowsListResultSchema",
      "v4WorkflowsListResultSchema",
      {
        workflows: [
          {
            name: "daily",
            description: "日报",
            scope: "project",
            path: "F:/repo/.acode/workflows/daily.md",
            args: { date: { type: "string" } },
          },
        ],
        invalid: [{ path: "F:/repo/.acode/workflows/bad.md", reason: "bad frontmatter" }],
        dir: "F:/repo/.acode/workflows",
      },
    ],
    [
      "acodeWorkflowsGetResultSchema",
      "v4WorkflowsGetResultSchema",
      {
        ok: true,
        name: "daily",
        path: "F:/repo/.acode/workflows/daily.md",
        scope: "project",
        meta: { description: "日报" },
        script: "await world.run('x')",
      },
    ],
    [
      "acodeWorkflowsGetResultSchema",
      "v4WorkflowsGetResultSchema",
      { ok: false, reason: "not_found" },
    ],
    [
      "acodeWorkflowsUpdateMetaResultSchema",
      "v4WorkflowsUpdateMetaResultSchema",
      { ok: true, path: "F:/repo/.acode/workflows/daily.md" },
    ],
    [
      "acodeWorkflowsDeleteResultSchema",
      "v4WorkflowsDeleteResultSchema",
      { ok: false, reason: "parse_error", detail: "bad yaml" },
    ],
    [
      "acodeWorkflowsRunsResultSchema",
      "v4WorkflowsRunsResultSchema",
      {
        runs: [
          {
            runId: "run-1",
            name: "daily",
            status: "stopped",
            stopReason: "user",
            createdAt: 1,
            updatedAt: 2,
            spentTokens: 3,
            parentSessionId: "session-1",
            toolCallId: "tool-1",
            args: { date: "2026-10-28" },
            cwd: "F:/repo",
            artifacts: [{ id: "a1", kind: "markdown", version: 2, title: "报告" }],
          },
        ],
        truncated: true,
      },
    ],
    [
      "acodeWorkflowsMoveResultSchema",
      "v4WorkflowsMoveResultSchema",
      { ok: true, from: "C:/Users/u/.acode/workflows/daily.md", to: "F:/repo/.acode/workflows/daily.md" },
    ],
    [
      "acodeWorkflowsMoveResultSchema",
      "v4WorkflowsMoveResultSchema",
      { ok: false, reason: "target_exists", path: "F:/repo/.acode/workflows/daily.md" },
    ],
  ];
  for (const [legacyKey, v4Key, input] of resultPairs) {
    assert.deepEqual(
      v4Workflows[v4Key].parse(input),
      legacy[legacyKey].parse(input),
      `${v4Key} 必须与 ${legacyKey} parse 同形`,
    );
  }

  // 失败/状态词表逐字一致。
  assert.deepEqual(
    [...v4Workflows.v4SavedWorkflowFailureReasonSchema.options].sort(),
    [...legacy.acodeSavedWorkflowFailureReasonSchema.options].sort(),
  );
  assert.deepEqual(
    [...v4Workflows.v4SavedWorkflowRunStatusSchema.options].sort(),
    [...legacy.acodeSavedWorkflowRunStatusSchema.options].sort(),
  );
  assert.deepEqual(
    [...v4Workflows.v4SavedWorkflowRunStopReasonSchema.options].sort(),
    [...legacy.acodeSavedWorkflowRunStopReasonSchema.options].sort(),
  );
  assert.deepEqual(
    [...v4Workflows.v4SavedWorkflowScopeSchema.options].sort(),
    [...legacy.acodeSavedWorkflowScopeSchema.options].sort(),
  );
  // artifacts chips 上界 8：第 9 件两侧同拒。
  const nineArtifacts = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, kind: "file", version: 1 }));
  const runWithNine = {
    runId: "run-1",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    spentTokens: 0,
    artifacts: nineArtifacts,
  };
  assert.equal(
    v4Workflows.v4WorkflowsRunsResultSchema.safeParse({ runs: [runWithNine] }).success,
    false,
    "artifacts 超 8 件必须拒绝",
  );
});

test("M2-6 skills referenceCatalog schemas keep verbatim parity with legacy", () => {
  for (const input of [
    { workspace: m26Workspace },
    { workspace: m26Workspace, sessionId: "session-1" },
  ]) {
    assert.deepEqual(
      v4Skills.v4SkillsReferenceCatalogParamsSchema.parse(input),
      legacy.acodeSkillsReferenceCatalogParamsSchema.parse(input),
    );
    assert.equal(
      v4Skills.v4SkillsReferenceCatalogParamsSchema.safeParse({ ...input, bogus: 1 }).success,
      false,
    );
  }
  const catalog = {
    authority: "workspace",
    skills: [
      {
        id: "glm:workspace:F:/repo/.acode/skills/x/SKILL.md",
        name: "x",
        description: "desc",
        path: "F:/repo/.acode/skills/x/SKILL.md",
        scope: "workspace",
        enabled: true,
      },
      {
        id: "glm:plugin:F:/plugins/p/skills/y/SKILL.md",
        name: "y",
        description: "desc",
        path: "F:/plugins/p/skills/y/SKILL.md",
        scope: "plugin",
        enabled: true,
        pluginName: "p",
      },
    ],
  };
  assert.deepEqual(
    v4Skills.v4SkillsReferenceCatalogResultSchema.parse(catalog),
    legacy.acodeSkillsReferenceCatalogResultSchema.parse(catalog),
  );
  // authority 词表逐字一致；enabled 恒 true（literal）。
  assert.deepEqual(
    [...v4Skills.v4SkillsReferenceCatalogResultSchema.shape.authority.options].sort(),
    [...legacy.acodeSkillsReferenceCatalogResultSchema.shape.authority.options].sort(),
  );
  assert.equal(
    v4Skills.v4SkillsReferenceCatalogResultSchema.safeParse({
      authority: "workspace",
      skills: [{ ...catalog.skills[0], enabled: false }],
    }).success,
    false,
    "enabled 必须是 literal true",
  );
});

test("M2-6 mcp list schemas keep verbatim parity with legacy", () => {
  // mode 缺省 connect：两侧 default 同值。
  const parsed = v4Mcp.v4McpListParamsSchema.parse({ workspace: m26Workspace });
  assert.equal(parsed.mode, "connect");
  assert.deepEqual(parsed, legacy.acodeMcpListParamsSchema.parse({ workspace: m26Workspace }));
  for (const input of [
    { workspace: m26Workspace, mode: "status" },
    { workspace: m26Workspace, mcpServers: [mcpServer] },
    { workspace: m26Workspace, mcpServers: [mcpServer], mode: "connect" },
  ]) {
    assert.deepEqual(
      v4Mcp.v4McpListParamsSchema.parse(input),
      legacy.acodeMcpListParamsSchema.parse(input),
    );
    assert.equal(
      v4Mcp.v4McpListParamsSchema.safeParse({ ...input, bogus: 1 }).success,
      false,
    );
  }
  // 状态快照：全字段 fixture 两侧同形；failure kind / status kind 词表逐字一致。
  const snapshot = {
    status: "failed",
    transport: "stdio",
    toolCount: 0,
    updatedAt: "2026-10-28T00:00:00.000Z",
    error: "boom",
    failureKind: "process_start_failed",
    serverRequestId: "req-1",
    protocolEra: "modern",
    reconnectSuspension: {
      consecutiveFailures: 3,
      consecutiveInCallCrashes: 1,
      suspendedAt: "2026-10-28T00:30:00.000Z",
      suspendedBy: "crash_storm",
    },
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://example.test/auth",
      startedAt: "2026-10-28T00:00:00.000Z",
    },
  };
  const statuses = { statuses: { local: snapshot } };
  assert.deepEqual(
    v4Mcp.v4McpListResultSchema.parse(statuses),
    legacy.acodeMcpListResultSchema.parse(statuses),
  );
  assert.deepEqual(
    [...v4Mcp.v4McpServerStatusKindSchema.options].sort(),
    [...legacy.acodeMcpServerStatusKindSchema.options].sort(),
  );
  assert.deepEqual(
    [...v4Mcp.V4_MCP_SERVER_FAILURE_KINDS].sort(),
    [...legacy.MCP_SERVER_FAILURE_KINDS].sort(),
    "v4 failure kinds 词表必须与 legacy 逐字一致",
  );
});

test("M2-6 new v4 schema files have no reverse import into the legacy protocol barrel", async () => {
  for (const file of ["workflows.ts", "skills.ts", "mcp.ts"]) {
    const source = await readFile(
      new URL(`../src/acode-protocol-v4/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /acode-protocol\/index(?:\.js|\.ts)?/, `${file} 不得反向 import legacy barrel`);
  }
});

// ── M2-8：workspace + provider + process 域 11 方法迁 v4 ──
// （apps/acode-cli/specs/m2-8-workspace-provider-process.md）
// v4 面在 acode-protocol-v4/workspace-runtime.ts / workspace-policies.ts /
// provider-process.ts 结构化再声明，与 legacy 逐字 parity；两侧形状由以下用例互相钉住，
// 漂移即红。11 法全迁、无保留词（generateText 不提前退役；childProcesses 观测面迁移保留）。
const v4WorkspaceRuntime = await import("../src/acode-protocol-v4/workspace-runtime.ts");
const v4WorkspacePolicies = await import("../src/acode-protocol-v4/workspace-policies.ts");
const v4ProviderProcess = await import("../src/acode-protocol-v4/provider-process.ts");

const m28Workspace = { workspacePath: "F:/repo", workspaceKey: "wk-1" };
const m28Selection = { providerId: "acode", modelId: "k3" };
const m28Digest = "a".repeat(64);

test("M2-8 v4 method names land in V4_METHODS with v4/ prefix", () => {
  assert.deepEqual(
    {
      workspaceReadPresentation: v4Transport.V4_METHODS.workspaceReadPresentation,
      workspaceHookTrustGrant: v4Transport.V4_METHODS.workspaceHookTrustGrant,
      workspaceUpdateInteractionPreferences:
        v4Transport.V4_METHODS.workspaceUpdateInteractionPreferences,
      workspaceUpdateModelIoPreferences: v4Transport.V4_METHODS.workspaceUpdateModelIoPreferences,
      workspaceUpdateOffPeakToolPolicy: v4Transport.V4_METHODS.workspaceUpdateOffPeakToolPolicy,
      workspaceUpdateDynamicWorkflowPolicy:
        v4Transport.V4_METHODS.workspaceUpdateDynamicWorkflowPolicy,
      workspaceGenerateText: v4Transport.V4_METHODS.workspaceGenerateText,
      workspaceCancelGenerateText: v4Transport.V4_METHODS.workspaceCancelGenerateText,
      providerUpdateAccountConfig: v4Transport.V4_METHODS.providerUpdateAccountConfig,
      providerTestModelConnectivity: v4Transport.V4_METHODS.providerTestModelConnectivity,
      processChildProcesses: v4Transport.V4_METHODS.processChildProcesses,
    },
    {
      workspaceReadPresentation: "v4/workspace/readPresentation",
      workspaceHookTrustGrant: "v4/workspace/hooks/trustGrant",
      workspaceUpdateInteractionPreferences: "v4/workspace/updateInteractionPreferences",
      workspaceUpdateModelIoPreferences: "v4/workspace/updateModelIoPreferences",
      workspaceUpdateOffPeakToolPolicy: "v4/workspace/updateOffPeakToolPolicy",
      workspaceUpdateDynamicWorkflowPolicy: "v4/workspace/updateDynamicWorkflowPolicy",
      workspaceGenerateText: "v4/workspace/generateText",
      workspaceCancelGenerateText: "v4/workspace/cancelGenerateText",
      providerUpdateAccountConfig: "v4/provider/updateAccountConfig",
      providerTestModelConnectivity: "v4/provider/testModelConnectivity",
      processChildProcesses: "v4/process/childProcesses",
    },
  );
});

test("M2-8 params schemas keep verbatim parity with legacy", () => {
  const parityPairs = [
    [
      legacy.acodeWorkspaceReadPresentationParamsSchema,
      v4WorkspaceRuntime.v4WorkspaceReadPresentationParamsSchema,
      { workspace: m28Workspace },
    ],
    [
      legacy.acodeWorkspaceHookTrustGrantParamsSchema,
      v4WorkspacePolicies.v4WorkspaceHookTrustGrantParamsSchema,
      { workspace: m28Workspace, bundleDigest: m28Digest, hookDeclarationDigest: m28Digest },
    ],
    [
      legacy.acodeWorkspaceUpdateInteractionPreferencesParamsSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateInteractionPreferencesParamsSchema,
      { workspace: m28Workspace, preferences: { askUserQuestionAutoResolutionEnabled: true } },
    ],
    [
      legacy.acodeWorkspaceUpdateModelIoPreferencesParamsSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateModelIoPreferencesParamsSchema,
      { workspace: m28Workspace, preferences: { fullRetentionEnabled: false } },
    ],
    [
      legacy.acodeWorkspaceUpdateOffPeakToolPolicyParamsSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateOffPeakToolPolicyParamsSchema,
      { workspace: m28Workspace, enabled: true },
    ],
    [
      legacy.acodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
      { workspace: m28Workspace, enabled: false },
    ],
    [
      legacy.acodeWorkspaceGenerateTextParamsSchema,
      v4WorkspaceRuntime.v4WorkspaceGenerateTextParamsSchema,
      {
        workspace: m28Workspace,
        selection: m28Selection,
        prompt: "润色这段文字",
        querySource: "prompt-polish",
        maxOutputTokens: 1024,
        operationId: "op-1",
      },
    ],
    [
      legacy.acodeWorkspaceGenerateTextParamsSchema,
      v4WorkspaceRuntime.v4WorkspaceGenerateTextParamsSchema,
      {
        workspace: m28Workspace,
        selection: m28Selection,
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
          {
            role: "assistant",
            content: "a",
            toolCalls: [{ id: "t-1", name: "tool", input: { x: 1 } }],
          },
          { role: "tool", content: "r", toolCallId: "t-1", toolName: "tool", isError: false },
        ],
        tools: [{ name: "tool", description: "d", inputSchema: { type: "object" } }],
        querySource: "prompt-polish",
      },
    ],
    [
      legacy.acodeWorkspaceCancelGenerateTextParamsSchema,
      v4WorkspaceRuntime.v4WorkspaceCancelGenerateTextParamsSchema,
      { operationId: "op-1" },
    ],
    [
      legacy.acodeProviderUpdateAccountConfigParamsSchema,
      v4ProviderProcess.v4ProviderUpdateAccountConfigParamsSchema,
      {
        revision: "r-1",
        basedOnACodeBuiltinRevision: "b-1",
        providers: { acode: { endpoint: "https://example.test" } },
        states: {
          acode: {
            availability: "unavailable",
            entitled: false,
            unavailableReason: "not-entitled",
            current: true,
            connectionKey: "k",
            effectiveAt: 1_700_000_000_000,
          },
        },
      },
    ],
    [
      legacy.acodeProviderTestModelConnectivityParamsSchema,
      v4ProviderProcess.v4ProviderTestModelConnectivityParamsSchema,
      { workspace: m28Workspace, selection: m28Selection },
    ],
    [
      legacy.acodeProcessChildProcessesParamsSchema,
      v4ProviderProcess.v4ProcessChildProcessesParamsSchema,
      {},
    ],
  ];
  for (const [legacySchema, v4Schema, payload] of parityPairs) {
    const legacyParsed = legacySchema.safeParse(payload);
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 payload：${JSON.stringify(payload)}`);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 payload：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy parse 产出必须逐字一致");
    // strict parity：未知键两侧同拒。
    const widened = { ...payload, unexpectedM28Probe: true };
    assert.equal(v4Schema.safeParse(widened).success, false, "v4 strict 必须拒未知键");
    assert.equal(legacySchema.safeParse(widened).success, false, "legacy strict 必须拒未知键");
  }
  // generateText refine parity：prompt/messages 至少其一，两侧同拒同收。
  const noPrompt = {
    workspace: m28Workspace,
    selection: m28Selection,
    querySource: "prompt-polish",
  };
  assert.equal(v4WorkspaceRuntime.v4WorkspaceGenerateTextParamsSchema.safeParse(noPrompt).success, false);
  assert.equal(legacy.acodeWorkspaceGenerateTextParamsSchema.safeParse(noPrompt).success, false);
  // hookTrust digest 正则 parity：非 64 位小写 hex 两侧同拒。
  const badDigest = { workspace: m28Workspace, bundleDigest: "zz", hookDeclarationDigest: m28Digest };
  assert.equal(v4WorkspacePolicies.v4WorkspaceHookTrustGrantParamsSchema.safeParse(badDigest).success, false);
  assert.equal(legacy.acodeWorkspaceHookTrustGrantParamsSchema.safeParse(badDigest).success, false);
  // workspace ref 缺 workspaceKey 两侧同拒（中性 schema 共用）。
  const noKey = { workspace: { workspacePath: "/repo" } };
  assert.equal(v4WorkspaceRuntime.v4WorkspaceReadPresentationParamsSchema.safeParse(noKey).success, false);
  assert.equal(legacy.acodeWorkspaceReadPresentationParamsSchema.safeParse(noKey).success, false);
});

test("M2-8 result schemas keep verbatim parity with legacy", () => {
  const resultPairs = [
    [
      legacy.acodeWorkspacePresentationSchema,
      v4WorkspaceRuntime.v4WorkspacePresentationSchema,
      {
        workspace: m28Workspace,
        mode: "build",
        slashCommands: [
          { name: "review", description: "评审", inputHint: "[path]", source: "builtin" },
          { name: "x", description: "d" },
        ],
      },
    ],
    [
      legacy.acodeWorkspaceHookTrustGrantResultSchema,
      v4WorkspacePolicies.v4WorkspaceHookTrustGrantResultSchema,
      { accepted: false, reasonCode: "workspace_hooks_policy_requires_pretrust" },
    ],
    [
      legacy.acodeWorkspaceHookTrustGrantResultSchema,
      v4WorkspacePolicies.v4WorkspaceHookTrustGrantResultSchema,
      { accepted: true },
    ],
    [
      legacy.acodeWorkspaceUpdateInteractionPreferencesResultSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateInteractionPreferencesResultSchema,
      { workspace: m28Workspace, askUserQuestionAutoResolutionEnabled: true, snoozedInteractionCount: 2 },
    ],
    [
      legacy.acodeWorkspaceUpdateModelIoPreferencesResultSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateModelIoPreferencesResultSchema,
      { workspace: m28Workspace, fullRetentionEnabled: true, updatedSessionCount: 3 },
    ],
    [
      legacy.acodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateOffPeakToolPolicyResultSchema,
      { workspace: m28Workspace, enabled: true },
    ],
    [
      legacy.acodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
      v4WorkspacePolicies.v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema,
      { workspace: m28Workspace, enabled: false },
    ],
    [
      legacy.acodeWorkspaceGenerateTextResultSchema,
      v4WorkspaceRuntime.v4WorkspaceGenerateTextResultSchema,
      {
        text: "润色后",
        selection: m28Selection,
        finishReason: "stop",
        toolCalls: [{ id: "t-1", name: "tool", input: {} }],
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
          serverToolUse: { webSearchRequests: 1, webFetchRequests: 0 },
        },
      },
    ],
    [
      legacy.acodeWorkspaceCancelGenerateTextResultSchema,
      v4WorkspaceRuntime.v4WorkspaceCancelGenerateTextResultSchema,
      { operationId: "op-1", cancelled: true },
    ],
    [
      legacy.acodeProviderUpdateAccountConfigResultSchema,
      v4ProviderProcess.v4ProviderUpdateAccountConfigResultSchema,
      { receivedRevision: "r-1", providerCount: 2, status: "received" },
    ],
    [
      legacy.acodeProviderTestModelConnectivityResultSchema,
      v4ProviderProcess.v4ProviderTestModelConnectivityResultSchema,
      { success: true },
    ],
    [
      legacy.acodeProcessChildProcessesResultSchema,
      v4ProviderProcess.v4ProcessChildProcessesResultSchema,
      {
        processes: [
          { pid: 100, serverName: "mcp-1", mcpSource: "builtin", pluginName: "official" },
          { pid: 101, serverName: "mcp-2", mcpSource: "custom" },
        ],
      },
    ],
  ];
  for (const [legacySchema, v4Schema, payload] of resultPairs) {
    const legacyParsed = legacySchema.safeParse(payload);
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy result parse 产出必须逐字一致");
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM28Probe: true }).success, false);
    assert.equal(legacySchema.safeParse({ ...payload, unexpectedM28Probe: true }).success, false);
  }
  // hookTrust reasonCode 词表逐字一致。
  assert.deepEqual(
    [...v4WorkspacePolicies.v4WorkspaceHookTrustGrantReasonCodeSchema.options].sort(),
    [...legacy.acodeWorkspaceHookTrustGrantReasonCodeSchema.options].sort(),
    "v4 hookTrust reasonCode 词表必须与 legacy 逐字一致",
  );
  // sessionMode / slashCommand 是本地再声明件（白名单未登记/barrel 全禁），值域逐字钉住。
  assert.deepEqual(
    [...v4WorkspaceRuntime.v4WorkspaceSessionModeSchema.options].sort(),
    [...legacyTypes.acodeSessionModeSchema.options].sort(),
    "v4 sessionMode 值域必须与 legacy-types 逐字一致",
  );
  const slash = { name: "review", description: "评审", inputHint: "[p]", source: "custom" };
  assert.deepEqual(
    v4WorkspaceRuntime.v4WorkspaceSlashCommandSchema.parse(slash),
    legacy.acodeSlashCommandSchema.parse(slash),
    "v4 slashCommand 形状必须与 legacy barrel 逐字一致",
  );
});

test("M2-8 new v4 schema files have no reverse import into the legacy protocol barrel", async () => {
  for (const file of ["workspace-runtime.ts", "workspace-policies.ts", "provider-process.ts"]) {
    const source = await readFile(
      new URL(`../src/acode-protocol-v4/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /acode-protocol\/index(?:\.js|\.ts)?/, `${file} 不得反向 import legacy barrel`);
  }
});

// ── M2-3：session 读写面 v4 化 ────────────────────────────────────────────────
const v4SessionReadwrite = await import("../src/acode-protocol-v4/session-readwrite.ts");

test("M2-3 v4 session read/write method names land in V4_METHODS with v4/ prefix", () => {
  assert.deepEqual(
    {
      sessionRead: v4Transport.V4_METHODS.sessionRead,
      sessionResume: v4Transport.V4_METHODS.sessionResume,
      sessionsList: v4Transport.V4_METHODS.sessionsList,
      sessionMessages: v4Transport.V4_METHODS.sessionMessages,
      sessionEvents: v4Transport.V4_METHODS.sessionEvents,
      sessionSubscribe: v4Transport.V4_METHODS.sessionSubscribe,
      sessionRuntimePreferences: v4Transport.V4_METHODS.sessionRuntimePreferences,
    },
    {
      sessionRead: "v4/session/read",
      sessionResume: "v4/session/resume",
      sessionsList: "v4/sessions/list",
      sessionMessages: "v4/session/messages",
      sessionEvents: "v4/session/events",
      sessionSubscribe: "v4/session/subscribe",
      sessionRuntimePreferences: "v4/session/runtimePreferences",
    },
  );
});

test("M2-3 v4 session params schemas keep verbatim parity with legacy", () => {
  // 同一输入两侧 parse 结果 deep-equal（strict 形状一致；v4 未新增/删减字段的面全量 parity）。
  const pairs = [
    [
      legacy.acodeSessionReadParamsSchema,
      v4SessionReadwrite.v4SessionReadParamsSchema,
      { sessionId: "s1" },
    ],
    [
      legacy.acodeSessionReadParamsSchema,
      v4SessionReadwrite.v4SessionReadParamsSchema,
      { sessionId: "s1", deliveryKind: "desktop-continuous", messageLimit: 50, afterSeq: 3 },
    ],
    [
      legacy.acodeSessionResumeParamsSchema,
      v4SessionReadwrite.v4SessionResumeParamsSchema,
      { sessionId: "s1" },
    ],
    [
      legacy.acodeSessionResumeParamsSchema,
      v4SessionReadwrite.v4SessionResumeParamsSchema,
      {
        sessionId: "s1",
        workspace: { workspacePath: "/w", workspaceKey: "wk" },
        thoughtLevel: "high",
        mcpServers: [mcpServer],
        toolAllowlist: ["Bash"],
        toolDenylist: ["Write"],
        offPeakToolEnabled: true,
        dynamicWorkflowEnabled: false,
      },
    ],
    [
      legacy.acodeSessionListParamsSchema,
      v4SessionReadwrite.v4SessionsListParamsSchema,
      { workspace: { workspacePath: "/w", workspaceKey: "wk" }, limit: 10 },
    ],
    [
      legacy.acodeSessionListParamsSchema,
      v4SessionReadwrite.v4SessionsListParamsSchema,
      { sessionIds: ["a", "b"], includeArchived: true },
    ],
    [
      legacy.acodeSessionMessagesParamsSchema,
      v4SessionReadwrite.v4SessionMessagesParamsSchema,
      { sessionId: "s1", afterMessageId: "m1", limit: 20 },
    ],
    [
      legacy.acodeSessionEventsParamsSchema,
      v4SessionReadwrite.v4SessionEventsParamsSchema,
      { sessionId: "s1", afterSeq: 2, limit: 100 },
    ],
    [
      legacy.acodeSessionSubscribeParamsSchema,
      v4SessionReadwrite.v4SessionSubscribeParamsSchema,
      { sessionId: "s1", deliveryKind: "web-remote-replayable", afterSeq: 1, includeSnapshot: true },
    ],
  ];
  for (const [legacySchema, v4Schema, input] of pairs) {
    assert.deepEqual(
      v4Schema.parse(input),
      legacySchema.parse(input),
      `v4/legacy params parse 必须逐字一致：${JSON.stringify(input)}`,
    );
  }
  // strict：未知键两侧都必须拒绝。
  assert.throws(() =>
    v4SessionReadwrite.v4SessionReadParamsSchema.parse({ sessionId: "s1", protocolSeqs: true }),
  );
  assert.throws(() =>
    v4SessionReadwrite.v4SessionSubscribeParamsSchema.parse({
      sessionId: "s1",
      deliveryKind: "desktop-continuous",
      includeSubagentEvents: true,
    }),
  );
  // mode（plain/local）是 handler 层选项，不在 wire 面——wire 不得长出该键。
  assert.throws(() =>
    v4SessionReadwrite.v4SessionSubscribeParamsSchema.parse({
      sessionId: "s1",
      deliveryKind: "desktop-continuous",
      mode: "plain",
    }),
  );
});

test("M2-3 v4 sessions/list result schema is the normalized legacy-types sessionInfo", () => {
  // 注意同名歧义：barrel 的 acodeSessionInfoSchema 是 opencode Session.Info 形状，
  // v4 wire 用的是 legacy-types 的规范化 sessionInfo（sessionId/workspace/sessionKind/
  // mode/status/createdAt/updatedAt）——与 M2-2 session-control 同一条约。
  const sessionInfo = {
    sessionId: "s1",
    workspace: { workspacePath: "/w", workspaceKey: "wk" },
    sessionKind: "interactive",
    title: "t",
    mode: "build",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
  };
  const normalized = legacyTypes.acodeSessionInfoSchema.parse(sessionInfo);
  assert.deepEqual(
    v4SessionReadwrite.v4SessionsListResultSchema.parse({ sessions: [sessionInfo] }),
    { sessions: [normalized] },
    "sessions/list 结果面必须是 legacy-types 规范化 sessionInfo 数组",
  );
  // messages 刻意无 v4 result schema：op 直通 raw opencode MessageWithParts（info.id
  // 词汇），legacy services 对 barrel acodeSessionMessagesResultSchema 仅是孤儿 import
  // 从不校验——迁移 parity 即「不校验」。normalized 词汇只在 session/read snapshot 的
  // mapMessageWithParts 路径（spec §6 登记）。
  assert.equal(v4SessionReadwrite.v4SessionMessagesResultSchema, undefined);
  // read/resume/events/subscribe 的 result schema 刻意不自立：事件词汇 26 变体与
  // snapshot 闭合不复制，services 侧继续用 legacy barrel result schema 校验（wire 形态
  // 逐字一致，居所 consolidation 归 M4，spec §2.6）。
  assert.equal(v4SessionReadwrite.v4SessionSubscribeResultSchema, undefined);
  assert.equal(typeof legacy.acodeSessionSubscribeResultSchema.parse, "function");
});

test("M2-3 v4 createSession payload carries the nine additive parity fields, all optional", () => {
  const createPayload = v4.commandPayloadSchemas.createSession;
  for (const key of [
    "sessionId",
    "persistence",
    "titleGenerationEnabled",
    "toolAllowlist",
    "toolDenylist",
    "importedHistory",
    "mode",
    "model",
    "thoughtLevel",
  ]) {
    assert.ok(key in v4SessionReadwrite.v4SessionCreateParityFieldShapes, `parity 字段表必须含 ${key}`);
  }
  assert.equal(Object.keys(v4SessionReadwrite.v4SessionCreateParityFieldShapes).length, 9);
  // 九个字段全缺席：仍是合法 createSession 载荷（普通新会话路径）。
  const minimal = { workspaceId: "/w" };
  assert.ok(createPayload.safeParse(minimal).success, "九字段全缺席必须合法");
  // 全量在场：合法且逐字透传。
  const full = {
    ...minimal,
    sessionId: "s-import",
    persistence: "immediate",
    titleGenerationEnabled: false,
    toolAllowlist: ["Bash"],
    toolDenylist: ["Write"],
    importedHistory: {
      source: "claudeCode",
      messages: [{ role: "user", content: "hi" }],
    },
    mode: "plan",
    model: { providerId: "anthropic", modelId: "claude-opus-4" },
    thoughtLevel: "high",
  };
  const parsed = createPayload.parse(full);
  for (const key of Object.keys(v4SessionReadwrite.v4SessionCreateParityFieldShapes)) {
    assert.deepEqual(parsed[key], full[key], `createSession 载荷必须透传 ${key}`);
  }
  // v4 payload 非 strict：未知键静默丢弃（fail-closed，旧 CLI 不炸）。
  const withBogus = createPayload.parse({ ...minimal, bogusField: 1 });
  assert.equal("bogusField" in withBogus, false, "未知键必须被静默丢弃而非透传");
  // persistence 值域钉住。
  assert.equal(createPayload.safeParse({ ...minimal, persistence: "bogus" }).success, false);
});

test("M2-3 v4 runtimePreferences push params strict; result is the empty strict object", () => {
  const prefs = {
    askUserQuestionAutoResolutionEnabled: true,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: true,
    integratedTerminalShell: { mode: "auto" },
  };
  assert.deepEqual(
    v4SessionReadwrite.v4SessionRuntimePreferencesPushParamsSchema.parse({
      preferences: prefs,
    }),
    { preferences: prefs },
  );
  // 布尔域 + shell 判别联合（auto / shell+dialect 词表）钉住。
  assert.equal(
    v4SessionReadwrite.v4SessionRuntimePreferencesPushParamsSchema.safeParse({
      preferences: { ...prefs, memoryEnabled: "yes" },
    }).success,
    false,
  );
  assert.equal(
    v4SessionReadwrite.v4SessionRuntimePreferencesPushParamsSchema.safeParse({
      preferences: {
        ...prefs,
        integratedTerminalShell: {
          mode: "shell",
          dialect: "powershell",
          id: "x",
          label: "x",
          path: "x",
        },
      },
    }).success,
    false,
    "shell dialect 词表只允许 cmd|git-bash",
  );
  assert.equal(
    v4SessionReadwrite.v4SessionRuntimePreferencesPushParamsSchema.safeParse({
      preferences: prefs,
      extra: 1,
    }).success,
    false,
    "push params strict：未知键拒绝",
  );
  // 推送面是无返回值的承载：结果 schema = z.object({}).strict()。
  assert.deepEqual(v4SessionReadwrite.v4SessionRuntimePreferencesResultSchema.parse({}), {});
  assert.equal(
    v4SessionReadwrite.v4SessionRuntimePreferencesResultSchema.safeParse({ echoed: true }).success,
    false,
  );
});

test("M2-3 session-readwrite schema leaf has no reverse import into the legacy protocol barrel", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-v4/session-readwrite.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /acode-protocol\/index(?:\.js|\.ts)?/,
    "session-readwrite.ts 不得反向 import legacy barrel",
  );
});

// ── M2-4 inbound 交互面（specs/m2-4-inbound-interaction.md）──
// 纪律：六反向请求 + 两通知只换方法名/通知名，不换载荷——故这里逐字钉住 v4 wire 形态
// 与 legacy barrel 的 parity（同一份合法/非法载荷两侧判定一致），以及 transport 登记的字面值。

test("M2-4 transport registers six inbound request methods with v4/interaction prefix", () => {
  assert.equal(v4Transport.V4_METHODS.interactionRequestPermission, "v4/interaction/requestPermission");
  assert.equal(v4Transport.V4_METHODS.interactionRequestUserInput, "v4/interaction/requestUserInput");
  assert.equal(
    v4Transport.V4_METHODS.interactionRequestProviderRuntimeHeaders,
    "v4/interaction/requestProviderRuntimeHeaders",
  );
  assert.equal(
    v4Transport.V4_METHODS.interactionRequestOfficialMcpAuthHeaders,
    "v4/interaction/requestOfficialMcpAuthHeaders",
  );
  assert.equal(v4Transport.V4_METHODS.interactionBrowserList, "v4/interaction/browserList");
  assert.equal(v4Transport.V4_METHODS.interactionBrowserExecute, "v4/interaction/browserExecute");
});

test("M2-4 transport registers two CLI->host notifications", () => {
  assert.equal(v4Transport.V4_NOTIFICATIONS.cuaOperationEvent, "v4/cua/operationEvent");
  assert.equal(
    v4Transport.V4_NOTIFICATIONS.interactionProviderRuntimeHeadersCancelled,
    "v4/interaction/providerRuntimeHeadersCancelled",
  );
});

test("M2-4 announce+ack result schema is the empty strict object", () => {
  assert.deepEqual(v4Inbound.v4InteractionRequestAckSchema.parse({}), {});
  assert.equal(v4Inbound.v4InteractionRequestAckSchema.safeParse({ echoed: 1 }).success, false);
});

test("M2-4 permission request params wire shape is verbatim parity with legacy", () => {
  const params = {
    requestId: "req-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "Bash",
    reason: "run a command",
    riskLevel: "high",
    input: { command: "ls" },
    options: [
      {
        optionId: "allowOnce",
        kind: "allow",
        name: "Allow once",
        response: { decision: "allow" },
      },
    ],
  };
  assert.deepEqual(
    v4Inbound.v4InteractionRequestPermissionParamsSchema.parse(params),
    legacy.acodePermissionRequestParamsSchema.parse(params),
    "合法载荷两侧判定与产物逐字一致",
  );
  // strict：未知键拒绝（与 legacy 同纪律）。
  assert.equal(
    v4Inbound.v4InteractionRequestPermissionParamsSchema.safeParse({ ...params, bogus: 1 }).success,
    false,
  );
  // riskLevel 值域钉住。
  assert.equal(
    v4Inbound.v4InteractionRequestPermissionParamsSchema.safeParse({ ...params, riskLevel: "extreme" })
      .success,
    false,
  );
  // options 非空约束。
  assert.equal(
    v4Inbound.v4InteractionRequestPermissionParamsSchema.safeParse({ ...params, options: [] }).success,
    false,
  );
});

test("M2-4 userInput request params and response are verbatim parity with legacy", () => {
  const params = {
    requestId: "req-2",
    sessionId: "sess-2",
    toolName: "AskUserQuestion",
    questions: [
      {
        question: "pick one",
        header: "Choice",
        options: [{ value: "a", label: "A" }],
        multiSelect: false,
      },
    ],
  };
  assert.deepEqual(
    v4Inbound.v4InteractionRequestUserInputParamsSchema.parse(params),
    legacy.acodeUserInputRequestParamsSchema.parse(params),
  );
  const response = { action: "accept", content: { answer: "a" } };
  assert.deepEqual(
    v4Inbound.v4UserInputResponseSchema.parse(response),
    legacy.acodeUserInputResponseSchema.parse(response),
  );
  // action 值域钉住。
  assert.equal(v4Inbound.v4UserInputResponseSchema.safeParse({ action: "bogus" }).success, false);
});

test("M2-4 providerRuntimeHeaders params/cancelled/response are verbatim parity with legacy", () => {
  const params = {
    requestId: "req-3",
    sessionId: "sess-3",
    workspace: { workspacePath: "/w", workspaceKey: "w-key" },
    modelSelection: { providerId: "anthropic", modelId: "claude-opus-4" },
    providerId: "anthropic",
    reason: "model-request",
  };
  assert.deepEqual(
    v4Inbound.v4InteractionRequestProviderRuntimeHeadersParamsSchema.parse(params),
    legacy.acodeProviderRuntimeHeadersRequestParamsSchema.parse(params),
  );
  const cancelled = { requestId: "req-3", sessionId: "sess-3", workspace: { workspacePath: "/w", workspaceKey: "w-key" } };
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersCancelledSchema.parse(cancelled),
    legacy.acodeProviderRuntimeHeadersCancelledSchema.parse(cancelled),
  );
  const ok = { headersApplied: true, requestAuth: { apiKey: "sk-x" } };
  const fail = { headersApplied: false, errorMessage: "no auth" };
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersResponseSchema.parse(ok),
    legacy.acodeProviderRuntimeHeadersResponseSchema.parse(ok),
  );
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersResponseSchema.parse(fail),
    legacy.acodeProviderRuntimeHeadersResponseSchema.parse(fail),
  );
  // reason 值域钉住。
  assert.equal(
    v4Inbound.v4InteractionRequestProviderRuntimeHeadersParamsSchema.safeParse({ ...params, reason: "other" })
      .success,
    false,
  );
});

test("M2-4 officialMcp params/response are verbatim parity with legacy; failure reasons enumerable", () => {
  const params = {
    requestId: "req-4",
    workspace: { workspacePath: "/w", workspaceKey: "w-key" },
    pluginId: "plug-1",
    mcpKey: "key-1",
    targetOrigin: "https://api.example.test",
  };
  assert.deepEqual(
    v4Inbound.v4InteractionRequestOfficialMcpAuthHeadersParamsSchema.parse(params),
    legacy.acodeOfficialMcpAuthHeadersRequestParamsSchema.parse(params),
  );
  const okResp = { ok: true, headers: { Authorization: "Bearer x" } };
  const failResp = { ok: false, reason: "official_auth_unavailable" };
  assert.deepEqual(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.parse(okResp),
    legacy.acodeOfficialMcpAuthHeadersResponseSchema.parse(okResp),
  );
  assert.deepEqual(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.parse(failResp),
    legacy.acodeOfficialMcpAuthHeadersResponseSchema.parse(failResp),
  );
  // 失败原因必须落在可枚举集合内（自由文本拒绝）。
  assert.equal(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.safeParse({ ok: false, reason: "whatever" }).success,
    false,
  );
  // 响应不含 errorMessage（可枚举纪律）。
  assert.equal(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.safeParse({ ok: false, reason: "official_auth_unavailable", errorMessage: "x" })
      .success,
    false,
  );
});

test("M2-4 browserList/browserExecute params parity with legacy; results re-export the neutral leaves", () => {
  const listParams = {
    requestId: "req-5",
    sessionId: "sess-5",
    workspaceKey: "w-key",
    workspacePath: "/w",
    clientMode: "desktop-continuous",
    sessionContext: "live",
  };
  assert.deepEqual(
    v4Inbound.v4InteractionBrowserListParamsSchema.parse(listParams),
    legacy.acodeBrowserListParamsSchema.parse(listParams),
  );
  const executeParams = {
    requestId: "req-6",
    sessionId: "sess-6",
    command: { method: "turnEnded", turnId: "turn-6" },
  };
  assert.deepEqual(
    v4Inbound.v4InteractionBrowserExecuteParamsSchema.parse(executeParams),
    legacy.acodeBrowserExecuteParamsSchema.parse(executeParams),
  );
  // result 面直接重导出中立叶（同一 schema 实例）。
  assert.equal(v4Inbound.v4InteractionBrowserListResultSchema, legacy.acodeBrowserListResultSchema);
  assert.equal(v4Inbound.v4InteractionBrowserExecuteResultSchema, legacy.acodeBrowserExecuteResultSchema);
});

test("M2-4 CUA operation event discriminated union is point-equivalent to legacy (fail-closed)", () => {
  const base = { eventId: "e1", sequenceNumber: 1, sessionId: "sess-c", timestamp: 1735000000000 };
  for (const variant of [
    { ...base, kind: "turn-started", turnId: "t1" },
    { ...base, kind: "turn-completed", turnId: "t1" },
    { ...base, kind: "turn-failed", turnId: "t1" },
    { ...base, kind: "tool-scheduled", turnId: "t1", toolCallId: "c1", toolName: "computer", computerUse: true },
    { ...base, kind: "tool-started", toolCallId: "c1" },
    { ...base, kind: "session-closed" },
  ]) {
    assert.deepEqual(
      v4Inbound.v4CuaOperationEventSchema.parse(variant),
      legacy.acodeComputerUseOperationEventSchema.parse(variant),
      `kind=${variant.kind} 逐点等价`,
    );
  }
  // fail-closed：未知 kind / 缺字段两侧都拒绝。
  assert.equal(v4Inbound.v4CuaOperationEventSchema.safeParse({ ...base, kind: "bogus" }).success, false);
  assert.equal(
    v4Inbound.v4CuaOperationEventSchema.safeParse({ ...base, kind: "turn-started" }).success,
    false,
    "turn-started 必须带 turnId",
  );
  assert.equal(
    legacy.acodeComputerUseOperationEventSchema.safeParse({ ...base, kind: "turn-started" }).success,
    false,
  );
});

test("M2-4 inbound-interaction schema leaf has no reverse import into the legacy protocol barrel", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-v4/inbound-interaction.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /acode-protocol\/index(?:\.js|\.ts)?/,
    "inbound-interaction.ts 不得反向 import legacy barrel",
  );
});

// ── M2-7：automation/offPeak 七法 v4 化 ───────────────────────────────────────
const v4AutomationOffPeak = await import("../src/acode-protocol-v4/automation-offpeak.ts");

test("M2-7 v4 automation/offPeak method names land in V4_METHODS with v4/ prefix", () => {
  assert.deepEqual(
    {
      automationCreate: v4Transport.V4_METHODS.automationCreate,
      automationUpdate: v4Transport.V4_METHODS.automationUpdate,
      automationCheckTaskBinding: v4Transport.V4_METHODS.automationCheckTaskBinding,
      automationList: v4Transport.V4_METHODS.automationList,
      automationDelete: v4Transport.V4_METHODS.automationDelete,
      offPeakCreate: v4Transport.V4_METHODS.offPeakCreate,
      offPeakList: v4Transport.V4_METHODS.offPeakList,
    },
    {
      automationCreate: "v4/automation/create",
      automationUpdate: "v4/automation/update",
      automationCheckTaskBinding: "v4/automation/checkTaskBinding",
      automationList: "v4/automation/list",
      automationDelete: "v4/automation/delete",
      offPeakCreate: "v4/offPeak/create",
      offPeakList: "v4/offPeak/list",
    },
  );
});

test("M2-7 automation params parity with legacy barrel (refines included)", () => {
  const automationParamsPairs = [
    [
      legacy.acodeAutomationCreateParamsSchema,
      v4AutomationOffPeak.v4AutomationCreateParamsSchema,
      {
        title: "nightly",
        cronExpr: "0 2 * * *",
        prompt: "整理日报",
        recurring: true,
        maxRuns: 10,
      },
    ],
    [
      legacy.acodeAutomationCreateParamsSchema,
      v4AutomationOffPeak.v4AutomationCreateParamsSchema,
      {
        cronExpr: "0 * * * *",
        prompt: "每 50 小时巡检",
        intervalUnit: "hourly",
        interval: 50,
        targetTaskId: "task-1",
      },
    ],
    [
      legacy.acodeAutomationUpdateParamsSchema,
      v4AutomationOffPeak.v4AutomationUpdateParamsSchema,
      { automationId: "auto-1", title: "renamed", recurring: true },
    ],
    [
      legacy.acodeAutomationUpdateParamsSchema,
      v4AutomationOffPeak.v4AutomationUpdateParamsSchema,
      { automationId: "auto-1", maxRuns: null, recurring: true },
    ],
    [
      legacy.acodeAutomationCheckTaskBindingParamsSchema,
      v4AutomationOffPeak.v4AutomationCheckTaskBindingParamsSchema,
      { targetTaskId: "task-1" },
    ],
    [
      legacy.acodeAutomationDeleteParamsSchema,
      v4AutomationOffPeak.v4AutomationDeleteParamsSchema,
      { automationId: "auto-1" },
    ],
  ];
  for (const [legacySchema, v4Schema, payload] of automationParamsPairs) {
    const legacyParsed = legacySchema.safeParse(payload);
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 params：${JSON.stringify(payload)}`);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 params：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy params parse 产出必须逐字一致");
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
    assert.equal(legacySchema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
  }

  // create refine 逐字等价：intervalUnit/interval 必须配对。
  for (const schema of [
    legacy.acodeAutomationCreateParamsSchema,
    v4AutomationOffPeak.v4AutomationCreateParamsSchema,
  ]) {
    const base = { cronExpr: "0 * * * *", prompt: "p" };
    assert.equal(schema.safeParse({ ...base, intervalUnit: "hourly" }).success, false);
    assert.equal(schema.safeParse({ ...base, interval: 5 }).success, false);
    // 周期 carrier 与一次性相对延迟语义冲突。
    assert.equal(
      schema.safeParse({ ...base, intervalUnit: "hourly", interval: 5, relativeDelayMinutes: 30 }).success,
      false,
    );
    // 周期 carrier 不得配 recurring=false / maxRuns。
    assert.equal(
      schema.safeParse({ ...base, intervalUnit: "hourly", interval: 5, recurring: false }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...base, intervalUnit: "hourly", interval: 5, maxRuns: 3 }).success,
      false,
    );
  }

  // update refine 逐字等价：至少一个可改字段。
  for (const schema of [
    legacy.acodeAutomationUpdateParamsSchema,
    v4AutomationOffPeak.v4AutomationUpdateParamsSchema,
  ]) {
    assert.equal(schema.safeParse({ automationId: "auto-1" }).success, false);
    // 清 maxRuns 必须 recurring=true；recurring=true 不得配数值 maxRuns。
    assert.equal(schema.safeParse({ automationId: "auto-1", maxRuns: null }).success, false);
    assert.equal(
      schema.safeParse({ automationId: "auto-1", recurring: true, maxRuns: 5 }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ automationId: "auto-1", intervalUnit: "daily" }).success,
      false,
      "intervalUnit 不得单独出现（必须与 interval 配对）",
    );
  }

  // list params：两侧都是空对象严格面。
  for (const schema of [
    legacy.acodeAutomationListParamsSchema,
    v4AutomationOffPeak.v4AutomationListParamsSchema,
  ]) {
    assert.deepEqual(schema.parse({}), {});
    assert.equal(schema.safeParse({ stray: 1 }).success, false);
  }
});

test("M2-7 automation/offPeak result parity (full object incl. scheduleRule; offPeak union both arms)", () => {
  const automation = {
    automationId: "auto-1",
    title: "nightly",
    cronExpr: "0 * * * *",
    prompt: "整理日报",
    enabled: true,
    lifecycleStatus: "active",
    nextRunAt: 1_735_000_000_000,
    lastRunAt: 1_734_900_000_000,
    runCount: 3,
    recurring: true,
    maxRuns: 10,
    scheduleRule: {
      unit: "hourly",
      interval: 50,
      hour: 0,
      minute: 0,
      anchorAt: 1_734_900_000_000,
    },
  };
  const resultPairs = [
    [
      legacy.acodeAutomationCreateResultSchema,
      v4AutomationOffPeak.v4AutomationCreateResultSchema,
      { automation },
    ],
    [
      legacy.acodeAutomationUpdateResultSchema,
      v4AutomationOffPeak.v4AutomationUpdateResultSchema,
      { automation: { ...automation, title: "renamed", scheduleRule: undefined } },
    ],
    [
      legacy.acodeAutomationListResultSchema,
      v4AutomationOffPeak.v4AutomationListResultSchema,
      { automations: [automation] },
    ],
    [
      legacy.acodeAutomationCheckTaskBindingResultSchema,
      v4AutomationOffPeak.v4AutomationCheckTaskBindingResultSchema,
      { bound: true },
    ],
    [
      legacy.acodeAutomationDeleteResultSchema,
      v4AutomationOffPeak.v4AutomationDeleteResultSchema,
      { deleted: false },
    ],
  ];
  for (const [legacySchema, v4Schema, payload] of resultPairs) {
    const legacyParsed = legacySchema.safeParse(payload);
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "v4/legacy result parse 产出必须逐字一致");
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
    assert.equal(legacySchema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
  }

  // offPeak 判别联合两臂逐字等价。
  const offPeakPairs = [
    {
      ok: true,
      task: {
        offPeakTaskId: "op-1",
        title: "夜间批跑",
        status: "queued",
        queuePosition: 2,
        sessionId: "sess-op",
        createdAt: 1_735_000_000_000,
      },
    },
    {
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "model_not_allowed",
    },
    {
      ok: false,
      failureStage: "ticket_request",
      errorCategory: "quota_3103",
      errorCode: "quota_exhausted",
    },
  ];
  for (const payload of offPeakPairs) {
    const legacyParsed = legacy.acodeOffPeakCreateResultSchema.safeParse(payload);
    const v4Parsed = v4AutomationOffPeak.v4OffPeakCreateResultSchema.safeParse(payload);
    assert.equal(legacyParsed.success, true, `legacy 必须接受合法 offPeak result：${JSON.stringify(payload)}`);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 offPeak result：${JSON.stringify(payload)}`);
    assert.deepEqual(v4Parsed.data, legacyParsed.data, "offPeak 判别联合 parse 产出必须逐字一致");
  }

  // offPeak create params 与 list 面。
  const offPeakCreate = { title: "夜间批跑", prompt: "跑全量回归", permissionMode: "dontAsk", model: "glm-4.6" };
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakCreateParamsSchema.parse(offPeakCreate),
    legacy.acodeOffPeakCreateParamsSchema.parse(offPeakCreate),
  );
  assert.equal(
    v4AutomationOffPeak.v4OffPeakCreateParamsSchema.safeParse({ ...offPeakCreate, permissionMode: "auto" }).success,
    false,
    "permissionMode 只开放产品五档词表",
  );
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakListParamsSchema.parse({}),
    legacy.acodeOffPeakListParamsSchema.parse({}),
  );
  const offPeakListResult = {
    tasks: [
      { offPeakTaskId: "op-1", title: "夜间批跑", status: "running", createdAt: 1_735_000_000_000 },
    ],
  };
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakListResultSchema.parse(offPeakListResult),
    legacy.acodeOffPeakListResultSchema.parse(offPeakListResult),
  );
});

test("M2-7 automation-offpeak schema leaf has no reverse import into the legacy protocol barrel", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-v4/automation-offpeak.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /acode-protocol\/index(?:\.js|\.ts)?/,
    "automation-offpeak.ts 不得反向 import legacy barrel",
  );
});
