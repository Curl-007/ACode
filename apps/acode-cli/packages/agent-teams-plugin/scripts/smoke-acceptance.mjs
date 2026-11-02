#!/usr/bin/env node
/**
 * AgentTeams 验收闭环的端到端冒烟（批次 0 + 批次 1，**真实隔离 worktree**）。
 *
 * 与 smoke.mjs 同一驱动模式：真实 stdio 拉起构建后的 dist/mcp/server.js，用
 * @modelcontextprotocol/client 走宿主同一条协商链路；无 _meta 时用 caller 降级身份
 * （captain / dev-1）。**全程无模型**：脚本自己扮演队长与成员——成员的「干活」= 在你的
 * 真实 worktree 里真实写文件 + 真实 git 提交。
 *
 * 覆盖交付报告里登记的 E2E 缺口：
 *   ① 真实 worktree/分支落盘；② 汇报落 in_review；③ review diff 钉 base/head + 旧 headRef；
 *   ④ run_checks 真实执行（失败退出码如实）与未声明命令零执行；⑤ 打回→返工→真实合并
 *   （--no-ff）→ done/accepted_tasks；⑥ 清理后按显式 ref 回看仍可读；⑦ 归档 pending_tasks；
 *   ⑧ wakePending 窄投影事实。
 *
 * 全部真 git、真文件 IO、真命令执行；工作区是临时目录（自清理），git 用户配置**局部**设置。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agent-teams-acceptance-")));
const repo = workspace; // 工作区即 git 仓库根：worktree 隔离要求 ACODE_PROJECT_DIR 是仓库。
console.log(`workspace: ${workspace}`);

// ---- 真实 git（局部用户配置，不污染全局） ----
const runGit = (cwd, args, { allowFailure = false } = {}) => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${error.stderr ?? error.message}`);
    }
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout : "" };
  }
};
const git = (cwd, args) => runGit(cwd, args).stdout.trim();
/** 归一化路径比较（git porcelain 与产品句柄可能分别是正/反斜杠、盘符大小写）。 */
const normPath = (value) => resolve(value).replace(/\\/gu, "/").toLowerCase();
/** 该路径是否是 git 登记的 worktree（与 manager.listRegisteredWorktrees 同源判据）。 */
const isRegisteredWorktree = (repoRoot, path) =>
  git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => normPath(line.slice("worktree ".length)) === normPath(path));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, "..", "dist", "mcp", "server.js")],
  env: { ...process.env, ACODE_PROJECT_DIR: repo },
});
const client = new Client(
  { name: "acceptance-smoke", version: "0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

const pluginStateNotifications = [];
client.setNotificationHandler("notifications/message", (notification) => {
  const params = notification.params ?? {};
  if (typeof params.logger === "string" && params.logger.startsWith("acode-plugin-state:")) {
    pluginStateNotifications.push({ logger: params.logger, data: params.data });
  }
});
const waitForPluginState = (predicate, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const found = pluginStateNotifications.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("plugin state notification not observed in time"));
      }
      setTimeout(poll, 100);
    };
    poll();
  });

let failures = 0;
const check = (label, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
};
/** 打印真实 git 事实（SHA 等），便于人工核对与留痕。 */
const note = (label, value) => console.log(`INFO  ${label}: ${value}`);

const toolCall = (name, args, caller = captain) =>
  client.callTool({ name, arguments: { ...args, caller } });
const text = (result) => {
  const parsed = JSON.parse(result.content[0].text);
  if (parsed.ok === false) throw new Error(`tool ${parsed.error.code}: ${parsed.error.message}`);
  return parsed;
};
const errorOf = (result) => JSON.parse(result.content[0].text).error;

const captain = { role: "captain" };
const member = { name: "dev-1", role: "member" };

const CHECK_V1 =
  "// ACCEPTANCE_SMOKE_V1: fails on purpose\nconsole.log('check v1: failing');\nprocess.exit(1);\n";
const CHECK_V2 =
  "// ACCEPTANCE_SMOKE_V2: fixed\nconsole.log('check v2: ok');\nprocess.exit(0);\n";
const commitInWorktree = (handle, paths, message) => {
  runGit(handle.path, ["add", ...paths]);
  runGit(handle.path, ["commit", "-q", "-m", message]);
};

