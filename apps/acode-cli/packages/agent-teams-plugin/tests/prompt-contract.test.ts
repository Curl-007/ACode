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

  it("commands/team.md routes rejection through send_message, not reassign", () => {
    assert.ok(team.includes("驳回返工走追加指令"), "team.md must name the rejection channel");
    assert.ok(
      team.includes("agent_teams_send_message(to: <成员名>"),
      "team.md must show the send_message call shape",
    );
    assert.ok(
      team.includes("只用于两件事"),
      "team.md must scope reassign to owner change and takeover",
    );
  });

  it("commands/team.md caps reassign rounds and stops on the cap", () => {
    assert.ok(team.includes("最大驳回轮次"), "team.md must carry the max-rounds discipline");
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
      "SKILL.md must name the rejection channel",
    );
    assert.ok(skill.includes("reassign_limit_exceeded"), "SKILL.md must name the cap error");
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

  it("allows a member to reject a task it should not do", () => {
    assert.ok(member.includes("允许否决"), "member.md must allow vetoing a task");
    assert.ok(member.includes("不该做"), "member.md must name the veto condition");
  });

  it("asks long tasks to be split into batches", () => {
    assert.ok(member.includes("长任务分批跑"), "member.md must ask for batched long tasks");
    assert.ok(member.includes("blockedReason"), "member.md must say how to report a batch stop");
  });

  it("keeps the scope boundary and the stop-after-report rule", () => {
    assert.ok(member.includes("只做指定那一步"), "member.md must keep the scope boundary");
    assert.ok(member.includes("答完停下回报"), "member.md must keep stop-after-report");
  });

  it("does not change the frontmatter knobs the PRD froze", () => {
    assert.ok(member.includes("maxTurns: 40"), "maxTurns must stay 40");
  });
});

describe("prompt contract: docs and spec", () => {
  it("docs/protocol.md documents the rejection semantics and the cap", () => {
    const protocol = read("docs/protocol.md");
    assert.ok(protocol.includes("驳回语义"), "protocol.md must document rejection semantics");
    assert.ok(protocol.includes("reassign_limit_exceeded"), "protocol.md must document the error");
    assert.ok(protocol.includes("不记得上一批"), "protocol.md must state next_actions is derived");
  });

  it("docs/usage.md documents the two new troubleshooting rows", () => {
    const usage = read("docs/usage.md");
    assert.ok(usage.includes("队长在轮询"), "usage.md must cover the polling symptom");
    assert.ok(usage.includes("驳回后成员从零开始"), "usage.md must cover the lost-context symptom");
    assert.ok(usage.includes("maxReassignRounds"), "usage.md must list the new config key");
  });
});
