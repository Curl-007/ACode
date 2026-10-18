/**
 * 上下文溢出的「模型晋升」候选策略（specs/failure-recovery-tracks.md 轨道 1）。
 *
 * 机制参照 oh-my-pi (MIT) packages/coding-agent/src/session/session-maintenance.ts
 * （#tryContextPromotion / #promoteContextModel / resolveContextPromotionTarget）与
 * session/role-models.ts（resolveContextPromotionConfiguredTarget），自撰实现，未复制代码。
 * omp 的晋升目标来自模型显式配置 contextPromotionTarget；ACode 无该配置面，候选改为
 * 从现有 ModelCatalogPort 目录推导：同 provider、窗口可证更大、未禁用。
 *
 * 本文件是纯策略（无 IO、无 runtime 依赖）；执行体在
 * runtime/methods/context-promotion.ts（唯一写入路径）。
 */

/** 当前轮实际持有的模型身份与窗口（来自 state.model，不是会话选择——两者可能不同）。 */
interface ContextPromotionCurrentModel {
  providerId: string;
  modelId: string;
  /** 模型声明的上下文窗口；未知/非正数 = 无法证明候选更大 ⇒ 不可晋升（fail-safe）。 */
  contextWindow: number | undefined;
}

/** ModelCatalogPort.listModels() 条目的结构化子集（contracts ModelCatalogEntry 同形）。 */
interface ContextPromotionCatalogEntry {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  /** 目录标记的「当前会话选择」条目；晋升不选它（即便 modelId 巧合不同）。 */
  current?: boolean;
  /** 不可选用理由（未配密钥/被策略禁用）；在场即非候选。 */
  disabledReason?: string;
  reasoningLevels?: readonly string[];
}

interface ContextPromotionCandidate {
  providerId: string;
  modelId: string;
  contextWindow: number;
  /** 候选支持的推理档位；执行体据此决定 reasoningLevel 是否随迁。 */
  reasoningLevels: readonly string[];
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 解析晋升候选；undefined = 无候选，调用方必须跳过晋升直接走压缩（fail-safe）。
 *
 * 规则（specs/failure-recovery-tracks.md「晋升候选」）：
 * 1. 同 provider（跨 provider 涉及账号/计费面，波外）；
 * 2. 非当前模型且非目录 current 条目；
 * 3. 未禁用（disabledReason 缺席）；
 * 4. 双方窗口都是有限正数且候选窗口严格更大——当前窗口未知即无法证明，不猜；
 * 5. 确定性：取最小的更大窗口（最小充分跳变，成本保守），同窗口按 modelId 字典序。
 */
export function resolveContextPromotionCandidate(input: {
  currentModel: ContextPromotionCurrentModel;
  catalog: readonly ContextPromotionCatalogEntry[];
}): ContextPromotionCandidate | undefined {
  const currentWindow = input.currentModel.contextWindow;
  if (!isPositiveFinite(currentWindow)) return undefined;

  let best: ContextPromotionCandidate | undefined;
  for (const entry of input.catalog) {
    if (entry.providerId !== input.currentModel.providerId) continue;
    if (entry.modelId === input.currentModel.modelId) continue;
    if (entry.current === true) continue;
    if (entry.disabledReason !== undefined) continue;
    if (!isPositiveFinite(entry.contextWindow)) continue;
    if (entry.contextWindow <= currentWindow) continue;

    const candidate: ContextPromotionCandidate = {
      providerId: entry.providerId,
      modelId: entry.modelId,
      contextWindow: entry.contextWindow,
      reasoningLevels: entry.reasoningLevels ?? [],
    };
    if (
      best === undefined ||
      candidate.contextWindow < best.contextWindow ||
      (candidate.contextWindow === best.contextWindow && candidate.modelId < best.modelId)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** 钉住轮事实的结构化子集（RegularTurnLoopState 同形字段，纯判定不依赖 runtime 类型）。 */
interface ContextPromotionTurnFacts {
  /** 本轮是否已晋升过（每轮至多 1 次）。 */
  promotionAttempted: boolean;
  /** execution = Active Model 被显式钉住（submission/guide 语义），不得改写。 */
  modelSelectionScope?: "execution";
  /** subagent 显式模型 override 在场 = 选型被钉住。 */
  hasSubagentModelOverride: boolean;
  /** 无人值守轮（automation/off-peak）：用户不在场，不能替用户切换计费模型。 */
  isUnattendedTurn: boolean;
}

/**
 * 本轮是否有资格发起晋升。任何钉住/无人值守/已晋升事实都直接取消资格，
 * 调用方无缝落入既有压缩轨道（fail-safe，绝不阻断恢复链）。
 */
export function isContextPromotionEligibleTurn(facts: ContextPromotionTurnFacts): boolean {
  if (facts.promotionAttempted) return false;
  if (facts.modelSelectionScope === "execution") return false;
  if (facts.hasSubagentModelOverride) return false;
  if (facts.isUnattendedTurn) return false;
  return true;
}
