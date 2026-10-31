/**
 * ExternalAgentImportDialog 的纯决策模型（上帝组件批次 4 helper 外迁）：
 * 选择 key 编码/解码、selection 构建、错误归一化、导入结果提取、
 * agent/scope 文案、sourceRoot 推断与按 scope 分组。
 * 迁移依据：settings 上帝组件拆分批次 4 —— 以下类型/常量/函数体逐字自
 * settings/ExternalAgentImportDialog.tsx 迁入，仅追加 export 并收敛 import。
 */
import type {
  SettingsSyncAgentSummary,
  SettingsSyncCategory,
  SettingsSyncCommandImportResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
  SettingsSyncImportMode,
  SettingsSyncMcpServerImportResult,
  SettingsSyncSourceMcpServerSummary,
  SettingsSyncPluginImportResult,
  SettingsSyncSkillImportResult,
  SettingsSyncSourceCommandSummary,
  SettingsSyncSourcePluginSummary,
  SettingsSyncSourceSkillSummary,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceScope,
} from "@acode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

export type ImportResourceCategory = Extract<
  SettingsSyncCategory,
  "skills" | "commands" | "plugins" | "mcpServers"
>;
export type ImportItemSummary =
  | SettingsSyncSourceSkillSummary
  | SettingsSyncSourceCommandSummary
  | SettingsSyncSourcePluginSummary
  | SettingsSyncSourceMcpServerSummary;
export type ImportItemResult =
  | SettingsSyncSkillImportResult
  | SettingsSyncCommandImportResult
  | SettingsSyncPluginImportResult
  | SettingsSyncMcpServerImportResult;

export interface ResourceSelectionKeyPayload {
  agent: string;
  category: ImportResourceCategory;
  sourceScope?: SettingsSyncSourceScope;
  resourcePath: string;
}

export function getSourceSelectionKey(
  agent: string,
  category: string,
  sourceScope?: SettingsSyncSourceScope,
): string {
  return sourceScope ? `${agent}:${category}:${sourceScope}` : `${agent}:${category}`;
}

export function getResourceSelectionKey(payload: ResourceSelectionKeyPayload): string {
  return JSON.stringify(payload);
}

export function readResourceSelectionKey(key: string): ResourceSelectionKeyPayload | null {
  try {
    const payload = JSON.parse(key) as Partial<ResourceSelectionKeyPayload>;
    if (
      typeof payload.agent !== "string" ||
      typeof payload.category !== "string" ||
      typeof payload.resourcePath !== "string"
    ) {
      return null;
    }
    return {
      agent: payload.agent,
      category: payload.category as ImportResourceCategory,
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      resourcePath: payload.resourcePath,
    };
  } catch {
    return null;
  }
}

export function buildExternalAgentImportSelections(
  selectedKeys: string[],
  targetScope: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode,
): SettingsSyncSelection[] {
  const grouped = new Map<string, SettingsSyncSelection>();
  for (const key of selectedKeys) {
    const payload = readResourceSelectionKey(key);
    if (!payload) {
      continue;
    }
    const groupKey = JSON.stringify([payload.agent, payload.category, payload.sourceScope ?? null]);
    const selection = grouped.get(groupKey) ?? {
      agent: payload.agent as SettingsSyncSelection["agent"],
      category: payload.category as SettingsSyncSelection["category"],
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      targetScope,
      importMode,
      ...(payload.category === "skills"
        ? { skillPaths: [] }
        : payload.category === "commands"
          ? { commandPaths: [] }
          : payload.category === "plugins"
            ? { pluginPaths: [] }
            : { mcpServerPaths: [] }),
    };
    if (payload.category === "skills") {
      selection.skillPaths = [...(selection.skillPaths ?? []), payload.resourcePath];
    } else if (payload.category === "commands") {
      selection.commandPaths = [...(selection.commandPaths ?? []), payload.resourcePath];
    } else if (payload.category === "plugins") {
      selection.pluginPaths = [...(selection.pluginPaths ?? []), payload.resourcePath];
    } else {
      selection.mcpServerPaths = [...(selection.mcpServerPaths ?? []), payload.resourcePath];
    }
    grouped.set(groupKey, selection);
  }
  return [...grouped.values()];
}

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getImportResults(
  result: SettingsSyncImportResult | null,
  category: ImportResourceCategory,
): ImportItemResult[] {
  return (
    result?.taskResults.flatMap((taskResult) =>
      category === "skills"
        ? (taskResult.skillResults ?? [])
        : category === "commands"
          ? (taskResult.commandResults ?? [])
          : category === "plugins"
            ? (taskResult.pluginResults ?? [])
            : (taskResult.mcpServerResults ?? []),
    ) ?? []
  );
}

