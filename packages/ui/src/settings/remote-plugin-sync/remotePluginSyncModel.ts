/**
 * RemotePluginSyncDialog 的纯函数叶子模块（god-component-split-plan.md 本文件批次第一刀）。
 * 27 个纯函数逐字迁移：行构建/选择解析/portable option 判定/marketplace source 序列化/stopped
 * 错误形态/install 诊断格式化；互相引用密集，整组一起搬。副作用函数留在主文件；类型在
 * ./remotePluginSyncTypes.ts（re-export 于下方，消费方只需 import 本模块一个口）。
 */
import type { PluginSyncCandidate, PluginSyncRemoteStatus } from "@acode/shared";
import { type V4PluginInfo, type V4PluginMarketplaceSummary, type V4PluginOptionValue, type V4PluginUserConfigOption, type V4PluginsOverviewResult } from "@acode/shared/acode-protocol-v4";
import {
  RemotePluginSyncStoppedError,
  type RemotePluginSyncAgentService, type RemotePluginSyncCandidate,
  type RemotePluginSyncCandidateStatus, type RemotePluginSyncDialogStep,
  type RemotePluginSyncPluginOptions, type RemotePluginSyncResultItem, type RemotePluginSyncRow,
} from "./remotePluginSyncTypes.js";
export { REMOTE_PLUGIN_SYNC_CONFIG_SCOPE, RemotePluginSyncStoppedError } from "./remotePluginSyncTypes.js";
export type {
  RemotePluginSyncAgentService, RemotePluginSyncCandidate, RemotePluginSyncCandidateStatus,
  RemotePluginSyncDialogStep, RemotePluginSyncKind, RemotePluginSyncPluginOptions,
  RemotePluginSyncProgressEvent, RemotePluginSyncProgressStatus, RemotePluginSyncProgressView,
  RemotePluginSyncResultItem, RemotePluginSyncResultStatus, RemotePluginSyncRow,
  RemotePluginSyncRunResult, RemotePluginSyncStopControl,
} from "./remotePluginSyncTypes.js";

export function shouldFinishRemotePluginSyncRun(
  currentRun: AbortController | null,
  run: AbortController,
): boolean {
  return currentRun === run;
}

let remotePluginSyncOperationCounter = 0;
export function createRemotePluginSyncOperationId(row: RemotePluginSyncRow): string {
  remotePluginSyncOperationCounter += 1;
  const safePluginId = row.candidate.pluginId.replace(/[^a-z0-9._-]+/giu, "-");
  return `remote-plugin-sync-${remotePluginSyncOperationCounter}-${safePluginId}`;
}

export function toInlineRemotePluginSyncCandidate(
  candidate: PluginSyncCandidate,
): RemotePluginSyncCandidate {
  return {
    id: `inline:${candidate.id}`,
    kind: "inline",
    name: candidate.name,
    pluginId: candidate.pluginId,
    marketplace: "inline",
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    path: candidate.path,
    enabled: candidate.enabled,
    componentTypes: candidate.componentTypes,
    inlineCandidate: candidate,
  };
}

export function createInlineStatusKey(pluginId: string, directoryName: string): string {
  return `${pluginId.toLowerCase()}\u0000${directoryName}`;
}

