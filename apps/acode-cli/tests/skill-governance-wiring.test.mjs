import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * SKILL-A frontmatter 治理·消费接线验收（specs/skill-frontmatter-governance.md
 * R4/R5/R6 接线项，波 2 接线波 WI2-A）：
 * - ① 权限消费：激活期作用域 deny 并入会话级 deny 同位次（yolo 不复活）、allow
 *   并入会话级 allow 位次且被 policy floor / plan 结构性压制（永不穿透地板）；
 *   匹配语义裁决（mcp__ 前缀 / "*" 双侧不对称 / Windows 路径归一）逐项钉住；
 * - ② paths 触发源：文件触碰后置判定 → 会话激活集 → 模型清单过滤 + reminder；
 * - ③ disable-model-invocation 硬门：用户指名标记一次性消费，无标记拒绝。
 */

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { buildSkillActivationScope } = await import(
  "../packages/core/src/agent/skill-activation-scope.ts"
);
const {
  activateSkillsForTouchedToolCall,
  buildSkillPathActivationReminder,
  clearSkillPathActivations,
  listPathActivatedSkills,
} = await import("../packages/core/src/agent/skill-path-activation.ts");
const { buildSkillsSection } = await import("../packages/core/src/context/sections/skills.ts");
const {
  clearUserInvokedSkillMarker,
  consumeUserInvokedSkillMarker,
  markUserInvokedSkillForTurn,
} = await import("../packages/core/src/agent/skill-user-invocation.ts");
const { skillToolEntry } = await import("../packages/core/src/tool/handlers/skill.ts");

const WORKSPACE = join(tmpdir(), "acode-skill-wiring-workspace");

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(extra.allowedTools ?? []),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(extra.policyFloor ? { policyFloor: extra.policyFloor } : {}),
  });
}

function ctx(toolName, input, mode = "build", riskLevel = "medium", extra = {}) {
  return {
    toolName,
    input,
    riskLevel,
    mode,
    sessionId: "sess_wiring",
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...extra,
  };
}

function scope(allow = [], deny = [], skills = ["demo"]) {
  return { allow, deny, skills };
}

// ── ① 权限消费：deny 并入会话级 deny 位次 ─────────────────────────────

test("①: 技能激活期 deny 在 yolo 下照常拒绝（会话级 deny 位次，模式不复活）", () => {
  const service = makeService();
  const decision = service.checkPermission(
    ctx("Bash", { command: "git push origin main" }, "yolo", "high", {
      skillActivationRules: scope([], [{ toolName: "Bash" }]),
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.skillActivation.deny");
});

test("①: 实参级 deny（ruleContent 前缀语义）只拒命中形态", () => {
  const service = makeService();
  const denyPush = scope([], [{ toolName: "Bash", ruleContent: "git push:*" }]);
  assert.equal(
    service.checkPermission(ctx("Bash", { command: "git push origin" }, "yolo", "high", { skillActivationRules: denyPush })).decision,
    "deny",
  );
  // 未命中 content 的命令照常走 yolo 直通。
  assert.equal(
    service.checkPermission(ctx("Bash", { command: "git status" }, "yolo", "high", { skillActivationRules: denyPush })).decision,
    "allow",
  );
});

test("①: 裁决 4——deny 侧 \"*\" 全工具通配生效；allow 侧 \"*\" 不授予（fail-closed）", () => {
  const service = makeService();
  assert.equal(
    service.checkPermission(ctx("Bash", { command: "ls" }, "yolo", "low", { skillActivationRules: scope([], [{ toolName: "*" }]) })).decision,
    "deny",
  );
  // allow "*" 在 build 下不改变副作用工具的 ask 结局（不授予）。
  const decision = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "build", "medium", {
      skillActivationRules: scope([{ toolName: "*" }]),
    }),
  );
  assert.notEqual(decision.ruleId, "rule.skillActivation.allow");
});

test("①: 裁决 3——mcp__server 服务器级前缀覆盖双侧生效", () => {
  const service = makeService();
  const allowSrv = scope([{ toolName: "mcp__srv" }]);
  assert.equal(
    service.checkPermission(ctx("mcp__srv__tool", {}, "build", "medium", { skillActivationRules: allowSrv })).decision,
    "allow",
  );
  const denySrv = scope([], [{ toolName: "mcp__srv" }]);
  assert.equal(
    service.checkPermission(ctx("mcp__srv__tool", {}, "yolo", "low", { skillActivationRules: denySrv })).decision,
    "deny",
  );
});

test("①: 裁决 5——ruleContent 含 / 时 subject 反斜杠归一再匹配（Windows 路径）", () => {
  const service = makeService();
  const denySecret = scope([], [{ toolName: "Write", ruleContent: "C:/secret/*" }]);
  assert.equal(
    service.checkPermission(
      ctx("Write", { file_path: "C:\\secret\\creds.json" }, "yolo", "medium", {
        skillActivationRules: denySecret,
      }),
    ).decision,
    "deny",
  );
});

// ── ① 权限消费：allow 并入会话级 allow 位次且受压制 ───────────────────

test("①: 技能 allow 放行 build 下本会 ask 的写入（会话级 allow 位次）", () => {
  const service = makeService();
  const baseline = service.checkPermission(ctx("Write", { file_path: "a.ts" }, "build", "medium"));
  assert.equal(baseline.decision, "ask");
  const decision = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "build", "medium", {
      skillActivationRules: scope([{ toolName: "Write" }]),
    }),
  );
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "rule.skillActivation.allow");
});

