import assert from "node:assert/strict";
import test from "node:test";
import type {
  SettingsSyncAgentSummary,
  SettingsSyncCategorySummary,
  SettingsSyncImportResult,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceSkillSummary,
  SettingsSyncTaskImportResult,
} from "@acode/shared";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";
import {
  IMPORT_MODE_ORDER,
  SOURCE_ROOT_SCOPE_ORDER,
  buildExternalAgentImportSelections,
  formatAgentName,
  formatSourceRootScope,
  getImportResults,
  getResourceCategory,
  getResourceSelectionKey,
  getSourceRootItems,
  getSourceRoots,
  getSourceSelectionKey,
  groupAgentsBySourceRootScope,
  inferSourceRootScope,
  normalizeError,
  normalizePathForScope,
  readResourceSelectionKey,
} from "../src/settings/external-agent-import/importModel.js";

/**
 * ExternalAgentImportDialog 批次 4 helper 外迁的接缝内决策表单测（split-plan「settings 上帝组件
 * 拆分计划」批次 4，对照 automationsNavigationModel.test.ts 形态）。覆盖 importModel 全部导出
 * 的分支矩阵：选择 key round-trip 与畸形 key、selection 分组、结果提取、错误归一化、
 * scope 推断、sourceRoots 回退与分组排序、intl 文案 id。
 */

const intlStub = {
  formatMessage: (descriptor: { id: string }) => descriptor.id,
} as IntlInstance;

function makeSkillItem(
  overrides: Partial<SettingsSyncSourceSkillSummary> = {},
): SettingsSyncSourceSkillSummary {
  return {
    name: "demo-skill",
    path: "/root/skills/demo",
    importable: true,
    ...overrides,
  };
}

function makeSourceRoot(
  overrides: Partial<SettingsSyncSourceRootSummary> = {},
): SettingsSyncSourceRootSummary {
  return {
    scope: "global",
    path: "/root",
    discoveredCount: 1,
    importableCount: 1,
    skills: [makeSkillItem()],
    ...overrides,
  };
}

