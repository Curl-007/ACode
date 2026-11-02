// ============================================================
// 协调者只读预设（specs/coordinator-readonly-preset.md R1/R6）
// ============================================================
// 「AgentTeams 队长会话禁用文件写工具」的判定单一事实源：工具名单、ruleId、文案、
// identity_missing 字面量各只一处（R8.3 / EI-2）。判定位次与消费接线见
// permission/service.ts 的 2.5 判定；判定来源（谁算队长）见 agent/coordinator-scope.ts。
//
// 集合边界（R1.3）：只收核的**文件写工具**，不含 Bash/PowerShell/Task/Agent/读工具/
// MCP 工具/团队工具。Bash 是已知残余面（重定向 / `node -e` 写文件）——本预设防失误
// 不防注入，如实登记，不包装成「队长完全无法写代码」（EI-9）。Bash 面（Q1 裁决）
// 默认不禁：它同时是队长的只读审查命令面（git diff/log 等），令行禁止会废掉读能力。

/**
 * 队长会话禁用集合（R1.1）。成员 = 当前 core 注册的**文件写工具**
 * （`tool/handlers/{write,edit,apply-patch}.ts`，无 NotebookEdit/MultiEdit）。
 * 漂移守护（tests/coordinator-readonly.test.mjs）：每个成员必须是已注册工具名；
 * `tool/handlers/` 新增文件写工具必须同批登记进本名单。
 */
export const COORDINATOR_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Write",
  "Edit",
  "ApplyPatch",
]);

/** 协调者只读拒绝的独立 ruleId（R1.2；勿并入 rule.disallowedTools，保留可区分归因）。 */
export const COORDINATOR_READONLY_RULE_ID = "rule.coordinator.readonly";

/** 首次拒绝文案（R6.2，冻结）。中性陈述保留了什么 + 该怎么做，不描述为错误。 */
export const COORDINATOR_READONLY_REASON =
  "This session is the coordinator of an AgentTeams team; file-writing tools are disabled " +
  "by the team protocol. Dispatch the change to a member instead.";

/** identity_missing 字面量（R4.3；单一事实源，与插件 TEAM_ERROR_CODES 的 parity 由测试钉住）。 */
export const COORDINATOR_IDENTITY_MISSING_TOKEN = "identity_missing";

/** identity_missing 拒绝文案附加句（R6.3）。 */
export const COORDINATOR_IDENTITY_MISSING_SUFFIX =
  "Coordinator status could not be re-confirmed; the session stays read-only (identity_missing).";

/**
 * 协调者只读作用域（会话级快照，R1.4；与 skillActivationRules 同型）。
 * `identityMissing` = R4.1 粘性期（曾建立判定后遇到「判定不可得」）仍保持只读。
 */
export interface CoordinatorScope {
  readonly tools: readonly string[];
  readonly identityMissing?: boolean;
}

/**
 * 2.5 位次判定（R1.2）：工具名在作用域名单内即 deny。
 * 缺席作用域（非队长 / 未施加 / 逃生阀放开）返回 undefined = 零行为变化。
 */
export function resolveCoordinatorDeny(input: {
  toolName: string;
  scope?: CoordinatorScope;
}): { ruleId: string; reason: string } | undefined {
  const { scope } = input;
  if (!scope || !scope.tools.includes(input.toolName)) return undefined;
  return {
    ruleId: COORDINATOR_READONLY_RULE_ID,
    reason: scope.identityMissing
      ? `${COORDINATOR_READONLY_REASON} ${COORDINATOR_IDENTITY_MISSING_SUFFIX}`
      : COORDINATOR_READONLY_REASON,
  };
}

/** R6.1 队长系统提示词注入行（生效期渲染，缺席零渲染）。文本自撰英文。 */
export const COORDINATOR_ENV_INFO_INSTRUCTION =
  "This session is the coordinator of an AgentTeams team. File-writing tools " +
  "(Write/Edit/ApplyPatch) are disabled by the team protocol; dispatch changes to a member " +
  "instead. Read-only tools remain available.";