test("①: frontmatter 授权永不穿透 policy floor（地板 deny 压过技能 allow）", () => {
  const service = makeService({
    policyFloor: { deny: [{ toolName: "Write" }], ask: [], disableBypassPermissionsMode: false },
  });
  const decision = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "build", "medium", {
      skillActivationRules: scope([{ toolName: "Write" }]),
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.policy.deny");
});

test("①: plan 结构拒写压过技能 allow（planEnabled 分支在 allow 位次之前）", () => {
  const service = makeService();
  const decision = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "plan", "medium", {
      skillActivationRules: scope([{ toolName: "Write" }]),
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.notEqual(decision.ruleId, "rule.skillActivation.allow");
});

test("①: disallowedTools 硬阻断压过技能 allow（硬禁用先收口）", () => {
  const service = makeService({ disallowedTools: ["Write"] });
  const decision = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "build", "medium", {
      skillActivationRules: scope([{ toolName: "Write" }]),
    }),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("①: buildSkillActivationScope 并集去重语义不回退（消费端契约自检）", () => {
  const built = buildSkillActivationScope({
    loadedSkillNames: ["a", "a"],
    catalog: [
      {
        name: "a",
        governance: {
          allowedTools: [{ toolName: "Read" }, { toolName: "Read" }],
          disallowedTools: [{ toolName: "Bash", ruleContent: "curl:*" }],
        },
      },
    ],
  });
  assert.equal(built.allow.length, 1);
  assert.equal(built.deny.length, 1);
  assert.deepEqual(built.skills, ["a"]);
});

// ── ② paths 触发源 ────────────────────────────────────────────────────

function pathSkill(name, patterns) {
  return {
    name,
    description: `desc ${name}`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    source: "file",
    ...(patterns ? { governance: { pathTriggers: patterns } } : {}),
  };
}

test("②: 文件触碰命中 pathTriggers → 激活并只激活一次；reminder 携带技能名", () => {
  const sessionId = "sess_paths_wiring";
  clearSkillPathActivations(sessionId);
  const catalog = [pathSkill("db-skill", ["src/db/**"]), pathSkill("plain")];
  const first = activateSkillsForTouchedToolCall({
    sessionId,
    catalog,
    toolName: "Write",
    toolInput: { file_path: join(WORKSPACE, "src/db/schema.ts") },
    workingDirectory: WORKSPACE,
  });
  assert.deepEqual(first.map((skill) => skill.name), ["db-skill"]);
  assert.match(buildSkillPathActivationReminder(first), /"db-skill"/);
  assert.match(buildSkillPathActivationReminder(first), /<system-reminder>/);
  // 二次触碰不重复激活。
  const second = activateSkillsForTouchedToolCall({
    sessionId,
    catalog,
    toolName: "Read",
    toolInput: { file_path: join(WORKSPACE, "src/db/other.ts") },
    workingDirectory: WORKSPACE,
  });
  assert.deepEqual(second, []);
  assert.ok(listPathActivatedSkills(sessionId).has("db-skill"));
  clearSkillPathActivations(sessionId);
});

test("②: 逃逸路径不触发（fail-closed）；非文件工具零动作", () => {
  const sessionId = "sess_paths_escape";
  clearSkillPathActivations(sessionId);
  const catalog = [pathSkill("db-skill", ["src/db/**"])];
  assert.deepEqual(
    activateSkillsForTouchedToolCall({
      sessionId,
      catalog,
      toolName: "Read",
      toolInput: { file_path: join(tmpdir(), "outside/src/db/x.ts") },
      workingDirectory: WORKSPACE,
    }),
    [],
  );
  assert.deepEqual(
    activateSkillsForTouchedToolCall({
      sessionId,
      catalog,
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/src/db/x" },
      workingDirectory: WORKSPACE,
    }),
    [],
  );
  clearSkillPathActivations(sessionId);
});

test("②: 模型清单过滤——sessionId 在场时未激活的 paths 技能不可见，激活后可见；缺席零回归", () => {
  const sessionId = "sess_paths_listing";
  clearSkillPathActivations(sessionId);
  const outcome = {
    skills: [pathSkill("db-skill", ["src/db/**"]), pathSkill("plain")],
    diagnostics: [],
    totalDiscovered: 2,
  };
  // sessionId 缺席（子代理/旧调用方）：全量清单（既有行为零回归）。
  const anonymous = buildSkillsSection({ outcome });
  assert.match(anonymous.content, /db-skill/);
  // 会话在场、未激活：paths 技能隐藏，普通技能照常。
  const before = buildSkillsSection({ outcome, sessionId });
  assert.ok(!before.content.includes("db-skill"));
  assert.match(before.content, /plain/);
  // 激活后：清单重建即可见。
  activateSkillsForTouchedToolCall({
    sessionId,
    catalog: outcome.skills,
    toolName: "Edit",
    toolInput: { file_path: join(WORKSPACE, "src/db/m.ts") },
    workingDirectory: WORKSPACE,
  });
  const after = buildSkillsSection({ outcome, sessionId });
  assert.match(after.content, /db-skill/);
  clearSkillPathActivations(sessionId);
});

// ── ③ disable-model-invocation 硬门 ──────────────────────────────────

test("③: 用户指名标记一次性消费；不匹配不吞标记", () => {
  markUserInvokedSkillForTurn("sess_marker", "deploy");
  // 名字不匹配：拒绝且不消费（用户指名的 deploy 仍可被兑现）。
  assert.equal(consumeUserInvokedSkillMarker("sess_marker", ["other"]), false);
  assert.equal(consumeUserInvokedSkillMarker("sess_marker", ["deploy"]), true);
  // 一次性：再消费为 false。
  assert.equal(consumeUserInvokedSkillMarker("sess_marker", ["deploy"]), false);
  clearUserInvokedSkillMarker("sess_marker");
});

function makeSkillContext(sessionId, governance) {
  return {
    sessionId,
    toolCallId: "call_1",
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    skillPort: {
      loadSkill: async () => ({
        baseDirectory: join(WORKSPACE, ".agents/skills/locked"),
        content: "locked skill body without placeholders",
        metadata: {
          name: "locked",
          qualifiedName: "plugin:locked",
          source: "file",
          ...(governance ? { governance } : {}),
        },
        truncated: false,
      }),
    },
  };
}

test("③: handler 硬门——无标记拒绝受门技能（业务失败+指位文案），有标记放行且消费", async () => {
  const sessionId = "sess_gate";
  clearUserInvokedSkillMarker(sessionId);
  const gated = await skillToolEntry.handler(
    { skill: "locked" },
    makeSkillContext(sessionId, { disableModelInvocation: true }),
  );
  assert.equal(gated.result, false);
  assert.match(gated.message, /reserved for explicit user invocation/);
  assert.match(gated.message, /NOT loaded/);

  markUserInvokedSkillForTurn(sessionId, "locked");
  const allowed = await skillToolEntry.handler(
    { skill: "locked" },
    makeSkillContext(sessionId, { disableModelInvocation: true }),
  );
  assert.equal(typeof allowed, "string");
  assert.match(allowed, /<skill_content name="locked">/);
  // 标记已被消费：紧接着的第二次模型面调用被拒。
  const second = await skillToolEntry.handler(
    { skill: "locked" },
    makeSkillContext(sessionId, { disableModelInvocation: true }),
  );
  assert.equal(second.result, false);
  clearUserInvokedSkillMarker(sessionId);
});

test("③: 无 governance 技能不受门影响（缺省语义零回归）", async () => {
  const output = await skillToolEntry.handler(
    { skill: "locked" },
    makeSkillContext("sess_gate_default", undefined),
  );
  assert.equal(typeof output, "string");
  assert.match(output, /locked skill body/);
});
