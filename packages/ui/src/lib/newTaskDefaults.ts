import type { ModelSelection, NewTaskDefaults } from "@acode/shared";
import { normalizeNewTaskDefaultMode } from "@acode/shared";
import type { SubmissionMode } from "@acode/shared/acode-protocol-v4";
import { validateModelSelectionOptions, type ModelSelectionView } from "@acode/provider";

/**
 * 设置中已固定的运行时项；null 表示该项按应用原有规则取值（见 docs/specs/new-task-defaults.md）。
 *
 * speed 与 reasoningLevel 同口径：固定值必须命中目标模型声明的 Option Spec，
 * 不命中时保留既有解析结果，不回写设置。
 */
interface ResolvedNewTaskDefaults {
  readonly mode: SubmissionMode | null;
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  readonly reasoningLevel: string | null;
  readonly speed: string | null;
}

/**
 * 归一化设置中的已固定项；开关关闭（或开着但一项都没固定）返回 null，
 * 让新建任务走与升级前完全一致的默认路径，不产生第二条分叉。
 */
export function resolveNewTaskDefaults(
  settings: NewTaskDefaults | null | undefined,
): ResolvedNewTaskDefaults | null {
  if (!settings?.enabled) return null;
  const mode = normalizeNewTaskDefaultMode(settings.mode);
  const model = settings.model ?? null;
  const reasoningLevel = settings.reasoningLevel ?? null;
  const speed = settings.speed ?? null;
  if (!mode && !model && !reasoningLevel && !speed) return null;
  return { mode, model, reasoningLevel, speed };
}

/**
 * 把已固定的档位叠加到新建任务初始选择上。
 *
 * 固定值必须命中目标模型声明的 Option Spec；不命中时保留既有解析结果（该模型的默认档位），
 * 既不阻断新建任务，也不回写设置——设置保留用户原意图，模型恢复后重新生效。
 * 校验复用 Registry 的 `validateModelSelectionOptions`，UI 不另写一份档位规则。
 */
export function applyNewTaskDefaults(
  view: ModelSelectionView,
  selection: ModelSelection | null,
  defaults: ResolvedNewTaskDefaults | null,
): ModelSelection | null {
  if (!selection || !defaults) return selection;
  const model = findModel(view, selection);
  if (!model) return selection;
  const withReasoning = applyFixedReasoningLevel(model, selection, defaults.reasoningLevel);
  return applyFixedSpeed(model, withReasoning, defaults.speed);
}

type OptionSourceModel = NonNullable<ReturnType<typeof findModel>>;

function applyFixedReasoningLevel(
  model: OptionSourceModel,
  selection: ModelSelection,
  fixed: string | null,
): ModelSelection {
  if (!fixed || fixed === selection.options?.reasoningLevel) return selection;
  const candidate: ModelSelection = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { ...selection.options, reasoningLevel: fixed },
  };
  return validateModelSelectionOptions(model, candidate).ok ? candidate : selection;
}

function applyFixedSpeed(
  model: OptionSourceModel,
  selection: ModelSelection,
  fixed: string | null,
): ModelSelection {
  if (!fixed || fixed === selection.options?.speed) return selection;
  const candidate: ModelSelection = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { ...selection.options, speed: fixed },
  };
  return validateModelSelectionOptions(model, candidate).ok ? candidate : selection;
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  return view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
}
