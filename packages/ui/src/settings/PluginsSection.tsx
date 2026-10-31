/* eslint-disable max-lines -- 共享能力外壳聚合 Scope，并承载 Plugin tabs 与独立 Commands 入口（PluginList 已外迁 settings/plugins/）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { getPathLeaf } from "@/lib/path.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { PluginEmptyState } from "@/settings/plugins/PluginEmptyState.js";
import { PluginList } from "@/settings/plugins/PluginList.js";
import {
  getPluginTabCountClass,
  normalizePluginTab,
  type PluginTab,
  type PluginTabTarget,
} from "@/settings/plugins/pluginTabs.js";

type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: WorkspaceTabState };

interface PluginsSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  initialTab?: PluginTabTarget;
  initialScopeKey?: string;
  mode?: "plugin" | "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
}

export function PluginsSection({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  initialTab = "plugins",
  initialScopeKey,
  mode = "plugin",
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
}: PluginsSectionProps) {
  const { intl } = useACodeIntl();
  const tabs = useTabStore((state) => state.tabs);
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    const scopedTabs = tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = getPluginWorkspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (
      activeWorkspacePath &&
      !activeWorkspaceIdentity?.trim() &&
      !scopedTabs.some(
        (tab) => getPluginWorkspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
      )
    ) {
      // 启动恢复可能先恢复 activeWorkspacePath，再异步补齐 tabs；此时不能把
      // Workspace 配置范围误显示成不可用，否则用户无法读取/修改项目配置。
      scopedTabs.push({
        id: `__active_workspace__:${activeWorkspaceIdentity?.trim() || activeWorkspacePath}`,
        kind: "workspace",
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        label: getPathLeaf(activeWorkspacePath) || activeWorkspacePath,
      });
    }
    return scopedTabs;
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabs]);
  const preferredHost = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          getPluginWorkspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""),
      ) ??
      workspaceTabs[0] ??
      null,
    [activeWorkspaceIdentity, activeWorkspacePath, workspaceTabs],
  );
  const [pickedScopeKey, setPickedScopeKey] = useState(() => initialScopeKey?.trim() || "user");
  const selectedScopeKey = pickedScopeKey;
  const fixedTab: PluginTabTarget | null =
    mode === "mcp" ? "mcps" : mode === "skill" ? "skills" : mode === "command" ? "commands" : null;
  const [interactiveTab, setInteractiveTab] = useState<PluginTab>(() =>
    normalizePluginTab(initialTab),
  );
  useEffect(() => setInteractiveTab(normalizePluginTab(initialTab)), [initialTab]);
  useEffect(() => {
    setPickedScopeKey(initialScopeKey?.trim() || "user");
  }, [initialScopeKey]);
  const selectedTab = fixedTab ?? interactiveTab;
  const [searchQueries, setSearchQueries] = useState<Record<PluginTabTarget, string>>({
    plugins: "",
    mcps: "",
    skills: "",
    commands: "",
  });
  const [capabilityCounts, setCapabilityCounts] = useState<Record<PluginTabTarget, number>>({
    plugins: 0,
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  const activeSearchQuery = searchQueries[selectedTab];
  const selectedScope: PluginScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => getPluginWorkspaceKey(candidate) === selectedScopeKey);
    return tab ? { kind: "workspace", key: getPluginWorkspaceKey(tab), tab } : { kind: "user", key: "user" };
  }, [selectedScopeKey, workspaceTabs]);
  const openPluginStoreForSelectedScope = useCallback(
    (_returnScopeKey?: string, intent?: "add-marketplace") => {
      // Workspace 是已安装 Plugin 的配置视图，不提供 Marketplace 入口；市场只在 User
      // 视图中负责 package/cache 生命周期。
      if (selectedScope.kind !== "user") return;
      onOpenPluginStore("user", intent);
    },
    [onOpenPluginStore, selectedScope.kind],
  );
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : preferredHost;
  const effectiveMcpScopeKey =
    mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : selectedScopeKey;
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? preferredHost);
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : selectedScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? preferredHost);

  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  useEffect(() => {
    if (
      pickedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === pickedScopeKey)
    ) {
      // 市场返回记录的是具体 workspace identity；目标已关闭或断连时，
      // 静默选中 User 会让用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
      setPickedScopeKey("user");
      toast(
        intl.formatMessage({
          id: "settings.plugin.scopeUnavailableFallback",
        }),
      );
    }
  }, [intl, pickedScopeKey, workspaceTabs]);
  const selectedTargetKey = target ? getPluginWorkspaceKey(target) : "";

  const updatePluginCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.plugins === count ? current : { ...current, plugins: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);

  return (
    <div className="space-y-6">
      {mode === "plugin" &&
      showMarketplaceBreadcrumb &&
      !pluginDetailOpen &&
      !mcpEditorOpen &&
      !skillDetailOpen ? (
        <SettingsBreadcrumbReporter
          items={[
            {
              label: intl.formatMessage({
                id: "settings.plugins.title",
              }),
            },
          ]}
          onSectionSelect={openPluginStoreForSelectedScope}
        />
      ) : null}
      <Tabs
        value={selectedTab}
        onValueChange={(value) => {
          if (mode === "plugin") {
            setInteractiveTab(normalizePluginTab(value as PluginTabTarget));
          }
        }}
      >
        {!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <PluginScopeMenu
                align="start"
                selectedScopeKey={selectedScopeKey}
                triggerTestId="plugin-settings-scope-trigger"
                userOptionTestId="plugin-settings-scope-user-option"
                workspaceOptionTestIdPrefix="plugin-settings-scope-option"
                workspaceTabs={workspaceTabs}
                onScopeKeyChange={setPickedScopeKey}
              />
              <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
              {mode === "plugin" ? (
                <TabsList variant="line" className="h-7 max-w-full gap-1 overflow-x-auto p-0">
                  <TabsTrigger
                    value="plugins"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.plugins",
                    })}
                    <span className={getPluginTabCountClass("plugins", selectedTab)}>
                      {capabilityCounts.plugins}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="mcps"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.mcps",
                    })}
                    <span className={getPluginTabCountClass("mcps", selectedTab)}>
                      {capabilityCounts.mcps}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="skills"
                    className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                  >
                    {intl.formatMessage({
                      id: "settings.plugin.tab.skills",
                    })}
                    <span className={getPluginTabCountClass("skills", selectedTab)}>
                      {capabilityCounts.skills}
                    </span>
                  </TabsTrigger>
                </TabsList>
              ) : (
                <div
                  data-independent-capability-count="true"
                  className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
                >
                  <span>
                    {intl.formatMessage({
                      id:
                        mode === "mcp"
                          ? "settings.plugin.tab.mcps"
                          : mode === "skill"
                            ? "settings.plugin.tab.skills"
                            : "settings.plugin.tab.commands",
                    })}
                  </span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {mode === "mcp"
                      ? capabilityCounts.mcps
                      : mode === "skill"
                        ? capabilityCounts.skills
                        : capabilityCounts.commands}
                  </span>
                </div>
              )}
            </div>
            <SettingsSearchInput
              data-testid="plugin-settings-search"
              containerClassName="w-full sm:ml-auto sm:w-64"
              clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
              value={activeSearchQuery}
              onClear={() => {
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: "",
                }));
              }}
              onChange={(event) => {
                const value = event.target.value;
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: value,
                }));
              }}
              placeholder={intl.formatMessage({
                id:
                  selectedTab === "plugins"
                    ? "settings.plugin.plugins.searchPlaceholder"
                    : selectedTab === "mcps"
                      ? "settings.mcp.searchPlaceholder"
                      : selectedTab === "skills"
                        ? "settings.skills.searchPlaceholder"
                        : "settings.commands.searchPlaceholder",
              })}
            />
          </div>
        ) : null}
        {mode === "plugin" ? (
          <TabsContent
            forceMount
            value="plugins"
            className={
              pluginDetailOpen
                ? "data-[state=inactive]:hidden"
                : "mt-6 data-[state=inactive]:hidden"
            }
          >
            <PluginList
              target={target}
              configScope={selectedScope.kind === "user" ? "user" : "workspace"}
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              searchQuery={searchQueries.plugins}
              onAdd={selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined}
              onCreateTask={onCreateTask}
              onDetailOpenChange={setPluginDetailOpen}
              onOpenPluginStore={openPluginStoreForSelectedScope}
              showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
              onVisibleCountChange={updatePluginCount}
            />
          </TabsContent>
        ) : null}
        {mode === "plugin" || mode === "mcp" ? (
          <TabsContent
            forceMount
            value="mcps"
            className={
              mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {mcpTarget ? (
              <McpSettingsSection
                workspacePath={mcpTarget.workspacePath}
                workspaceIdentity={mcpTarget.workspaceIdentity}
                remoteSessionId={mcpTarget.remoteSessionId}
                remoteTarget={mcpTarget.remoteTarget}
                localWorkspacePath={mcpTarget.localWorkspacePath}
                scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.mcps}
                onVisibleCountChange={updateMcpCount}
                onEditorOpenChange={handleMcpEditorOpenChange}
                onFormScopeKeyChange={setMcpFormScopeKey}
                onOpenPluginStore={
                  selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                }
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
              />
            ) : (
              <PluginEmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "plugin" || mode === "skill" ? (
          <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
            {target ? (
              <SkillsSection
                workspacePath={target.workspacePath}
                workspaceIdentity={target.workspaceIdentity}
                remoteSessionId={target.remoteSessionId}
                remoteTarget={target.remoteTarget}
                scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                searchQuery={searchQueries.skills}
                onCreateTask={onCreateTask}
                onDetailOpenChange={setSkillDetailOpen}
                onOpenPluginStore={
                  selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                }
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                reportDetailBreadcrumb={mode === "plugin"}
                onVisibleCountChange={updateSkillCount}
              />
            ) : (
              <PluginEmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "command" ? (
          <TabsContent
            forceMount
            value="commands"
            className={
              commandEditorOpen
                ? "data-[state=inactive]:hidden"
                : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {commandTarget ? (
              <CommandsSection
                workspacePath={commandTarget.workspacePath}
                workspaceIdentity={commandTarget.workspaceIdentity}
                scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.commands}
                onVisibleCountChange={updateCommandCount}
                onEditorOpenChange={setCommandEditorOpen}
                onFormScopeKeyChange={setCommandFormScopeKey}
              />
            ) : (
              <PluginEmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
