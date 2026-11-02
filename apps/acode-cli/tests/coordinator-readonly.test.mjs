// 协调者只读预设验收（apps/acode-cli/specs/coordinator-readonly-preset.md）。
// 覆盖测试矩阵 #1–#18（#12 为两构造点同源的源码 parity 断言，#18 含漂移守护与
// identity_missing / token parity）。派生侧（重放重建、粘性、逃生阀）见
// coordinator-readonly-derivation.test.mjs。
import assert from "node:assert/strict";
import { test } from "node:test";

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const coord = await import("../packages/core/src/permission/coordinator-readonly.ts");
const scope = await import("../packages/core/src/agent/coordinator-scope.ts");
const autoDeny = await import("../packages/core/src/permission/auto-deny-reasons.ts");
const { PermissionDenialReason } = await import("../packages/contracts/src/errors/index.ts");
const { builtInTools } = await import("../packages/core/src/tool/handlers/index.ts");
const { buildEnvInfoSection } = await import("../packages/core/src/context/sections/env-info.ts");

const WORKSPACE = "/tmp/coordinator-readonly-ws";
const COORDINATOR_RULE = coord.COORDINATOR_READONLY_RULE_ID;

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(extra.allowedTools ?? []),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(extra.policyFloor ? { policyFloor: extra.policyFloor } : {}),
    ...(extra.logger ? { logger: extra.logger } : {}),
  });
}

function ctx(toolName, mode, sessionId, extra = {}) {
  return {
    toolName,
    input: { file_path: "a.ts" },
    riskLevel: "medium",
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    sessionId,
    // 与 executor 构造点（permission-flow / permission-input-recheck）同源：
    // PermissionContext 的 coordinatorReadOnly 快照来自会话级 store。
    coordinatorReadOnly: scope.snapshotSessionCoordinatorScope(sessionId),
    ...extra,
  };
}

function denyWith(service, toolName, mode, sessionId, extra = {}) {
  return service.checkPermission(ctx(toolName, mode, sessionId, extra));
}

const WRITE_TOOLS = coord.COORDINATOR_DISALLOWED_TOOLS;

// ── #1 队长 build 下写工具被独立 ruleId 拒，文案冻结且含派成员指引 ─────────────
test("#1 队长 build：Write/Edit/ApplyPatch → deny rule.coordinator.readonly + 冻结文案", () => {
  for (const tool of WRITE_TOOLS) {
    const sid = `sess_1_${tool}`;
    scope.clearAllSessionCoordinatorScopes();
    scope.setSessionCoordinatorBasis(sid, true);
    const decision = denyWith(makeService(), tool, "build", sid);
    assert.equal(decision.decision, "deny", tool);
    assert.equal(decision.ruleId, COORDINATOR_RULE, tool);
    assert.equal(decision.allowed, false, tool);
    assert.ok(
      decision.reason.includes(coord.COORDINATOR_READONLY_REASON),
      `${tool} 文案为冻结中性文案`,
    );
    assert.ok(decision.reason.includes("Dispatch the change to a member"), tool);
    assert.ok(!decision.reason.includes("identity_missing"), `${tool} 非粘性期不带 identity_missing`);
  }
});

// ── #2 全模式一致：edit/plan/auto/yolo/dontAsk 同样被本 ruleId 拒（yolo 不复活、无双重拒绝）
test("#2 队长 edit/plan/auto/yolo/dontAsk：仍 deny 本 ruleId（终局恰一条）", () => {
  for (const mode of ["edit", "plan", "auto", "yolo", "dontAsk"]) {
    const sid = `sess_2_${mode}`;
    scope.clearAllSessionCoordinatorScopes();
    scope.setSessionCoordinatorBasis(sid, true);
    const decision = denyWith(makeService(), "Write", mode, sid);
    assert.equal(decision.decision, "deny", mode);
    assert.equal(decision.ruleId, COORDINATOR_RULE, `${mode} 不叠加其它 ruleId`);
    assert.ok(decision.reason.includes(coord.COORDINATOR_READONLY_REASON), mode);
  }
});

// ── #3 读工具 / 团队工具 / Bash 不受影响（默认不禁 Bash，只读审查命令面保留）
test("#3 队长：Read/Glob/Grep/Bash/agent_teams_* 不命中本 ruleId", () => {
  for (const tool of ["Read", "Glob", "Grep", "Bash", "agent_teams_status"]) {
    const sid = `sess_3_${tool}`;
    scope.clearAllSessionCoordinatorScopes();
    scope.setSessionCoordinatorBasis(sid, true);
    const decision = denyWith(makeService(), tool, "build", sid);
    assert.notEqual(decision.ruleId, COORDINATOR_RULE, tool);
  }
  // yolo 下读工具照常（不被本预设拦）
  const sid = "sess_3_yolo_read";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const read = denyWith(makeService(), "Read", "yolo", sid);
  assert.notEqual(read.ruleId, COORDINATOR_RULE);
});

