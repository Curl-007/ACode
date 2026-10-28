/**
 * Plugin 详情高级区的配置草稿状态与保存（批次 4 helper 外迁 2026-10-28，controller 超 400 行
 * 后的第二刀）：自 plugins/usePluginListController 逐字迁移 pluginOptionsDrafts state、
 * setPluginOptionDraft、getPluginOptionValue、savePluginOptions。
 * hook 顺序不变：usePluginListController 在原 drafts useState 的槽位调用本 hook，
 * 内部 useState 占据同一顺序位置；configureStore 选择器仍留在 controller 原位（不动
 * store hook 顺序），经参数传入。
 */
import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ACodePluginInfo,
  ACodePluginScope,
  ACodePluginUserConfigOption,
} from "@acode/shared";
import type { IPluginManagementService } from "@acode/services";
import {
  buildPluginConfigPatch,
  type PluginOptionDraftValue,
} from "@/settings/pluginConfigPatch.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

/** 草稿 hook 的具名返回契约：PluginListDetail 的 props 依 ts-no-return-type 规则按名引用。 */
export interface PluginOptionDraftsController {
  pluginOptionsDrafts: Record<string, Record<string, PluginOptionDraftValue>>;
  setPluginOptionsDrafts: Dispatch<
    SetStateAction<Record<string, Record<string, PluginOptionDraftValue>>>
  >;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  getPluginOptionValue: (
    plugin: ACodePluginInfo,
    key: string,
    option: ACodePluginUserConfigOption,
  ) => string | number | boolean;
  savePluginOptions: (plugin: ACodePluginInfo) => Promise<void>;
}

export function usePluginOptionDrafts({
  configScope,
  configurePlugin,
  pluginManagementService,
}: {
  configScope: ACodePluginScope;
  configurePlugin: PluginManagementState["configurePlugin"];
  pluginManagementService: IPluginManagementService;
}): PluginOptionDraftsController {
  const [pluginOptionsDrafts, setPluginOptionsDrafts] = useState<
    Record<string, Record<string, PluginOptionDraftValue>>
  >({});
  const setPluginOptionDraft = (
    pluginId: string,
    key: string,
    value: string | number | boolean,
  ) => {
    setPluginOptionsDrafts((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [key]: value },
    }));
  };
  const getPluginOptionValue = (
    plugin: ACodePluginInfo,
    key: string,
    option: ACodePluginUserConfigOption,
  ): string | number | boolean => {
    const draft = pluginOptionsDrafts[plugin.id]?.[key];
    if (draft === null) return "";
    return (
      draft ??
      plugin.configuredOptions?.[key] ??
      option.default ??
      (option.type === "boolean" ? false : "")
    );
  };
  const savePluginOptions = async (plugin: ACodePluginInfo) => {
    const { options, clearOptionKeys } = buildPluginConfigPatch(
      plugin,
      pluginOptionsDrafts[plugin.id] ?? {},
    );
    // 没有显式修改时不写入空的 Workspace 配置，避免无操作保存制造配置足迹。
    if (Object.keys(options).length === 0 && clearOptionKeys.length === 0) return;
    const configured = await configurePlugin(
      plugin.id,
      options,
      pluginManagementService,
      configScope,
      clearOptionKeys,
    );
    // 保存失败时保留用户输入和敏感字段清除意图，避免 RPC 错误后 UI 看起来像已提交。
    if (!configured) return;
    setPluginOptionsDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  return {
    pluginOptionsDrafts,
    setPluginOptionsDrafts,
    setPluginOptionDraft,
    getPluginOptionValue,
    savePluginOptions,
  };
}
