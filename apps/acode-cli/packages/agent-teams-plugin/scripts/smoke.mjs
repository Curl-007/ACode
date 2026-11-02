#!/usr/bin/env node
/**
 * AgentTeams 插件 server 的端到端冒烟：用 @modelcontextprotocol/client 的
 * Client + StdioClientTransport 驱动（与宿主 adapter 同一条协商链路，含
 * server/discover 版本协商）。无 _meta 的 tools/call 用 caller 降级身份。
 * 驱动/通知/断言样板在 scripts/smoke-lib.mjs（与 smoke-acceptance.mjs 共用）。
 *
 * 验证：tools/list（21 个）→ create → add/bind → create_task（依赖）→
 * approve → status（next_actions）→ claim → update（verify 门，汇报落 in_review）→
 * send_message → accept_task（非隔离团队验收 → done）→ status → 面板 API →
 * delete → 工具关闭；0.2 增补：多团队并行、teamId 寻址、team_ambiguous、
 * status 总览、adopt_team、teams[] 通知、/api/teams。
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capturePluginState,
  createChecker,
  createWorkspace,
  errorOf,
  parseResult,
  startAgentTeamsClient,
} from "./smoke-lib.mjs";

const workspace = createWorkspace("agent-teams-smoke-");
const { client, transport } = startAgentTeamsClient({ workspace, name: "smoke" });
const { waitForPluginState } = capturePluginState(client);
await client.connect(transport);

const toolCall = (name, args, caller) =>
  client.callTool({ name, arguments: { ...args, ...(caller ? { caller } : {}) } });
const text = parseResult;
const { check, crash, finish } = createChecker();

try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  check("21 tools listed", names.length === 21);
  check("create present", names.includes("agent_teams_create"));
  check("adopt_team present", names.includes("agent_teams_adopt_team"));
  check("merge_member_worktree present", names.includes("agent_teams_merge_member_worktree"));
  // 批次 0/1/3 新增的工具面：验收 diff/checks、显式验收、队长等待成员。
  check("review_member_diff present", names.includes("agent_teams_review_member_diff"));
  check("run_checks present", names.includes("agent_teams_run_checks"));
  check("accept_task present", names.includes("agent_teams_accept_task"));
  check("wait_for_members present", names.includes("agent_teams_wait_for_members"));
  check(
    "schemas carry type object",
    listed.tools.every((tool) => tool.inputSchema?.type === "object"),
  );

  const created = text(
    await toolCall("agent_teams_create", { goal: "smoke goal" }, { role: "captain" }),
  );
  check("team created as draft", created.status === "draft");
  check("identity_degraded warning present", typeof created.identity_degraded === "string");
  check("panel_url present", typeof created.panel_url === "string");

  const added = text(
    await toolCall(
      "agent_teams_add_member",
      { name: "dev-1", role: "dev", charter: "impl" },
      { role: "captain" },
    ),
  );
  check(
    "spawn_instruction returned",
    added.spawn_instruction.subagent_type === "agent-teams:member",
  );

  const bound = text(
    await toolCall(
      "agent_teams_bind_member",
      { name: "dev-1", agentId: "agent-smoke-1" },
      { role: "captain" },
    ),
  );
  check("bind ok", bound.member === "dev-1");

  const t1 = text(
    await toolCall(
      "agent_teams_create_task",
      { title: "implement", objective: "write it", acceptance: ["works"] },
      { role: "captain" },
    ),
  );
  check("task t-1", t1.taskId === "t-1");
  const t2 = text(
    await toolCall(
      "agent_teams_create_task",
      {
        title: "review",
        objective: "review it",
        acceptance: ["reviewed"],
        kind: "review",
        dependencies: ["t-1"],
      },
      { role: "captain" },
    ),
  );
  check("task t-2", t2.taskId === "t-2");

  const denied = await toolCall(
    "agent_teams_create_task",
    { title: "x", objective: "y", acceptance: ["z"] },
    { name: "dev-1", role: "member" },
  );
  check("member cannot create task", errorOf(denied).code === "forbidden_for_caller");

  const approved = text(
    await toolCall("agent_teams_approve_plan", { confirmation: "smoke go" }, { role: "captain" }),
  );
  check("approved to active", approved.status === "active");
  check("wake instruction for t-1", approved.next_actions.wake[0]?.taskId === "t-1");
  check(
    "wake message carries acceptance",
    approved.next_actions.wake[0]?.message.includes("works"),
  );

  // 桌面面板通道：approve 之后应收到带任务列表的 TeamPanelState 通知。
  const panelState = await waitForPluginState((n) => n.data?.tasks?.length === 2);
  check(
    "plugin state notification carries TeamPanelState",
    panelState.logger === "acode-plugin-state:agent-teams" &&
      panelState.data.v === 1 &&
      Array.isArray(panelState.data.tasks) &&
      panelState.data.counts.todo === 2,
  );
  // 派生字段：本场景 t-1 无依赖（唯一就绪），t-2 依赖 t-1（故不就绪、关键路径 2 层）。
  // 这几个字段是宿主画依赖图与就绪集的唯一来源，缺了面板只能退化成扁平列表。
  check(
    "panel state carries derived dag fields",
    Array.isArray(panelState.data.readyTaskIds) &&
      panelState.data.readyTaskIds.length === 1 &&
      panelState.data.readyTaskIds[0] === "t-1" &&
      panelState.data.criticalPathDepth === 2 &&
      Array.isArray(panelState.data.blockedByFailedQuality) &&
      panelState.data.blockedByFailedQuality.length === 0 &&
      Array.isArray(panelState.data.mailboxes) &&
      Array.isArray(panelState.data.unreadMessages) &&
      typeof panelState.data.maxMembers === "number",
  );

  const parallelClaims = await Promise.all([
    toolCall("agent_teams_claim_task", { taskId: "t-1" }, { name: "dev-1", role: "member" }),
    toolCall("agent_teams_claim_task", { taskId: "t-1" }, { name: "dev-1", role: "member" }),
  ]);
  const successfulClaims = parallelClaims
    .map((result) => JSON.parse(result.content[0].text))
    .filter((result) => result.ok);
  check("parallel claims admit exactly one attempt", successfulClaims.length === 1);
  const claimed = successfulClaims[0];
  check("claim returns attempt_id", typeof claimed?.attempt_id === "string");

  const noVerify = await toolCall(
    "agent_teams_update_task",
    { taskId: "t-1", attemptId: claimed.attempt_id, status: "done", summary: "ok" },
    { name: "dev-1", role: "member" },
  );
  check("done requires verify", errorOf(noVerify).code === "verify_required");

  const updated = text(
    await toolCall(
      "agent_teams_update_task",
      {
        taskId: "t-1",
        attemptId: claimed.attempt_id,
        status: "done",
        summary: "ok",
        verify: "smoke pass",
      },
      { name: "dev-1", role: "member" },
    ),
  );
  // 批次 1（spec 第 2 册 R2.1/R2.2）：update_task(done) 是「汇报」，落 in_review 而非 done。
  check("task reported to in_review", updated.status === "in_review");
  check("in_review awaits acceptance", updated.awaiting_acceptance === true);

  const sent = text(
    await toolCall(
      "agent_teams_send_message",
      { to: "captain", message: "done" },
      { name: "dev-1", role: "member" },
    ),
  );
  check("message from derived", sent.from === "dev-1");

  // 批次 1（spec 第 2 册 R2.1/OQ-1）：本冒烟团队未开工作树隔离，无合并入口，验收走
  // 队长显式 accept_task（isolated 团队该工具会被拒，改由合并耦合验收）。仅 accept 到 done
  // 后才放行下游依赖（dag.dependencySatisfied 只认 done）。
  const accepted = text(
    await toolCall("agent_teams_accept_task", { taskId: "t-1" }, { role: "captain" }),
  );
  check(
    "accept_task closes in_review task",
    accepted.status === "done" && accepted.accepted === true,
  );

  const status = text(await toolCall("agent_teams_status", {}, { role: "captain" }));
  check("captain status perspective", status.perspective === "captain");
  // status 返回本次读取的消息内容（读即置已读），下次 status 才为空。
  check(
    "captain mailbox delivered content",
    Array.isArray(status.unread.captain) &&
      status.unread.captain.some((message) => message.from === "dev-1"),
  );
  check("t-2 ready after t-1 accepted", status.ready_tasks.includes("t-2"));
  const readState = await waitForPluginState(
    (notification) =>
      notification.data?.teamId === created.teamId &&
      notification.data?.mailboxes?.some(
        (mailbox) => mailbox.address === "captain" && mailbox.unread === 0 && mailbox.read === 1,
      ),
  );
  check(
    "reading captain mailbox updates projected counts and message sample",
    readState.data.unreadMessages.every((message) => message.to !== "captain"),
  );

  const panelUrl = created.panel_url;
  const panelResponse = await fetch(`${panelUrl}api/state`);
  const panelApiState = await panelResponse.json();
  check("panel serves disk truth", panelApiState.team?.goal === "smoke goal");
  check("panel shows tasks", panelApiState.tasks?.length === 2);

  const deleted = text(
    await toolCall("agent_teams_delete", { archive: true }, { role: "captain" }),
  );
  check("archived", deleted.archived === true);
  const archivedState = await waitForPluginState(
    (n) => n.data?.teamId === created.teamId && n.data?.status === "archived",
  );
  check("archive notification retains terminal team", archivedState.data.status === "archived");
  check(
    "archive notification retains mailbox counts",
    archivedState.data.mailboxes?.some(
      (mailbox) => mailbox.address === "captain" && mailbox.read === 1,
    ),
  );
  const historyResponse = await fetch(`${panelUrl}history/${created.teamId}/api`);
  const history = await historyResponse.json();
  check(
    "archived panel keeps team and tasks",
    history.team?.status === "archived" && history.tasks?.length === 2,
  );
  const closed = await toolCall("agent_teams_status", {}, { role: "captain" });
  check("tools closed after archive", errorOf(closed).code === "no_active_team");

  // ---- 0.2 多团队 ----
  const teamA = text(
    await toolCall("agent_teams_create", { goal: "scan goal" }, { role: "captain" }),
  );
  const teamB = text(
    await toolCall("agent_teams_create", { goal: "fix goal" }, { role: "captain" }),
  );
  check("second team created (multi-team)", teamA.teamId !== teamB.teamId);

  // 不带 teamId 的非 status 工具在名下 ≥2 团队时报 team_ambiguous 且带 candidates。
  const ambiguous = await toolCall(
    "agent_teams_add_member",
    { name: "dev-1", role: "dev", charter: "c" },
    { role: "captain" },
  );
  const ambiguousError = errorOf(ambiguous);
  check(
    "team_ambiguous with candidates",
    ambiguousError.code === "team_ambiguous" && ambiguousError.data.candidates.length === 2,
  );

  // status 不带 teamId 返回多团队总览。
  const overview = text(await toolCall("agent_teams_status", {}, { role: "captain" }));
  check(
    "status overview lists both teams",
    Array.isArray(overview.teams) &&
      overview.teams.length === 2 &&
      overview.teams.some((team) => team.teamId === teamA.teamId) &&
      overview.teams.some((team) => team.teamId === teamB.teamId),
  );

  // teamId 寻址：A 组团，B 保持空团队（隐式寻址会歧义，全部显式）。
  const memberAdded = text(
    await toolCall(
      "agent_teams_add_member",
      { teamId: teamA.teamId, name: "dev-1", role: "dev", charter: "impl" },
      { role: "captain" },
    ),
  );
  check("teamId addressing works", memberAdded.teamId === teamA.teamId);
  const taskA = text(
    await toolCall(
      "agent_teams_create_task",
      { teamId: teamA.teamId, title: "scan", objective: "scan it", acceptance: ["scanned"] },
      { role: "captain" },
    ),
  );
  const taskB = text(
    await toolCall(
      "agent_teams_create_task",
      { teamId: teamB.teamId, title: "scan", objective: "scan it too", acceptance: ["scanned"] },
      { role: "captain" },
    ),
  );
  check("task ids are per-team namespaces", taskA.taskId === "t-1" && taskB.taskId === "t-1");

  // 面板多团队端点。
  const teamsListing = await (await fetch(`${panelUrl}api/teams`)).json();
  check(
    "panel /api/teams lists both",
    teamsListing.teams?.length === 2 && teamsListing.teams.some((t) => t.teamId === teamA.teamId),
  );
  const teamPage = await (await fetch(`${panelUrl}team/${teamA.teamId}/api/state`)).json();
  check("panel /team/<id>/api/state scopes to team", teamPage.team?.goal === "scan goal");
  const missingTeam = await fetch(`${panelUrl}team/team-nonexist0/api/state`);
  check("panel 404s unknown team", missingTeam.status === 404);

  // 宿主通知 teams[]：add_member（A）后应看到 teams 数组含两团。
  const multiState = await waitForPluginState(
    (n) => Array.isArray(n.data?.teams) && n.data.teams.length === 2,
  );
  check(
    "plugin state carries additive teams[]",
    multiState.data.teams.some((t) => t.teamId === teamA.teamId) &&
      multiState.data.teams.some((t) => t.teamId === teamB.teamId),
  );

  // 孤儿团队接管：手工把 team.json 的队长改成已消失的会话（模拟真实孤儿：磁盘事实）。
  const orphan = text(
    await toolCall("agent_teams_create", { goal: "orphan goal" }, { role: "captain" }),
  );
  const orphanPath = join(workspace, ".agent-teams", "teams", orphan.teamId, "team.json");
  const orphanState = JSON.parse(readFileSync(orphanPath, "utf8"));
  orphanState.captainSessionId = "session-gone";
  // lastCaptainSeenAt 拨回 11 分钟前：冷静期外，无需 force 即可接管。
  orphanState.lastCaptainSeenAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  writeFileSync(orphanPath, JSON.stringify(orphanState));
  const adopted = text(
    await toolCall(
      "agent_teams_adopt_team",
      { teamId: orphan.teamId, reason: "take over" },
      { role: "captain" },
    ),
  );
  check("orphan adopted without force outside cooldown", adopted.adopted === true);

  // 清场：按 teamId 逐个归档（隐式寻址在 3 团队下会歧义）。
  for (const teamId of [teamA.teamId, teamB.teamId, orphan.teamId]) {
    text(await toolCall("agent_teams_delete", { teamId, archive: false }, { role: "captain" }));
  }
  const finalStatus = await toolCall("agent_teams_status", {}, { role: "captain" });
  check("all teams archived", errorOf(finalStatus).code === "no_active_team");
} catch (error) {
  crash(error);
} finally {
  await client.close().catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true });
}

finish();