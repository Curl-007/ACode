import type {
  PluginScope,
  PluginsOverviewResult,
  ACodePluginsMarketplaceMutationResult,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IPluginsService {
  getOverview(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<PluginsOverviewResult>;
  addMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    source: string;
  }): Promise<void>;
  removeMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    marketplace: string;
  }): Promise<void>;
  updateMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    marketplace?: string;
  }): Promise<ACodePluginsMarketplaceMutationResult | void>;
  installPlugin(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
  }): Promise<void>;
  uninstallPlugin(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
  }): Promise<void>;
  setPluginEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
    nativeScope?: "user" | "project" | "local";
    enabled: boolean;
  }): Promise<void>;
}

export const IPluginsService = createServiceDescriptor<IPluginsService>(ServiceChannels.Plugins, {
  allowedMethods: [
    "getOverview",
    "addMarketplace",
    "removeMarketplace",
    "updateMarketplace",
    "installPlugin",
    "uninstallPlugin",
    "setPluginEnabled",
  ],
  argumentValidators: {
    getOverview: (args) => {
      requireWorkspaceParams(args);
    },
    // source/marketplace/pluginName 为标识性字符串：空值属明显异常，边界要求非空。
    addMarketplace: (args) => {
      const params = requireWorkspaceParams(args);
      requireNonEmptyString(params.source, "source");
    },
    removeMarketplace: (args) => {
      const params = requireWorkspaceParams(args);
      requireNonEmptyString(params.marketplace, "marketplace");
    },
    updateMarketplace: (args) => {
      const params = requireWorkspaceParams(args);
      // marketplace 可选（缺省表示刷新全部来源）；存在时只校验字符串类型。
      requireOptionalString(params.marketplace, "marketplace");
    },
    installPlugin: (args) => {
      const params = requireWorkspaceParams(args);
      requirePluginIdentity(params);
      requireOptionalString(params.scope, "scope");
    },
    uninstallPlugin: (args) => {
      const params = requireWorkspaceParams(args);
      requirePluginIdentity(params);
      requireOptionalString(params.scope, "scope");
    },
    setPluginEnabled: (args) => {
      const params = requireWorkspaceParams(args);
      requirePluginIdentity(params);
      requireOptionalString(params.scope, "scope");
      requireOptionalString(params.nativeScope, "nativeScope");
      requireBoolean(params.enabled, "enabled");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 全部方法共享 workspacePath（必选）+ workspaceIdentity（可选）前缀字段。 */
function requireWorkspaceParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  requireString(value.workspacePath, "workspacePath");
  requireOptionalString(value.workspaceIdentity, "workspaceIdentity");
  return value;
}

function requirePluginIdentity(params: Record<string, unknown>): void {
  requireNonEmptyString(params.pluginName, "pluginName");
  requireNonEmptyString(params.marketplace, "marketplace");
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
