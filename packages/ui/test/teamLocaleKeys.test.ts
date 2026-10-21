import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 团队卡 / 团队面板文案守护：中英两套词典的团队键集必须一致，且源仓库团队卡依赖的
 * 关键键一个都不能少（缺键时 IntlProvider 会把原始 id 直接画到界面上）。
 */
const isTeamKey = (key: string) =>
  key.startsWith("teamPanel.") ||
  key === "sidePane.team" ||
  key.startsWith("sidePane.team.") ||
  key.startsWith("chat.statusPanel.agentTeams");

const zhKeys = Object.keys(zhCN).filter(isTeamKey).sort();
const enKeys = Object.keys(enUS).filter(isTeamKey).sort();

test("zh-CN and en-US expose the same team key set", () => {
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length >= 96, `团队键数量不足：${zhKeys.length}`);
});

test("team card and team pane critical keys exist in both locales", () => {
  const required = [
    "teamPanel.timeline.card",
    "teamPanel.timeline.phase",
    "teamPanel.timeline.unassigned",
    "teamPanel.timeline.summary",
    "teamPanel.timeline.memberTasks",
    "teamPanel.timeline.failures",
    "teamPanel.timeline.collapseMembers",
    "teamPanel.timeline.expandMembers",
    "teamPanel.timeline.doneCount",
    "teamPanel.timeline.tasksTitle",
    "teamPanel.timeline.groupRunning",
    "teamPanel.timeline.groupFailed",
    "teamPanel.timeline.groupReady",
    "teamPanel.timeline.groupTodo",
    "teamPanel.timeline.groupDone",
    "teamPanel.timeline.moreTasks",
    "teamPanel.timeline.fillApproval",
    "teamPanel.timeline.copyApproval",
    "teamPanel.timeline.copied",
    "teamPanel.timeline.viewPlan",
    "teamPanel.timeline.openStage",
    "teamPanel.timeline.paneSummary",
    "teamPanel.blocked.title",
    "teamPanel.blocked.body",
    "teamPanel.blocked.fixHint",
    "teamPanel.blocked.gateSuffix",
    "teamPanel.topology.label",
    "teamPanel.topology.digraph",
    "teamPanel.topology.chain",
    "teamPanel.topology.single",
    "teamPanel.topology.parallel",
    "teamPanel.group.inProgress",
    "teamPanel.group.ready",
    "teamPanel.group.waiting",
    "teamPanel.group.done",
    "teamPanel.group.blocked",
    "teamPanel.group.empty",
    "teamPanel.readyUnavailable",
    "teamPanel.nowReady",
    "teamPanel.tasks.empty",
    "teamPanel.member.empty",
    "teamPanel.member.openSession",
    "teamPanel.member.openSessionShort",
    "teamPanel.member.waitingDeps",
    "teamPanel.member.pending",
    "teamPanel.member.idle",
    "teamPanel.member.registered",
    "teamPanel.mailbox.unreadSection",
    "teamPanel.mailbox.rosterSection",
    "teamPanel.mailbox.empty",
    "teamPanel.mailbox.previewUnavailable",
    "teamPanel.mailbox.previewLimited",
    "teamPanel.mailbox.rosterEmpty",
    "teamPanel.mailbox.counts",
    "teamPanel.tab.overview",
    "teamPanel.tab.tasks",
    "teamPanel.tab.members",
    "teamPanel.tab.mailbox",
    "teamPanel.teamSwitcher",
    "teamPanel.empty",
    "teamPanel.loading",
    "teamPanel.targetEnded",
    "teamPanel.archivedHint",
    "teamPanel.endedReadonly",
    "teamPanel.metric.ready",
    "teamPanel.metric.criticalPath",
    "teamPanel.metric.members",
    "teamPanel.metric.unread",
    "teamPanel.depthUnit",
    "teamPanel.view.graph",
    "teamPanel.view.list",
    "sidePane.team",
    "chat.statusPanel.agentTeams",
    "chat.statusPanel.agentTeams.statusDraft",
    "chat.statusPanel.agentTeams.statusActive",
    "chat.statusPanel.agentTeams.statusPaused",
    "chat.statusPanel.agentTeams.statusArchived",
    "chat.statusPanel.agentTeams.memberCount",
    "chat.statusPanel.agentTeams.memberCountOfMax",
    "chat.statusPanel.agentTeams.openPanel",
    "chat.statusPanel.agentTeams.copyPanelUrlFailed",
    "chat.statusPanel.agentTeams.stale",
    "chat.statusPanel.agentTeams.staleHint",
    "chat.statusPanel.agentTeams.showAll",
    "chat.statusPanel.agentTeams.showLess",
    "chat.statusPanel.agentTeams.endedTeams",
    "chat.statusPanel.agentTeams.failedCount",
    "chat.statusPanel.agentTeams.lingeringMembers",
    "chat.statusPanel.agentTeams.stopAll",
  ];
  for (const key of required) {
    assert.equal(typeof zhCN[key], "string", `zh-CN 缺少 ${key}`);
    assert.equal(typeof enUS[key], "string", `en-US 缺少 ${key}`);
  }
});
