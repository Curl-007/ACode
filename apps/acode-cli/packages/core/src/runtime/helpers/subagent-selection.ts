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

/** 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  requireExplicitModelSelection?: boolean;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): { hasConcreteModel: boolean; selection: ModelSelection } {
  const explicit = input.profileSelection;
  // fail-closed 门（specs/agent-teams-derived-config.md R4）：打了显式选择标记的
  // profile（AgentTeams 成员且未开启 inheritCaptainModel）既没有自己的模型选择、
  // 也没有可借用的覆盖时，拒绝派生——不能悄悄回退父模型（队长模型），否则
  // 成员会在用户不知情的情况下烧队长的档位。错误消息带设置页修复引导。
  if (input.requireExplicitModelSelection && !explicit && !input.overrideSelection) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot start AgentTeams member: configure a model for agent-teams:member or general-purpose under Subagents, or enable inheritCaptainModel in the AgentTeams plugin settings.",
      {
        recoverable: true,
        context: { selectionIssue: "selection-missing", reason: "selection-missing" },
      },
    );
  }
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : explicit
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(explicit))
        : { effectiveSelection: explicit }
      : { effectiveSelection: input.parentSelection ?? null };
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? explicit ?? input.parentSelection;
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
  return {
    hasConcreteModel: explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}