// ── #4/#5/#6 成员与非团队主会话不受影响（未建立判定）；逃生阀放开 = 同基线 ───────
test("#4/#5/#6 成员 / 非团队 / 逃生阀放开：与基线逐项一致（不施加预设）", () => {
  const modes = ["build", "edit", "plan", "auto", "yolo", "dontAsk"];
  for (const mode of modes) {
    const baseline = denyWith(makeService(), "Write", mode, `sess_base_${mode}`);
    // 成员（subagent）会话：从不是任何团队 captainSessionId → 无 scope
    const member = denyWith(makeService(), "Write", mode, `sess_member_${mode}`);
    // 非团队主会话：同样无 scope
    const plain = denyWith(makeService(), "Write", mode, `sess_plain_${mode}`);
    assert.equal(member.ruleId, baseline.ruleId, `成员 ${mode} 与基线一致`);
    assert.equal(member.decision, baseline.decision, `成员 ${mode} 决策一致`);
    assert.equal(plain.ruleId, baseline.ruleId, `非团队 ${mode} 与基线一致`);
    assert.notEqual(baseline.ruleId, COORDINATOR_RULE, `${mode} 基线与本项无关`);
  }
  // 逃生阀放开（enabled=false ⇒ 不写 basis）等价于基线下可写
  const sid = "sess_escape";
  scope.clearAllSessionCoordinatorScopes();
  const baseline = denyWith(makeService(), "Write", "build", "sess_escape_base");
  const escaped = denyWith(makeService(), "Write", "build", sid);
  assert.equal(escaped.ruleId, baseline.ruleId);
  assert.equal(escaped.decision, baseline.decision);
});

// ── #7 粘性：曾建立后判定不可得 → 仍 deny + identity_missing 一次（去重审计）────
test("#7 粘性只读：basis 建立后「判定不可得」仍 deny 且带 identity_missing，审计去重一次", () => {
  const sid = "sess_7_sticky";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  // 判定不可得（状态缺失 / teams[] 缺席）
  scope.setSessionCoordinatorBasis(sid, undefined);
  const snapshot = scope.snapshotSessionCoordinatorScope(sid);
  assert.ok(snapshot, "粘性：作用域仍在");
  assert.equal(snapshot.identityMissing, true);

  const warns = [];
  const logger = { warn: (member, details) => warns.push({ member, details }) };
  const service = makeService({ logger });
  const first = denyWith(service, "Write", "build", sid);
  const second = denyWith(service, "Write", "build", sid);
  assert.equal(first.ruleId, COORDINATOR_RULE);
  assert.ok(first.reason.includes(coord.COORDINATOR_IDENTITY_MISSING_SUFFIX), "拒绝文案带 identity_missing");
  assert.ok(first.reason.includes(coord.COORDINATOR_IDENTITY_MISSING_TOKEN));
  assert.equal(second.ruleId, COORDINATOR_RULE);
  const audit = warns.filter(
    (entry) => entry.details?.event === "permission.coordinator_readonly.identity_missing",
  );
  assert.equal(audit.length, 1, "同一会话同一窗口只审计一次（去重）");
  assert.equal(audit[0].details.reason, coord.COORDINATOR_IDENTITY_MISSING_TOKEN);
});

// ── #8 从未建立：状态缺失 → 不施加（可写）──────────────────────────────────────
test("#8 从未建立：判定不可得 → 不施加（作用域缺席，判定回基线）", () => {
  const sid = "sess_8_never";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, undefined);
  assert.equal(scope.snapshotSessionCoordinatorScope(sid), undefined);
  const baseline = denyWith(makeService(), "Write", "build", "sess_8_base");
  const decision = denyWith(makeService(), "Write", "build", sid);
  assert.equal(decision.ruleId, baseline.ruleId);
  assert.notEqual(decision.ruleId, COORDINATOR_RULE);
});

// ── #9 策略地板优先（地板压过本项）─────────────────────────────────────────────
test("#9 队长 + 策略地板 deny Write → rule.policy.deny 优先", () => {
  const sid = "sess_9_floor";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const service = makeService({ policyFloor: { deny: [{ toolName: "Write" }], ask: [] } });
  const decision = denyWith(service, "Write", "build", sid);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.policy.deny");
  assert.notEqual(decision.ruleId, COORDINATOR_RULE);
});