try {
  // 前置：真实仓库
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Acceptance Smoke"]);
  runGit(repo, ["config", "user.email", "acceptance-smoke@example.com"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  check("21 tools listed", names.length === 21);
  check(
    "acceptance tools present",
    ["agent_teams_review_member_diff", "agent_teams_run_checks", "agent_teams_accept_task",
     "agent_teams_merge_member_worktree"].every((name) => names.includes(name)),
  );

  // ---- ① 建队开隔离 → 真实 worktree 与分支落盘 ----
  const created = text(
    await toolCall("agent_teams_create", { goal: "acceptance smoke", approval: "automatic", worktreeIsolation: true }),
  );
  check("team active with worktree isolation", created.status === "active" && created.worktree_isolation?.enabled === true);
  text(await toolCall("agent_teams_add_member", { name: "dev-1", role: "dev", charter: "impl" }));
  const capStatus = text(await toolCall("agent_teams_status", {}));
  const memberView = capStatus.team.members.find((m) => m.name === "dev-1");
  const handle = memberView?.worktree;
  check("member worktree handle recorded on disk", Boolean(handle?.path && handle?.branch && handle?.baseCommit));
  check("worktree dir is a real checkout on disk", existsSync(handle.path) && existsSync(join(handle.path, "shared.txt")));
  check("worktree is git-registered (worktree list)", isRegisteredWorktree(repo, handle.path));
  const tipAfterCreate = git(repo, ["rev-parse", `refs/heads/${handle.branch}`]);
  check("worktree branch exists at the creation commit", /^[0-9a-f]{40}$/.test(tipAfterCreate) && tipAfterCreate === handle.baseCommit);
  const baseCommit = handle.baseCommit;
  check("worktree baseCommit is the creation HEAD", baseCommit === git(repo, ["rev-parse", "HEAD"]));
  note("worktree", handle.path);
  note("worktree branch", handle.branch);
  note("baseCommit", baseCommit);

  text(await toolCall("agent_teams_create_task", {
    title: "deliver check", objective: "write check.js", acceptance: ["check.js exits 0"],
  }));

  // ---- ② 成员认领 → 真实改文件提交 → 汇报落 in_review ----
  const claim = text(await toolCall("agent_teams_claim_task", { taskId: "t-1" }, member));
  check("member claimed task (attempt_id)", typeof claim.attempt_id === "string" && claim.attempt_id.length > 0);
  writeFileSync(join(handle.path, "check.js"), CHECK_V1);
  writeFileSync(join(handle.path, "feature.js"), "module.exports = 'ACCEPTANCE_FEATURE';\n");
  commitInWorktree(handle, ["."], "deliver check v1");
  const memberCommit1 = git(handle.path, ["rev-parse", "HEAD"]);
  check("member committed into its own worktree", memberCommit1 !== baseCommit);
  check("main branch untouched by member commit", git(repo, ["rev-parse", "HEAD"]) === baseCommit);
  note("memberCommit(v1)", memberCommit1);

  const reported = text(await toolCall("agent_teams_update_task", {
    taskId: "t-1", attemptId: claim.attempt_id, status: "done", summary: "delivered v1",
    verify: "$ node check.js\nv1（预期失败，用于验证验收闸门）",
  }, member));
  check("update_task(done) reports into in_review", reported.status === "in_review" && reported.awaiting_acceptance === true);

  // ---- ⑧ wakePending（在队长再次读取前断言，避免 ack 过滤掉汇报事实）----
  const wake = await waitForPluginState(
    (n) => n.data?.teamId === created.teamId && n.data?.wakePending?.messages?.some((m) => m.from === "dev-1"),
  );
  const wakePending = wake.data.wakePending;
  check("wakePending generation > 0", typeof wakePending.generation === "number" && wakePending.generation > 0);
  check("wakePending carries the member report fact", wakePending.messages.some((m) => m.from === "dev-1" && m.kind === "report"));
  check("wakePending settledTasks excludes the in_review task", !wakePending.settledTasks.some((s) => s.taskId === "t-1"));
  check("wakePending captainSessionId routed", typeof wakePending.captainSessionId === "string" && wakePending.captainSessionId.length > 0);

  // ---- ③ review_member_diff 钉住 base/head ----
  const branchTip1 = git(repo, ["rev-parse", `refs/heads/${handle.branch}`]);
  const review1 = text(await toolCall("agent_teams_review_member_diff", { member: "dev-1" }));
  check("review base pinned to the worktree creation commit", review1.baseCommit === baseCommit);
  check("review head is the member branch tip", review1.headCommit === branchTip1 && review1.headIsBranchTip === true);
  check("review file list carries the member commit", review1.files.some((f) => f.path === "check.js") && review1.files.some((f) => f.path === "feature.js"));
  check("review diff carries real member content", typeof review1.diff === "string" && review1.diff.includes("ACCEPTANCE_SMOKE_V1") && review1.diff.includes("ACCEPTANCE_FEATURE"));
  check("review anchor reports in_review", review1.task.status === "in_review" && review1.task.taskId === "t-1");

  // 再提交一次：head 变化；显式旧 headRef 钉住旧交付
  writeFileSync(join(handle.path, "feature2.js"), "module.exports = 'ACCEPTANCE_FEATURE_2';\n");
  commitInWorktree(handle, ["."], "deliver extra v2");
  const branchTip2 = git(repo, ["rev-parse", `refs/heads/${handle.branch}`]);
  const review2 = text(await toolCall("agent_teams_review_member_diff", { member: "dev-1" }));
  check("head follows the new commit", review2.headCommit === branchTip2 && review2.headCommit !== review1.headCommit && review2.headIsBranchTip === true);
  const pinned = text(await toolCall("agent_teams_review_member_diff", { member: "dev-1", headRef: review1.headCommit }));
  check("explicit old headRef pins the earlier delivery", pinned.headCommit === review1.headCommit && pinned.headIsBranchTip === false);
  check("pinned review excludes the later commit", pinned.files.every((f) => f.path !== "feature2.js"));

  // ---- ④ run_checks 真实执行 + 未声明命令零执行 ----
  const run1 = text(await toolCall("agent_teams_run_checks", { member: "dev-1", command: "node check.js" }));
  check("declared command really executed in the worktree", run1.cwd === handle.path && run1.command === "node check.js");
  check("failing check reports a non-zero exit code truthfully", run1.exitCode !== 0 && run1.timedOut === false);
  check("failing check recorded as not passed", run1.stdout !== null && run1.stdout.includes("check v1: failing"));

  writeFileSync(join(handle.path, "probe.js"), "require('node:fs').writeFileSync('probe-ran.txt','1')\n");
  const probeMarker = join(handle.path, "probe-ran.txt");
  const refused = await toolCall("agent_teams_run_checks", { member: "dev-1", command: "node probe.js" });
  check("undeclared command refused with verify_required", errorOf(refused).code === "verify_required");
  check("undeclared command left no execution trace", !existsSync(probeMarker));
  const metaRefused = await toolCall("agent_teams_run_checks", { member: "dev-1", command: "node check.js && node probe.js" });
  check("shell-metachar command rejected with invalid_input", errorOf(metaRefused).code === "invalid_input");
  check("metachar command left no execution trace", !existsSync(probeMarker));
  rmSync(join(handle.path, "probe.js"), { force: true }); // 不留未跟踪文件，避免被合并快照带走

  // 隔离团队不接受显式 accept（验收与合并耦合）
  const acceptRefused = await toolCall("agent_teams_accept_task", { taskId: "t-1" });
  check("accept_task refused on an isolated team (merge is the acceptance)", errorOf(acceptRefused).code === "invalid_input");

  // ---- ⑤ 打回 → 返工 → 真实合并（--no-ff）→ done + accepted_tasks ----
  text(await toolCall("agent_teams_reassign_task", { taskId: "t-1", assignee: "dev-1", reason: "check.js must exit 0" }));
  const afterReject = text(await toolCall("agent_teams_status", {}));
  check("reassign from in_review returns the task to todo", afterReject.tasks.find((t) => t.taskId === "t-1").status === "todo");
  check("worktree kept after rejection", existsSync(handle.path) && isRegisteredWorktree(repo, handle.path));

  const reclaim = text(await toolCall("agent_teams_claim_task", { taskId: "t-1" }, member));
  check("member re-claims after rejection (new attempt)", reclaim.attempt_id !== claim.attempt_id);
  writeFileSync(join(handle.path, "check.js"), CHECK_V2);
  commitInWorktree(handle, ["."], "fix check to pass");
  const memberCommit2 = git(handle.path, ["rev-parse", "HEAD"]);
  note("memberCommit(fixed)", memberCommit2);
  const reReported = text(await toolCall("agent_teams_update_task", {
    taskId: "t-1", attemptId: reclaim.attempt_id, status: "done", summary: "check fixed",
    verify: "$ node check.js\nv2（通过）",
  }, member));
  check("re-report lands in_review again", reReported.status === "in_review");
  const run2 = text(await toolCall("agent_teams_run_checks", { member: "dev-1", command: "node check.js" }));
  check("fixed check exits 0", run2.exitCode === 0);

  const mainBefore = git(repo, ["rev-parse", "HEAD"]);
  const merged = text(await toolCall("agent_teams_merge_member_worktree", { member: "dev-1", method: "merge", cleanup: true }));
  check("merge accepted the member's in_review task", Array.isArray(merged.accepted_tasks) && merged.accepted_tasks.includes("t-1"));
  check("merge was a real merge, not the idempotent no-op", merged.already_merged === false);
  const mainAfter = git(repo, ["rev-parse", "HEAD"]);
  check("base branch advanced with a merge commit", mainAfter !== mainBefore);
  check("member commit reachable from the base branch", runGit(repo, ["merge-base", "--is-ancestor", memberCommit2, "HEAD"], { allowFailure: true }).ok);
  check("merge is a real --no-ff merge (2 parents)", git(repo, ["rev-list", "--parents", "-1", "HEAD"]).split(" ").length === 3);
  check("cleanup removed the clean & merged worktree", !existsSync(handle.path));
  check("cleanup removed the merged branch", !runGit(repo, ["rev-parse", "--verify", `refs/heads/${handle.branch}`], { allowFailure: true }).ok);
  note("mergeCommit", merged.commit);
  note("mainHead", mainAfter);
  const doneStatus = text(await toolCall("agent_teams_status", {}));
  check("task is done after acceptance", doneStatus.tasks.find((t) => t.taskId === "t-1").status === "done");

  // ---- ⑥ 清理后按显式 ref 回看（不拿主 HEAD 冒充）----
  // 需要一个新的 in_review 任务作为锚点（t-1 已 done，不再是可审任务）。
  text(await toolCall("agent_teams_create_task", { title: "anchor", objective: "anchor the review", acceptance: ["ok"] }));
  const claim2 = text(await toolCall("agent_teams_claim_task", { taskId: "t-2" }, member));
  const anchorReport = text(await toolCall("agent_teams_update_task", { taskId: "t-2", attemptId: claim2.attempt_id, status: "done", summary: "anchor", verify: "$ node -v" }, member));
  check("anchor task sits in_review for the post-cleanup review", anchorReport.status === "in_review");
  const reReview = text(await toolCall("agent_teams_review_member_diff", { member: "dev-1", baseRef: baseCommit, headRef: merged.commit }));
  check("post-cleanup review still reads the merged range", typeof reReview.diff === "string" && reReview.diff.includes("ACCEPTANCE_SMOKE_V2"));
  check("post-cleanup review pins explicit refs, not main HEAD", reReview.baseCommit === baseCommit && reReview.headCommit === merged.commit && reReview.headIsBranchTip === false);

  // ---- ⑦ 归档显式列出未完成的 in_review 任务 ----
  text(await toolCall("agent_teams_create_task", { title: "leftover", objective: "still awaiting", acceptance: ["ok"] }));
  const claim3 = text(await toolCall("agent_teams_claim_task", { taskId: "t-3" }, member));
  const reported3 = text(await toolCall("agent_teams_update_task", { taskId: "t-3", attemptId: claim3.attempt_id, status: "done", summary: "leftover", verify: "$ node -v" }, member));
  check("leftover task sits in_review", reported3.status === "in_review");
  const deleted = text(await toolCall("agent_teams_delete", { archive: false }));
  check("delete lists in_review tasks in pending_tasks", Array.isArray(deleted.pending_tasks) && deleted.pending_tasks.some((p) => p.taskId === "t-2") && deleted.pending_tasks.some((p) => p.taskId === "t-3"));
  check("pending_tasks marks them in_review", deleted.pending_tasks.filter((p) => p.taskId === "t-2" || p.taskId === "t-3").every((p) => p.status === "in_review"));
} catch (error) {
  failures += 1;
  console.log(`FAIL  acceptance smoke crashed: ${error.message}`);
} finally {
  await client.close().catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nACCEPTANCE SMOKE OK" : `\nACCEPTANCE SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);