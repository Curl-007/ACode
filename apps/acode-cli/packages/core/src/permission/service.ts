// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  isAmendWorkflowOwnedPredecessor,
  PermissionCapabilityGroup,
  type ManagedPolicyFloorData,
  type PermissionCapabilityGroup as PermissionCapabilityGroupType,
  type PermissionRuleValue,
  type PermissionRuleset,
  type PermissionUpdate,
  type CollaborationMode,
  type ModelToolSideEffectScope,
  type RiskLevel,
  type ToolPermissionSpec,
} from "@acode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@acode/shared";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";
import {
  breakerContextFromPermissionContext,
  evaluateBypassImmuneBreakers,
} from "./bypass-immune-breakers.js";
import {
  BashConfirmReflexGate,
  type BashReflexGateOutcome,
  type BashReflexGateRequest,
} from "./bash-confirm-reflex-gate.js";
import type { PackageScriptSource } from "../tool/handlers/bash-target-risk/types.js";
import { getProcessManagedPolicyFloor } from "./process-policy-floor.js";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";

// -----------------------------------------------
// Types
// -----------------------------------------------

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

export interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
  /**
   * 会话工作目录。判定相对路径的落点用（目前只有 workflow 草稿免确认这一条），
   * 可选：拿不到工作目录的调用方照常按其余规则判定，不会因此少一层确认。
   */
  workingDirectory?: string;
  /**
   * 工作区根目录（安全加固 P2）。旁路免疫熔断器的「路径逃逸写」判定用；
   * 可选：拿不到时该类熔断器不触发（与 workingDirectory 同一容错哲学），
   * 其余判定不受影响。
   */
  workspaceRoot?: string;
  /**
   * 调用方身份（对抗复审 N3）：持有本次决策的会话 id。反射门的挑战键把它并入哈希,
   * 防止共享 PermissionService 实例的两个会话（general-purpose/自定义子代理继承父
   * 实例）互用对方的反射挑战——会话 A 触发的挑战对会话 B 不生效，B 首调带
   * justification 仍是预填 → deny。可选：legacy 调用方（既有单测、不经 executor 的
   * 直连调用）缺省时按仅命令文本哈希的现行为判定（spec R4 登记该边界）。
   */
  sessionId?: string;
  /**
   * npm/pnpm/yarn/bun run 的 package.json scripts 预解析 map（R6 边界⑥收口，
   * spec npm-script-body-scan.md R1/R4）。executor 的 permission 链路异步预取后注入；
   * deny 级熔断（body catastrophic → yolo 也 deny）与反射门从这里拿注入。
   * 缺省 = legacy 调用方：breaker/门看不到 body，run 族维持收口前行为（spec R6 登记）。
   */
  packageScripts?: readonly PackageScriptSource[];
  /**
   * 预取实际读过/走过的目录（扫描覆盖证据，对抗验证 F1②，spec
   * npm-script-body-scan.md R1/R2）。与 packageScripts 同源透传给熔断器与反射门：
   * 目标目录的 enclosing 命中只有被它覆盖才可信任。缺省 = legacy 调用方（维持
   * enclosing 信任）。
   */
  scannedDirectories?: readonly string[];
}

