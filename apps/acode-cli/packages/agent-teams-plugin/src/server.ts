import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveCallerIdentity } from "./identity.js";
import { startPanelAsync } from "./panel.js";
import { buildTeamPanelState, MAX_RECENT_ENDED_TEAMS } from "./panel-state.js";
import type { TeamPanelMailbox, TeamPanelMessage } from "./panel-state.js";
import { TeamStore, resolveStateRoot } from "./state/store.js";
import { createToolContext, isMemberCall } from "./tools/registry.js";
import { teamTools } from "./tools/team.js";
import { memberTools } from "./tools/members.js";
import { taskTools } from "./tools/tasks.js";
import { messageTools } from "./tools/messages.js";
import { waitForWorkTool } from "./tools/member-wait.js";
import { worktreeTools } from "./tools/worktree.js";
import { normalizeMaxActiveTeams, normalizeMaxReassignRounds, TeamError } from "./state/types.js";
import type { Tool } from "@modelcontextprotocol/server";

/**
 * AgentTeams 插件 MCP server（stdio）。
 * 环境变量由 ACode 的插件 MCP resolver 注入（.mcp.json env 模板）：
 *   AGENT_TEAMS_STATE_DIR / AGENT_TEAMS_MAX_MEMBERS / AGENT_TEAMS_PANEL_ENABLED /
 *   AGENT_TEAMS_MAX_REASSIGN_ROUNDS / AGENT_TEAMS_MAX_ACTIVE_TEAMS；
 *   ACODE_PROJECT_DIR（状态根落 workspace，resolver 已把它指向用户工作区）。
 */

const ALL_TOOLS = [
  ...teamTools,
  ...memberTools,
  ...taskTools,
  ...messageTools,
  ...worktreeTools,
  waitForWorkTool,
];

const envStateDir = process.env.AGENT_TEAMS_STATE_DIR?.trim() || "";
const maxMembersFromEnv = Number.parseInt(process.env.AGENT_TEAMS_MAX_MEMBERS ?? "", 10);
const maxMembers =
  Number.isFinite(maxMembersFromEnv) && maxMembersFromEnv > 0 ? Math.min(maxMembersFromEnv, 32) : 8;
// 缺字段（老配置文件）时 env 模板展开为空串 → normalize 退回默认，不报错。
const maxReassignRounds = normalizeMaxReassignRounds(process.env.AGENT_TEAMS_MAX_REASSIGN_ROUNDS);
const maxActiveTeams = normalizeMaxActiveTeams(process.env.AGENT_TEAMS_MAX_ACTIVE_TEAMS);
const panelEnabled =
  (process.env.AGENT_TEAMS_PANEL_ENABLED ?? "true").trim().toLowerCase() !== "false";

const workingDirectory =
  process.env.ACODE_PROJECT_DIR?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();

const stateRoot = resolveStateRoot({
  envStateDir: envStateDir || undefined,
  workingDirectory,
});
const store = new TeamStore(stateRoot);
store.ensureTeamsDirectory();

/**
 * recentEnded 缓存：归档目录不可变，按目录名缓存快照，避免每次推送重读磁盘。
 * 读不出（目录损坏）的条目缓存为 undefined 并跳过，不让它拖垮整帧。
 */
const recentEndedCache = new Map<
  string,
  (ReturnType<typeof buildTeamPanelState> & { endedAt: string }) | undefined
>();
// 旧平铺布局一次性迁移（0.2）：失败即启动报错退出——半迁移比不启动更糟，
// 且这里没有工具面可兜底（用户手工搬目录踩过句柄坑，见 PRD §4.1）。
await store.withLock(() => store.migrateFlatLayoutIfNeeded());

const panel = await startPanelAsync({ store, panelEnabled });
if (panel) {
  store.writePanelInfo({ port: panel.port, url: panel.url, pid: process.pid });
}

