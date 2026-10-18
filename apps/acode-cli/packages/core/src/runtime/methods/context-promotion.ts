/**
 * 上下文晋升执行体（specs/failure-recovery-tracks.md 轨道 1 的唯一写入路径）。
 *
 * 机制参照 oh-my-pi (MIT) packages/coding-agent/src/session/session-maintenance.ts
 * （#promoteContextModel：溢出/阈值决策点先换更大窗口模型再考虑压缩；候选解析在
 * compact/promotion.ts，本文件只做 runtime 副作用编排），自撰实现，未复制代码。
 * omp 依赖其 model registry（fitContextWindow/getApiKey）与 ephemeral setModelTemporary；
 * ACode 的候选面是 ModelCatalogPort（宿主注册表活视图，disabledReason 已表达密钥/策略
 * 不可用），切换走会话模型选择的既有唯一写入路径（set + persist + ModelSelected），
 * 晋升持久生效、用户可随时手动切回（无 revert 面，见 spec「与 omp 的有意差异」）。
 *
 * 两个决策点共用本执行体，不得各自实现晋升：
 * - reactive 溢出：turn-model-step.ts recoverModelStepAfterContextExceeded（compaction 前置）；
 * - threshold 阈值：compact.ts autoCompactIfNeeded（shouldAutoCompact 命中后、compaction 前置）。
 */
import type { Model, ModelSelection } from "@acode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import {
  isContextPromotionEligibleTurn,
  resolveContextPromotionCandidate,
} from "../../compact/promotion.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { createTurnModel, persistRuntimeModelSelection } from "./turn-model.js";

type ContextPromotionTrigger = "overflow" | "threshold";

/**
 * 尝试把本轮执行模型晋升为同 provider 更大窗口的候选，成功后返回晋升模型。
 * undefined = 未晋升（无资格/无候选/工厂失败），调用方必须无缝落入既有压缩轨道
 * （fail-safe：本函数不抛错、不阻断恢复链）。
 *
 * 副作用（仅成功路径，顺序固定）：
 * 1. `state.contextPromotionAttempted = true`（先占位：每轮至多 1 次，重入直接出局）；
 * 2. `state.model` 换绑 + context 前缀按晋升模型重投影（turn.ts 同款纪律）；
 * 3. 会话选择切换：set + persist + ModelSelected（不许静默换模型：UI 模型指示器与
 *    transcript modelChange marker 都随事件更新）+ warn 日志。
 */
export async function tryPromoteContextModelForRecovery(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { trigger: ContextPromotionTrigger },
): Promise<Model | undefined> {
  const traceContext = state.turnTraceContext;
  const eligible = isContextPromotionEligibleTurn({
    promotionAttempted: state.contextPromotionAttempted === true,
    ...(state.modelSelectionScope ? { modelSelectionScope: state.modelSelectionScope } : {}),
    hasSubagentModelOverride: state.subagentModelOverride !== undefined,
    isUnattendedTurn: Boolean(state.automationId?.trim() || state.offPeakTaskId?.trim()),
  });
  if (!eligible) return undefined;

  const catalog = this.modelCatalogPort?.listModels();
  if (catalog === undefined || catalog.length === 0) return undefined;

  const currentModel = state.model;
  const currentWindow = currentModel.properties.contextWindow;
  const candidate = resolveContextPromotionCandidate({
    currentModel: {
      providerId: String(currentModel.providerId),
      modelId: String(currentModel.modelId),
      contextWindow: currentWindow,
    },
    catalog,
  });
  if (!candidate) return undefined;

  // reasoningLevel 仅在候选模型声明支持时随迁；否则缺席走工厂默认（不猜档位）。
  const previousSelection = this.getSessionModelSelection();
  const carriedReasoningLevel = previousSelection?.options?.reasoningLevel;
  const selection: ModelSelection = {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    ...(carriedReasoningLevel && candidate.reasoningLevels.includes(carriedReasoningLevel)
      ? { options: { reasoningLevel: carriedReasoningLevel } }
      : {}),
  };

  let promoted: Model;
  try {
    promoted = createTurnModel(this, { selection });
  } catch (error) {
    // 目录活视图与工厂之间仍可能失效（provider client 掉线等）：放弃晋升走压缩。
    this.logger?.warn("Context promotion model creation failed; falling back to compaction", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "compact.context_promotion.model_creation_failed",
      module: "core.runtime",
      targetModelId: candidate.modelId,
      targetProviderId: candidate.providerId,
      trigger: options.trigger,
    });
    return undefined;
  }
  const promotedWindow = promoted.properties.contextWindow;
  // 防御：目录条目与工厂物化结果不一致（窗口没有可证更大）时放弃晋升，宁可压缩。
  if (
    typeof promotedWindow !== "number" ||
    !Number.isFinite(promotedWindow) ||
    (typeof currentWindow === "number" && promotedWindow <= currentWindow)
  ) {
    this.logger?.warn("Context promotion target window not provably larger; skipping promotion", {
      ...traceContextToLogContext(traceContext),
      currentContextWindow: currentWindow,
      event: "compact.context_promotion.window_recheck_failed",
      module: "core.runtime",
      promotedContextWindow: promotedWindow,
      trigger: options.trigger,
    });
    return undefined;
  }

  // 先占位再副作用：同轮重入（溢出与阈值决策点先后触发）第二次直接出局。
  state.contextPromotionAttempted = true;
  state.model = promoted;
  // context 前缀按晋升模型重投影（同 provider，渲染面兼容）；返回本轮请求 entries 的
  // 新投影，写回 turn-local 状态，重试请求即按晋升模型发出。
  state.turnRequestState.entries = rebuildContextPrefix(this, {
    model: promoted,
    turnRequestEntries: state.turnRequestState.entries,
  });

  const previousLabel = `${String(currentModel.providerId)}/${String(currentModel.modelId)}`;
  const promotedLabel = `${candidate.providerId}/${candidate.modelId}`;
  this.setSessionModelSelection(cloneModelSelection(selection));
  await persistRuntimeModelSelection(this, selection);
  await this.emitModelSelected({
    model: promoted,
    modelSelection: selection,
    effectiveReasoningLevel: promoted.options.reasoningLevel,
    ...(previousSelection !== undefined ? { previousModelSelection: previousSelection } : {}),
    supportedThoughtLevels: promoted.optionSpecs.reasoningLevel.values,
    traceContext,
  });
  // 不许静默换模型：warn 级日志固定携带 from/to/trigger/窗口对，与 ModelSelected 事件
  // （UI 指示器 + modelChange marker）共同构成用户可见告知（spec「晋升执行语义」）。
  this.logger?.warn("Context promotion applied before compaction", {
    ...traceContextToLogContext(traceContext),
    currentContextWindow: currentWindow,
    event: "compact.context_promotion.applied",
    from: previousLabel,
    module: "core.runtime",
    promotedContextWindow: promotedWindow,
    status: "completed",
    to: promotedLabel,
    trigger: options.trigger,
  });
  return promoted;
}
