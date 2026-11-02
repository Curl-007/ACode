import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * 提示词的**效果**无法单测（模型行为不确定），但**关键句子是否存在**可以断言。
 * 这些纪律是契约的一部分：后续有人重构文档时把它们删掉，这里会红。
 *
 * 只断言关键短语，不断言段落结构/编号顺序——否则改一个字就要改测试，文档维护会变僵硬。
 */

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const read = (relativePath: string): string =>
  readFileSync(join(PLUGIN_ROOT, relativePath), "utf8");

describe("prompt contract: captain protocol", () => {
  const team = read("commands/team.md");
  const skill = read("skills/agent-teams/SKILL.md");

  it("commands/team.md forbids polling", () => {
    assert.ok(team.includes("不许轮询"), "team.md must carry the no-polling discipline");
    assert.ok(team.includes("不是进度条"), "team.md must say status is not a progress bar");
    assert.ok(team.includes("派完活就真的停下"), "team.md must say to stop after dispatch");
  });

  it("commands/team.md states next_actions is freshly derived each time", () => {
    assert.ok(team.includes("不记得上一批"), "team.md must say next_actions does not remember");
    assert.ok(team.includes("纯派生"), "team.md must say next_actions is purely derived");
  });

  it("commands/team.md splits补要求 from 打回 and revokes captain takeover", () => {
    assert.ok(team.includes("只补要求、不返工"), "team.md must separate topping-up from rework");
    assert.ok(
      team.includes("agent_teams_send_message(to: <成员名>"),
      "team.md must show the send_message call shape",
    );
    assert.ok(
      team.includes("不再用于队长接管"),
      "team.md must revoke reassign-for-takeover (captain takeover revoked, Q2)",
    );
  });

  it("commands/team.md teaches 汇报 != 验收, in_review and merge-as-acceptance", () => {
    assert.ok(team.includes("只是**汇报**"), "team.md must say done is a report, not acceptance");
    assert.ok(team.includes("in_review"), "team.md must name the in_review status");
    assert.ok(team.includes("合并即验收"), "team.md must state merging is acceptance");
    assert.ok(team.includes("agent_teams_accept_task"), "team.md must name the explicit accept tool");
    assert.ok(team.includes("$ "), "team.md must carry the `$ ` declaration syntax");
    assert.ok(team.includes("verify_required"), "team.md must name the undeclared-command refusal");
  });

  it("commands/team.md caps reassign rounds and stops on the cap", () => {
    assert.ok(team.includes("最大重派轮次"), "team.md must carry the max-rounds discipline");
    assert.ok(team.includes("reassign_limit_exceeded"), "team.md must name the error code");
    assert.ok(team.includes("需要人工介入"), "team.md must say to report to the user at the cap");
  });

  it("commands/team.md requires reading the artifact before accepting", () => {
    assert.ok(team.includes("验收要读原文"), "team.md must carry the read-the-artifact discipline");
    assert.ok(team.includes("verification-reminder"), "team.md must point at the reminder tag");
  });

  it("SKILL.md mirrors the captain disciplines", () => {
    assert.ok(skill.includes("不许轮询"), "SKILL.md must forbid polling");
    assert.ok(skill.includes("不记得上一批"), "SKILL.md must state next_actions is not sticky");
    assert.ok(
      skill.includes("agent_teams_send_message"),
      "SKILL.md must name the topping-up channel",
    );
    assert.ok(skill.includes("reassign_limit_exceeded"), "SKILL.md must name the cap error");
    assert.ok(skill.includes("汇报 ≠ 验收"), "SKILL.md must mirror report != acceptance");
    assert.ok(skill.includes("合并即验收"), "SKILL.md must mirror merge-as-acceptance");
    assert.ok(skill.includes("$ <命令>"), "SKILL.md must mirror the `$ ` declaration syntax");
  });

  it("commands/team.md and SKILL.md teach the captain-side blocking wait (batch 3)", () => {
    assert.ok(
      team.includes("agent_teams_wait_for_members"),
      "team.md must route the captain into the wait tool instead of polling",
    );
    assert.ok(team.includes("timedOut"), "team.md must say a timedOut wait is not an error");
    assert.ok(
      team.includes("立即返回"),
      "team.md must state that a member question/escalation returns immediately",
    );
    assert.ok(
      skill.includes("agent_teams_wait_for_members"),
      "SKILL.md must mirror the captain wait tool",
    );
    assert.ok(
      skill.includes("wakePending"),
      "SKILL.md must name the host wake projection source",
    );
  });
});