function makeCategorySummary(
  overrides: Partial<SettingsSyncCategorySummary> = {},
): SettingsSyncCategorySummary {
  return {
    category: "skills",
    discoveredCount: 1,
    importableCount: 1,
    selectedByDefault: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<SettingsSyncAgentSummary> = {}): SettingsSyncAgentSummary {
  return {
    agent: "claudeCode",
    discovered: true,
    categories: [makeCategorySummary()],
    ...overrides,
  };
}

function makeTaskResult(
  overrides: Partial<SettingsSyncTaskImportResult> = {},
): SettingsSyncTaskImportResult {
  return {
    agent: "claudeCode",
    category: "skills",
    status: "success",
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

function makeImportResult(taskResults: SettingsSyncTaskImportResult[]): SettingsSyncImportResult {
  return { successCount: 0, skippedCount: 0, failedCount: 0, taskResults };
}

test("source selection key：带 scope 三段、不带 scope 两段", () => {
  assert.equal(getSourceSelectionKey("claudeCode", "skills", "global"), "claudeCode:skills:global");
  assert.equal(getSourceSelectionKey("claudeCode", "skills"), "claudeCode:skills");
  assert.equal(getSourceSelectionKey("codexCli", "mcpServers", "project"), "codexCli:mcpServers:project");
});

test("resource selection key round-trip：写入读出载荷等价（含/不含 scope）", () => {
  const withScope = {
    agent: "claudeCode",
    category: "skills" as const,
    sourceScope: "project" as const,
    resourcePath: "/ws/.claude/skills/a",
  };
  assert.deepEqual(readResourceSelectionKey(getResourceSelectionKey(withScope)), withScope);
  const withoutScope = {
    agent: "codexCli",
    category: "commands" as const,
    resourcePath: "/home/u/.codex/commands/b",
  };
  assert.deepEqual(readResourceSelectionKey(getResourceSelectionKey(withoutScope)), withoutScope);
});

test("resource selection key 畸形矩阵：非 JSON/缺字段/类型错误/JSON null/数组均返回 null", () => {
  const malformed = [
    "not-json",
    "{broken",
    JSON.stringify({ category: "skills", resourcePath: "/a" }),
    JSON.stringify({ agent: "claudeCode", resourcePath: "/a" }),
    JSON.stringify({ agent: "claudeCode", category: "skills" }),
    JSON.stringify({ agent: 1, category: "skills", resourcePath: "/a" }),
    "null",
    JSON.stringify(["claudeCode", "skills", "/a"]),
  ];
  for (const key of malformed) {
    assert.equal(readResourceSelectionKey(key), null, key);
  }
});

test("buildExternalAgentImportSelections：同 agent+category+scope 归组，target/mode 逐一落地", () => {
  const keys = [
    getResourceSelectionKey({
      agent: "claudeCode",
      category: "skills",
      sourceScope: "global",
      resourcePath: "/a/one",
    }),
    getResourceSelectionKey({
      agent: "claudeCode",
      category: "skills",
      sourceScope: "global",
      resourcePath: "/a/two",
    }),
  ];
  assert.deepEqual(buildExternalAgentImportSelections(keys, "project", "copy"), [
    {
      agent: "claudeCode",
      category: "skills",
      sourceScope: "global",
      targetScope: "project",
      importMode: "copy",
      skillPaths: ["/a/one", "/a/two"],
    },
  ]);
});

test("buildExternalAgentImportSelections：scope/agent 不同则拆组；四类 category 各落各的路径数组", () => {
  const keys = [
    getResourceSelectionKey({ agent: "claudeCode", category: "skills", resourcePath: "/s" }),
    getResourceSelectionKey({
      agent: "claudeCode",
      category: "skills",
      sourceScope: "project",
      resourcePath: "/sp",
    }),
    getResourceSelectionKey({ agent: "codexCli", category: "commands", resourcePath: "/c" }),
    getResourceSelectionKey({ agent: "openCode", category: "plugins", resourcePath: "/p" }),
    getResourceSelectionKey({ agent: "goose", category: "mcpServers", resourcePath: "/m" }),
    "not-json",
  ];
  const selections = buildExternalAgentImportSelections(keys, "global", "symlink");
  assert.deepEqual(selections, [
    {
      agent: "claudeCode",
      category: "skills",
      targetScope: "global",
      importMode: "symlink",
      skillPaths: ["/s"],
    },
    {
      agent: "claudeCode",
      category: "skills",
      sourceScope: "project",
      targetScope: "global",
      importMode: "symlink",
      skillPaths: ["/sp"],
    },
    {
      agent: "codexCli",
      category: "commands",
      targetScope: "global",
      importMode: "symlink",
      commandPaths: ["/c"],
    },
    {
      agent: "openCode",
      category: "plugins",
      targetScope: "global",
      importMode: "symlink",
      pluginPaths: ["/p"],
    },
    {
      agent: "goose",
      category: "mcpServers",
      targetScope: "global",
      importMode: "symlink",
      mcpServerPaths: ["/m"],
    },
  ]);
  assert.deepEqual(buildExternalAgentImportSelections([], "global", "symlink"), []);
});

test("getImportResults：null 与缺失数组回退空；按 category 提取并跨 task 拍平", () => {
  assert.deepEqual(getImportResults(null, "skills"), []);
  assert.deepEqual(getImportResults(makeImportResult([makeTaskResult()]), "skills"), []);
  const skillResult = {
    name: "s",
    path: "/s",
    sourceScope: "global" as const,
    status: "imported" as const,
  };
  const commandResult = {
    name: "c",
    path: "/c",
    sourceScope: "project" as const,
    status: "skipped" as const,
  };
  const pluginResult = {
    name: "p",
    path: "/p",
    sourceScope: "global" as const,
    status: "failed" as const,
  };
  const mcpResult = {
    name: "m",
    path: "/m",
    sourceScope: "global" as const,
    status: "imported" as const,
  };
  const result = makeImportResult([
    makeTaskResult({
      skillResults: [skillResult],
      commandResults: [commandResult],
      pluginResults: [pluginResult],
      mcpServerResults: [mcpResult],
    }),
    makeTaskResult({ skillResults: [{ ...skillResult, name: "s2", path: "/s2" }] }),
  ]);
  assert.deepEqual(getImportResults(result, "skills"), [
    skillResult,
    { ...skillResult, name: "s2", path: "/s2" },
  ]);
  assert.deepEqual(getImportResults(result, "commands"), [commandResult]);
  assert.deepEqual(getImportResults(result, "plugins"), [pluginResult]);
  assert.deepEqual(getImportResults(result, "mcpServers"), [mcpResult]);
});

test("normalizeError：Error 取 message，非 Error 走 String", () => {
  assert.equal(normalizeError(new Error("boom")), "boom");
  assert.equal(normalizeError("plain"), "plain");
  assert.equal(normalizeError(42), "42");
});

test("normalizePathForScope：反斜杠归一为正斜杠，尾部斜杠剥掉", () => {
  assert.equal(normalizePathForScope("C:\\ws\\proj\\"), "C:/ws/proj");
  assert.equal(normalizePathForScope("/a/b//"), "/a/b");
  assert.equal(normalizePathForScope("/a/b"), "/a/b");
});

test("inferSourceRootScope：无 workspace 恒 global；等于/位于 workspace 下为 project，其余 global", () => {
  assert.equal(inferSourceRootScope("/any", null), "global");
  assert.equal(inferSourceRootScope("/any", undefined), "global");
  assert.equal(inferSourceRootScope("/any", ""), "global");
  assert.equal(inferSourceRootScope("/ws", "/ws/"), "project");
  assert.equal(inferSourceRootScope("/ws/.claude/skills", "/ws"), "project");
  assert.equal(inferSourceRootScope("C:\\ws\\proj", "C:/ws"), "project");
  assert.equal(inferSourceRootScope("/ws-other", "/ws"), "global");
  assert.equal(inferSourceRootScope("/home/u/.claude", "/ws"), "global");
});

test("getResourceCategory/getSourceRootItems：按 category 命中，缺失回退空数组", () => {
  const agent = makeAgent({
    categories: [makeCategorySummary({ category: "commands", importableCount: 3 })],
  });
  assert.equal(getResourceCategory(agent, "commands")?.importableCount, 3);
  assert.equal(getResourceCategory(agent, "skills"), undefined);
  const root = makeSourceRoot({ skills: undefined, commands: undefined, plugins: undefined });
  assert.deepEqual(getSourceRootItems(root, "skills"), []);
  assert.deepEqual(getSourceRootItems(root, "commands"), []);
  assert.deepEqual(getSourceRootItems(root, "plugins"), []);
  const mcp = { name: "srv", path: "/m", importable: true };
  assert.deepEqual(getSourceRootItems(makeSourceRoot({ mcpServers: [mcp] }), "mcpServers"), [mcp]);
  assert.deepEqual(getSourceRootItems(makeSourceRoot(), "skills"), [makeSkillItem()]);
});

test("getSourceRoots：无 category 空；有 sourceRoots 原样返回；否则 sourcePaths 回退并推断 scope", () => {
  assert.deepEqual(getSourceRoots(makeAgent({ categories: [] }), "/ws", "skills"), []);
  const roots = [makeSourceRoot({ scope: "project", path: "/ws/.claude" })];
  const withRoots = makeAgent({
    categories: [makeCategorySummary({ sourceRoots: roots, sourcePaths: ["/ignored"] })],
  });
  assert.equal(getSourceRoots(withRoots, "/ws", "skills"), roots);
  const fallback = makeAgent({
    categories: [
      makeCategorySummary({
        discoveredCount: 4,
        importableCount: 2,
        skippedCount: 1,
        sourcePaths: ["/ws/.claude", "/home/u/.claude"],
      }),
    ],
  });
  assert.deepEqual(getSourceRoots(fallback, "/ws", "skills"), [
    {
      scope: "project",
      path: "/ws/.claude",
      discoveredCount: 4,
      importableCount: 2,
      skippedCount: 1,
    },
    {
      scope: "global",
      path: "/home/u/.claude",
      discoveredCount: 4,
      importableCount: 2,
      skippedCount: 1,
    },
  ]);
  // sourceRoots 为空数组同样走 sourcePaths 回退。
  const emptyRoots = makeAgent({
    categories: [makeCategorySummary({ sourceRoots: [], sourcePaths: ["/home/u/.claude"] })],
  });
  assert.deepEqual(
    getSourceRoots(emptyRoots, "/ws", "skills").map((root) => root.scope),
    ["global"],
  );
});

test("groupAgentsBySourceRootScope：global 组恒在 project 前；无可导入项的 root 被过滤", () => {
  assert.deepEqual(SOURCE_ROOT_SCOPE_ORDER, ["global", "project"]);
  assert.deepEqual(IMPORT_MODE_ORDER, ["symlink", "copy"]);
  const projectRoot = makeSourceRoot({ scope: "project", path: "/ws/.claude" });
  const globalRoot = makeSourceRoot({ scope: "global", path: "/home/u/.claude" });
  const emptyRoot = makeSourceRoot({
    scope: "global",
    path: "/opt/empty",
    skills: [makeSkillItem({ importable: false })],
  });
  const agent = makeAgent({
    categories: [makeCategorySummary({ sourceRoots: [projectRoot, globalRoot, emptyRoot] })],
  });
  const groups = groupAgentsBySourceRootScope([agent], "/ws", "skills");
  assert.deepEqual(
    groups.map((group) => group.scope),
    ["global", "project"],
  );
  assert.deepEqual(
    groups[0]?.rows.map((row) => row.sourceRoot.path),
    ["/home/u/.claude"],
  );
  assert.deepEqual(
    groups[1]?.rows.map((row) => row.sourceRoot.path),
    ["/ws/.claude"],
  );
  assert.equal(groups[0]?.rows[0]?.agent, agent);
});

test("formatAgentName/formatSourceRootScope：已知 agent 走 intl id，未知原样返回；scope id 带 category", () => {
  assert.equal(formatAgentName("claudeCode", intlStub), "settingsSync.agent.claudeCode");
  assert.equal(formatAgentName("acode", intlStub), "settingsSync.agent.acode");
  assert.equal(formatAgentName("someNewAgent", intlStub), "someNewAgent");
  assert.equal(
    formatSourceRootScope("global", intlStub, "skills"),
    "settings.skills.import.scope.global",
  );
  assert.equal(
    formatSourceRootScope("project", intlStub, "mcpServers"),
    "settings.mcpServers.import.scope.project",
  );
});