export function buildRemotePluginSyncRows(
  candidates: readonly PluginSyncCandidate[],
  statuses: readonly PluginSyncRemoteStatus[],
): RemotePluginSyncRow[] {
  const statusByKey = new Map(
    statuses.map((status) => [
      createInlineStatusKey(status.pluginId, status.directoryName),
      status,
    ]),
  );
  return buildRemotePluginSyncRowsForCandidates(
    candidates.map(toInlineRemotePluginSyncCandidate),
    candidates.map((candidate) => {
      const status = statusByKey.get(
        createInlineStatusKey(candidate.pluginId, candidate.directoryName),
      );
      return {
        candidateId: `inline:${candidate.id}`,
        exists: status?.exists ?? false,
        ...(status?.path ? { path: status.path } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
      };
    }),
  );
}

export function buildRemotePluginSyncRowsForCandidates(
  candidates: readonly RemotePluginSyncCandidate[],
  statuses: readonly RemotePluginSyncCandidateStatus[],
): RemotePluginSyncRow[] {
  const statusById = new Map(statuses.map((status) => [status.candidateId, status]));
  return candidates.map((candidate) => {
    const status = statusById.get(candidate.id);
    return {
      candidate,
      exists: status?.exists ?? false,
      ...(status?.path ? { path: status.path } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
      ...(status?.remoteMarketplaceExists !== undefined
        ? { remoteMarketplaceExists: status.remoteMarketplaceExists }
        : {}),
    };
  });
}

export function resolveDefaultRemotePluginSyncSelection(
  rows: readonly RemotePluginSyncRow[],
): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

export function filterRemotePluginSyncRows(
  rows: readonly RemotePluginSyncRow[],
  showExistingRemotePlugins: boolean,
): RemotePluginSyncRow[] {
  return showExistingRemotePlugins ? [...rows] : rows.filter((row) => !row.exists);
}

export function shouldAllowRemotePluginSyncDialogOpenChange(
  step: RemotePluginSyncDialogStep,
  nextOpen: boolean,
): boolean {
  return nextOpen || (step !== "preflighting" && step !== "syncing");
}

export function buildMarketplaceRemotePluginSyncCandidates(
  overview: V4PluginsOverviewResult,
  plugins: readonly V4PluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const marketplaceSourceById = new Map(
    overview.marketplaces.map((marketplace) => [
      marketplace.id,
      buildMarketplaceSourceSyncInfo(marketplace),
    ]),
  );
  return overview.installedPlugins.map((plugin) => {
    const info = pluginInfoById.get(plugin.id);
    const componentTypes = plugin.componentTypes ?? componentTypesFromPluginInfo(info);
    const marketplaceSource = marketplaceSourceById.get(plugin.marketplace);
    const pluginOptions = buildRemotePluginSyncPluginOptions(info);
    return {
      id: `marketplace:${plugin.id}`,
      kind: "marketplace",
      name: plugin.name,
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
      ...((plugin.description ?? info?.description)
        ? { description: plugin.description ?? info?.description }
        : {}),
      ...((plugin.version ?? info?.version) ? { version: plugin.version ?? info?.version } : {}),
      ...((plugin.installPath ?? info?.rootPath)
        ? { path: plugin.installPath ?? info?.rootPath }
        : {}),
      enabled: plugin.enabled,
      componentTypes,
      ...(pluginOptions ? { pluginOptions } : {}),
      marketplacePlugin: {
        ...marketplaceSource,
        pluginName: plugin.name,
      },
    };
  });
}

export function buildMarketplaceRemotePluginStatuses(
  candidates: readonly RemotePluginSyncCandidate[],
  remoteOverview: V4PluginsOverviewResult,
): RemotePluginSyncCandidateStatus[] {
  const installedById = new Map(
    remoteOverview.installedPlugins.map((plugin) => [plugin.id, plugin]),
  );
  const remoteMarketplaceIds = new Set(
    remoteOverview.marketplaces.map((marketplace) => marketplace.id),
  );
  return candidates.map((candidate) => {
    const installed = installedById.get(candidate.pluginId);
    return {
      candidateId: candidate.id,
      exists: Boolean(installed),
      ...(installed?.installPath ? { path: installed.installPath } : {}),
      ...(installed ? { reason: "samePluginId" as const } : {}),
      remoteMarketplaceExists: remoteMarketplaceIds.has(candidate.marketplace),
    };
  });
}

export function componentTypesFromPluginInfo(plugin: V4PluginInfo | undefined): string[] {
  return plugin?.components?.map((component) => component.kind) ?? [];
}

export function buildRemotePluginSyncPluginOptions(
  plugin: V4PluginInfo | undefined,
): RemotePluginSyncPluginOptions | undefined {
  const configuredOptions = plugin?.configuredOptions ?? {};
  if (Object.keys(configuredOptions).length === 0) {
    return undefined;
  }
  return {
    configuredOptions: { ...configuredOptions },
    // {...undefined} 不添加任何属性；oxlint no-useless-fallback-in-spread 要求去掉 ?? {}。
    userConfig: { ...plugin?.userConfig },
  };
}

export function applyPluginInfoToRemoteSyncCandidate(
  candidate: RemotePluginSyncCandidate,
  plugin: V4PluginInfo | undefined,
): RemotePluginSyncCandidate {
  const pluginOptions = buildRemotePluginSyncPluginOptions(plugin);
  return pluginOptions ? { ...candidate, pluginOptions } : candidate;
}

export function enrichRemotePluginSyncCandidatesWithPluginInfo(
  candidates: readonly RemotePluginSyncCandidate[],
  plugins: readonly V4PluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return candidates.map((candidate) =>
    applyPluginInfoToRemoteSyncCandidate(candidate, pluginInfoById.get(candidate.pluginId)),
  );
}

export function summarizeLocalPluginOptionsForDisplay(
  pluginOptions: RemotePluginSyncPluginOptions | undefined,
): { manualCount: number; syncableCount: number } | null {
  if (!pluginOptions || Object.keys(pluginOptions.configuredOptions).length === 0) {
    return null;
  }
  let syncableCount = 0;
  let manualCount = 0;
  for (const [key, value] of Object.entries(pluginOptions.configuredOptions)) {
    const option = pluginOptions.userConfig[key];
    if (isPortablePluginOptionValue(value, option, option)) {
      syncableCount += 1;
    } else {
      manualCount += 1;
    }
  }
  return { manualCount, syncableCount };
}

export function serializeMarketplaceSourceInput(
  marketplace: V4PluginMarketplaceSummary,
): string | undefined {
  const source = marketplace.source;
  const sourceKind = typeof source.source === "string" ? source.source : "";
  const refSuffix =
    typeof source.ref === "string" && source.ref.trim() ? `#${source.ref.trim()}` : "";
  if (sourceKind === "github" && typeof source.repo === "string" && source.repo.trim()) {
    return `${source.repo.trim()}${refSuffix}`;
  }
  if (sourceKind === "git" && typeof source.url === "string" && source.url.trim()) {
    return `${source.url.trim()}${refSuffix}`;
  }
  if (sourceKind === "url" && typeof source.url === "string" && source.url.trim()) {
    return source.url.trim();
  }
  return undefined;
}

export function buildMarketplaceSourceSyncInfo(
  marketplace: V4PluginMarketplaceSummary,
): Pick<
  NonNullable<RemotePluginSyncCandidate["marketplacePlugin"]>,
  "marketplaceSourceArchive" | "marketplaceSourceInput"
> {
  const sourceInput = serializeMarketplaceSourceInput(marketplace);
  if (sourceInput) {
    return { marketplaceSourceInput: sourceInput };
  }
  const sourceKind = typeof marketplace.source.source === "string" ? marketplace.source.source : "";
  if (["file", "directory", "settings"].includes(sourceKind)) {
    return {
      marketplaceSourceArchive: {
        marketplaceId: marketplace.id,
        source: marketplace.source,
      },
    };
  }
  return {};
}

export function isRemotePluginSyncStoppedError(
  error: unknown,
): error is RemotePluginSyncStoppedError {
  return error instanceof RemotePluginSyncStoppedError;
}

export function buildStoppedRemotePluginResult(row: RemotePluginSyncRow): RemotePluginSyncResultItem {
  return {
    name: row.candidate.name,
    pluginId: row.candidate.pluginId,
    directoryName:
      row.candidate.kind === "inline"
        ? (row.candidate.inlineCandidate?.directoryName ?? row.candidate.name)
        : `${row.candidate.marketplace}/${row.candidate.name}`,
    status: "stopped",
    error:
      "stop requested; stopped waiting for this plugin sync. Any remote RPC that already started may still finish on the remote target.",
  };
}

export function isPathPluginOption(option: V4PluginUserConfigOption | undefined): boolean {
  return option?.type === "file" || option?.type === "directory";
}

export function isPortablePluginOptionValue(
  value: V4PluginOptionValue,
  localOption: V4PluginUserConfigOption | undefined,
  remoteOption: V4PluginUserConfigOption | undefined,
): boolean {
  if (!localOption || !remoteOption) {
    return false;
  }
  if (localOption.sensitive === true || remoteOption.sensitive === true) {
    return false;
  }
  if (isPathPluginOption(localOption) || isPathPluginOption(remoteOption)) {
    return false;
  }
  const expectedType = remoteOption.type ?? localOption.type;
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "number") return typeof value === "number";
  if (expectedType === "string") return typeof value === "string";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function buildPortablePluginOptionsSyncPlan(
  localOptions: RemotePluginSyncPluginOptions,
  remotePlugin: V4PluginInfo,
): { options: Record<string, V4PluginOptionValue>; skippedCount: number } {
  const options: Record<string, V4PluginOptionValue> = {};
  let skippedCount = 0;
  for (const [key, value] of Object.entries(localOptions.configuredOptions)) {
    if (
      isPortablePluginOptionValue(
        value,
        localOptions.userConfig[key],
        remotePlugin.userConfig?.[key],
      )
    ) {
      options[key] = value;
    } else {
      skippedCount += 1;
    }
  }
  return { options, skippedCount };
}

export function arePluginOptionsEqual(
  left: Record<string, V4PluginOptionValue>,
  right: Record<string, V4PluginOptionValue>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

export function buildSelectedMarketplacePluginNames(
  rows: readonly RemotePluginSyncRow[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const marketplacePlugin = row.candidate.marketplacePlugin;
    if (row.candidate.kind !== "marketplace" || !marketplacePlugin) {
      continue;
    }
    const names = result.get(row.candidate.marketplace) ?? [];
    names.push(marketplacePlugin.pluginName);
    result.set(row.candidate.marketplace, names);
  }
  return result;
}

export function formatInstallError(
  result: Awaited<ReturnType<RemotePluginSyncAgentService["installPlugin"]>>,
  pluginId: string,
): string | null {
  const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (diagnostics.length === 0) {
    return null;
  }
  return diagnostics
    .map((diagnostic) => {
      const target = diagnostic.pluginId ?? pluginId;
      return `${target}: ${diagnostic.message}`;
    })
    .join("; ");
}
