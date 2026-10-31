/**
 * WorkspaceSidebar 批次 5 外迁：任务区工具栏受控组件（JSX 逐字迁移自
 * WorkspaceSidebar.tsx 的 workspaceTaskToolbar 闭包）。
 *
 * 性能契约不变：主文件仍以 useCallback 按原 deps 列表稳定 render prop，
 * 本组件是纯受控渲染叶子，不自带 memo（重建节律完全由调用侧闭包决定）。
 */
import type { CSSProperties, MutableRefObject, RefObject } from "react";
import {
  Archive,
  Clock3,
  Folder,
  Hash,
  ListFilter,
  Maximize2,
  MessageCircleCheck,
  MessageCirclePlus,
  Minimize2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { SidebarTaskSortBy } from "@/lib/sidebarTaskPreferences.js";
import type { SidebarTaskGroupTogglePresentation } from "@/WorkspaceSidebar/taskGroupTogglePresentation.js";
import type { SidebarTaskViewMode } from "@/WorkspaceSidebar/sidebarTaskViewMode.js";

export type PrimaryTaskMode = "workspace" | "grouped";

export interface WorkspaceSidebarTaskToolbarProps {
  activePrimaryTaskMode: PrimaryTaskMode;
  archivedTasksActionLabel: string;
  createGroupedTaskGroupAction: (() => void) | null;
  onArchivedActionsContainerChange: (node: HTMLDivElement | null) => void;
  onPrimaryTaskModeChange: (value: string) => void;
  onTaskSortByChange: (value: SidebarTaskSortBy) => void;
  onToggleAllTaskGroups: () => void;
  onToggleArchivedTasks: () => void;
  onWorkspaceTaskViewChange: (value: string) => void;
  primaryTaskIndicatorStyle: CSSProperties;
  primaryTaskTabsListRef: RefObject<HTMLDivElement | null>;
  primaryTaskTabTriggerRefs: MutableRefObject<Record<PrimaryTaskMode, HTMLButtonElement | null>>;
  showArchivedTasks: boolean;
  showTaskSortOptions: boolean;
  showTaskViewFilter: boolean;
  showWorkspaceViewOptions: boolean;
  taskSortBy: SidebarTaskSortBy;
  taskViewMode: SidebarTaskViewMode;
  toggleAllTaskGroupsPresentation: SidebarTaskGroupTogglePresentation | null;
  workspaceReadOnly: boolean;
  workspaceReadOnlyReason?: string;
  workspaceTaskViewValue: string;
}

export function WorkspaceSidebarTaskToolbar({
  activePrimaryTaskMode,
  archivedTasksActionLabel,
  createGroupedTaskGroupAction,
  onArchivedActionsContainerChange,
  onPrimaryTaskModeChange,
  onTaskSortByChange,
  onToggleAllTaskGroups,
  onToggleArchivedTasks,
  onWorkspaceTaskViewChange,
  primaryTaskIndicatorStyle,
  primaryTaskTabsListRef,
  primaryTaskTabTriggerRefs,
  showArchivedTasks,
  showTaskSortOptions,
  showTaskViewFilter,
  showWorkspaceViewOptions,
  taskSortBy,
  taskViewMode,
  toggleAllTaskGroupsPresentation,
  workspaceReadOnly,
  workspaceReadOnlyReason,
  workspaceTaskViewValue,
}: WorkspaceSidebarTaskToolbarProps) {
  const { intl } = useACodeIntl();
  return (
    <div className="pl-2.5 pr-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <Tabs
            value={activePrimaryTaskMode}
            onValueChange={onPrimaryTaskModeChange}
            className="w-fit shrink-0"
            aria-label={intl.formatMessage({
              id: "workspaceSidebar.organize",
            })}
          >
            {/* TabsList 默认横向态是 h-8；这里同步覆盖 variant，避免实际 Radix 横向态把外壳撑高。 */}
            <TabsList
              ref={primaryTaskTabsListRef}
              className="relative h-7 w-fit overflow-hidden rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0.5 left-0 rounded-full bg-background transition-[opacity,transform,width] duration-200 ease-out"
                style={primaryTaskIndicatorStyle}
              />
              <TabsTrigger
                ref={(node) => {
                  primaryTaskTabTriggerRefs.current.grouped = node;
                }}
                value="grouped"
                className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
              >
                <Hash aria-hidden="true" className="size-3 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "workspaceSidebar.organizeGrouped",
                  })}
                </span>
              </TabsTrigger>
              <TabsTrigger
                ref={(node) => {
                  primaryTaskTabTriggerRefs.current.workspace = node;
                }}
                value="workspace"
                className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
              >
                <Folder aria-hidden="true" className="size-3 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "workspaceSidebar.organizeByProject",
                  })}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {toggleAllTaskGroupsPresentation ? (
            <ControlHintTooltip
              title={intl.formatMessage({
                id: toggleAllTaskGroupsPresentation.messageId,
              })}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={intl.formatMessage({
                  id: toggleAllTaskGroupsPresentation.messageId,
                })}
                disabled={!toggleAllTaskGroupsPresentation.canToggle}
                onClick={onToggleAllTaskGroups}
              >
                {toggleAllTaskGroupsPresentation.areAllExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {taskViewMode === "grouped" ? (
            <ControlHintTooltip
              title={workspaceReadOnlyReason ?? intl.formatMessage({ id: "taskGroup.newGroup" })}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={intl.formatMessage({
                  id: "taskGroup.newGroup",
                })}
                disabled={workspaceReadOnly || !createGroupedTaskGroupAction}
                onClick={() => {
                  if (!workspaceReadOnly) {
                    createGroupedTaskGroupAction?.();
                  }
                }}
              >
                <Hash className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          ) : null}
          {showTaskViewFilter ? (
            <DropdownMenu>
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "workspaceSidebar.taskViewOptions",
                })}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-foreground-subtle hover:text-foreground"
                    aria-label={intl.formatMessage({
                      id: "workspaceSidebar.taskViewOptions",
                    })}
                  >
                    <ListFilter className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ControlHintTooltip>
              <DropdownMenuContent align="end" className="w-48 min-w-48">
                {showWorkspaceViewOptions ? (
                  <>
                    <DropdownMenuLabel>
                      {intl.formatMessage({
                        id: "workspaceSidebar.organize",
                      })}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={workspaceTaskViewValue}
                      onValueChange={onWorkspaceTaskViewChange}
                    >
                      <DropdownMenuRadioItem value="project">
                        <Folder className="size-4" />
                        {intl.formatMessage({
                          id: "workspaceSidebar.viewByWorkspace",
                        })}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="chronological">
                        <Clock3 className="size-4" />
                        {intl.formatMessage({
                          id: "workspaceSidebar.organizeChronologicalList",
                        })}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </>
                ) : null}
                {showWorkspaceViewOptions && showTaskSortOptions ? (
                  <DropdownMenuSeparator />
                ) : null}
                {showTaskSortOptions ? (
                  <>
                    <DropdownMenuLabel>
                      {intl.formatMessage({
                        id: "workspaceSidebar.sortBy",
                      })}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={taskSortBy}
                      onValueChange={(value) => {
                        if (value === "created" || value === "updated") {
                          onTaskSortByChange(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="updated">
                        <MessageCircleCheck className="size-4" />
                        {intl.formatMessage({
                          id: "workspaceSidebar.sortByUpdated",
                        })}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="created">
                        <MessageCirclePlus className="size-4" />
                        {intl.formatMessage({
                          id: "workspaceSidebar.sortByCreated",
                        })}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showArchivedTasks ? (
            <div
              ref={onArchivedActionsContainerChange}
              data-testid="archived-tasks-toolbar-actions"
              className="flex shrink-0 items-center"
            />
          ) : null}
          <ControlHintTooltip title={archivedTasksActionLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle hover:text-foreground data-[state=on]:bg-hover data-[state=on]:text-foreground"
              data-state={showArchivedTasks ? "on" : "off"}
              aria-label={archivedTasksActionLabel}
              onClick={onToggleArchivedTasks}
            >
              {showArchivedTasks ? <X className="size-3.5" /> : <Archive className="size-3.5" />}
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </div>
  );
}