// ── #10 用户/项目 disallowedTools 优先（用户显式配置压过本项）─────────────────
test("#10 队长 + disallowedTools 含 Write → rule.disallowedTools 优先", () => {
  const sid = "sess_10_disallow";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const service = makeService({ disallowedTools: ["Write"] });
  const decision = denyWith(service, "Write", "build", sid);
  assert.equal(decision.ruleId, "rule.disallowedTools");
  assert.notEqual(decision.ruleId, COORDINATOR_RULE);
});

// ── #11 与技能激活期 deny 同向：本项位次更前，报本 ruleId ─────────────────────
test("#11 队长 + 活跃技能 deny Write → rule.coordinator.readonly 优先（同向拒）", () => {
  const sid = "sess_11_skill";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const decision = denyWith(makeService(), "Write", "build", sid, {
    skillActivationRules: { allow: [], deny: [{ toolName: "Write" }], skills: ["fixture"] },
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, COORDINATOR_RULE);
});

// ── #12 复核链路 parity：两处 PermissionContext 构造点同源 ─────────────────────
test("#12 两构造点（permission-flow / permission-input-recheck）注入同源快照", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const flow = readFileSync(join(root, "packages/core/src/tool/executor/permission-flow.ts"), "utf8");
  const recheck = readFileSync(
    join(root, "packages/core/src/tool/executor/permission-input-recheck.ts"),
    "utf8",
  );
  const needle = "coordinatorReadOnly: snapshotSessionCoordinatorScope(";
  assert.ok(flow.includes(needle), "permission-flow 注入 coordinatorReadOnly 快照");
  assert.ok(recheck.includes(needle), "permission-input-recheck 注入同源快照（hook 改写后仍 deny）");
});

// ── #13 解除：被接管（新状态不再含本会话为 captain）→ 解除 ────────────────────
test("#13 接管换队长：新状态 teams[] 不再含本会话 → 解除（可写）", () => {
  const sid = "sess_13_adopt";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const basis = scope.deriveCoordinatorBasisFromPluginState(
    { teams: [{ teamId: "t1", captainSessionId: "sess_other" }] },
    sid,
  );
  assert.equal(basis, false);
  scope.setSessionCoordinatorBasis(sid, basis);
  assert.equal(scope.snapshotSessionCoordinatorScope(sid), undefined);
  const baseline = denyWith(makeService(), "Write", "build", "sess_13_base");
  const decision = denyWith(makeService(), "Write", "build", sid);
  assert.equal(decision.ruleId, baseline.ruleId);
});

// ── #14 解除：归档（teams[] 移除；归档 primary 不参与判定）────────────────────
test("#14 归档：teams[] 为空 → 解除；primary 展示投影不参与判定", () => {
  const sid = "sess_14_archive";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, true);
  const basis = scope.deriveCoordinatorBasisFromPluginState(
    { teams: [], primary: { captainSessionId: sid }, recentEnded: [{ captainSessionId: sid }] },
    sid,
  );
  assert.equal(basis, false, "只认 teams[]，归档展示投影不参与");
  scope.setSessionCoordinatorBasis(sid, basis);
  assert.equal(scope.snapshotSessionCoordinatorScope(sid), undefined);
});

// ── #15 恢复：由重放状态/事件重建 → 首次调用前即 deny ─────────────────────────
test("#15 会话恢复：重放状态重建 basis → 恢复后判定为只读", () => {
  const sid = "sess_15_resume";
  scope.clearAllSessionCoordinatorScopes();
  // 模拟重放：仅有状态快照（内存 basis 已随进程/会话重建）。
  // 键 = `${pluginId}:agent-teams`，官方实存 pluginId = agent-teams@acode-plugins-official。
  const pluginStates = {
    "agent-teams@acode-plugins-official:agent-teams": {
      teams: [{ teamId: "t1", captainSessionId: sid }],
    },
  };
  const basis = scope.deriveCoordinatorBasisFromPluginStates(pluginStates, sid);
  assert.equal(basis, true);
  scope.setSessionCoordinatorBasis(sid, basis);
  const decision = denyWith(makeService(), "Write", "build", sid);
  assert.equal(decision.ruleId, COORDINATOR_RULE);
});

