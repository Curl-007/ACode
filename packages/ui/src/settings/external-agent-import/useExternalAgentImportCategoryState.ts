/**
 * ExternalAgentImportDialog 的类别级导入状态 hook（上帝组件批次 4 helper 外迁）：
 * discovery 加载、选择/展开/active scope/import target/mode 状态机与 selections 派生。
 * 迁移依据：settings 上帝组件拆分批次 4 —— 接口与 hook 函数体逐字自
 * settings/ExternalAgentImportDialog.tsx 迁入；纯 helper 改从 ./importModel.js 引入，
 * logger import 照搬主文件。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncImportMode,
  SettingsSyncSelection,
  SettingsSyncSourceScope,
} from "@acode/shared";
import type { ISettingsSyncService } from "@acode/services";
import { logger } from "@/logger.js";
import {
  buildExternalAgentImportSelections,
  type ImportResourceCategory,
  normalizeError,
} from "./importModel.js";

export interface ExternalAgentImportCategoryState {
  activeScope: SettingsSyncSourceScope;
  discovery: SettingsSyncDiscoveryResult | null;
  error: string | null;
  expandedSourceKeys: string[];
  importMode: SettingsSyncImportMode;
  importTargetScope: SettingsSyncSourceScope;
  loading: boolean;
  selectedCount: number;
  selectedKeys: string[];
  selections: SettingsSyncSelection[];
  totalImportableCount: number;
  loadDiscovery: () => Promise<void>;
  setActiveSourceScope: (scope: SettingsSyncSourceScope) => void;
  setImportMode: (mode: SettingsSyncImportMode) => void;
  setImportTargetScope: (scope: SettingsSyncSourceScope) => void;
  setResourceSelection: (keys: string[], checked: boolean) => void;
  toggleExpanded: (key: string) => void;
  toggleSelection: (key: string) => void;
}

export function useExternalAgentImportCategoryState({
  category,
  enabled,
  settingsSyncService,
  workspaceIdentity,
  workspacePath,
}: {
  category: ImportResourceCategory;
  enabled: boolean;
  settingsSyncService: ISettingsSyncService;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
}): ExternalAgentImportCategoryState {
  const [loading, setLoading] = useState(false);
  const [discovery, setDiscovery] = useState<SettingsSyncDiscoveryResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [expandedSourceKeys, setExpandedSourceKeys] = useState<string[]>([]);
  const [activeScope, setActiveScope] = useState<SettingsSyncSourceScope>("global");
  const [importTargetScope, setImportTargetScope] = useState<SettingsSyncSourceScope>("global");
  const [importMode, setImportMode] = useState<SettingsSyncImportMode>("symlink");
  const [error, setError] = useState<string | null>(null);

  const totalImportableCount = useMemo(
    () =>
      discovery?.agents.reduce(
        (sum, agent) =>
          sum +
          agent.categories.reduce(
            (categorySum, category) => categorySum + category.importableCount,
            0,
          ),
        0,
      ) ?? 0,
    [discovery],
  );

  const loadDiscovery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextDiscovery = await settingsSyncService.detect({
        workspacePath: workspacePath ?? undefined,
        workspaceIdentity,
        categories: [category],
        intent: "manualImport",
      });
      setDiscovery(nextDiscovery);
      setSelectedKeys([]);
      setExpandedSourceKeys([]);
      setActiveScope("global");
      setImportTargetScope("global");
    } catch (loadError) {
      const message = normalizeError(loadError);
      logger.error("[ExternalAgentImportDialog] scan failed", { category, error: message });
      setError(message);
      setDiscovery({ agents: [] });
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  }, [category, settingsSyncService, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!enabled || discovery || loading) {
      return;
    }
    void loadDiscovery();
  }, [discovery, enabled, loadDiscovery, loading]);

  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return [...next];
    });
  }, []);

  const setResourceSelection = useCallback((keys: string[], checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return [...next];
    });
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedSourceKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }, []);

  const setActiveSourceScope = useCallback((nextScope: SettingsSyncSourceScope) => {
    setActiveScope(nextScope);
    setImportTargetScope(nextScope);
  }, []);

  const selections = useMemo(
    () => buildExternalAgentImportSelections(selectedKeys, importTargetScope, importMode),
    [importMode, importTargetScope, selectedKeys],
  );

  return {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount: selectedKeys.length,
    selectedKeys,
    selections,
    totalImportableCount,
    loadDiscovery,
    setActiveSourceScope,
    setImportMode,
    setImportTargetScope,
    setResourceSelection,
    toggleExpanded,
    toggleSelection,
  };
}
