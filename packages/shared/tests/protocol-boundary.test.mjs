import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const shared = await import("../src/acode-protocol-shared.ts");
const sessionTypes = await import("../src/acode-session-types.ts");
const sessionProjection = await import("../src/acode-session-projection.ts");
const sessionEvents = await import("../src/acode-session-events.ts");
const v4 = await import("../src/acode-protocol-v4/command.ts");
const v4Transport = await import("../src/acode-protocol-v4/transport.ts");
const v4Inbound = await import("../src/acode-protocol-v4/inbound-interaction.ts");

const mcpServer = {
  name: "local",
  command: "node",
  args: ["server.mjs"],
  env: [],
};

test("neutral MCP/browser schema and v4 consume the same validation", () => {
  assert.equal(shared.acodeProtocolMcpServerSchema.safeParse(mcpServer).success, true);
  assert.equal(
    v4.commandPayloadSchemas.createSession.safeParse({
      workspaceId: "workspace-1",
      mcpServers: [mcpServer],
    }).success,
    true,
  );

  const ambient = { tabCount: 1, currentUrl: "https://example.test/" };
  assert.equal(shared.acodeBrowserAmbientContextSchema.safeParse(ambient).success, true);
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
  const legacyOnline = v4SessionReadwrite.v4SessionSubscribeParamsSchema.parse({
    sessionId: "session-1",
    deliveryKind: "desktop-continuous",
    afterSeq: 7,
    includeSnapshot: false,
  });
  const legacyReplayable = v4SessionReadwrite.v4SessionSubscribeParamsSchema.parse({
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
    sessionEvents.acodeSessionSubscribeResultSchema.safeParse(ack).success,
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
    [...sessionTypes.acodeSessionModeSchema.options].sort(),
    ["auto", "build", "dontAsk", "edit", "plan", "yolo"],
  );
  assert.deepEqual(
    [...v4.commandPayloadSchemas.switchCollaborationMode.shape.mode.options].sort(),
    [...sessionTypes.acodeSessionModeSchema.options].sort(),
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
    [...sessionProjection.acodeSessionPersistenceSchema.options].sort(),
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

test("v4 plugins params schemas are strict and shape-preserving", () => {
  const workspace = { workspacePath: "/repo", workspaceKey: "wk-1" };
  const parityPairs = [
    [v4Plugins.v4PluginsListParamsSchema, { workspace, configScope: "user" }],
    [v4Plugins.v4PluginsOverviewParamsSchema, { workspace }],
    [v4Plugins.v4PluginsDescribeParamsSchema, { workspace, pluginName: "p", marketplace: "m" }],
    [v4Plugins.v4PluginsValidateParamsSchema, { workspace, source: "gh:acode/p" }],
    [v4Plugins.v4PluginsReferenceCatalogParamsSchema, { workspace, sessionId: "s-1" }],
    [v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema, { workspace, stableId: "p@m", operationId: "op-1", clientMode: "desktop-continuous", deliveryKind: "web-remote-replayable" }],
    [v4Plugins.v4PluginsSetEnabledParamsSchema, { workspace, pluginId: "p@m", enabled: true, operationId: "op-1", scope: "workspace" }],
    [v4Plugins.v4PluginsMarketplaceAddParamsSchema, { workspace, source: "gh:acode/m", dryRun: true, operationId: "op-1" }],
    [v4Plugins.v4PluginsMarketplaceRemoveParamsSchema, { workspace, marketplace: "m" }],
    [v4Plugins.v4PluginsMarketplaceUpdateParamsSchema, { workspace, operationId: "op-1" }],
    [v4Plugins.v4PluginsInstallParamsSchema, { workspace, pluginName: "p", marketplace: "m", scope: "user", dryRun: false, operationId: "op-1" }],
    [v4Plugins.v4PluginsUninstallParamsSchema, { workspace, pluginId: "p@m", removeCache: true }],
    [v4Plugins.v4PluginsUpdateParamsSchema, { workspace, marketplace: "m" }],
    [v4Plugins.v4PluginsRestoreBuiltinParamsSchema, { workspace, pluginId: "p@m" }],
    [v4Plugins.v4PluginsConfigureParamsSchema, { workspace, pluginId: "p@m", options: { k: 1 }, clearOptionKeys: ["x"], scope: "user", dryRun: true }],
    [v4Plugins.v4PluginsResetConfigParamsSchema, { workspace, pluginId: "p@m", scope: "workspace" }],
  ];
  for (const [v4Schema, payload] of parityPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 payload：${JSON.stringify(payload)}`);
    // strict parity：未知键两侧同拒。
    const widened = { ...payload, unexpectedM2Probe: true };
    assert.equal(v4Schema.safeParse(widened).success, false, "v4 strict 必须拒未知键");
  }
  // workspace ref 缺 workspaceKey 两侧同拒（中性 schema 共用）。
  const noKey = { workspace: { workspacePath: "/repo" } };
  assert.equal(v4Plugins.v4PluginsListParamsSchema.safeParse(noKey).success, false);
});

test("v4 plugins result schemas are strict and shape-preserving", () => {
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
    [v4Plugins.v4PluginsListResultSchema, { plugins: [info], diagnostics: [diagnostic] }],
    [v4Plugins.v4PluginsOverviewResultSchema, { marketplaces: [marketplaceSummary], availablePlugins: [available], installedPlugins: [installed], restorableBuiltins: [], diagnostics: [], capability: { supported: true } }],
    [v4Plugins.v4PluginsDescribeResultSchema, { components: [{ kind: "mcp", items: [{ name: "srv" }] }], metadata: { version: "1.0.0" } }],
    [v4Plugins.v4PluginsValidateResultSchema, { ok: false, diagnostics: [diagnostic], compatibility: { runnable: ["skills"], diagnosticOnly: ["agents"], unsupported: ["mcpb"] } }],
    [v4Plugins.v4PluginsReferenceCatalogResultSchema, { authority: "session", plugins: [catalogEntry] }],
    [v4Plugins.v4PluginsSetEnabledResultSchema, { plugin: info, enabled: false }],
    [v4Plugins.v4PluginsMarketplaceMutationResultSchema, { marketplaces: [marketplaceSummary], diagnostics: [diagnostic] }],
    [v4Plugins.v4PluginsInstallResultSchema, { installedPlugins: [installed], dependencyClosure: ["p@m"], diagnostics: [] }],
    [v4Plugins.v4PluginsUninstallResultSchema, { removedPlugin: installed, diagnostics: [] }],
    [v4Plugins.v4PluginsRestoreBuiltinResultSchema, { pluginId: "p@m", diagnostics: [] }],
    [v4Plugins.v4PluginsConfigureResultSchema, { pluginId: "p@m", diagnostics: [diagnostic] }],
  ];
  for (const [v4Schema, payload] of resultPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload).slice(0, 80)}`);
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM2Probe: 1 }).success, false);
  }
  // catalog entry 的 subagentNames default([])：legacy barrel 已删，parity 改为对 v4
  // 自身的字面钉住——缺省补齐必须稳定为 []，不得变成 undefined 或抛错。
  const noSubagents = { ...catalogEntry };
  delete noSubagents.subagentNames;
  assert.deepEqual(v4Plugins.v4PluginReferenceCatalogEntrySchema.parse(noSubagents), {
    ...catalogEntry,
    subagentNames: [],
  });
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
  // acode-session-types 中立叶纪律：两叶只许引 acodeWorkspaceRefSchema。
  // M4 前该符号在 acode-protocol-legacy-types.ts（已随 barrel 删除）；本断言改指新家园，
  // 仍钉住「不得从该叶引白名单外符号」的原意。
  for (const leaf of ["plugins-queries.ts", "plugins-commands.ts"]) {
    const source = await readFile(
      new URL(`../src/acode-protocol-v4/${leaf}`, import.meta.url),
      "utf8",
    );
    const sessionTypesImport = source.match(
      /import \{([^}]*)\} from "\.\.\/acode-session-types\.js"/,
    );
    assert.ok(sessionTypesImport, `${leaf} 应从 acode-session-types 取 workspace ref`);
    assert.deepEqual(
      sessionTypesImport[1].split(",").map((name) => name.trim()),
      ["acodeWorkspaceRefSchema"],
      `${leaf} 不得从 acode-session-types 引白名单外符号`,
    );
  }
  // 本地再声明的 deliveryKind 值域与 legacy acodeDeliveryKindSchema 逐字一致。
  assert.deepEqual(
    v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema.shape.clientMode.options,
    [...sessionTypes.acodeDeliveryKindSchema.options],
    "v4 deliveryKind 本地再声明必须与 legacy 值域逐字一致",
  );
  assert.deepEqual(
    v4Plugins.v4PluginsResolveSuggestedReferenceParamsSchema.shape.deliveryKind.options,
    [...sessionTypes.acodeDeliveryKindSchema.options],
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

test("M2-6 workflows params schemas are strict and shape-preserving", () => {
  // M4 后 legacy barrel 已删，原先的「两侧 parity」对象不存在；本用例改为对 v4 自身的
  // 字面钉住：同一输入 parse 后形态不变（无隐式补值/丢键），且 strict 拒未知键。
  const paramPairs = [
    ["v4WorkflowsListParamsSchema", { workspace: m26Workspace }],
    ["v4WorkflowsListParamsSchema", { workspace: m26Workspace, scope: "global" }],
    ["v4WorkflowsGetParamsSchema", { workspace: m26Workspace, name: "daily" }],
    [
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
    ["v4WorkflowsDeleteParamsSchema", { workspace: m26Workspace, name: "daily", scope: "project" }],
    [
      "v4WorkflowsRunsParamsSchema",
      { workspace: m26Workspace, name: "daily", limit: 20, scope: "global" },
    ],
    ["v4WorkflowsMoveParamsSchema", { workspace: m26Workspace, name: "daily" }],
  ];
  for (const [v4Key, input] of paramPairs) {
    assert.deepEqual(v4Workflows[v4Key].parse(input), input, `${v4Key} parse 必须形态不变`);
    assert.equal(
      v4Workflows[v4Key].safeParse({ ...input, bogus: 1 }).success,
      false,
      `${v4Key} 必须拒绝未知键`,
    );
  }

  // runs limit 界：1/50 收，0/51/非整数拒。
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
  }
  assert.equal(v4Workflows.V4_WORKFLOWS_RUNS_MAX_LIMIT, 50);

  // result 六法：代表性 fixture parse 后形态不变。
  const resultPairs = [
    [
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
    ["v4WorkflowsGetResultSchema", { ok: false, reason: "not_found" }],
    [
      "v4WorkflowsUpdateMetaResultSchema",
      { ok: true, path: "F:/repo/.acode/workflows/daily.md" },
    ],
    ["v4WorkflowsDeleteResultSchema", { ok: false, reason: "parse_error", detail: "bad yaml" }],
    [
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
      "v4WorkflowsMoveResultSchema",
      { ok: true, from: "C:/Users/u/.acode/workflows/daily.md", to: "F:/repo/.acode/workflows/daily.md" },
    ],
    [
      "v4WorkflowsMoveResultSchema",
      { ok: false, reason: "target_exists", path: "F:/repo/.acode/workflows/daily.md" },
    ],
  ];
  for (const [v4Key, input] of resultPairs) {
    assert.deepEqual(v4Workflows[v4Key].parse(input), input, `${v4Key} parse 必须形态不变`);
  }

  // 失败/状态词表逐字钉住（词表是 wire 契约，漂移即红）。
  assert.deepEqual([...v4Workflows.v4SavedWorkflowFailureReasonSchema.options].sort(), [
    "invalid_name",
    "not_found",
    "parse_error",
    "read_error",
  ]);
  assert.deepEqual([...v4Workflows.v4SavedWorkflowRunStatusSchema.options].sort(), [
    "completed",
    "errored",
    "pending",
    "running",
    "stopped",
  ]);
  assert.deepEqual([...v4Workflows.v4SavedWorkflowRunStopReasonSchema.options].sort(), [
    "interrupted",
    "model",
    "provider",
    "superseded",
    "user",
  ]);
  assert.deepEqual([...v4Workflows.v4SavedWorkflowScopeSchema.options].sort(), [
    "global",
    "project",
  ]);
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

test("M2-6 skills referenceCatalog schemas are strict and shape-preserving", () => {
  // M4 后 legacy barrel 已删，parity 改为对 v4 自身形态的字面钉住。
  for (const input of [
    { workspace: m26Workspace },
    { workspace: m26Workspace, sessionId: "session-1" },
  ]) {
    assert.deepEqual(
      v4Skills.v4SkillsReferenceCatalogParamsSchema.parse(input),
      input,
      "params parse 必须形态不变",
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
    catalog,
    "result parse 必须形态不变",
  );
  // authority 词表逐字钉住；enabled 恒 true（literal）。
  assert.deepEqual(
    [...v4Skills.v4SkillsReferenceCatalogResultSchema.shape.authority.options].sort(),
    ["session", "workspace"],
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

test("M2-6 mcp list schemas are strict and shape-preserving", () => {
  // mode 缺省 connect（default 补齐是 wire 契约的一部分，必须逐字钉住）。
  const parsed = v4Mcp.v4McpListParamsSchema.parse({ workspace: m26Workspace });
  assert.deepEqual(parsed, { workspace: m26Workspace, mode: "connect" });
  for (const input of [
    { workspace: m26Workspace, mode: "status" },
    { workspace: m26Workspace, mcpServers: [mcpServer] },
    { workspace: m26Workspace, mcpServers: [mcpServer], mode: "connect" },
  ]) {
    assert.deepEqual(
      v4Mcp.v4McpListParamsSchema.parse(input),
      { ...input, mode: input.mode ?? "connect" },
      "params parse 除 mode 缺省补齐外形态不变",
    );
    assert.equal(
      v4Mcp.v4McpListParamsSchema.safeParse({ ...input, bogus: 1 }).success,
      false,
    );
  }
  // 状态快照：全字段 fixture parse 后形态不变；failure kind / status kind 词表逐字钉住。
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
    statuses,
    "result parse 必须形态不变",
  );
  assert.deepEqual([...v4Mcp.v4McpServerStatusKindSchema.options].sort(), [
    "connected",
    "connecting",
    "disabled",
    "disconnected",
    "failed",
    "untrusted",
  ]);
  assert.deepEqual([...v4Mcp.V4_MCP_SERVER_FAILURE_KINDS].sort(), [
    "coding_plan_required",
    "config_invalid",
    "connection_failed",
    "connection_timeout",
    "network_unreachable",
    "not_authenticated",
    "oauth_authorization_failed",
    "official_origin_untrusted",
    "process_start_failed",
    "protocol_error",
    "protocol_negotiation_failed",
    "rate_limited",
    "runtime_unavailable",
    "server_internal_error",
    "server_not_found",
    "server_unavailable",
    "status_unavailable",
    "tool_list_failed",
    "unexpected_disconnect",
  ]);
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

test("M2-8 params schemas are strict and shape-preserving", () => {
  const parityPairs = [
    [v4WorkspaceRuntime.v4WorkspaceReadPresentationParamsSchema,
      { workspace: m28Workspace },
    ],
    [v4WorkspacePolicies.v4WorkspaceHookTrustGrantParamsSchema,
      { workspace: m28Workspace, bundleDigest: m28Digest, hookDeclarationDigest: m28Digest },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateInteractionPreferencesParamsSchema,
      { workspace: m28Workspace, preferences: { askUserQuestionAutoResolutionEnabled: true } },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateModelIoPreferencesParamsSchema,
      { workspace: m28Workspace, preferences: { fullRetentionEnabled: false } },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateOffPeakToolPolicyParamsSchema,
      { workspace: m28Workspace, enabled: true },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateDynamicWorkflowPolicyParamsSchema,
      { workspace: m28Workspace, enabled: false },
    ],
    [
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
      v4WorkspaceRuntime.v4WorkspaceCancelGenerateTextParamsSchema,
      { operationId: "op-1" },
    ],
    [v4ProviderProcess.v4ProviderUpdateAccountConfigParamsSchema,
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
    [v4ProviderProcess.v4ProviderTestModelConnectivityParamsSchema,
      { workspace: m28Workspace, selection: m28Selection },
    ],
    [v4ProviderProcess.v4ProcessChildProcessesParamsSchema,
      {},
    ],
  ];
  for (const [v4Schema, payload] of parityPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 payload：${JSON.stringify(payload)}`);
    // strict parity：未知键两侧同拒。
    const widened = { ...payload, unexpectedM28Probe: true };
    assert.equal(v4Schema.safeParse(widened).success, false, "v4 strict 必须拒未知键");
  }
  // generateText refine parity：prompt/messages 至少其一，两侧同拒同收。
  const noPrompt = {
    workspace: m28Workspace,
    selection: m28Selection,
    querySource: "prompt-polish",
  };
  assert.equal(v4WorkspaceRuntime.v4WorkspaceGenerateTextParamsSchema.safeParse(noPrompt).success, false);
  assert.equal(v4WorkspaceRuntime.v4WorkspaceGenerateTextParamsSchema.safeParse(noPrompt).success, false);
  // hookTrust digest 正则 parity：非 64 位小写 hex 两侧同拒。
  const badDigest = { workspace: m28Workspace, bundleDigest: "zz", hookDeclarationDigest: m28Digest };
  assert.equal(v4WorkspacePolicies.v4WorkspaceHookTrustGrantParamsSchema.safeParse(badDigest).success, false);
  // workspace ref 缺 workspaceKey 两侧同拒（中性 schema 共用）。
  const noKey = { workspace: { workspacePath: "/repo" } };
  assert.equal(v4WorkspaceRuntime.v4WorkspaceReadPresentationParamsSchema.safeParse(noKey).success, false);
});

test("M2-8 result schemas are strict and shape-preserving", () => {
  const resultPairs = [
    [v4WorkspaceRuntime.v4WorkspacePresentationSchema,
      {
        workspace: m28Workspace,
        mode: "build",
        slashCommands: [
          { name: "review", description: "评审", inputHint: "[path]", source: "builtin" },
          { name: "x", description: "d" },
        ],
      },
    ],
    [v4WorkspacePolicies.v4WorkspaceHookTrustGrantResultSchema,
      { accepted: false, reasonCode: "workspace_hooks_policy_requires_pretrust" },
    ],
    [v4WorkspacePolicies.v4WorkspaceHookTrustGrantResultSchema,
      { accepted: true },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateInteractionPreferencesResultSchema,
      { workspace: m28Workspace, askUserQuestionAutoResolutionEnabled: true, snoozedInteractionCount: 2 },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateModelIoPreferencesResultSchema,
      { workspace: m28Workspace, fullRetentionEnabled: true, updatedSessionCount: 3 },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateOffPeakToolPolicyResultSchema,
      { workspace: m28Workspace, enabled: true },
    ],
    [v4WorkspacePolicies.v4WorkspaceUpdateDynamicWorkflowPolicyResultSchema,
      { workspace: m28Workspace, enabled: false },
    ],
    [v4WorkspaceRuntime.v4WorkspaceGenerateTextResultSchema,
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
    [v4WorkspaceRuntime.v4WorkspaceCancelGenerateTextResultSchema,
      { operationId: "op-1", cancelled: true },
    ],
    [v4ProviderProcess.v4ProviderUpdateAccountConfigResultSchema,
      { receivedRevision: "r-1", providerCount: 2, status: "received" },
    ],
    [v4ProviderProcess.v4ProviderTestModelConnectivityResultSchema,
      { success: true },
    ],
    [v4ProviderProcess.v4ProcessChildProcessesResultSchema,
      {
        processes: [
          { pid: 100, serverName: "mcp-1", mcpSource: "builtin", pluginName: "official" },
          { pid: 101, serverName: "mcp-2", mcpSource: "custom" },
        ],
      },
    ],
  ];
  for (const [v4Schema, payload] of resultPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM28Probe: true }).success, false);
  }
  // hookTrust reasonCode 词表逐字钉住（wire 契约，漂移即红）。
  assert.deepEqual(
    [...v4WorkspacePolicies.v4WorkspaceHookTrustGrantReasonCodeSchema.options].sort(),
    [
      "workspace_hooks_blocked_by_policy",
      "workspace_hooks_bundle_changed",
      "workspace_hooks_config_unreadable",
      "workspace_hooks_policy_requires_pretrust",
      "workspace_hooks_snapshot_mismatch",
      "workspace_hooks_trust_store_corrupt",
    ],
    "hookTrust reasonCode 词表漂移",
  );
  // sessionMode / slashCommand 是本地再声明件（v4 不反向 import legacy 面），值域逐字钉住。
  assert.deepEqual(
    [...v4WorkspaceRuntime.v4WorkspaceSessionModeSchema.options].sort(),
    [...sessionTypes.acodeSessionModeSchema.options].sort(),
    "v4 sessionMode 值域必须与中立 session-types 叶逐字一致",
  );
  const slash = { name: "review", description: "评审", inputHint: "[p]", source: "custom" };
  assert.deepEqual(
    v4WorkspaceRuntime.v4WorkspaceSlashCommandSchema.parse(slash),
    sessionProjection.acodeSlashCommandSchema.parse(slash),
    "v4 slashCommand 形状必须与中立 session-projection 叶逐字一致",
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

test("M2-3 v4 session params schemas are strict and shape-preserving", () => {
  // M4 后 legacy barrel 已删，原「v4/legacy 两侧 parity」的对象不复存在。这里改为：
  // ① v4 自身 parse 形态不变（strict，无隐式补值/丢键）；
  // ② 仍存在的中立叶（session-projection 的 acodeSessionListParamsSchema）与 v4 逐字 parity
  //    ——该叶是 M4 后 sessions/list params 的承重家园，漂移仍须红。
  const v4Only = [
    [v4SessionReadwrite.v4SessionReadParamsSchema, { sessionId: "s1" }],
    [
      v4SessionReadwrite.v4SessionReadParamsSchema,
      { sessionId: "s1", deliveryKind: "desktop-continuous", messageLimit: 50, afterSeq: 3 },
    ],
    [v4SessionReadwrite.v4SessionResumeParamsSchema, { sessionId: "s1" }],
    [
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
      v4SessionReadwrite.v4SessionMessagesParamsSchema,
      { sessionId: "s1", afterMessageId: "m1", limit: 20 },
    ],
    [v4SessionReadwrite.v4SessionEventsParamsSchema, { sessionId: "s1", afterSeq: 2, limit: 100 }],
    [
      v4SessionReadwrite.v4SessionSubscribeParamsSchema,
      {
        sessionId: "s1",
        deliveryKind: "web-remote-replayable",
        afterSeq: 1,
        includeSnapshot: true,
      },
    ],
  ];
  for (const [v4Schema, input] of v4Only) {
    assert.deepEqual(v4Schema.parse(input), input, `params parse 必须形态不变：${JSON.stringify(input)}`);
  }

  // sessions/list params：v4 与中立 session-projection 叶逐字 parity。
  const listParity = [
    { workspace: { workspacePath: "/w", workspaceKey: "wk" }, limit: 10 },
    { sessionIds: ["a", "b"], includeArchived: true },
  ];
  for (const input of listParity) {
    assert.deepEqual(
      v4SessionReadwrite.v4SessionsListParamsSchema.parse(input),
      sessionProjection.acodeSessionListParamsSchema.parse(input),
      `sessions/list params 必须与 session-projection 叶逐字一致：${JSON.stringify(input)}`,
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

test("M2-3 v4 sessions/list result schema is the normalized session-types sessionInfo", () => {
  // 注意同名歧义：历史 barrel 的 acodeSessionInfoSchema 是 opencode Session.Info 形状，
  // v4 wire 用的是 session-types 中立叶的规范化 sessionInfo（sessionId/workspace/
  // sessionKind/mode/status/createdAt/updatedAt）——与 M2-2 session-control 同一条约。
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
  const normalized = sessionTypes.acodeSessionInfoSchema.parse(sessionInfo);
  assert.deepEqual(
    v4SessionReadwrite.v4SessionsListResultSchema.parse({ sessions: [sessionInfo] }),
    { sessions: [normalized] },
    "sessions/list 结果面必须是 session-types 规范化 sessionInfo 数组",
  );
  // messages 刻意无 v4 result schema：op 直通 raw opencode MessageWithParts（info.id
  // 词汇），legacy services 对旧 barrel acodeSessionMessagesResultSchema 仅是孤儿 import
  // 从不校验——迁移 parity 即「不校验」。normalized 词汇只在 session/read snapshot 的
  // mapMessageWithParts 路径（spec §6 登记）。
  assert.equal(v4SessionReadwrite.v4SessionMessagesResultSchema, undefined);
  // read/resume/events/subscribe 的 result schema 刻意不自立：事件词汇 26 变体与
  // snapshot 闭合不复制，services 侧继续用中立 session-events 叶的 result schema 校验
  // （wire 形态逐字一致；居所 consolidation 已在 M4 完成，spec §2.6）。
  assert.equal(v4SessionReadwrite.v4SessionSubscribeResultSchema, undefined);
  assert.equal(typeof sessionEvents.acodeSessionSubscribeResultSchema.parse, "function");
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
// 纪律：六反向请求 + 两通知只换方法名/通知名，不换载荷。M4 删除 legacy barrel 后，
// 「两侧 parity」不再可测；改为逐字钉住 v4 wire 形态本身（合法载荷 parse 形态不变、
// strict 拒未知键、值域 fail-closed），以及 transport 登记的字面值。

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

test("M2-4 permission request params wire shape is strict and shape-preserving", () => {
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
    params,
    "合法载荷 parse 必须形态不变",
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

test("M2-4 userInput request params and response are strict and shape-preserving", () => {
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
    params,
    "params parse 必须形态不变",
  );
  const response = { action: "accept", content: { answer: "a" } };
  assert.deepEqual(
    v4Inbound.v4UserInputResponseSchema.parse(response),
    response,
    "response parse 必须形态不变",
  );
  // action 值域钉住。
  assert.equal(v4Inbound.v4UserInputResponseSchema.safeParse({ action: "bogus" }).success, false);
});

test("M2-4 providerRuntimeHeaders params/cancelled/response are strict and shape-preserving", () => {
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
    params,
    "params parse 必须形态不变",
  );
  const cancelled = { requestId: "req-3", sessionId: "sess-3", workspace: { workspacePath: "/w", workspaceKey: "w-key" } };
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersCancelledSchema.parse(cancelled),
    cancelled,
    "cancelled 通知 parse 必须形态不变",
  );
  const ok = { headersApplied: true, requestAuth: { apiKey: "sk-x" } };
  const fail = { headersApplied: false, errorMessage: "no auth" };
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersResponseSchema.parse(ok),
    ok,
    "ok 臂 parse 必须形态不变",
  );
  assert.deepEqual(
    v4Inbound.v4ProviderRuntimeHeadersResponseSchema.parse(fail),
    fail,
    "fail 臂 parse 必须形态不变",
  );
  // reason 值域钉住。
  assert.equal(
    v4Inbound.v4InteractionRequestProviderRuntimeHeadersParamsSchema.safeParse({ ...params, reason: "other" })
      .success,
    false,
  );
});

test("M2-4 officialMcp params/response are strict; failure reasons enumerable", () => {
  const params = {
    requestId: "req-4",
    workspace: { workspacePath: "/w", workspaceKey: "w-key" },
    pluginId: "plug-1",
    mcpKey: "key-1",
    targetOrigin: "https://api.example.test",
  };
  assert.deepEqual(
    v4Inbound.v4InteractionRequestOfficialMcpAuthHeadersParamsSchema.parse(params),
    params,
    "params parse 必须形态不变",
  );
  const okResp = { ok: true, headers: { Authorization: "Bearer x" } };
  const failResp = { ok: false, reason: "official_auth_unavailable" };
  assert.deepEqual(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.parse(okResp),
    okResp,
    "ok 臂 parse 必须形态不变",
  );
  assert.deepEqual(
    v4Inbound.v4OfficialMcpAuthHeadersResponseSchema.parse(failResp),
    failResp,
    "fail 臂 parse 必须形态不变",
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

test("M2-4 browserList/browserExecute params are strict and shape-preserving", () => {
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
    listParams,
    "browserList params parse 必须形态不变",
  );
  const executeParams = {
    requestId: "req-6",
    sessionId: "sess-6",
    command: { method: "turnEnded", turnId: "turn-6" },
  };
  assert.deepEqual(
    v4Inbound.v4InteractionBrowserExecuteParamsSchema.parse(executeParams),
    executeParams,
    "browserExecute params parse 必须形态不变",
  );
  // strict：未知键拒绝。
  assert.equal(
    v4Inbound.v4InteractionBrowserListParamsSchema.safeParse({ ...listParams, bogus: 1 }).success,
    false,
  );
  assert.equal(
    v4Inbound.v4InteractionBrowserExecuteParamsSchema.safeParse({ ...executeParams, bogus: 1 })
      .success,
    false,
  );
});

test("M2-4 CUA operation event discriminated union is shape-preserving (fail-closed)", () => {
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
      variant,
      `kind=${variant.kind} parse 必须形态不变`,
    );
  }
  // fail-closed：未知 kind / 缺字段都拒绝。
  assert.equal(v4Inbound.v4CuaOperationEventSchema.safeParse({ ...base, kind: "bogus" }).success, false);
  assert.equal(
    v4Inbound.v4CuaOperationEventSchema.safeParse({ ...base, kind: "turn-started" }).success,
    false,
    "turn-started 必须带 turnId",
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

test("M2-7 automation params are strict; refines preserved", () => {
  const automationParamsPairs = [
    [
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
      v4AutomationOffPeak.v4AutomationUpdateParamsSchema,
      { automationId: "auto-1", title: "renamed", recurring: true },
    ],
    [
      v4AutomationOffPeak.v4AutomationUpdateParamsSchema,
      { automationId: "auto-1", maxRuns: null, recurring: true },
    ],
    [
      v4AutomationOffPeak.v4AutomationCheckTaskBindingParamsSchema,
      { targetTaskId: "task-1" },
    ],
    [
      v4AutomationOffPeak.v4AutomationDeleteParamsSchema,
      { automationId: "auto-1" },
    ],
  ];
  for (const [v4Schema, payload] of automationParamsPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 params：${JSON.stringify(payload)}`);
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
  }

  // create refine 逐字等价：intervalUnit/interval 必须配对。
  for (const schema of [
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
      v4AutomationOffPeak.v4AutomationCreateResultSchema,
      { automation },
    ],
    [
      v4AutomationOffPeak.v4AutomationUpdateResultSchema,
      { automation: { ...automation, title: "renamed", scheduleRule: undefined } },
    ],
    [
      v4AutomationOffPeak.v4AutomationListResultSchema,
      { automations: [automation] },
    ],
    [v4AutomationOffPeak.v4AutomationCheckTaskBindingResultSchema,
      { bound: true },
    ],
    [
      v4AutomationOffPeak.v4AutomationDeleteResultSchema,
      { deleted: false },
    ],
  ];
  for (const [v4Schema, payload] of resultPairs) {
    const v4Parsed = v4Schema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 result：${JSON.stringify(payload)}`);
    assert.equal(v4Schema.safeParse({ ...payload, unexpectedM27Probe: true }).success, false);
  }

  // offPeak 判别联合两臂：合法载荷必须被接受（M4 后不再与 legacy 对拍，改为 v4 自身断言）。
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
    const v4Parsed = v4AutomationOffPeak.v4OffPeakCreateResultSchema.safeParse(payload);
    assert.equal(v4Parsed.success, true, `v4 必须接受合法 offPeak result：${JSON.stringify(payload)}`);
  }

  // offPeak create params 与 list 面。
  const offPeakCreate = { title: "夜间批跑", prompt: "跑全量回归", permissionMode: "dontAsk", model: "glm-4.6" };
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakCreateParamsSchema.parse(offPeakCreate),
    offPeakCreate,
    "offPeak create params parse 必须形态不变",
  );
  assert.equal(
    v4AutomationOffPeak.v4OffPeakCreateParamsSchema.safeParse({ ...offPeakCreate, permissionMode: "auto" }).success,
    false,
    "permissionMode 只开放产品五档词表",
  );
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakListParamsSchema.parse({}),
    {},
    "offPeak list params 是空严格对象",
  );
  const offPeakListResult = {
    tasks: [
      { offPeakTaskId: "op-1", title: "夜间批跑", status: "running", createdAt: 1_735_000_000_000 },
    ],
  };
  assert.deepEqual(
    v4AutomationOffPeak.v4OffPeakListResultSchema.parse(offPeakListResult),
    offPeakListResult,
    "offPeak list result parse 必须形态不变",
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

// ── M4a：legacy barrel 终态（spec apps/acode-cli/specs/m4-shared-barrel-removal.md §0）──
// barrel 与 legacy-types 已整删；承重面收编为一组有意命名的中立模块，幸存/偏斜 wire 词
// 收敛到两个最小登记模块。以下用例把「删除」与「收编」两个方向都钉住，防回流。

test("M4a: legacy protocol barrel and legacy-types are gone", () => {
  assert.equal(existsSync(new URL("../src/acode-protocol/index.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/acode-protocol", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/acode-protocol-legacy-types.ts", import.meta.url)), false);
});

test("M4a: root entry no longer re-exports the barrel; survivors/skew exposed directly", async () => {
  const root = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(root, /acode-protocol\/index\.js/);
  assert.doesNotMatch(root, /acode-protocol-legacy-types\.js/);
  assert.match(root, /export \* from "\.\/acode-protocol-legacy-survivors\.js";/);
  assert.match(root, /export \* from "\.\/acode-protocol-legacy-skew\.js";/);
  assert.match(root, /export \* from "\.\/acode-protocol-envelope\.js";/);
});

test("M4a: survivor and skew modules exist and carry their registration header", async () => {
  for (const [file, marker] of [
    ["../src/acode-protocol-legacy-survivors.ts", /M3 幸存三词的最小登记模块/],
    ["../src/acode-protocol-legacy-skew.ts", /M3 遗留偏斜面/],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, marker, `${file} 头部必须保留登记裁决依据`);
  }
  // 幸存三词只许出现在 survivor 模块的登记表里（wire 字面量收敛到唯一登记点）。
  const survivors = await import("../src/acode-protocol-legacy-survivors.ts");
  assert.deepEqual(survivors.LEGACY_SURVIVOR_METHODS, {
    sessionSubagents: "session/subagents",
    sessionSend: "session/send",
    pluginsCancelOperation: "plugins/cancelOperation",
  });
});

test("M4a: v4 surface contains no survivor or legacy notification wire word", async () => {
  const survivors = await import("../src/acode-protocol-legacy-survivors.ts");
  const skew = await import("../src/acode-protocol-legacy-skew.ts");
  const v4MethodValues = new Set(Object.values(v4Transport.V4_METHODS));
  const v4NotificationValues = new Set(Object.values(v4Transport.V4_NOTIFICATIONS));
  for (const word of Object.values(survivors.LEGACY_SURVIVOR_METHODS)) {
    assert.equal(v4MethodValues.has(word), false, `v4 方法面不得出现幸存词 ${word}`);
    assert.equal(v4NotificationValues.has(word), false, `v4 通知面不得出现幸存词 ${word}`);
  }
  for (const word of Object.values(skew.LEGACY_NOTIFICATIONS)) {
    assert.equal(v4NotificationValues.has(word), false, `v4 通知面不得出现 legacy 通知词 ${word}`);
  }
  // 偏斜回落词在 v4 已有 v4/ 前缀等价物：legacy 字面量只许作为回落备选，不得进 v4 表。
  for (const word of Object.values(skew.LEGACY_SKEW_FALLBACK_METHODS)) {
    assert.equal(v4MethodValues.has(word), false, `v4 方法面不得出现偏斜回落词 ${word}`);
  }
});

test("M4a: envelope module carries the version-agnostic JSON-RPC wire family", async () => {
  // 裁决 E：NDJSON 信封是永久 wire 载体面（非 legacy 债务），迁入有意命名的中立模块。
  const envelope = await import("../src/acode-protocol-envelope.ts");
  for (const name of [
    "acodeProtocolRequestSchema",
    "acodeProtocolNotificationSchema",
    "acodeProtocolResponseSchema",
    "acodeProtocolErrorSchema",
    "acodeProtocolMessageSchema",
  ]) {
    assert.equal(typeof envelope[name]?.safeParse, "function", `envelope 必须导出 ${name}`);
  }
  assert.equal(envelope.ACODE_PROTOCOL_NAME, "ACode Protocol");
  assert.equal(envelope.ACODE_PROTOCOL_VERSION, 1);
});

test("M4a: no source file imports the deleted barrel path", async () => {
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        await walk(full);
      } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) {
        const source = await readFile(full, "utf8");
        if (/from\s+"[^"]*acode-protocol\/index(?:\.js)?"/.test(source)) offenders.push(full);
      }
    }
  };
  await walk(fileURLToPath(new URL("../src", import.meta.url)));
  assert.deepEqual(offenders, [], `仍有文件 import 已删除的 legacy barrel：${offenders.join(", ")}`);
});
