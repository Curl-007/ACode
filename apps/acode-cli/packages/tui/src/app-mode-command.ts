import React from "react";
import type { ModeCommandSelectionState } from "./app-model.js";
import { TUI_SWITCHABLE_MODES } from "./app-mode.js";
import { matchesText } from "./state.js";
import type { TuiModeOption, TuiSwitchableMode } from "./types.js";

const MODE_COMMAND_NAME = "/mode";
const MODE_COMMAND_WITH_SPACE = `${MODE_COMMAND_NAME} `;

const MODE_DESCRIPTIONS: Record<TuiSwitchableMode, string> = {
  build: "Ask before each file changes.",
  edit: "Edit selected files or relevant workspace files automatically.",
  plan: "Inspect the code and present a plan before editing.",
  yolo: "Edit and run commands with fewer confirmations.",
  // dontAsk（specs/permission-adjudication-batch2.md R1）：语义 = 无人可问即拒绝——
  // 规则已放行的一律照常执行，其余全部当场拒掉，永远不弹审批窗。
  dontAsk: "Never prompt: anything not already allowed by rules is denied on the spot.",
};

// dontAsk 只进 /mode 菜单、不进键盘循环（app-mode.ts TUI_SWITCHABLE_MODES 保持四档）：
// Shift+Tab 循环误触会切进「未白名单全拒」档，打断正在跑的活；显式敲 /mode 才是
// 有意识的选择。菜单选项 = 循环四档 + dontAsk 尾项。
const TUI_MODE_OPTIONS: readonly TuiModeOption[] = [
  ...TUI_SWITCHABLE_MODES.map((mode) => ({
    description: MODE_DESCRIPTIONS[mode],
    id: mode,
    label: formatModeLabel(mode),
  })),
  {
    description: MODE_DESCRIPTIONS.dontAsk,
    id: "dontAsk",
    label: formatModeLabel("dontAsk"),
  },
];

function modeCommandQuery(draft: string): string | undefined {
  if (draft === MODE_COMMAND_NAME) return "";
  if (draft.startsWith(MODE_COMMAND_WITH_SPACE)) {
    return draft.slice(MODE_COMMAND_WITH_SPACE.length);
  }
  if (draft.startsWith(MODE_COMMAND_NAME) && !/\s/u.test(draft)) {
    const compactQuery = draft.slice(MODE_COMMAND_NAME.length);
    return isCompactModeQuery(compactQuery) ? compactQuery : undefined;
  }
  return undefined;
}

function filterModeOptions(draft: string): readonly TuiModeOption[] {
  const query = modeCommandQuery(draft);
  if (query === undefined) return [];
  return TUI_MODE_OPTIONS.filter((mode) =>
    matchesText(query, [
      mode.id,
      mode.label,
      mode.description,
      `${MODE_COMMAND_WITH_SPACE}${mode.id}`,
    ]),
  );
}

function reconcileModeCommandSelection(draft: string): ModeCommandSelectionState | undefined {
  return modeCommandQuery(draft) !== undefined ? { selectedIndex: 0 } : undefined;
}

function selectedModeOption(
  submittedValue: string,
  modeSelection: ModeCommandSelectionState | undefined,
  modes: readonly TuiModeOption[],
): TuiModeOption | undefined {
  if (!modeSelection || modeCommandQuery(submittedValue) === undefined || modes.length === 0) {
    return undefined;
  }
  return modes[Math.max(0, Math.min(modeSelection.selectedIndex, modes.length - 1))];
}

export function useModeCommandController(draft: string): {
  filteredOptions: readonly TuiModeOption[];
  reconcileDraft: (value: string) => ModeCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModeOption | undefined;
  selection: ModeCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModeCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<ModeCommandSelectionState | undefined>();
  const filteredOptions = React.useMemo(() => filterModeOptions(draft), [draft]);
  const reconcileDraft = React.useCallback((value: string) => {
    const nextSelection = reconcileModeCommandSelection(value);
    setSelection(nextSelection);
    return nextSelection;
  }, []);
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModeOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
  };
}

function formatModeLabel(mode: TuiSwitchableMode): string {
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}

function isCompactModeQuery(query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return TUI_MODE_OPTIONS.some(
    (mode) =>
      mode.id.startsWith(normalizedQuery) || mode.label.toLowerCase().startsWith(normalizedQuery),
  );
}
