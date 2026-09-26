// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 IACodeAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 acode-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@acode/rpc";
import type {
  ACodePluginOperationProgressNotification,
  ACodePluginsConfigureResult,
  ACodePluginsCancelOperationResult,
  ACodePluginsDescribeResult,
  ACodePluginsInstallResult,
  ACodePluginsListResult,
  ACodePluginsMarketplaceMutationResult,
  ACodePluginsOverviewResult,
  ACodePluginsReferenceCatalogResult,
  ACodePluginsRestoreBuiltinResult,
  ACodePluginsSetEnabledResult,
  ACodePluginsUninstallResult,
  ACodePluginsValidateResult,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ACodeAgentAddPluginMarketplaceParams,
  ACodeAgentConfigurePluginParams,
  ACodeAgentCancelPluginOperationParams,
  ACodeAgentDescribePluginParams,
  ACodeAgentInstallPluginParams,
  ACodeAgentPluginReferenceCatalogParams,
  ACodeAgentResolveSuggestedPluginReferenceParams,
  ACodeAgentResetPluginConfigParams,
  ACodeAgentPluginViewParams,
  ACodeAgentRemovePluginMarketplaceParams,
  ACodeAgentRestoreBuiltinPluginParams,
  ACodeAgentSetPluginEnabledParams,
  ACodeAgentUninstallPluginParams,
  ACodeAgentUpdatePluginMarketplaceParams,
  ACodeAgentUpdatePluginParams,
  ACodeAgentValidatePluginParams,
} from "../acode-agent/acodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: ACodeAgentPluginViewParams): Promise<ACodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: ACodeAgentPluginReferenceCatalogParams,
  ): Promise<ACodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: ACodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@acode/shared").ACodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ACodePluginOperationProgressNotification>;
  getPluginsOverview(params: ACodeAgentPluginViewParams): Promise<ACodePluginsOverviewResult>;
  addPluginMarketplace(
    params: ACodeAgentAddPluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ACodeAgentRemovePluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ACodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ACodePluginsMarketplaceMutationResult>;
  installPlugin(params: ACodeAgentInstallPluginParams): Promise<ACodePluginsInstallResult>;
  cancelPluginOperation(
    params: ACodeAgentCancelPluginOperationParams,
  ): Promise<ACodePluginsCancelOperationResult>;
  uninstallPlugin(params: ACodeAgentUninstallPluginParams): Promise<ACodePluginsUninstallResult>;
  updatePlugin(params: ACodeAgentUpdatePluginParams): Promise<ACodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ACodeAgentRestoreBuiltinPluginParams,
  ): Promise<ACodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ACodeAgentConfigurePluginParams): Promise<ACodePluginsConfigureResult>;
  resetPluginConfig(
    params: ACodeAgentResetPluginConfigParams,
  ): Promise<ACodePluginsConfigureResult>;
  validatePlugin(params: ACodeAgentValidatePluginParams): Promise<ACodePluginsValidateResult>;
  describePlugin(params: ACodeAgentDescribePluginParams): Promise<ACodePluginsDescribeResult>;
  setPluginEnabled(params: ACodeAgentSetPluginEnabledParams): Promise<ACodePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
