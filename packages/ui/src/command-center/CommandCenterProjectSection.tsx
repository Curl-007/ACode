import type { ReactNode } from "react";
import { FolderIcon } from "lucide-react";
import { CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { quickPickItemClassName } from "@/quickpick/quickPickStyles.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function filterCommandCenterProjects(
  tabs: readonly WorkspaceTabState[],
  query: string,
): WorkspaceTabState[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      tab.label.toLocaleLowerCase().includes(normalizedQuery) ||
      tab.workspacePath.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

export function CommandCenterProjectSection({
  rows,
  query,
  showEmpty,
  onSelect,
  children,
}: {
  rows: WorkspaceTabState[];
  query: string;
  showEmpty: boolean;
  onSelect: (tab: WorkspaceTabState) => void;
  children?: ReactNode;
}) {
  const { intl } = useACodeIntl();
  if (rows.length === 0 && !showEmpty) return null;
  return (
    <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.projects" })}>
      {rows.length === 0 ? (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "commandCenter.empty.projects" })}
        </CommandEmpty>
      ) : null}
      {rows.map((tab) => (
        <CommandItem
          key={tab.workspaceIdentity?.trim() || tab.workspacePath}
          value={`project:${tab.id}`}
          className={quickPickItemClassName}
          onSelect={() => onSelect(tab)}
          title={`${tab.label}\n${tab.workspacePath}`}
        >
          <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
            <span className="truncate text-ui-base leading-5 text-foreground">
              <HighlightedMatchText text={tab.label} query={query} />
            </span>
            <span className="truncate font-mono text-ui-sm leading-4 text-foreground-subtle">
              <HighlightedMatchText text={tab.workspacePath} query={query} />
            </span>
          </span>
        </CommandItem>
      ))}
      {children}
    </CommandGroup>
  );
}