// ── #15b 身份与 marketplace 解耦：裸名与任意 marketplace 都命中 ───────────────
test("#15b pluginStates 键按身份+主题匹配（裸名 / 任意 marketplace 都命中）", () => {
  const sid = "sess_15b_identity";
  assert.equal(scope.isAgentTeamsPluginId("agent-teams"), true);
  assert.equal(scope.isAgentTeamsPluginId("agent-teams@acode-plugins-official"), true);
  assert.equal(scope.isAgentTeamsPluginId("agent-teams@some-market"), true);
  assert.equal(scope.isAgentTeamsPluginId("agent-teams-plus"), false);
  assert.equal(scope.isAgentTeamsPluginId("other@acode-plugins-official"), false);
  const state = { teams: [{ teamId: "t1", captainSessionId: sid }] };
  assert.equal(scope.deriveCoordinatorBasisFromPluginStates({ "agent-teams:agent-teams": state }, sid), true);
  assert.equal(
    scope.deriveCoordinatorBasisFromPluginStates({ "agent-teams@m:agent-teams": state }, sid),
    true,
  );
  assert.equal(
    scope.deriveCoordinatorBasisFromPluginStates({ "other:agent-teams": state }, sid),
    undefined,
    "非 agent-teams 身份的 :agent-teams 键不消费",
  );
  assert.equal(scope.deriveCoordinatorBasisFromPluginStates({}, sid), undefined);
});

// ── #16 多团队：本会话是其中 1 支队长 → deny ──────────────────────────────────
test("#16 多团队：任一活跃团队仍以本会话为队长 → deny", () => {
  const sid = "sess_16_multi";
  const basis = scope.deriveCoordinatorBasisFromPluginState(
    {
      teams: [
        { teamId: "t1", captainSessionId: "sess_x" },
        { teamId: "t2", captainSessionId: sid },
      ],
    },
    sid,
  );
  assert.equal(basis, true);
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid, basis);
  const decision = denyWith(makeService(), "Write", "build", sid);
  assert.equal(decision.ruleId, COORDINATOR_RULE);
});

// ── #17 env-info 段：生效渲染 1 行；缺席零渲染（逐字节）────────────────────────
test("#17 env-info：生效渲染说明行，缺席时段内容逐字节不变", () => {
  const envInfo = {
    cwd: "/tmp/ws",
    isGitRepository: true,
    platform: "linux",
    shell: "bash",
    osVersion: "linux 1.0 x64",
    nodeVersion: "20.0.0",
  };
  const absent = buildEnvInfoSection(envInfo, undefined, undefined, false);
  const baseline = buildEnvInfoSection(envInfo, undefined, undefined);
  assert.equal(absent.content, baseline.content, "缺席零渲染（逐字节）");
  assert.ok(!absent.content.includes(coord.COORDINATOR_ENV_INFO_INSTRUCTION));
  const present = buildEnvInfoSection(envInfo, undefined, undefined, true);
  assert.ok(present.content.includes(coord.COORDINATOR_ENV_INFO_INSTRUCTION), "生效渲染 1 行");
  assert.equal(
    present.content.split("\n").filter((line) => line.includes("coordinator of an AgentTeams team"))
      .length,
    1,
  );
});

// ── #18 漂移守护：名单 ⊆ 已注册工具名；identity_missing / token parity ─────────
test("#18 漂移守护：写工具名单为已注册工具名；identity_missing 与 TEAM_ERROR_CODES 一致", async () => {
  const names = new Set(builtInTools.map((entry) => entry.metadata.name));
  for (const tool of WRITE_TOOLS) {
    assert.ok(names.has(tool), `${tool} 必须是已注册工具名（改名/删除即红）`);
  }
  // 写语义工具必须全部登记（漂移即红：新增文件写工具须同批登记）
  const fileWriteHandlers = ["Write", "Edit", "ApplyPatch"];
  for (const tool of fileWriteHandlers) {
    assert.ok(WRITE_TOOLS.includes(tool), `${tool} 必须登记进 COORDINATOR_DISALLOWED_TOOLS`);
  }
  // token / ruleId 单一事实源
  assert.equal(
    autoDeny.classifyAutoDenyRuleId(COORDINATOR_RULE),
    PermissionDenialReason.CoordinatorReadOnly,
  );
  assert.equal(PermissionDenialReason.CoordinatorReadOnly, "coordinator_readonly");
  // 与插件 TEAM_ERROR_CODES 的 identity_missing 字面量 parity
  const pluginTypes = await import("../packages/agent-teams-plugin/src/state/types.ts");
  assert.ok(
    pluginTypes.TEAM_ERROR_CODES.includes(coord.COORDINATOR_IDENTITY_MISSING_TOKEN),
    "identity_missing 与插件 TEAM_ERROR_CODES 对齐",
  );
});