describe("prompt contract: member brief", () => {
  const member = read("agents/member.md");

  it("carries the task-brief discipline section", () => {
    assert.ok(member.includes("任务书纪律"), "member.md must carry the task-brief section");
  });

  it("separates measured results from unverified claims", () => {
    assert.ok(member.includes("实测"), "member.md must mention measured results");
    assert.ok(member.includes("未验证"), "member.md must mention unverified claims");
  });

  it("teaches members that done reports into in_review with `$ ` declarations", () => {
    assert.ok(member.includes("in_review"), "member.md must name the in_review status");
    assert.ok(member.includes("不是终态"), "member.md must say in_review is not terminal");
    assert.ok(member.includes("$ "), "member.md must carry the `$ ` declaration syntax");
    assert.ok(
      member.includes("agent_teams_run_checks"),
      "member.md must name the command the captain runs",
    );
  });

  it("allows a member to reject a task it should not do", () => {
    assert.ok(member.includes("允许否决"), "member.md must allow vetoing a task");
    assert.ok(member.includes("不该做"), "member.md must name the veto condition");
  });

  it("asks long tasks to be split into batches", () => {
    assert.ok(member.includes("长任务分批跑"), "member.md must ask for batched long tasks");
    assert.ok(member.includes("blockedReason"), "member.md must say how to report a batch stop");
  });

  it("keeps the scope boundary and the wait-after-report rule", () => {
    assert.ok(member.includes("只做指定那一步"), "member.md must keep the scope boundary");
    assert.ok(member.includes("答完回报再等活"), "member.md must keep wait-after-report");
    assert.ok(
      member.includes("agent_teams_wait_for_work"),
      "member.md must route idle members into the wait tool instead of ending",
    );
    assert.ok(
      member.includes("只有队长能让你停"),
      "member.md must state that only the captain ends members",
    );
  });

  it("scope control suggests follow-ups instead of fixing unrelated issues", () => {
    assert.ok(member.includes("范围控制"), "member.md must carry the scope-control section");
    assert.ok(
      member.includes("只建议不修"),
      "member.md must say unrelated issues are suggested, not fixed",
    );
    assert.ok(
      member.includes("验证面跟验收走"),
      "member.md must tie the verification surface to acceptance",
    );
  });

  it("resumed tasks check existing progress before continuing", () => {
    assert.ok(member.includes("续跑任务"), "member.md must carry the resumed-tasks section");
    assert.ok(
      member.includes("先核对盘上已有进度"),
      "member.md must say to check on-disk progress first",
    );
    assert.ok(member.includes("不从头重做"), "member.md must say not to redo from scratch");
    assert.ok(
      member.includes("记忆可信，盘面为准"),
      "member.md must prefer the current disk state over memory",
    );
  });

  it("on permission denial members report instead of working around", () => {
    assert.ok(member.includes("出错时"), "member.md must carry the when-things-go-wrong section");
    assert.ok(member.includes("权限被拒绝"), "member.md must name the permission-denied case");
    assert.ok(
      member.includes("需要用户审批"),
      "member.md must say approval needs are reported back",
    );
    assert.ok(member.includes("不换路径绕过"), "member.md must forbid working around a denial");
  });

  it("gives resident members enough turns to idle-wait", () => {
    // 常驻成员每轮等待（≤8 分钟）消耗一轮；40 轮只够约 5 小时空等，放宽到 200。
    assert.ok(member.includes("maxTurns: 200"), "maxTurns must be 200 for resident members");
  });
});

describe("prompt contract: docs and spec", () => {
  it("docs/protocol.md documents the rejection semantics and the cap", () => {
    const protocol = read("docs/protocol.md");
    assert.ok(protocol.includes("驳回语义"), "protocol.md must document rejection semantics");
    assert.ok(protocol.includes("reassign_limit_exceeded"), "protocol.md must document the error");
    assert.ok(protocol.includes("不记得上一批"), "protocol.md must state next_actions is derived");
  });

  it("docs/protocol.md documents the in_review state machine and the acceptance discipline", () => {
    const protocol = read("docs/protocol.md");
    assert.ok(protocol.includes("in_review"), "protocol.md must document the in_review status");
    assert.ok(
      protocol.includes("in_review --accept--> done"),
      "protocol.md must show the accept transition",
    );
    assert.ok(protocol.includes("验收纪律"), "protocol.md must carry the acceptance discipline");
    assert.ok(
      protocol.includes("未经验收的 done"),
      "protocol.md must state there is no unaccepted done",
    );
    assert.ok(protocol.includes("合并即验收"), "protocol.md must state merging is acceptance");
  });

  it("docs/usage.md documents the acceptance loop and in_review troubleshooting", () => {
    const usage = read("docs/usage.md");
    assert.ok(usage.includes("待验收"), "usage.md must mention awaiting acceptance");
    assert.ok(usage.includes("in_review"), "usage.md must name the status for operators");
    assert.ok(usage.includes("verify_required"), "usage.md must cover the verify_required row");
    assert.ok(usage.includes("acceptance_frozen"), "usage.md must cover the frozen-acceptance row");
  });

  it("docs/usage.md documents the two new troubleshooting rows", () => {
    const usage = read("docs/usage.md");
    assert.ok(usage.includes("队长在轮询"), "usage.md must cover the polling symptom");
    assert.ok(usage.includes("驳回后成员从零开始"), "usage.md must cover the lost-context symptom");
    assert.ok(usage.includes("maxReassignRounds"), "usage.md must list the new config key");
  });

  it("docs/protocol.md documents the captain wait tool and the wake projection (batch 3)", () => {
    const protocol = read("docs/protocol.md");
    assert.ok(
      protocol.includes("agent_teams_wait_for_members"),
      "protocol.md must document the captain wait tool",
    );
    assert.ok(protocol.includes("wakePending"), "protocol.md must document the wake projection");
    assert.ok(protocol.includes("timedOut"), "protocol.md must say a timed-out wait is not an error");
    assert.ok(
      protocol.includes("kind"),
      "protocol.md must document the send_message kind tag",
    );
  });
});
