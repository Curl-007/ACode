import { createServer } from "node:http";
import type { TeamStore } from "./state/store.js";

/**
 * 团队面板（PRD §15）：localhost 只读 HTTP。绑定 127.0.0.1 随机端口；
 * /api/state 直接读磁盘真相；/api/events 用 seq 差量 + 2s 节流轮询（只读，
 * 不参与调度）。归档团队经 /history/<teamId> 只读。
 */

export interface PanelHandle {
  port: number;
  url: string;
  /** listen 完成后 resolve 实际端口；startPanel 返回的是已绑定句柄的占位。 */
  listening: Promise<number>;
  close(): Promise<void>;
}

interface BoundPanelHandle extends PanelHandle {
  bind(url: string): void;
}

export function startPanel(params: {
  store: TeamStore;
  panelEnabled: boolean;
}): PanelHandle | undefined {
  if (!params.panelEnabled) return undefined;
  const server = createServer((request, response) => {
    try {
      handlePanelRequest(params.store, request, response);
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "panel_internal" } }));
    }
  });
  // listen 是异步绑定：同步读 address() 会拿到 port 0。listening promise 承载实际
  // 端口；startPanelAsync 绑定完成后返回，调用方（server.ts 模块顶层 await）保证
  // 工具返回值里的 panel_url 是真实地址。
  const listening: Promise<number> = new Promise((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
    server.once("error", reject);
  });
  const handle: BoundPanelHandle = {
    port: 0,
    url: "",
    listening,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    bind(url: string): void {
      this.url = url;
    },
  };
  server.listen(0, "127.0.0.1");
  void listening.then((port: number) => {
    handle.port = port;
    handle.bind(`http://127.0.0.1:${port}/`);
  });
  return handle;
}

/** startPanel 的同步占位需要调用方 await listening 拿到真实端口后再使用。 */
export async function startPanelAsync(params: {
  store: TeamStore;
  panelEnabled: boolean;
}): Promise<PanelHandle | undefined> {
  const handle = startPanel(params);
  if (!handle) return undefined;
  await handle.listening;
  return handle;
}

function handlePanelRequest(
  store: TeamStore,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): void {
  const url = new URL(request.url ?? "/", `http://127.0.0.1`);
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: "method_not_allowed" } }));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    respondHtml(response, renderPanelHtml());
    return;
  }
  if (url.pathname === "/api/state") {
    respondJson(response, readPanelState(store));
    return;
  }
  if (url.pathname === "/api/events") {
    const lastSeq = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
    const state = readPanelState(store);
    const seq = readTeamSeq(state.team);
    if (seq > (Number.isFinite(lastSeq) ? lastSeq : 0)) {
      respondJson(response, { changed: true, seq, state });
    } else {
      respondJson(response, { changed: false, seq });
    }
    return;
  }
  const historyMatch = /^\/history\/([a-z0-9-]+)(\/api\/state|\/api\/events|\/api)?$/u.exec(
    url.pathname,
  );
  if (historyMatch?.[1]) {
    const record = store.readArchivedTeam(historyMatch[1]);
    if (!record) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "archive_not_found" } }));
      return;
    }
    const state = { team: record.team, tasks: record.tasks, mailboxes: [] };
    if (historyMatch[2] === "/api/events") {
      const lastSeq = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
      respondJson(
        response,
        record.team.seq > lastSeq
          ? { changed: true, seq: record.team.seq, state }
          : { changed: false, seq: record.team.seq },
      );
    } else if (historyMatch[2]) {
      respondJson(response, state);
    } else {
      respondHtml(response, renderPanelHtml());
    }
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
}

interface PanelTeamSummary {
  seq?: number;
  teamId?: string;
  status?: string;
}

function readPanelState(store: TeamStore): {
  team: unknown;
  tasks: unknown;
  mailboxes: unknown;
  archives?: unknown;
} {
  const team = store.readTeamFile();
  const tasks = store.readTasks();
  const mailboxes = store.listAllMailboxes();
  return { team, tasks, mailboxes, archives: store.listArchivedTeams() };
}

function readTeamSeq(team: unknown): number {
  if (typeof team === "object" && team !== null) {
    const seq = (team as PanelTeamSummary).seq;
    if (typeof seq === "number" && Number.isFinite(seq)) return seq;
  }
  return 0;
}