export interface PermissionToolCapability {
  allowedInPlanMode?: boolean;
  alwaysAsk?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  riskLevel?: RiskLevel;
  needsApproval?: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permission?: ToolPermissionSpec;
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  decision: PermissionBehavior;
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
  mode: CollaborationMode;
  ruleId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  /**
   * 该 ask 来自工具的 alwaysAsk 声明，不是模式或规则推导出来的。下游（PreToolUse hook 的
   * allow 覆盖）靠这个结构化标记识别"不可抹掉的确认"，而不是去匹配 ruleId 字符串。
   */
  alwaysAsk?: boolean;
}

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  private sessionRules: PermissionRuleset = { version: 1 };

  /**
   * J1-2：Bash Confirm 级反射门（specs/bash-confirm-reflexive-gate.md）。
   * 挑战登记表随实例生灭（一个实例 = 一个 app = 一个会话，与 sessionRules 同一
   * 生命周期哲学）；重启 / 冷恢复 / `/new` 自然清零，不存在跨会话的预填绕过。
   */
  private readonly bashReflexGate = new BashConfirmReflexGate();

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  /**
   * 安全加固 P2（R4）：托管策略地板是否禁用了 yolo/bypass 直通。
   * 供模式切换边界（runtime 的 applyRuntimeExecutionState）拒绝显式的全权限档请求；
   * 决策层的跳过（checkPermissionByMode 的 yolo 分支）是安全底线，本方法是 UX 一致性。
   */
  isBypassPermissionsModeDisabled(): boolean {
    return this.resolvePolicyFloor()?.disableBypassPermissionsMode === true;
  }

  /**
   * 策略地板解析链（安全加固 P2 补丁项，subagent-policy-floor-inheritance R1）：
   * 显式构造参数优先，缺省回落进程级注册地板。Explore 子代理与 memory agent 用
   * defaultPermissionConfig 自建实例，构造参数纪律覆盖不到——进程级回落让
   * 「地板对所有权限决策生效」成为结构性不变量。三处消费点（policy deny/ask、
   * yolo 直通跳过、isBypassPermissionsModeDisabled）必须统一走本方法，不得直读
   * this.config.policyFloor。
   */
  private resolvePolicyFloor(): ManagedPolicyFloorData | undefined {
    return this.config.policyFloor ?? getProcessManagedPolicyFloor();
  }

  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const capability = this.resolveCapability(context, toolCapability);

    // 安全加固 P2（R3 步骤 0/1）：托管策略地板压过一切分支——deny 绝对最高，
    // ask 压过 yolo/plan-readonly/项目 allow/allowedTools。规则匹配复用项目规则同一套
    // 语义（toolName + ruleContent + 能力域），策略层不另造匹配器。
    // 解析链见 resolvePolicyFloor：显式构造参数 ?? 进程级注册地板（覆盖 Explore/memory agent）。
    // 对抗复审 N1：policy ask 命中**不再提前返回**——提前返回会绕过其后 deny 级熔断
    // 与反射门，把 catastrophic 的绝对 deny 降级成可批准的 ask。policy ask 只是地板
    // 不是天花板，命中后仅把门前 decision 托底为 ask（见下方 policyAskHit 消费点），
    // 最终决策 = 最严者胜。
    const policyFloor = this.resolvePolicyFloor();
    let policyAskHit = false;
    if (policyFloor) {
      const policyRuleset: PermissionRuleset = {
        version: 1,
        deny: [...policyFloor.deny],
        ask: [...policyFloor.ask],
      };
      if (this.matchesProjectRules(policyRuleset, "deny", context, capability, rulePolicy)) {
        return this.deny(
          context,
          capability,
          "rule.policy.deny",
          `Tool ${context.toolName} is denied by managed policy`,
        );
      }
      policyAskHit = this.matchesProjectRules(policyRuleset, "ask", context, capability, rulePolicy);
    }

    // 安全加固 P2（R3 步骤 2）：disallowedTools 硬禁用前移到所有模式分支之前。
    // 此前 yolo 直通先于该检查——用户/策略显式禁用的工具在 yolo 下会被放行
    // （原 checkAlwaysAsk 注释自认的 wart）。硬禁用是明确意图，任何模式都不能复活它；
    // 策略层的 disallowedTools 已在配置合并时并入本集合（strictest-wins 并集）。
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }

    // 对抗复审 N1：policy ask 命中时仍要计算模式判定——它压过放行类决策（yolo 直通/
    // 项目 allow/allowedTools），但**压不过既有 deny**（plan nonReadOnly、auto
    // unimplemented、项目 deny 等）：deny 严于 ask，直接保留，策略地板不能把任何
    // deny 放宽成 ask。
    const decision = policyAskHit
      ? this.resolvePolicyAskFloorDecision(context, capability, projectRules, rulePolicy)
      : this.checkPermissionByMode(context, capability, projectRules, rulePolicy);

    // 安全加固 P2（R2/R3 步骤 6）：旁路免疫熔断器在决策收口处统一应用——无论放行来自
    // yolo 直通、项目 allow、allowedTools 还是 build/edit 低风险分支，命中都生效
    // （bypass-immune 的完整语义），两个调用方（executor 与 input-recheck）自动同语义。
    // J1-1（bash-target-blast-radius R5）：命中分两级——
    // · behavior "deny"（catastrophic 目标档）：把 allow 与 ask 一并降级为 deny。
    //   「永不执行、任何论证不解锁」；deny 比原决策更严，仍满足「熔断器只收紧、
    //   永不放宽」不变量。
    // · ask 级（缺省）：维持既有「只降级 allow；已是 ask 保留原 ruleId」语义。
    // deny 决策不经过熔断器：不可能更严，也不可能被放宽。
    if (decision.decision !== "deny") {
      const breakerHit = evaluateBypassImmuneBreakers(breakerContextFromPermissionContext(context));
      if (breakerHit?.behavior === "deny") {
        return this.deny(context, capability, breakerHit.ruleId, breakerHit.reason);
      }
      if (breakerHit && decision.decision === "allow") {
        return this.ask(context, capability, breakerHit.ruleId, breakerHit.reason);
      }
      // J1-2（bash-confirm-reflexive-gate R1/R2）：仅在无熔断器命中时叠加反射门——
      // 既有熔断优先，confirm 级形态已被类 1 覆盖的（rm -rf "$DIR" 族）不重复反射。
      // 门只收紧 allow/ask：首次调用 deny + 四问回喂；有效 justification 后
      // ask lane 收敛到 ask（用户裁决），allow lane 放行且必留审计。
      if (!breakerHit) {
        const gateOutcome = this.evaluateBashReflexGate(
          context,
          decision.decision as "allow" | "ask",
        );
        if (gateOutcome.action === "deny") {
          return this.deny(context, capability, gateOutcome.ruleId!, gateOutcome.reason!);
        }
        if (gateOutcome.action === "ask") {
          // 对抗复审 N1：policy ask 命中时，门收敛出的这次 ask 的在案原因仍是托管策略
          // ——ruleId 保留 rule.policy.ask（与「ask 级熔断命中不覆写既有 ask 的
          // ruleId」同一哲学），reason 同时携带策略地板与门语义（justification 原文 +
          // 不可静态验证的事实），审批弹窗两类信息都看得到。
          if (policyAskHit) {
            return this.ask(
              context,
              capability,
              "rule.policy.ask",
              buildPolicyAskWithGateReason(context.toolName, gateOutcome.reason!),
            );
          }
          return this.ask(context, capability, gateOutcome.ruleId!, gateOutcome.reason!);
        }
        if (gateOutcome.action === "allow") {
          return this.allow(context, capability, gateOutcome.ruleId!, gateOutcome.reason);
        }
      }
    }
    return decision;
  }

  /**
   * 对抗复审 N1：策略 ask 的收敛语义——地板不是天花板。命中 policy ask 时先算模式判定：
   * 模式层给出 deny（plan nonReadOnly、auto unimplemented、项目 deny 等）则保留 deny
   * （deny 严于 ask，policy ask 不得把任何 deny 放宽成 ask）；否则把决策托底为 ask
   * rule.policy.ask（压过 yolo 直通/项目 allow/allowedTools 的放行，也覆盖模式层自身
   * 的 ask），reason 与既有提前返回完全同文案。deny 级熔断与反射门的收口在调用方
   * （checkPermission）照常执行，最严者胜。
   */
  private resolvePolicyAskFloorDecision(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const underlying = this.checkPermissionByMode(context, capability, projectRules, rulePolicy);
    if (underlying.decision === "deny") return underlying;
    return this.ask(
      context,
      capability,
      "rule.policy.ask",
      `Tool ${context.toolName} requires approval by managed policy`,
    );
  }

  private evaluateBashReflexGate(
    context: PermissionContext,
    decision: "allow" | "ask",
  ): BashReflexGateOutcome {
    const request: BashReflexGateRequest = {
      toolName: context.toolName,
      input: context.input,
      decision,
      ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
      ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
      // 对抗复审 N3：调用方身份进挑战键，挑战不跨身份生效（spec R4）。
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      // R6 边界⑥收口：confirm 级 script body（npm run $X 等）在 yolo 下经反射门
      // 收口（deny 首轮 + 四问），与目标侧 confirm 同一语义。
      ...(context.packageScripts ? { packageScripts: context.packageScripts } : {}),
      // 对抗验证 F1②：覆盖证据同源进反射门（cd/选择器目标的 enclosing 充数拦截
      // 依赖它，缺了会在门内退回误判放行）。
      ...(context.scannedDirectories ? { scannedDirectories: context.scannedDirectories } : {}),
    };
    return this.bashReflexGate.evaluate(request);
  }

  /** 模式与规则驱动的既有判定流程；策略地板与熔断器在 checkPermission 收口，不在这里重复。 */
  private checkPermissionByMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const planModeTransition = resolvePlanModeTransitionPermission(context);

    if (planModeTransition) {
      return planModeTransition.behavior === "allow"
        ? this.allow(context, capability, planModeTransition.ruleId, planModeTransition.reason)
        : this.deny(context, capability, planModeTransition.ruleId, planModeTransition.reason);
    }

    if (capability.requiresUserInteraction) {
      return this.ask(
        context,
        capability,
        "tool.userInteraction",
        `Tool ${context.toolName} requires user interaction`,
      );
    }

    // 声明 alwaysAsk 的工具必须经过用户确认，不能被权限模式的放行分支绕过。
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
    }

    const planEnabled = context.planEnabled ?? context.mode === "plan";
    if (context.mode === "yolo" && !planEnabled) {
      // 安全加固 P2（R1/R3 步骤 7）：策略地板 disableBypassPermissionsMode=true 时
      // yolo 直通失效——不返回 allow，落入下方与 build 模式相同的判定（副作用动作 ask）。
      // 经 resolvePolicyFloor：进程级地板对 Explore 子代理的缺省 yolo 同样生效。
      if (!this.resolvePolicyFloor()?.disableBypassPermissionsMode) {
        return this.allow(context, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
      }
    }

    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }

    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }

    if (this.matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
      return this.ask(
        context,
        capability,
        "rule.project.ask",
        `Tool ${context.toolName} requires approval by project permission rules`,
      );
    }

    if (planEnabled) {
      return this.checkPlanMode(context, capability);
    }

    if (this.matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.project.allow",
        `Tool ${context.toolName} is allowed by project permission rules`,
      );
    }

    if (this.isPreapprovedWebFetchRequest(context)) {
      return this.allow(
        context,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }

    // workflow 草稿免确认：
    // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
    // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
    // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
    if (
      isPreapprovedWorkflowDraftWrite({
        input: context.input,
        toolName: context.toolName,
        workingDirectory: context.workingDirectory,
      })
    ) {
      return this.allow(
        context,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }

    if (this.config.allowedTools.has(context.toolName)) {
      return this.allow(
        context,
        capability,
        "rule.allowedTools",
        `Tool ${context.toolName} is explicitly allowed`,
      );
    }

    if (context.mode === "edit") {
      return this.checkEditMode(context, capability);
    }

    return this.checkBuildMode(context, capability);
  }

  private matchesProjectRules(
    ruleset: PermissionRuleset | null | undefined,
    behavior: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    rulePolicy?: ToolPermissionRulePolicy,
  ): boolean {
    const rules = ruleset?.[behavior];
    if (!Array.isArray(rules)) return false;
    const toolRules = rules.filter((rule) =>
      this.matchesRuleScope(rule, context.toolName, capability),
    );
    if (toolRules.length === 0) return false;
    if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
    return toolRules.some((rule) => this.matchesRule(rule, context, capability));
  }

  private matchesRule(
    rule: PermissionRuleValue,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (!this.matchesRuleScope(rule, context.toolName, capability)) return false;
    if (!rule.ruleContent) return true;

    const subjects = this.ruleSubjects(context.input, context.toolName);
    if (subjects.length === 0) return false;

    return subjects.some((subject) => this.matchesRuleContent(subject, rule.ruleContent!));
  }

  private matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean {
    if (ruleToolName === contextToolName) return true;
    return contextToolName === "Write" && ruleToolName === "Edit";
  }

  private matchesRuleScope(
    rule: PermissionRuleValue,
    contextToolName: string,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
      // 保留 key 只有在当前 tool entry 另行携带宿主验证后的 official_cua
      // capability 时才匹配。同名第三方 MCP、authority 漂移以及旧普通 tool
      // 都不能把可解析的 wire/storage 字符串升级成可信能力。
      return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
    }
    return this.matchesRuleToolName(rule.toolName, contextToolName);
  }

  private ruleSubjects(input: unknown, toolName: string): string[] {
    if (typeof input === "string") return [input];
    if (!input || typeof input !== "object") return [];

    const record = input as Record<string, unknown>;
    if (toolName === "WebFetch" && typeof record.url === "string") {
      return webFetchRuleSubjects(record.url);
    }

    for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
      const value = record[key];
      if (typeof value === "string") return [value];
    }

    return [];
  }

  private isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
    if (context.toolName !== "WebFetch") return false;
    if (!context.input || typeof context.input !== "object") return false;
    const url = (context.input as Record<string, unknown>).url;
    return typeof url === "string" && isWebFetchPreapprovedUrl(url);
  }

  private matchesRuleContent(subject: string, ruleContent: string): boolean {
    if (ruleContent.endsWith(":*")) {
      const prefix = ruleContent.slice(0, -2);
      return (
        subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
      );
    }

    if (ruleContent.includes("*")) {
      return wildcardToRegExp(ruleContent).test(subject);
    }

    return subject === ruleContent;
  }

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：项目 deny 规则符合工具自报的 denyPriority: "beforeAsk"，
   * auto 模式是"该模式未实现"的保护。少了这一步，一个被项目规则禁用的工具会退化成
   * "弹个窗、用户一点就能跑"。
   *
   * disallowedTools 与策略地板 deny/ask 已在 checkPermission 收口处前置（安全加固 P2），
   * 到达这里时必然未命中，不再重复判定。
   */
  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
    // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
    if (this.matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    // 修订免确认：AmendWorkflow 的前驱是
    // **本会话发起**的 run、且不是用户亲手停下的，即放行。与会话规则同位——阻断分支之后、ask 之前，
    // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
    // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
    // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
    if (this.isOwnedWorkflowAmend(context)) {
      return this.allow(
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return this.ask(
      context,
      capability,
      "tool.alwaysAsk",
      `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  /** AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」。 */
  private isOwnedWorkflowAmend(context: PermissionContext): boolean {
    if (context.toolName !== AMEND_WORKFLOW_TOOL_NAME) return false;
    if (!context.input || typeof context.input !== "object") return false;
    // 谓词本体住在契约里：就地调并发落回修订时读的必须是同一条规则，不能各写一遍。
    return isAmendWorkflowOwnedPredecessor((context.input as Record<string, unknown>).predecessor);
  }

  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.mcp",
        "Plan mode allows non-destructive MCP tool execution",
      );
    }

    if (
      capability.allowedInPlanMode &&
      capability.sideEffectScope === "session" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.plan.explicitSessionCapability",
        "Plan mode allows this explicit non-destructive session control action",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }

  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }

  private checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.build.readOnly",
        "Build mode allows read-only tools",
      );
    }

    if (capability.riskLevel === "critical") {
      return this.ask(
        context,
        capability,
        "mode.build.criticalRisk",
        "Critical risk tools require explicit approval",
      );
    }

    if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(
        context,
        capability,
        "mode.build.highRisk",
        "High risk tools require explicit approval",
      );
    }

    if (
      capability.sideEffectScope === "session" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.build.sessionState",
        "Build mode allows low-risk session-local state updates",
      );
    }

    if (
      capability.needsApproval ||
      capability.destructive ||
      capability.sideEffectScope !== "none"
    ) {
      return this.ask(
        context,
        capability,
        "mode.build.sideEffect",
        "Tool has side effects and requires approval",
      );
    }

    return this.allow(
      context,
      capability,
      "mode.build.lowRisk",
      "Build mode allows low-risk tool execution",
    );
  }

  private checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
      return this.allow(
        context,
        capability,
        "mode.edit.fileEdit",
        "Edit mode allows file edit tools",
      );
    }

    return this.checkBuildMode(context, capability);
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    const decision = this.checkPermission(context, toolCapability);
    return decision.decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    if (toolCapability?.riskLevel) {
      return toolCapability.riskLevel;
    }

    if (this.isReadOnlyTool(toolName)) {
      return "low";
    }

    if (this.isWriteTool(toolName)) {
      return "medium";
    }

    if (this.isDestructiveTool(toolName)) {
      return "high";
    }

    return "medium";
  }

  private isReadOnlyTool(name: string): boolean {
    return new Set([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "TodoRead",
      "TodoWrite",
      "AskUserQuestion",
      "Agent",
      "Task",
      "Skill",
    ]).has(name);
  }

  private isWriteTool(name: string): boolean {
    return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
  }

  private isDestructiveTool(name: string): boolean {
    return new Set(["Bash"]).has(name);
  }

  private resolveCapability(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
  ): ResolvedPermissionCapability {
    return {
      allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
      alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
      readOnly: toolCapability?.readOnly ?? this.isReadOnlyTool(context.toolName),
      destructive: toolCapability?.destructive ?? this.isDestructiveTool(context.toolName),
      requiresUserInteraction:
        toolCapability?.requiresUserInteraction ??
        (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
          "userInteraction",
      sideEffectScope:
        toolCapability?.permission?.sideEffectScope ??
        toolCapability?.sideEffectScope ??
        (this.isReadOnlyTool(context.toolName) ? "none" : "workspace"),
      riskLevel:
        toolCapability?.permission?.riskLevel ??
        this.getRiskLevel(context.toolName, toolCapability),
      needsApproval:
        toolCapability?.permission?.needsApproval ??
        toolCapability?.needsApproval ??
        !this.isReadOnlyTool(context.toolName),
      permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
      permissionName: toolCapability?.permission?.permission,
    };
  }

  private allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return this.result("allow", context, capability, ruleId, reason);
  }

  private ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("ask", context, capability, ruleId, reason);
  }

  private deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("deny", context, capability, ruleId, reason);
  }

  private result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return {
      decision,
      allowed: decision === "allow",
      escalated: decision === "ask",
      mode: context.mode,
      reason,
      riskLevel: capability.riskLevel,
      ruleId,
      sideEffectScope: capability.sideEffectScope,
      ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
    };
  }
}

interface ResolvedPermissionCapability {
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresUserInteraction: boolean;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permissionName?: string;
}

/**
 * 对抗复审 N1：policy ask × 反射门收敛后的 ask reason——策略地板与门语义同屏。
 * 第一行说明在案原因（托管策略要求批准），门的部分原样保留（justification 原文 +
 * 不可静态验证的事实），审批弹窗两类信息都看得到。
 */
function buildPolicyAskWithGateReason(toolName: string, gateAskReason: string): string {
  return [
    `Tool ${toolName} requires approval by managed policy.`,
    "The command was re-issued after the reflection gate and needs your review:",
    gateAskReason,
  ].join("\n");
}

// -----------------------------------------------
// Configuration
// -----------------------------------------------

export interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
  /**
   * 安全加固 P2：托管策略地板（strictest-wins）。由 createConfig 从 OS 托管路径读入、
   * 经 ConfigScope.Policy 合并后注入；缺省表示本机未部署策略文件（零行为变化）。
   * 注意：策略的 disallowedTools 已在配置合并层并入上面的 disallowedTools 集合，
   * 这里只消费 deny/ask 规则与 disableBypassPermissionsMode。
   */
  policyFloor?: ManagedPolicyFloorData;
}

export const defaultPermissionConfig: PermissionConfig = {
  allowedTools: new Set(),
  disallowedTools: new Set(),
  autoApproveHighRisk: false,
  allowMediumRiskInAutoMode: false,
};
