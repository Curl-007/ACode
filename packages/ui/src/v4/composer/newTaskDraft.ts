import type { ModelSelectionView } from "@acode/services";
import type { NewTaskDefaults } from "@acode/shared";
import type { DefaultReasoningLevelPick } from "@acode/provider";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { applyNewTaskDefaults, resolveNewTaskDefaults } from "@/lib/newTaskDefaults.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/**
 * 普通新任务初始化；保留 Recent 原意图，由公共 View 解析有效选择。
 *
 * `settings` 是设置页「新建任务默认值」：已固定的模型身份优先作为解析种子，已固定的档位在
 * 解析结果上叠加并通过目标模型 Option Spec 校验；未固定项保持 Recent + 模型默认档位的既有语义。
 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  settings?: NewTaskDefaults | null,
  reasoningPick?: DefaultReasoningLevelPick,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  const defaults = resolveNewTaskDefaults(settings);
  const resolved = resolveDraftInitialModelSelection(
    view,
    defaults?.model ?? recent?.modelSelection ?? null,
    reasoningPick,
  );
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: defaults?.mode ?? (recent?.mode === "plan" ? "build" : (recent?.mode ?? "build")),
    planEnabled: false,
    modelSelection: applyNewTaskDefaults(view, resolved.selection, defaults) ?? undefined,
  };
}

/** 空 Root 草稿的旧默认值只在用户尚未明确改选时升级；正文和真实会话不走这条路。 */
export function refreshUneditedNewTaskDefaults(
  draft: V4ComposerDraft,
  view: ModelSelectionView,
  settings?: NewTaskDefaults | null,
  reasoningPick?: DefaultReasoningLevelPick,
): V4ComposerDraft {
  if (draft.modelSelectionEdited || draft.text.trim()) return draft;
  const resolved = resolveDraftInitialModelSelection(
    view,
    draft.modelSelection ?? null,
    reasoningPick,
  );
  // 目录刷新走与初始化同一条叠加：否则「重新推导默认档」会把用户固定的档位覆盖掉。
  const next = applyNewTaskDefaults(view, resolved.selection, resolveNewTaskDefaults(settings));
  if (
    !next ||
    (draft.modelSelection &&
      (next.providerId !== draft.modelSelection.providerId ||
        next.modelId !== draft.modelSelection.modelId)) ||
    next.options?.reasoningLevel === draft.modelSelection?.options?.reasoningLevel
  )
    return draft;
  return { ...draft, modelSelection: next };
}