const server = new Server(
  { name: "acode-agent-teams", version: "0.4.0" },
  // logging capability 是插件状态通道的前提：server.notification() 发
  // notifications/message 前会断言该能力（缺省即抛 MethodNotSupportedByProtocolVersion）。
  { capabilities: { tools: {}, logging: {} } },
);

const toolList: Tool[] = ALL_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: zodToJsonSchema(tool.schema),
}));

server.setRequestHandler("tools/list", async () => ({ tools: toolList }));

server.setRequestHandler("tools/call", async (request, extra) => {
  const params = (request.params ?? {}) as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  const tool = ALL_TOOLS.find((item) => item.name === params.name);
  if (!tool) {
    return errorResult(
      new TeamError("invalid_input", `Unknown tool: ${params.name ?? "<missing>"}`),
    );
  }
  // 身份来自宿主注入的 _meta（同 node_repl 的 buildRequestMeta 语义）。
  const { identity, memberName } = resolveCallerIdentity({
    meta: extra.mcpReq._meta as Record<string, unknown> | undefined,
    explicitCaller: pickExplicitCaller(params.arguments),
  });
  if (isMemberCall(identity) && !tool.memberAllowed) {
    return errorResult(
      new TeamError(
        "forbidden_for_caller",
        `Tool ${tool.name} is captain-only; members cannot call it.`,
      ),
    );
  }
  const context = createToolContext({
    store,
    identity,
    memberNameHint: memberName,
    workspaceKey: identity.workspaceKey,
    workingDirectory,
    maxMembers,
    maxReassignRounds,
    maxActiveTeams,
    panelUrl: panel?.url,
  });
  try {
    if (tool.manageOwnLock) {
      // 长阻塞工具（成员等活）自行分段加锁；面板通知在它返回后补发一次。
      const { caller: _caller, ...toolArguments } = params.arguments ?? {};
      const result = await tool.handler(toolArguments, context);
      await store.withLock(async () => {
        if (seqMapsDiffer(snapshotTeamSeqs(), lastEmittedPanelSeqs)) {
          await emitPanelStateNotification();
        }
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
    // 工具读/校验/写和通知共用一条写入路径；否则并发 claim 会先各自通过
    // 就绪校验再覆盖对方 attempt，异步通知也可能让较旧快照晚于新快照到达。
    return await store.withLock(async () => {
      // caller 是身份降级通道（仅手动冒烟），不进入工具 schema。
      const { caller: _caller, ...toolArguments } = params.arguments ?? {};
      const beforeSeqs = snapshotTeamSeqs();
      const result = await tool.handler(toolArguments, context);
      const afterSeqs = snapshotTeamSeqs();
      if (seqMapsDiffer(beforeSeqs, afterSeqs) || seqMapsDiffer(afterSeqs, lastEmittedPanelSeqs)) {
        // 上次通知失败后游标仍旧；成功的只读调用也须重发当前快照，不能等下一次写盘。
        await emitPanelStateNotification(
          result.archived === true ? (result.teamId as string) : undefined,
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  } catch (error) {
    return errorResult(error);
  }
});

/** 通知去重游标：多团队后按「每团队一个 seq」比较（PRD §6.3）。 */
function snapshotTeamSeqs(): Map<string, number> {
  return new Map(store.listTeams().map((team) => [team.teamId, team.seq]));
}

function seqMapsDiffer(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return true;
  for (const [teamId, seq] of left) {
    if (right.get(teamId) !== seq) return true;
  }
  return false;
}

/**
 * 邮箱快照：计数恒定下发；未读正文只在总量可控时读。
 *
 * 每条未读消息是一次独立文件读，而通知跑在每次工具调用的收尾路径上——成员刷屏时
 * 逐条读会拖慢每一次工具返回。超限只丢正文，计数仍在（宿主仍能显示「未读 N」），
 * 完整正文本来就在磁盘 mailbox 与浏览器面板里。归档后 mailbox 目录已随归档搬走，
 * listAllMailboxes 自然返回空，不需要为归档单开分支。
 */
const MAX_UNREAD_BODY_READS = 40;

function collectMailboxSnapshot(
  teamId: string,
  archived?: NonNullable<ReturnType<TeamStore["readArchivedTeam"]>>,
): {
  mailboxes: TeamPanelMailbox[];
  unreadMessages: TeamPanelMessage[];
} {
  const mailboxes = archived?.mailboxes ?? store.listAllMailboxes(teamId);
  const totalUnread = mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0);
  if (totalUnread === 0 || totalUnread > MAX_UNREAD_BODY_READS) {
    return { mailboxes, unreadMessages: [] };
  }
  const unreadMessages: TeamPanelMessage[] = [];
  for (const mailbox of mailboxes) {
    if (mailbox.unread === 0) continue;
    const messages = archived
      ? archived.unreadMessages.filter((message) => message.to === mailbox.address)
      : store.listUnreadMessages(teamId, mailbox.address);
    for (const message of messages) {
      unreadMessages.push({
        id: message.id,
        from: message.from,
        to: message.to,
        ...(message.summary ? { summary: message.summary } : {}),
        message: message.message,
        deliveredAt: message.deliveredAt,
      });
    }
  }
  return { mailboxes, unreadMessages };
}

/**
 * 面板状态通知：读磁盘全量 → MCP 标准 notifications/message（logging）推送。
 * 宿主 adapter 只识别 logger 前缀 acode-plugin-state: 的通知；logger 名 = 插件身份 +
 * 主题（agent-teams）。draft/active/paused 都推（面板能看到审批前草稿）；无团队时
 * 推 null（宿主键级替换为 null 语义 = 卡片消失）；保留归档时读 archives 终态。
 *
 * 多团队形状（0.2，additive）：顶层仍是 v1 单团队形状，primary 取「最近更新的活跃
 * 团队」（归档保留时取归档终态）；另附 teams[] 数组（各活跃团队完整快照）。旧宿主
 * 忽略 teams[] 渲染 primary 单卡，新宿主读 teams[] 渲染多卡。
 */
async function emitPanelStateNotification(archivedTeamId?: string): Promise<void> {
  try {
    const archived = archivedTeamId
      ? store.readArchivedTeam(archivedTeamId, MAX_UNREAD_BODY_READS)
      : undefined;
    const activeTeams = store.listTeams();
    // primary：归档保留时展示归档终态（宿主键级 null 只在「真无团队」时发）；
    // 否则取 updatedAt 最新的活跃团队——正在动的团队最值得看。
    const primary = archived?.team ?? pickMostRecentlyUpdated(activeTeams);
    const state = primary
      ? {
          ...buildTeamPanelState({
            team: primary,
            tasks: archived?.tasks ?? store.readTasks(primary.teamId),
            ...(panel
              ? { panelUrl: archived ? `${panel.url}history/${primary.teamId}` : panel.url }
              : {}),
            ...collectMailboxSnapshot(primary.teamId, archived),
          }),
          teams: activeTeams.map((team) => buildTeamPanelSnapshot(team)),
          recentEnded: buildRecentEndedSnapshots(),
        }
      : null;
    const nextSeqs = snapshotTeamSeqs();
    if (state && seqMapsEqual(nextSeqs, lastEmittedPanelSeqs) && !archived) return;
    await server.notification({
      method: "notifications/message",
      params: {
        level: "info",
        logger: PLUGIN_STATE_LOGGER,
        data: state,
      },
    });
    lastEmittedPanelSeqs = nextSeqs;
  } catch {
    // 通知失败时保留旧游标，下次成功的工具调用仍可重试当前磁盘状态。
  }
}

/** 最近结束的团队快照（最多 MAX_RECENT_ENDED_TEAMS 条）：不带 mailbox / 未读样本。 */
function buildRecentEndedSnapshots(): Array<
  ReturnType<typeof buildTeamPanelState> & { endedAt: string }
> {
  const out: Array<ReturnType<typeof buildTeamPanelState> & { endedAt: string }> = [];
  for (const entry of store.listRecentArchivedTeams(MAX_RECENT_ENDED_TEAMS)) {
    // 缓存键带上 teamId（PRD fix-spec-012 §3）：readArchivedTeam 精确匹配失败会按前缀
    // 回退取字典序最新，同 teamId 多份归档并存时会把别的归档的快照配给本条的 endedAt。
    const cacheKey = `${entry.archiveName}\u0000${entry.teamId}`;
    let cached = recentEndedCache.get(cacheKey);
    if (cached === undefined && !recentEndedCache.has(cacheKey)) {
      const archived = store.readArchivedTeam(entry.archiveName);
      cached = archived
        ? {
            ...buildTeamPanelState({
              team: archived.team,
              tasks: archived.tasks,
              ...(panel ? { panelUrl: `${panel.url}history/${archived.team.teamId}` } : {}),
            }),
            endedAt: entry.endedAt,
          }
        : undefined;
      recentEndedCache.set(cacheKey, cached);
    }
    if (cached) out.push(cached);
  }
  return out;
}

/** teams[] 的成员卡不带 mailbox 正文样本（正文只属于 primary，避免通知体积膨胀）。 */
function buildTeamPanelSnapshot(team: import("./state/types.js").TeamState) {
  return buildTeamPanelState({
    team,
    tasks: store.readTasks(team.teamId),
    mailboxes: store.listAllMailboxes(team.teamId),
  });
}

function pickMostRecentlyUpdated(
  teams: readonly import("./state/types.js").TeamState[],
): import("./state/types.js").TeamState | undefined {
  if (teams.length === 0) return undefined;
  return teams.reduce((latest, team) =>
    team.updatedAt.localeCompare(latest.updatedAt) > 0 ? team : latest,
  );
}

function seqMapsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [teamId, seq] of left) {
    if (right.get(teamId) !== seq) return false;
  }
  return true;
}

let lastEmittedPanelSeqs = new Map<string, number>();

const PLUGIN_STATE_LOGGER = "acode-plugin-state:agent-teams";

function pickExplicitCaller(
  args: Record<string, unknown> | undefined,
): { name?: string; role?: "captain" | "member" } | undefined {
  if (!args) return undefined;
  if (args.caller && typeof args.caller === "object") {
    const caller = args.caller as Record<string, unknown>;
    const name = typeof caller.name === "string" ? caller.name : undefined;
    const role = caller.role === "captain" || caller.role === "member" ? caller.role : undefined;
    if (name || role) return { name, role };
  }
  return undefined;
}

/** zod 4 → JSON Schema：SDK 的 Tool.inputSchema 需要可序列化 object 形状。 */
function zodToJsonSchema(schema: unknown): { type: "object" } & Record<string, unknown> {
  const holder = schema as { toJSONSchema?: (options?: unknown) => unknown };
  if (typeof holder.toJSONSchema === "function") {
    const converted = holder.toJSONSchema({ target: "draft-2020-12" }) as Record<string, unknown>;
    return { ...converted, type: "object" };
  }
  return { type: "object" };
}

function errorResult(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const teamError =
    error instanceof TeamError
      ? error
      : new TeamError("invalid_input", error instanceof Error ? error.message : String(error));
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            code: teamError.code,
            message: teamError.message,
            ...(teamError.data ? { data: teamError.data } : {}),
          },
        }),
      },
    ],
    isError: true,
  };
}

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  store.releaseLockOnShutdown();
  if (panel) void panel.close().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// serveStdio 接受 server factory（initialize 时执行）；状态与面板在进程生命周期
// 顶部初始化，factory 只回传单例 server。
serveStdio(() => server, { legacy: "reject" });
