/* eslint-disable max-lines -- 子智能体管理页集中维护作用域列表、表单和启用状态，避免状态分散 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ListChecks, Plus, X } from "lucide-react";
import {
  ACODE_AGENT_PROVIDER,
  type AgentsCapability,
  type AgentSummary,
  type ModelSelection,
  type SubAgentConfig,
} from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
} from "@/lib/modelSelectionGroups.js";
import { encodeCustomModelValue } from "@/lib/acodeCustomModelValue.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroupHeader.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
// 子智能体批量编辑（specs/subagent-batch-edit.md）：操作条 + 分组统一设置弹层 + 纯逻辑。
// 应用写路径只走既有 service 方法（覆盖路径 / updateAgent），不新建平行写入通道。
import { SubagentModelBatchBar } from "@/settings/SubagentModelBatchBar.js";
import { SubagentModelBatchDialog } from "@/settings/SubagentModelBatchDialog.js";
import {
  buildUserAgentBatchConfig,
  createEmptyBatchResult,
  isBatchApplicableAgent,
  resolveBatchApplyTargets,
  resolveBatchWritePath,
  resolveGroupBatchCheckState,
  type SubagentModelBatchResult,
  type SubagentModelBatchValue,
} from "@/settings/SubagentModelBatchApply.js";
import { refreshLoadedSubagentsStoreForWorkspace } from "@/store/subagentsStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
// helper 外迁批次 1（split-plan settings/SubagentsSection.tsx）：能力矩阵 / 工具合并 /
// 模型档位 / 表单初值纯函数 + 常量集中到 subagents/agentModel.ts，避免与本文件循环 import。
import {
  getBuiltInSubagentName,
  isBuiltInAgent,
  isEditableUserAgent,
  projectSettingsSubagents,
  supportsEnabledToggle,
  toSubagentModelSelection,
} from "@/settings/subagents/agentModel.js";
// 批次 2：列表选择态（SubagentList）/ 表单草稿态（SubagentForm）/ 纯展示子组件（primitives）外迁。
import {
  AgentListRow,
  SubagentGroupBatchMenu,
  SubagentGroupSelectAll,
} from "@/settings/subagents/SubagentList.js";
import { SubagentForm } from "@/settings/subagents/SubagentForm.js";

// 源仓新增的批量 test id 定义在 packages/shared/src/test-ids.ts；本任务限定只改
// packages/ui，这里用局部字面量保持同一 data-testid 契约（E2E 可按字面量选取）。
const TID_SUBAGENT_BATCH_TRIGGER = "subagent-batch-trigger";
const TID_SUBAGENT_BATCH_SELECT_ALL = "subagent-batch-select-all";

interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

interface SubagentsSectionProps {
  onManageModels?: () => void;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}


function groupAgentsByScope(agents: readonly AgentSummary[]): AgentGroups {
  const groups: AgentGroups = { builtIn: [], plugin: [], user: [] };
  for (const agent of agents) {
    if (isEditableUserAgent(agent)) {
      groups.user.push(agent);
    } else if (agent.source === "plugin") {
      groups.plugin.push(agent);
    } else {
      groups.builtIn.push(agent);
    }
  }
  return groups;
}

/** 按完整插件 ID 分组，避免同名 marketplace 的子智能体互相合并。 */
function groupPluginAgentsById(agents: readonly AgentSummary[]): Array<[string, AgentSummary[]]> {
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key =
      agent.pluginId?.trim() || agent.pluginName?.trim() || agent.name.split(":", 1)[0] || "Plugin";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}




/** 内置与插件 subagent 共用的行内 model / effort 覆盖控件，即改即存。 */


