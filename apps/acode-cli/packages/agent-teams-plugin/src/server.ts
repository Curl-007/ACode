import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveCallerIdentity } from "./identity.js";
import { startPanelAsync } from "./panel.js";
import { buildTeamPanelState } from "./panel-state.js";
import type { TeamPanelMailbox, TeamPanelMessage } from "./panel-state.js";
import { TeamStore, resolveStateRoot } from "./state/store.js";
import { createToolContext, isMemberCall } from "./tools/registry.js";
import { teamTools } from "./tools/team.js";
import { memberTools } from "./tools/members.js";
import { taskTools } from "./tools/tasks.js";
import { messageTools } from "./tools/messages.js";
import { normalizeMaxReassignRounds, TeamError } from "./state/types.js";
import type { Tool } from "@modelcontextprotocol/server";

/**
 * AgentTeams 插件 MCP server（stdio）。
 * 环境变量由 ACode 的插件 MCP resolver 注入（.mcp.json env 模板）：
 *   AGENT_TEAMS_STATE_DIR / AGENT_TEAMS_MAX_MEMBERS / AGENT_TEAMS_PANEL_ENABLED /
 *   AGENT_TEAMS_MAX_REASSIGN_ROUNDS；
 *   ACODE_PROJECT_DIR（状态根落 workspace，resolver 已把它指向用户工作区）。
 */

const ALL_TOOLS = [...teamTools, ...memberTools, ...taskTools, ...messageTools];

const envStateDir = process.env.AGENT_TEAMS_STATE_DIR?.trim() || "";
const maxMembersFromEnv = Number.parseInt(process.env.AGENT_TEAMS_MAX_MEMBERS ?? "", 10);
const maxMembers =
  Number.isFinite(maxMembersFromEnv) && maxMembersFromEnv > 0 ? Math.min(maxMembersFromEnv, 32) : 8;
// 缺字段（老配置文件）时 env 模板展开为空串 → normalize 退回默认 3，不报错。
const maxReassignRounds = normalizeMaxReassignRounds(process.env.AGENT_TEAMS_MAX_REASSIGN_ROUNDS);
const panelEnabled =
  (process.env.AGENT_TEAMS_PANEL_ENABLED ?? "true").trim().toLowerCase() !== "false";

const workingDirectory =
  process.env.ACODE_PROJECT_DIR?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();

const stateRoot = resolveStateRoot({
  envStateDir: envStateDir || undefined,
  workingDirectory,
});
const store = new TeamStore(stateRoot);
store.createTeamDirectories();

const panel = await startPanelAsync({ store, panelEnabled });
if (panel) {
  store.writePanelInfo({ port: panel.port, url: panel.url, pid: process.pid });
}

const server = new Server(
  { name: "acode-agent-teams", version: "0.1.0" },
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
    maxMembers,
    maxReassignRounds,
    panelUrl: panel?.url,
  });
  try {
    // 工具读/校验/写和通知共用一条写入路径；否则并发 claim 会先各自通过
    // 就绪校验再覆盖对方 attempt，异步通知也可能让较旧快照晚于新快照到达。
    return await store.withLock(async () => {
      // caller 是身份降级通道（仅手动冒烟），不进入工具 schema。
      const { caller: _caller, ...toolArguments } = params.arguments ?? {};
      const beforeSeq = store.readTeamFile()?.seq;
      const result = await tool.handler(toolArguments, context);
      const afterSeq = store.readTeamFile()?.seq;
      if (afterSeq !== beforeSeq || lastEmittedPanelSeq !== (afterSeq ?? null)) {
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

/**
 * 邮箱快照：计数恒定下发；未读正文只在总量可控时读。
 *
 * 每条未读消息是一次独立文件读，而通知跑在每次工具调用的收尾路径上——成员刷屏时
 * 逐条读会拖慢每一次工具返回。超限只丢正文，计数仍在（宿主仍能显示「未读 N」），
 * 完整正文本来就在磁盘 mailbox 与浏览器面板里。归档后 mailbox 目录已随归档搬走，
 * listAllMailboxes 自然返回空，不需要为归档单开分支。
 */
const MAX_UNREAD_BODY_READS = 40;

function collectMailboxSnapshot(archived?: NonNullable<ReturnType<TeamStore["readArchivedTeam"]>>): {
  mailboxes: TeamPanelMailbox[];
  unreadMessages: TeamPanelMessage[];
} {
  const mailboxes = archived?.mailboxes ?? store.listAllMailboxes();
  const totalUnread = mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0);
  if (totalUnread === 0 || totalUnread > MAX_UNREAD_BODY_READS) {
    return { mailboxes, unreadMessages: [] };
  }
  const unreadMessages: TeamPanelMessage[] = [];
  for (const mailbox of mailboxes) {
    if (mailbox.unread === 0) continue;
    const messages = archived
      ? archived.unreadMessages.filter((message) => message.to === mailbox.address)
      : store.listUnreadMessages(mailbox.address);
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
 */
async function emitPanelStateNotification(archivedTeamId?: string): Promise<void> {
  try {
    const archived = archivedTeamId
      ? store.readArchivedTeam(archivedTeamId, MAX_UNREAD_BODY_READS)
      : undefined;
    const team = archived?.team ?? store.readTeamFile();
    const state = team
      ? buildTeamPanelState({
          team,
          tasks: archived?.tasks ?? store.readTasks(),
          ...(panel
            ? { panelUrl: archived ? `${panel.url}history/${team.teamId}` : panel.url }
            : {}),
          ...collectMailboxSnapshot(archived),
        })
      : null;
    if (team && lastEmittedPanelSeq === team.seq && lastEmittedPanelTeamId === team.teamId) return;
    await server.notification({
      method: "notifications/message",
      params: {
        level: "info",
        logger: PLUGIN_STATE_LOGGER,
        data: state,
      },
    });
    lastEmittedPanelSeq = team?.seq ?? null;
    lastEmittedPanelTeamId = team?.teamId ?? null;
  } catch {
    // 通知失败时保留旧游标，下次成功的工具调用仍可重试当前磁盘状态。
  }
}

let lastEmittedPanelSeq: number | null = null;
let lastEmittedPanelTeamId: string | null = null;

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
