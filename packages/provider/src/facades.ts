// 2026-12-31 例外债务偿还：原 747 行 facades.ts 按职责拆为 4 个叶子（均 <400 行），
// 本文件降级为 barrel 保持导出面逐名不变，首行 oxlint max-lines 抑制头注随拆分删除：
// - provider-settings-views.ts       Provider Settings 视图契约族（12 个类型导出）
// - provider-settings-projection.ts  Registry 快照投影族（内部 helper，不经本 barrel 导出）
// - provider-settings-facade.ts      ProviderSettingsFacade
// - model-selection-facade.ts        ModelSelection 视图族 + ModelSelectionFacade + 投影函数
export type {
  ModelConfigResolution,
  ProviderDiscoveryInput,
  ProviderRegistryFacadeSource,
  ProviderSettingsCreationResult,
  ProviderSettingsModelCandidateView,
  ProviderSettingsModelView,
  ProviderSettingsMutationTarget,
  ProviderSettingsProviderView,
  ProviderSettingsTemplateView,
  ProviderSettingsView,
  ResolveModelConfigInput,
  SavePersonalModelDraftInput,
} from "./provider-settings-views.js";
export { ProviderSettingsFacade } from "./provider-settings-facade.js";
export type {
  ModelSelectionModelView,
  ModelSelectionProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "./model-selection-facade.js";
export { ModelSelectionFacade, projectModelSelectionProviderView } from "./model-selection-facade.js";
