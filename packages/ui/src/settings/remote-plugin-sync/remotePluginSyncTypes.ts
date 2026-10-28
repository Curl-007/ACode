/**
 * RemotePluginSyncDialog 外迁叶子的**类型与数据形状**（god-component-split-plan.md
 * settings/RemotePluginSyncDialog 批次第一刀）。
 *
 * 与 remotePluginSyncModel.ts 分离的唯一原因：split-plan 固定验收第 5 条要求新模块 <400 行，
 * 27 个纯函数 + 全部类型同文件会超限（~500 行）。类型无运行时代码（除
 * RemotePluginSyncStoppedError 这个 Error 子类与 REMOTE_PLUGIN_SYNC_CONFIG_SCOPE 常量），
 * 拆到本文件不改变任何行为；函数实现全部留在 remotePluginSyncModel.ts。
 */
import type {
  ACodePluginOptionValue,
  ACodePluginUserConfigOption,
  PluginSyncCandidate,
  PluginSyncImportResult,
} from "@acode/shared";
import type { IACodeAgentService } from "@acode/services";

export type RemotePluginSyncDialogStep =
  | "loading"
  | "selection"
  | "preflighting"
  | "syncing"
  | "complete";

export type RemotePluginSyncKind = "inline" | "marketplace";

export interface RemotePluginSyncPluginOptions {
  configuredOptions: Record<string, ACodePluginOptionValue>;
  userConfig: Record<string, ACodePluginUserConfigOption>;
}

export type RemotePluginSyncAgentService = Pick<
  IACodeAgentService,
  | "addPluginMarketplace"
  | "cancelPluginOperation"
  | "configurePlugin"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "setPluginEnabled"
>;

export const REMOTE_PLUGIN_SYNC_CONFIG_SCOPE = "user" as const;

export interface RemotePluginSyncCandidate {
  id: string;
  kind: RemotePluginSyncKind;
  name: string;
  pluginId: string;
  marketplace: string;
  description?: string;
  version?: string;
  path?: string;
  enabled: boolean;
  componentTypes: string[];
  inlineCandidate?: PluginSyncCandidate;
  pluginOptions?: RemotePluginSyncPluginOptions;
  marketplacePlugin?: {
    marketplaceSourceArchive?: {
      marketplaceId: string;
      source: Record<string, unknown>;
    };
    marketplaceSourceInput?: string;
    pluginName: string;
  };
}

export interface RemotePluginSyncCandidateStatus {
  candidateId: string;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

export interface RemotePluginSyncRow {
  candidate: RemotePluginSyncCandidate;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

export type RemotePluginSyncResultStatus =
  | PluginSyncImportResult["results"][number]["status"]
  | "stopped";

export interface RemotePluginSyncResultItem extends Omit<
  PluginSyncImportResult["results"][number],
  "status"
> {
  status: RemotePluginSyncResultStatus;
}

export interface RemotePluginSyncRunResult {
  results: RemotePluginSyncResultItem[];
}

export type RemotePluginSyncProgressStatus = "queued" | "syncing" | RemotePluginSyncResultStatus;

export interface RemotePluginSyncProgressEvent {
  candidateId: string;
  log: string;
  pluginId: string;
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

export interface RemotePluginSyncStopControl {
  cancelOperation?: (operationId: string) => Promise<void>;
  isStopped: (candidateId: string) => boolean;
  waitForStop?: (candidateId: string) => Promise<void>;
}

export interface RemotePluginSyncProgressView {
  logs: string[];
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

export class RemotePluginSyncStoppedError extends Error {
  constructor(readonly row: RemotePluginSyncRow) {
    super(`Stopped sync for ${row.candidate.pluginId}`);
    this.name = "RemotePluginSyncStoppedError";
  }
}