export function formatAgentName(agent: string, intl: IntlInstance): string {
  switch (agent) {
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "openClaw":
      return intl.formatMessage({ id: "settingsSync.agent.openClaw" });
    case "augment":
      return intl.formatMessage({ id: "settingsSync.agent.augment" });
    case "continue":
      return intl.formatMessage({ id: "settingsSync.agent.continue" });
    case "goose":
      return intl.formatMessage({ id: "settingsSync.agent.goose" });
    case "qwenCode":
      return intl.formatMessage({ id: "settingsSync.agent.qwenCode" });
    case "qode":
      return intl.formatMessage({ id: "settingsSync.agent.qode" });
    case "qodeCn":
      return intl.formatMessage({ id: "settingsSync.agent.qodeCn" });
    case "windsurf":
      return intl.formatMessage({ id: "settingsSync.agent.windsurf" });
    case "trae":
      return intl.formatMessage({ id: "settingsSync.agent.trae" });
    case "traeCn":
      return intl.formatMessage({ id: "settingsSync.agent.traeCn" });
    case "kiroCli":
      return intl.formatMessage({ id: "settingsSync.agent.kiroCli" });
    case "roo":
      return intl.formatMessage({ id: "settingsSync.agent.roo" });
    case "codeBuddy":
      return intl.formatMessage({ id: "settingsSync.agent.codeBuddy" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    case "acode":
      return intl.formatMessage({ id: "settingsSync.agent.acode" });
    default:
      return agent;
  }
}

export function getResourceCategory(
  agent: SettingsSyncAgentSummary,
  resourceCategory: ImportResourceCategory,
) {
  return agent.categories.find((category) => category.category === resourceCategory);
}

export const SOURCE_ROOT_SCOPE_ORDER: SettingsSyncSourceScope[] = ["global", "project"];
export const IMPORT_MODE_ORDER: SettingsSyncImportMode[] = ["symlink", "copy"];

export function formatSourceRootScope(
  scope: SettingsSyncSourceScope,
  intl: IntlInstance,
  resourceCategory: ImportResourceCategory,
): string {
  return intl.formatMessage({ id: `settings.${resourceCategory}.import.scope.${scope}` });
}

export function getSourceRootItems(
  sourceRoot: SettingsSyncSourceRootSummary,
  resourceCategory: ImportResourceCategory,
): ImportItemSummary[] {
  return resourceCategory === "skills"
    ? (sourceRoot.skills ?? [])
    : resourceCategory === "commands"
      ? (sourceRoot.commands ?? [])
      : resourceCategory === "plugins"
        ? (sourceRoot.plugins ?? [])
        : (sourceRoot.mcpServers ?? []);
}

export function normalizePathForScope(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function inferSourceRootScope(
  path: string,
  workspacePath: string | null | undefined,
): SettingsSyncSourceScope {
  if (!workspacePath) {
    return "global";
  }
  const normalizedPath = normalizePathForScope(path);
  const normalizedWorkspacePath = normalizePathForScope(workspacePath);
  return normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
    ? "project"
    : "global";
}

export function getSourceRoots(
  agent: SettingsSyncAgentSummary,
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): SettingsSyncSourceRootSummary[] {
  const category = getResourceCategory(agent, resourceCategory);
  if (!category) {
    return [];
  }
  if (category.sourceRoots && category.sourceRoots.length > 0) {
    return category.sourceRoots;
  }
  return (category.sourcePaths ?? []).map((path) => ({
    scope: inferSourceRootScope(path, workspacePath),
    path,
    discoveredCount: category.discoveredCount,
    importableCount: category.importableCount,
    skippedCount: category.skippedCount,
  }));
}

export function groupAgentsBySourceRootScope(
  agents: SettingsSyncAgentSummary[],
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): Array<{
  scope: SettingsSyncSourceScope;
  rows: Array<{
    agent: SettingsSyncAgentSummary;
    sourceRoot: SettingsSyncSourceRootSummary;
  }>;
}> {
  return SOURCE_ROOT_SCOPE_ORDER.map((scope) => ({
    scope,
    rows: agents.flatMap((agent) =>
      getSourceRoots(agent, workspacePath, resourceCategory)
        .filter((sourceRoot) => sourceRoot.scope === scope)
        .filter((sourceRoot) =>
          getSourceRootItems(sourceRoot, resourceCategory).some((item) => item.importable),
        )
        .map((sourceRoot) => ({ agent, sourceRoot })),
    ),
  }));
}
