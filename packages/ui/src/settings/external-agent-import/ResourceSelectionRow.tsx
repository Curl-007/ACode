import { CheckIcon } from "lucide-react";
import type {
  SettingsSyncAgentSummary,
  SettingsSyncSourceScope,
} from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import {
  getResourceSelectionKey,
  type ImportItemSummary,
  type ImportResourceCategory,
} from "./importModel.js";

/**
 * 外部 Agent 导入向导的单条资源勾选行（自 ExternalAgentImportDialog.tsx 迁出，
 * 维持该上帝组件的行数 ratchet 不增长；行为逐字不变）。被 skills/commands/plugins/mcpServers
 * 四类共用，只依赖纯模型与展示组件。
 */
export function ResourceSelectionRow({
  agent,
  category,
  sourceScope,
  selected,
  item,
  onToggleSelection,
}: {
  agent: SettingsSyncAgentSummary;
  category: ImportResourceCategory;
  sourceScope: SettingsSyncSourceScope;
  selected: Set<string>;
  item: ImportItemSummary;
  onToggleSelection: (key: string) => void;
}) {
  const itemKey = getResourceSelectionKey({
    agent: agent.agent,
    category,
    sourceScope,
    resourcePath: item.path,
  });
  const checked = selected.has(itemKey);

  return (
    <button
      type="button"
      onClick={() => onToggleSelection(itemKey)}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
            checked && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {checked ? <CheckIcon className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 truncate text-ui-base text-foreground">{item.name}</span>
        {"version" in item && item.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {item.version.startsWith("v") ? item.version : `v${item.version}`}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}