function respondJson(response: import("node:http").ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function respondHtml(response: import("node:http").ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function renderPanelHtml(): string {
  return PANEL_HTML;
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentTeams</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } }
  h1 { font-size: 18px; } h2 { font-size: 14px; margin-top: 24px; color: #656d76; text-transform: uppercase; letter-spacing: .04em; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
  @media (prefers-color-scheme: dark) { .card { background: #161b22; border-color: #30363d; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #d0d7de; vertical-align: top; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #30363d; } }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .st-todo { background: #ddf4ff; color: #0969da; } .st-in_progress { background: #fff8c5; color: #9a6700; }
  .st-done { background: #dafbe1; color: #116329; } .st-failed, .st-blocked { background: #ffebe9; color: #cf222e; }
  @media (prefers-color-scheme: dark) { .st-todo { background: #121d2f; color: #58a6ff; } .st-in_progress { background: #2d2b00; color: #d29922; } .st-done { background: #12261e; color: #3fb950; } .st-failed, .st-blocked { background: #2d1114; color: #f85149; } }
  .muted { color: #656d76; font-size: 12px; }
  .deps { font-family: ui-monospace, monospace; font-size: 12px; }
  header { display: flex; gap: 12px; align-items: baseline; }
  #status { margin-left: auto; font-size: 12px; color: #656d76; }
</style>
</head>
<body>
<header><h1>AgentTeams</h1><span id="status">connecting…</span></header>
<div id="root"></div>
<script>
const statusColors = { todo: "st-todo", in_progress: "st-in_progress", done: "st-done", failed: "st-failed", blocked: "st-blocked", cancelled: "st-failed" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function tick() {
  try {
    const res = await fetch(location.pathname.startsWith("/history/")
      ? location.pathname + "/api/state"
      : "/api/state");
    const data = await res.json();
    render(data);
    document.getElementById("status").textContent = "seq " + (data.team?.seq ?? 0) + " · " + new Date().toLocaleTimeString();
  } catch (e) { document.getElementById("status").textContent = "offline"; }
}
function render(data) {
  const root = document.getElementById("root");
  if (!data.team) { root.innerHTML = '<p class="muted">此工作区暂无团队。用 /agent-teams:team &lt;goal&gt; 创建。</p>'; return; }
  const counts = {};
  for (const t of data.tasks ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const team = data.team;
  root.innerHTML = "" +
    section("团队", '<div class="card"><b>' + esc(team.goal) + '</b><br><span class="muted">' + esc(team.teamId) + " · " + esc(team.status) + " · seq " + esc(team.seq) + "</span></div>") +
    section("进度", '<div class="card">' + Object.entries(counts).map(([k, v]) => '<span class="pill ' + (statusColors[k] ?? "") + '">' + esc(k) + " " + v + "</span>").join(" ") + (data.tasks?.length ? "" : " <span class='muted'>暂无任务</span>") + "</div>") +
    section("成员", '<table><tr><th>成员</th><th>角色</th><th>状态</th><th>当前任务</th></tr>' +
      (team.members ?? []).map((m) => {
        const cur = (data.tasks ?? []).find((t) => t.status === "in_progress" && (t.attempts?.find((a) => a.id === t.activeAttemptId)?.owner) === m.name);
        return "<tr><td>" + esc(m.name) + "</td><td>" + esc(m.role) + "</td><td>" + esc(m.status) + "</td><td>" + (cur ? esc(cur.taskId + " " + cur.title) : "—") + "</td></tr>";
      }).join("") + "</table>") +
    section("任务 DAG", '<table><tr><th>ID</th><th>标题</th><th>状态</th><th>类型</th><th>负责人</th><th>依赖</th></tr>' +
      (data.tasks ?? []).map((t) => "<tr><td class='deps'>" + esc(t.taskId) + "</td><td>" + esc(t.title) + "</td><td><span class='pill " + (statusColors[t.status] ?? "") + "'>" + esc(t.status) + "</span></td><td>" + esc(t.kind) + "</td><td>" + esc(t.assignee ?? "—") + "</td><td class='deps'>" + esc((t.dependencies ?? []).join(" ")) + "</td></tr>").join("") + "</table>") +
    section("邮箱", '<table><tr><th>地址</th><th>未读</th><th>已读</th></tr>' +
      (data.mailboxes ?? []).map((m) => "<tr><td>" + esc(m.address) + "</td><td>" + esc(m.unread) + "</td><td>" + esc(m.read) + "</td></tr>").join("") + "</table>") +
    ((data.archives ?? []).length ? section("历史归档", '<ul>' + data.archives.map((a) => "<li><a href='/history/" + esc(a) + "'>" + esc(a) + "</a></li>").join("") + "</ul>") : "");
}
function section(title, body) { return "<h2>" + title + "</h2>" + body; }
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