export function SubagentsSection({ onManageModels }: SubagentsSectionProps) {
  const { intl, locale } = useACodeIntl();
  const confirmDialog = useConfirmDialog();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // 非 Ready 生命周期均保留表单中的模型意图；error/unavailable 不能被误判成模型已失效。
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    return (
      tabs
        .filter(isWorkspaceTab)
        .filter(isPluginScopeWorkspaceConnected)
        // Subagent Settings 只管理 Local Environment；远程配置浏览/编辑是独立产品能力。
        .filter((tab) => !tab.remoteTarget && !tab.remoteSessionId && !tab.workspaceIdentity)
        .filter((tab) => {
          const key = getPluginWorkspaceKey(tab);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
    );
  }, [tabs]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [capability, setCapability] = useState<AgentsCapability | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [operatingAgentId, setOperatingAgentId] = useState<string | null>(null);
  // 批量编辑会话状态（唯一所有者，specs/subagent-batch-edit.md）：模式开关、选中集、
  // 串行应用进度与结果。操作条/弹层不持有已确认状态，只暂存未确认目标值。
  const [batchMode, setBatchMode] = useState(false);
  const [selectedBatchIds, setSelectedBatchIds] = useState<ReadonlySet<string>>(new Set());
  const [batchApplying, setBatchApplying] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResult, setBatchResult] = useState<SubagentModelBatchResult | null>(null);
  // 分组统一设置弹层的目标分组 key（user/builtIn/插件 id）；应用时按当前列表重算目标集，
  // 保证 buildUserAgentBatchConfig 的透传基线是最新行投影而非打开瞬间的快照。
  const [batchDialogGroupKey, setBatchDialogGroupKey] = useState<
    { kind: "user" } | { kind: "builtIn" } | { kind: "plugin"; pluginId: string } | null
  >(null);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const targetWorkspaceIdentity = undefined;
  const { pluginManagementService, subagentsService } = localHostServices;
  const activeScope = selectedWorkspace ? "workspace" : "user";
  const latestRequestIdRef = useRef(0);
  const pluginInventoryWorkspacePath = targetWorkspacePath || workspaceTabs[0]?.workspacePath;
  const chatModelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ACODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);
  const subagentModelSelectGroups = chatModelSelectGroups;
  const loadAgents = useCallback(
    async (showBlockingLoading: boolean) => {
      setLoading(showBlockingLoading);
      setRefreshing(!showBlockingLoading);
      setError(null);
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await subagentsService.list({
          workspacePath: targetWorkspacePath ?? "",
          workspaceIdentity: targetWorkspaceIdentity,
          provider: ACODE_AGENT_PROVIDER,
          mode: activeScope === "user" ? "settingsUserOnly" : "allRuntimeScopes",
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        // 插件 agent 是运行时 profile 的只读投影；设置页展示它们，但仍不展示工作区级编辑入口。
        setAgents(projectSettingsSubagents(result));
        setCapability(result.capability);
        setLoading(false);
        setRefreshing(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoading(false);
        setRefreshing(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [subagentsService, activeScope, targetWorkspaceIdentity, targetWorkspacePath],
  );

  useEffect(() => {
    void loadAgents(true);
  }, [loadAgents]);

  useEffect(() => {
    if (!pluginInventoryWorkspacePath) return;
    let active = true;
    // 冷启动 seed 晚于文件首读，旧用户页又跳过 inventory 初始化，导致插件直到重进才出现。
    // 复用已有初始化完成事件刷新只读资源，不阻塞用户列表、不轮询，也不把项目配置带入用户页。
    void (async () => {
      try {
        await initializePlugins({
          workspacePath: pluginInventoryWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          configScope: activeScope === "user" ? "user" : undefined,
          pluginService: pluginManagementService,
        });
        if (active) await loadAgents(false);
      } catch (initializationError) {
        if (active)
          logger.warn("[subagents] 插件资源初始化失败，保留当前列表", initializationError);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    activeScope,
    initializePlugins,
    loadAgents,
    pluginInventoryWorkspacePath,
    pluginManagementService,
    targetWorkspaceIdentity,
  ]);

  const refresh = useCallback(async () => {
    await loadAgents(false);
  }, [loadAgents]);

  const refreshMentionStore = useCallback(async () => {
    await refreshLoadedSubagentsStoreForWorkspace({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      subagentsService,
    });
  }, [subagentsService, targetWorkspaceIdentity, targetWorkspacePath]);

  const handleSave = useCallback(
    async (config: SubAgentConfig) => {
      setSaving(true);
      try {
        if (editingAgent) {
          await subagentsService.updateAgent({
            agentId: editingAgent.id,
            config,
            oldFilePath: editingAgent.path,
            provider: ACODE_AGENT_PROVIDER,
            scope: editingAgent.scope === "workspace" ? "workspace" : "user",
            workspacePath: editingAgent.projectPath ?? targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        } else {
          await subagentsService.createAgent({
            config,
            provider: ACODE_AGENT_PROVIDER,
            scope: activeScope,
            workspacePath: targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        }
        setShowForm(false);
        setEditingAgent(null);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (saveError) {
        toast(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [
      activeScope,
      editingAgent,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  const handleDelete = useCallback(
    async (agent: AgentSummary) => {
      if (!isEditableUserAgent(agent)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.subagents.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.subagents.delete.description" },
          { name: agent.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.deleteAgent({
          agentId: agent.id,
          filePath: agent.path,
        });
        setEditingAgent(null);
        setShowForm(false);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (deleteError) {
        toast(deleteError instanceof Error ? deleteError.message : String(deleteError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [confirmDialog, intl, refresh, refreshMentionStore, subagentsService],
  );

  const handleToggle = useCallback(
    async (agent: AgentSummary, enabled: boolean) => {
      if (!supportsEnabledToggle(agent)) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.setEnabled({
          agentId: agent.id,
          enabled,
        });
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (toggleError) {
        toast(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  const handleModelOverrideChange = useCallback(
    async (
      agent: AgentSummary,
      config: { model?: string; thoughtLevel?: string; speed?: string },
    ) => {
      const agentName = getBuiltInSubagentName(agent);
      if (!agentName && agent.source !== "plugin") {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        const modelSelection = toSubagentModelSelection(
          config.model,
          config.thoughtLevel,
          config.speed,
        );
        if (agentName) {
          await subagentsService.setBuiltInModelOverride({ agentName, modelSelection });
        } else {
          // 稳定 ID 不含插件版本；升级换目录后继续读取同一份用户 Selection 覆盖。
          await subagentsService.setPluginAgentModelOverride({ agentId: agent.id, modelSelection });
        }
      } catch (changeError) {
        toast(changeError instanceof Error ? changeError.message : String(changeError));
        setOperatingAgentId(null);
        throw changeError;
      }
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        // 持久化成功即为提交点；后续投影刷新失败只能提示，不能让控件回滚磁盘状态。
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  const recommendBatchStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");

  const enterBatchMode = useCallback(() => {
    setBatchMode(true);
    setSelectedBatchIds(new Set());
    setBatchResult(null);
    setBatchProgress(null);
  }, []);

  const exitBatchMode = useCallback(() => {
    if (batchApplying) {
      return;
    }
    setBatchMode(false);
    setSelectedBatchIds(new Set());
    setBatchResult(null);
    setBatchProgress(null);
  }, [batchApplying]);

  const handleBatchCheckChange = useCallback(
    (agent: AgentSummary, checked: boolean) => {
      // 应用进行中禁止改选中：行点击/复选框在 UI 层已禁用，这里再兜底一次。
      if (batchApplying || !isBatchApplicableAgent(agent)) {
        return;
      }
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        if (checked) {
          next.add(agent.id);
        } else {
          next.delete(agent.id);
        }
        return next;
      });
      setBatchResult(null);
    },
    [batchApplying],
  );

  // 分组全选/全不选：批量模式下勾选/取消该组全部可批量行。
  const handleBatchGroupCheck = useCallback(
    (groupAgents: readonly AgentSummary[], checked: boolean) => {
      const selectable = resolveBatchApplyTargets(groupAgents);
      if (selectable.length === 0) {
        return;
      }
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        for (const target of selectable) {
          if (checked) {
            next.add(target.id);
          } else {
            next.delete(target.id);
          }
        }
        return next;
      });
      setBatchResult(null);
    },
    [],
  );

  /**
   * 批量场景下的单行落盘：内置/插件行走行内覆盖（handleModelOverrideChange），
   * 自建/工作区 agent 走 updateAgent 重写定义文件 modelSelection（其余字段原样保留）。
   * 两条路径最终都落到 refresh 投影，保持唯一已确认状态。
   * value 的 modelSelection 已是解析好的结构体（不传 picker 编码串再手写切分）；
   * 顶层的 thoughtLevel 必须显式带上，否则覆盖路径会回落到选模型时的 Registry 默认档位。
   */
  const applyBatchTarget = useCallback(
    async (agent: AgentSummary, value: SubagentModelBatchValue) => {
      if (resolveBatchWritePath(agent) === "override") {
        await handleModelOverrideChange(agent, {
          model: value.modelSelection
            ? encodeCustomModelValue(value.modelSelection.providerId, value.modelSelection.modelId)
            : undefined,
          thoughtLevel: value.thoughtLevel ?? value.modelSelection?.options?.reasoningLevel,
          speed: value.speed ?? value.modelSelection?.options?.speed,
        });
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.updateAgent({
          agentId: agent.id,
          config: buildUserAgentBatchConfig(agent, value),
          oldFilePath: agent.path,
          provider: ACODE_AGENT_PROVIDER,
          scope: agent.scope === "workspace" ? "workspace" : "user",
          workspacePath: agent.projectPath ?? targetWorkspacePath ?? undefined,
          workspaceIdentity: targetWorkspaceIdentity,
        });
      } catch (changeError) {
        setOperatingAgentId(null);
        throw changeError;
      }
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [
      handleModelOverrideChange,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  /**
   * 批量应用唯一执行点（specs/subagent-batch-edit.md R1/R4）：整批只做一次 Start Plan
   * 推荐（循环外），随后按列表顺序逐行串行落盘，每行独立成功/失败；失败行保留磁盘
   * 原值并计入结果汇总，不中断后续行。写路径统一委托 applyBatchTarget。
   */
  const applyBatchModelOverride = useCallback(
    async (targets: readonly AgentSummary[], value: SubagentModelBatchValue) => {
      if (batchApplying || targets.length === 0) {
        return;
      }
      setBatchApplying(true);
      setBatchResult(null);
      setBatchProgress({ done: 0, total: targets.length });
      const result = createEmptyBatchResult();
      let targetValue = value;
      if (value.modelSelection) {
        // modelSelection 是选模型那一刻按 Registry 补的默认档位；用户随后在操作条改的
        // thoughtLevel 只在 value 顶层。先合并再推荐/写盘，避免推荐未改写时被冲回默认。
        const thoughtLevel = value.thoughtLevel?.trim();
        const userSelection: ModelSelection = {
          ...value.modelSelection,
          options: {
            ...value.modelSelection.options,
            ...(thoughtLevel ? { reasoningLevel: thoughtLevel } : {}),
          },
        };
        const chosen = await recommendBatchStartPlan(userSelection);
        if (!chosen) {
          // 用户拒绝/关闭推荐弹窗：整批保留原值，不进入逐行循环。
          setBatchProgress(null);
          setBatchApplying(false);
          setBatchResult({
            succeeded: [],
            failed: targets.map((agent) => ({
              name: agent.name,
              message: intl.formatMessage({ id: "settings.subagents.batch.declined" }),
            })),
          });
          return;
        }
        targetValue = {
          modelSelection: chosen,
          thoughtLevel: chosen.options?.reasoningLevel,
        };
      }
      for (let index = 0; index < targets.length; index += 1) {
        const agent = targets[index];
        if (!agent) {
          continue;
        }
        setBatchProgress({ done: index, total: targets.length });
        try {
          await applyBatchTarget(agent, targetValue);
          result.succeeded.push(agent.name);
        } catch (changeError) {
          result.failed.push({
            name: agent.name,
            message: changeError instanceof Error ? changeError.message : String(changeError),
          });
        }
      }
      // 结束后必须清空进度：操作条以 progress 非空判定显示「正在应用 n/n」转圈。
      setBatchProgress(null);
      setOperatingAgentId(null);
      setBatchApplying(false);
      setBatchResult(result);
      if (result.succeeded.length > 0) {
        try {
          await Promise.all([refresh(), refreshMentionStore()]);
        } catch (refreshError) {
          // 持久化成功即为提交点；批量后的投影刷新失败只提示，不回滚磁盘状态。
          toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      }
    },
    [applyBatchTarget, batchApplying, intl, recommendBatchStartPlan, refresh, refreshMentionStore],
  );

  const handleGroupBatchApply = useCallback(
    (groupAgents: readonly AgentSummary[]) => {
      const targets = resolveBatchApplyTargets(groupAgents);
      setBatchDialogGroupKey(null);
      void applyBatchModelOverride(targets, {});
    },
    [applyBatchModelOverride],
  );

  const handleEdit = useCallback((agent: AgentSummary) => {
    if (!isEditableUserAgent(agent)) {
      return;
    }
    setEditingAgent(agent);
    setShowForm(false);
  }, []);

  const canManageUserAgents =
    activeScope === "workspace"
      ? Boolean(targetWorkspacePath)
      : capability?.userScopeAvailable === true;

  const handleAddNew = useCallback(() => {
    if (!canManageUserAgents) {
      return;
    }
    setEditingAgent(null);
    setShowForm(true);
  }, [canManageUserAgents]);

  const handleCancelForm = useCallback(() => {
    setEditingAgent(null);
    setShowForm(false);
  }, []);

  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (activeScope === "user") {
        if (agent.scope === "workspace") return false;
      } else {
        if (isBuiltInAgent(agent) || agent.scope !== "workspace") return false;
        if (agent.source === "plugin" && agent.projectPath !== targetWorkspacePath) return false;
        if (
          agent.source !== "plugin" &&
          agent.projectPath &&
          agent.projectPath !== targetWorkspacePath
        )
          return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        agent.name,
        agent.description,
        agent.modelSelection
          ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
          : undefined,
        agent.path,
        agent.scope,
        agent.source,
        agent.tools?.join(" "),
        agent.disallowedTools?.join(" "),
        agent.skills?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeScope, agents, query, targetWorkspacePath]);

  const groupedAgents = useMemo(() => groupAgentsByScope(filteredAgents), [filteredAgents]);
  const pluginGroups = useMemo(
    () => groupPluginAgentsById(groupedAgents.plugin),
    [groupedAgents.plugin],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  const filteredAgentCount =
    groupedAgents.user.length + groupedAgents.plugin.length + groupedAgents.builtIn.length;
  const currentEditingAgent = useMemo(() => {
    if (!editingAgent) {
      return null;
    }
    return agents.find((agent) => agent.id === editingAgent.id) ?? editingAgent;
  }, [agents, editingAgent]);
  const isFormView = canManageUserAgents && (showForm || currentEditingAgent !== null);

  // 批量目标集 = 当前过滤可见 ∩ 可批量行 ∩ 选中集（specs/subagent-batch-edit.md R6）。
  const batchTargets = useMemo(
    () =>
      resolveBatchApplyTargets(filteredAgents).filter((agent) => selectedBatchIds.has(agent.id)),
    [filteredAgents, selectedBatchIds],
  );
  const batchSelectableAgents = useMemo(
    () => resolveBatchApplyTargets(filteredAgents),
    [filteredAgents],
  );
  const batchApplicableCount = batchSelectableAgents.length;

  /** 全部全选/全不选：勾选/取消当前筛选结果里所有可批量行（跨分组）。 */
  const toggleBatchAll = useCallback(
    (checked: boolean) => {
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        for (const agent of batchSelectableAgents) {
          if (checked) {
            next.add(agent.id);
          } else {
            next.delete(agent.id);
          }
        }
        return next;
      });
      setBatchResult(null);
    },
    [batchSelectableAgents],
  );

  // 过滤/作用域变化后裁剪选中集：选中 id 不在当前可见可批量集内即剔除。
  useEffect(() => {
    if (!batchMode) {
      return;
    }
    const visible = new Set(resolveBatchApplyTargets(filteredAgents).map((agent) => agent.id));
    setSelectedBatchIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [batchMode, filteredAgents]);

  // 分组统一设置弹层的目标集：按 key 从当前分组投影重算（保持透传基线新鲜）。
  const batchDialogGroup = useMemo(() => {
    if (!batchDialogGroupKey) {
      return null;
    }
    const resolveGroupName = (key: NonNullable<typeof batchDialogGroupKey>): string => {
      if (key.kind === "user") {
        return intl.formatMessage({ id: "settings.subagents.group.user" });
      }
      if (key.kind === "builtIn") {
        return intl.formatMessage({ id: "settings.subagents.group.builtIn" });
      }
      const items = pluginGroups.find(([pluginId]) => pluginId === key.pluginId)?.[1] ?? [];
      const head = items[0];
      return resolvePluginDisplayName(
        {
          name: head?.pluginName ?? key.pluginId,
          listing:
            (head?.pluginId ? pluginListingById.get(head.pluginId) : undefined) ??
            resolveUniquePluginListingByName(availablePlugins, head?.pluginName ?? key.pluginId),
        },
        locale,
      );
    };
    const resolveGroupItems = (
      key: NonNullable<typeof batchDialogGroupKey>,
    ): readonly AgentSummary[] => {
      if (key.kind === "user") {
        return groupedAgents.user;
      }
      if (key.kind === "builtIn") {
        return groupedAgents.builtIn;
      }
      return pluginGroups.find(([pluginId]) => pluginId === key.pluginId)?.[1] ?? [];
    };
    return {
      groupName: resolveGroupName(batchDialogGroupKey),
      targets: resolveBatchApplyTargets(resolveGroupItems(batchDialogGroupKey)),
    };
  }, [
    availablePlugins,
    batchDialogGroupKey,
    groupedAgents,
    intl,
    locale,
    pluginGroups,
    pluginListingById,
  ]);

  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label:
                currentEditingAgent?.name ??
                intl.formatMessage({ id: "settings.subagents.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingAgent
                ? intl.formatMessage({ id: "settings.subagents.edit" })
                : intl.formatMessage({ id: "settings.subagents.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingAgent
                ? intl.formatMessage({
                    id: "settings.subagents.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.subagents.addDescription",
                  })}
            </p>
          </div>

          <SubagentForm
            initial={currentEditingAgent ?? undefined}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            modelSelectGroups={subagentModelSelectGroups}
            onManageModels={onManageModels}
            saving={saving}
            onCancel={handleCancelForm}
            onDelete={handleDelete}
            onSave={handleSave}
            scopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
        </div>
      </div>
    );
  }

  const renderAgentList = (items: AgentSummary[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((agent, index) => (
        <div key={agent.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <AgentListRow
            agent={agent}
            pluginIconItem={
              agent.pluginId
                ? pluginIconItemById.get(agent.pluginId)
                : agent.pluginName
                  ? {
                      name: agent.pluginName,
                      listing: resolveUniquePluginListingByName(availablePlugins, agent.pluginName),
                    }
                  : undefined
            }
            isOperating={operatingAgentId === agent.id || refreshing}
            modelGroups={chatModelSelectGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            modelSelectGroups={subagentModelSelectGroups}
            batchMode={batchMode}
            batchChecked={batchMode && selectedBatchIds.has(agent.id)}
            batchApplying={batchApplying}
            onBatchCheckChange={handleBatchCheckChange}
            onModelOverrideChange={handleModelOverrideChange}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onToggle={handleToggle}
          />
        </div>
      ))}
    </div>
  );

  /**
   * 分组头行：批量模式渲染三态「全选本组」；普通模式渲染「…」批量菜单
   * （统一设置模型 / 本组恢复继承默认，specs/subagent-batch-edit.md R1）。
   */
  const renderGroupHead = (
    groupAgents: readonly AgentSummary[],
    groupKey: string,
    groupName: string,
    dialogKey: { kind: "user" } | { kind: "builtIn" } | { kind: "plugin"; pluginId: string },
    header: ReactNode,
    actions?: ReactNode,
  ) => {
    const check = batchMode ? resolveGroupBatchCheckState(groupAgents, selectedBatchIds) : null;
    const overridableCount = resolveBatchApplyTargets(groupAgents).length;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {check ? (
            <SubagentGroupSelectAll
              groupKey={groupKey}
              groupName={groupName}
              checkState={check.state}
              disabled={batchApplying || check.selectable.length === 0}
              onToggle={(checked) => handleBatchGroupCheck(groupAgents, checked)}
            />
          ) : null}
          {header}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!batchMode ? (
            <SubagentGroupBatchMenu
              groupKey={groupKey}
              groupName={groupName}
              overridableCount={overridableCount}
              disabled={batchApplying}
              onSetModels={() => setBatchDialogGroupKey(dialogKey)}
              onResetInherit={() => handleGroupBatchApply(groupAgents)}
            />
          ) : null}
          {actions}
        </div>
      </div>
    );
  };

  const hasSearchResultEmpty = Boolean(query.trim()) && filteredAgentCount === 0;
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
            <span>{intl.formatMessage({ id: "settings.subagents.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{filteredAgentCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.searchPlaceholder",
          })}
        />
        {batchMode ? (
          <label
            data-testid={TID_SUBAGENT_BATCH_SELECT_ALL}
            className={cn(
              "flex select-none items-center gap-2 text-ui-base text-foreground",
              (batchApplying || batchSelectableAgents.length === 0) &&
                "cursor-not-allowed opacity-60",
            )}
          >
            <Checkbox
              checked={
                batchTargets.length === 0
                  ? false
                  : batchTargets.length === batchSelectableAgents.length
                    ? true
                    : "indeterminate"
              }
              disabled={batchApplying || batchSelectableAgents.length === 0}
              aria-label={intl.formatMessage({ id: "settings.subagents.batch.selectAll.label" })}
              onCheckedChange={(checked) => toggleBatchAll(checked === true)}
            />
            {intl.formatMessage({ id: "settings.subagents.batch.selectAll.label" })}
          </label>
        ) : null}
        {batchMode ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={exitBatchMode}
            disabled={batchApplying}
          >
            <X data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.subagents.batch.bar.exit" })}
          </Button>
        ) : batchApplicableCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_SUBAGENT_BATCH_TRIGGER}
            onClick={enterBatchMode}
            disabled={loading || batchApplying}
          >
            <ListChecks data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.subagents.batch.entry" })}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {modelSelectionRead.state.status === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          <span>{intl.formatMessage({ id: "settings.subagents.modelLoadFailed" })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={modelSelectionRead.reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      {capability && !capability.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.subagents.userScopeDesktopOnly",
          })}
        </div>
      ) : null}

      {loading ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.subagents.empty" })} />
      ) : (
        <div className="space-y-6">
          <section
            className={query.trim() && groupedAgents.user.length === 0 ? "hidden" : "space-y-4"}
          >
            {renderGroupHead(
              groupedAgents.user,
              "user",
              intl.formatMessage({ id: "settings.subagents.group.user" }),
              { kind: "user" },
              <SettingsResourceGroupHeader
                count={groupedAgents.user.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.user",
                })}
              />,
              <SettingsResourceHeaderActions
                onRefresh={() => void Promise.all([refresh(), refreshMentionStore()])}
                onNew={batchMode ? undefined : canManageUserAgents ? handleAddNew : undefined}
                refreshing={refreshing}
              />,
            )}
            {groupedAgents.user.length > 0 ? (
              renderAgentList(groupedAgents.user)
            ) : (
              <PluginInstallEmptyState
                title={intl.formatMessage({ id: "settings.subagents.empty" })}
                description={intl.formatMessage({
                  id: "settings.subagents.addDescription",
                })}
                actions={
                  canManageUserAgents ? (
                    <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.create.action" })}
                    </Button>
                  ) : null
                }
              />
            )}
          </section>
          {pluginGroups.map(([pluginId, items]) => {
            const groupName = resolvePluginDisplayName(
              {
                name: items[0]?.pluginName ?? pluginId,
                listing:
                  (items[0]?.pluginId ? pluginListingById.get(items[0].pluginId) : undefined) ??
                  resolveUniquePluginListingByName(
                    availablePlugins,
                    items[0]?.pluginName ?? pluginId,
                  ),
              },
              locale,
            );
            return (
              <section key={pluginId} className="space-y-4">
                {renderGroupHead(
                  items,
                  `plugin:${pluginId}`,
                  groupName,
                  { kind: "plugin", pluginId },
                  <SettingsResourceGroupHeader count={items.length} title={groupName} />,
                )}
                {renderAgentList(items)}
              </section>
            );
          })}
          {groupedAgents.builtIn.length > 0 ? (
            <section className="space-y-4">
              {renderGroupHead(
                groupedAgents.builtIn,
                "builtIn",
                intl.formatMessage({ id: "settings.subagents.group.builtIn" }),
                { kind: "builtIn" },
                <SettingsResourceGroupHeader
                  count={groupedAgents.builtIn.length}
                  title={intl.formatMessage({
                    id: "settings.subagents.group.builtIn",
                  })}
                />,
              )}
              {renderAgentList(groupedAgents.builtIn)}
            </section>
          ) : null}
        </div>
      )}

      {batchMode ? (
        <SubagentModelBatchBar
          selectedCount={batchTargets.length}
          applying={batchApplying}
          progress={batchProgress}
          result={batchResult}
          disabled={loading || refreshing}
          modelGroups={chatModelSelectGroups}
          modelSelectionView={modelSelectionView}
          modelSelectionLoading={modelSelectionLoading}
          onValueChange={() => setBatchResult(null)}
          onApply={(value) => void applyBatchModelOverride(batchTargets, value)}
          onExit={exitBatchMode}
        />
      ) : null}

      {batchDialogGroup && batchDialogGroup.targets.length > 0 ? (
        <SubagentModelBatchDialog
          open
          groupName={batchDialogGroup.groupName}
          targetCount={batchDialogGroup.targets.length}
          disabled={batchApplying}
          modelGroups={chatModelSelectGroups}
          modelSelectionView={modelSelectionView}
          modelSelectionLoading={modelSelectionLoading}
          onOpenChange={(open) => {
            if (!open) {
              setBatchDialogGroupKey(null);
            }
          }}
          onApply={(value) => {
            const targets = batchDialogGroup.targets;
            setBatchDialogGroupKey(null);
            void applyBatchModelOverride(targets, value);
          }}
        />
      ) : null}
    </div>
  );
}
