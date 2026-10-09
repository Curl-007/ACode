import type {
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IPluginSyncService {
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<{
    archive: Uint8Array;
    archiveBytes: number;
    marketplaceId: string;
    pluginNames: string[];
  }>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMarketplaceSourceArchive(params: { archive: Uint8Array; overwrite?: false }): Promise<{
    marketplaceId: string;
    path: string;
    status: "skipped" | "synced";
  }>;
}

export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
  {
    allowedMethods: [
      "listLocalUserPluginCandidates",
      "listRemoteUserPluginStatuses",
      "exportPluginsArchive",
      "exportMarketplaceSourceArchive",
      "importPluginsArchive",
      "checkRemoteUserPluginWriteAccess",
      "importMarketplaceSourceArchive",
    ],
    argumentValidators: {
      listLocalUserPluginCandidates: (args) => requireNoArguments(args),
      listRemoteUserPluginStatuses: (args) => {
        const params = requireParams(args);
        const plugins = params.plugins;
        if (
          !Array.isArray(plugins) ||
          !plugins.every(
            (plugin) =>
              isRecord(plugin) &&
              typeof plugin.pluginId === "string" &&
              typeof plugin.directoryName === "string",
          )
        ) {
          throw new Error("invalid plugins");
        }
      },
      exportPluginsArchive: (args) => {
        const params = requireParams(args);
        requireStringArray(params.pluginIds, "pluginIds");
      },
      exportMarketplaceSourceArchive: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.marketplaceId, "marketplaceId");
        requireStringArray(params.pluginNames, "pluginNames");
        requireRecordField(params.source, "source");
      },
      importPluginsArchive: (args) => {
        const params = requireParams(args);
        requireBinaryArchive(params.archive, "archive");
        requireFalseOverwrite(params.overwrite);
      },
      checkRemoteUserPluginWriteAccess: (args) => requireNoArguments(args),
      importMarketplaceSourceArchive: (args) => {
        const params = requireParams(args);
        requireBinaryArchive(params.archive, "archive");
        requireFalseOverwrite(params.overwrite);
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`invalid ${field}`);
  }
}

function requireBinaryArchive(value: unknown, field: string): void {
  // 归档在线上是嵌套 Uint8Array：RPC 序列化会在接收端还原为真实二进制视图
  // （rpc serialization.ts 的 encode/decodeRpcJsonValue）。这里放宽到 ArrayBuffer.isView，
  // 避免跨 realm 的 instanceof 差异造成误拒；归档字节合法性由服务解压实现校验。
  if (!ArrayBuffer.isView(value)) throw new Error(`invalid ${field}`);
}

function requireFalseOverwrite(value: unknown): void {
  // 类型只允许字面量 false：显式传 true 属契约违规，边界直接拒绝。
  if (value !== undefined && value !== false) throw new Error("invalid overwrite");
}
