import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import type { EffectiveModelSelectionResult } from "@acode/shared/model-selection";

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected / 未选择模型",
  "account-connection-unavailable": "Account connection unavailable / 当前账号连接不可用",
  "provider-not-found": "Provider unavailable / 供应商不存在或不可用",
  "model-not-found": "Model unavailable / 模型不存在或不可用",
  "reasoning-level-missing": "No reasoning level selected / 未选择思考档位",
  "reasoning-level-not-supported": "Reasoning level unsupported / 不支持所选思考档位",
  // 1.0.3 给 shared selectionIssue 联合扩了 speed 两成员（model-selection.ts），本消费方 satisfies
  // Record 要求全覆盖却漏改，typecheck 红。按 reasoning-level 两条对称补齐（术语取 UI「模型速度」）。
  "speed-missing": "No model speed selected / 未选择模型速度",
  "speed-not-supported": "Model speed unsupported / 不支持所选模型速度",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/**
 * 空选择（「继承默认」）的派生来源（specs/agent-teams-derived-config.md R4.1）：
 * `app-default` = 应用配置默认模型环；`parent-session` = 父（派发方）会话模型环。
 * 调用方据此决定可见性义务：`requireExplicitModelSelection` 的 profile 走
 * `parent-session` 环时必须发用户可见 notice（R4「无感知不回退」口径）。
 */
export interface SubagentSelectionInheritance {
  readonly source: "app-default" | "parent-session";
}

/** 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  /** 应用配置默认模型（R4.1 链环 2）；registry 解析失败时跳过该环继续下一环。 */
  appDefaultSelection?: ModelSelection | null;
  requireExplicitModelSelection?: boolean;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): {
  hasConcreteModel: boolean;
  selection: ModelSelection;
  inheritance?: SubagentSelectionInheritance;
} {
  const explicit = input.profileSelection;
  const resolve = (selection: ModelSelection): EffectiveModelSelectionResult =>
    input.resolveSelection
      ? input.resolveSelection(cloneModelSelection(selection))
      : { effectiveSelection: selection };

  // R4.1：显式标记且 profile/override 皆空时不再立即 fail-closed——先走完
  // 应用默认 → 父会话两环（父会话环的可见性义务由调用方按 inheritance 履行），
  // 全链皆空才 fail-closed（消息列举全部配置途径）。
  const explicitMissing =
    input.requireExplicitModelSelection === true && !explicit && !input.overrideSelection;

  if (input.overrideSelection) {
    return {
      hasConcreteModel: explicit != null,
      selection: cloneModelSelection(input.overrideSelection),
    };
  }
  if (explicit) {
    const result = resolve(explicit);
    if (!result.effectiveSelection || result.selectionIssue) {
      throw selectionFailure(result, input.overrideSelection, explicit, input.parentSelection);
    }
    return { hasConcreteModel: true, selection: cloneModelSelection(result.effectiveSelection) };
  }
  // 空选择链环 2：应用配置默认模型（经 registry 解析；解析失败不报错，落下一环）。
  if (input.appDefaultSelection) {
    const result = resolve(input.appDefaultSelection);
    if (result.effectiveSelection && !result.selectionIssue) {
      return {
        hasConcreteModel: false,
        selection: cloneModelSelection(result.effectiveSelection),
        inheritance: { source: "app-default" },
      };
    }
  }
  // 空选择链环 3：父（派发方）会话模型（raw，与修订前父继承环同语义，不经 resolve）。
  if (input.parentSelection) {
    return {
      hasConcreteModel: false,
      selection: cloneModelSelection(input.parentSelection),
      inheritance: { source: "parent-session" },
    };
  }
  if (explicitMissing) {
    // fail-closed 门（specs/agent-teams-derived-config.md R4/R4.1）：全链皆空才拒绝；
    // 消息含全部配置引导（profile / general-purpose / 应用默认模型 / inheritCaptainModel）。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot start AgentTeams member: no model resolves for the empty selection chain. Configure a model for agent-teams:member or general-purpose under Subagents, set the app default model, or enable inheritCaptainModel in the AgentTeams plugin settings.",
      {
        recoverable: true,
        context: { selectionIssue: "selection-missing", reason: "selection-missing" },
      },
    );
  }
  throw selectionFailure(
    { effectiveSelection: null, selectionIssue: "selection-missing" },
    input.overrideSelection,
    explicit,
    input.parentSelection,
  );
}

/** 解析失败/全链皆空的统一错误投影（消息与 context 形状保持修订前口径）。 */
function selectionFailure(
  result: EffectiveModelSelectionResult,
  override: ModelSelection | undefined,
  explicit: ModelSelection | null | undefined,
  parent: ModelSelection | null | undefined,
): never {
  const reason = result.selectionIssue ?? "selection-missing";
  const requested = override ?? explicit ?? parent;
  const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
  // 解析失败不能落回父模型，否则会悄悄改变用户显式指定的子任务模型。
  // 公共错误投影不读取结构化字段（只有 selectionIssue 时消费方看不到）；后台也只保留 message。
  // 因此同时给既有 reason 和消息补上原因，两个消费路径都能定位，不增加专用错误协议。
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
    {
      recoverable: true,
      context: {
        selectionIssue: reason,
        reason,
        ...(result.effectiveSelection
          ? {
              providerId: result.effectiveSelection.providerId,
              modelId: result.effectiveSelection.modelId,
            }
          : {}),
      },
    },
  );
}
