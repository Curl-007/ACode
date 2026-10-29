// 脚本工作流管理面（运行历史 + 已持久化脚本清单）的读缓存。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §6/§8.2。
//
// 形状对齐 savedWorkflowStore（按 workspaceKey 分片、bypassCache 刷新、in-flight 去重），
// 两点刻意差异：
// - **无 errorCode 专列**：v4 错误走 reasonCode/ack.message，异常即 error 态（message 原文
//   留给排障；UI 只区分「加载失败（重试）」与「空态（引导创作）」）。
// - **发送走 v4 sendCommand**（不走 legacy client.request）：锚当前 workspace 的活动会话
//   （数据按 cwd 过滤是 workspace 级，锚会话只是路由键，与 startSavedWorkflow 同拓扑）。
//   无活动会话 → `noSession: true`，UI 给「打开一个会话后查看」的引导，不发命令。
// 存储是唯一权威（§3.3）：每次挂载/刷新现查，缓存只服务同页重渲染——与 saved-workflows
// 中枢同一条先例（挂载时快照会漏掉模型刚落盘的 run 行）。
import { create } from "zustand";
import {
  listScriptWorkflowDefinitionsResultSchema,
  listScriptWorkflowRunsResultSchema,
  type ListScriptWorkflowDefinitionsResult,
  type ListScriptWorkflowRunsResult,
} from "@acode/shared/acode-protocol-v4";
import { resolveWorkspaceKey } from "@acode/shared";
import type { IACodeAgentService } from "@acode/services";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";

/** 运行历史的页大小（协议缺省 50；截断由 result.truncated 表达，UI 显示「仅显示最近 N 条」）。 */
const SCRIPT_WORKFLOW_RUNS_PAGE = 50;

/** 锚会话候选数：只挑「最最近的几条」里没有父会话的主会话，避免拉全量列表。 */
const ANCHOR_SESSION_CANDIDATES = 5;

/**
 * 声明输出需要：AutomationsSection 的 selector 引用本类型，tsc -d 要求可命名。
 * @public
 */
export interface ScriptWorkflowWorkspaceState {
  runs: ListScriptWorkflowRunsResult["runs"];
  truncated: boolean;
  definitions: ListScriptWorkflowDefinitionsResult["definitions"];
  loading: boolean;
  loaded: boolean;
  /** 读失败（v4 failed ACK / 能力缺席 / 异常）。与空态严格区分：错误态引导重试，不伪造空。 */
  error: string | null;
  /**
   * workspace 当前没有可锚定的活动会话。不是错误也不是空数据：查询需要一个会话作路由键，
   * UI 据此给「打开一个会话后查看」的引导（与 startSavedWorkflow 的锚会话先例一致）。
   */
  noSession: boolean;
}

const EMPTY_SCRIPT_WORKFLOW_STATE: ScriptWorkflowWorkspaceState = {
  runs: [],
  truncated: false,
  definitions: [],
  loading: false,
  loaded: false,
  error: null,
  noSession: false,
};

interface ScriptWorkflowStoreState {
  byWorkspaceKey: Record<string, ScriptWorkflowWorkspaceState>;
  load: (
    target: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
    agentService: IACodeAgentService,
    options?: { bypassCache?: boolean },
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

function scriptWorkflowStoreKey(target: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return resolveWorkspaceKey({
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}

function buildWorkspaceRef(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  return {
    workspacePath: target.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    workspaceKey: resolveWorkspaceKey({
      workspacePath: target.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
  };
}

/** failed ACK 的可读消息：reasonCode 有则带上（能力缺席等结构化事实不丢）。 */
function ackFailureMessage(reasonCode: string | undefined, message: string | undefined): string {
  return [reasonCode, message].filter((part) => part !== undefined && part !== "").join(": ");
}

/**
 * 锚会话不在运行时的结构化拒绝码。CLI CommandInbox 对「路由 sessionId 查不到记录」在拒绝
 * ack 中直接给出 `reasonCode: "proto.sessionNotFound"`
 * （apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/command-inbox.ts 的 decide()）。
 * 无共享常量导出，这里按字面量对齐；
 * 判断只认 reasonCode 字段，绝不用 message 文本 includes（消息文案不是契约）。
 */
const SESSION_NOT_FOUND_REASON_CODE = "proto.sessionNotFound";

/** 该 ACK 是否「锚会话不在运行时」的结构化拒绝（status 未接受且 reasonCode 精确匹配）。 */
function isSessionNotFoundRejection(ack: { status: string; reasonCode?: string }): boolean {
  return ack.status !== "accepted" && ack.reasonCode === SESSION_NOT_FOUND_REASON_CODE;
}

async function fetchScriptWorkflows(
  target: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
  agentService: IACodeAgentService,
): Promise<Omit<ScriptWorkflowWorkspaceState, "loading" | "loaded">> {
  // ① 锚会话候选：当前 workspace 最新的主会话（无 parentSessionId），按 updatedAt 降序取前 N。
  // 一个都查不到 → noSession 引导，不创建会话（管理面是只读查询，不应有「看历史先建会话」的副作用）。
  const sessions = await agentService.listSessions({
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    limit: ANCHOR_SESSION_CANDIDATES,
  });
  const anchorCandidates = [...sessions]
    .filter((session) => session.parentSessionId === undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (anchorCandidates.length === 0) {
    return { runs: [], truncated: false, definitions: [], error: null, noSession: true };
  }

  // ② 连接租约 + 两个只读查询并行。查询纯读、幂等（§8.2）：无轮询、无订阅，等 ACK。
  // 租约锚定的是 workspace 连接而非会话，候选回退不换连接：循环外 acquire 一次，
  // try/finally 配对 release，不在候选循环里重复租借（避免泄漏/重复计数）。
  const lease = acquireWorkspaceConnection(
    {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    },
    agentService as WorkspaceConnectionAgentService,
  );
  try {
    const workspace = buildWorkspaceRef(target);
    // 「持久化会话 ≠ 运行时活跃会话」：listSessions 返回的是持久化会话（含 draft 预热），
    // 窗口刚打开、无已打开对话时最新主会话并未在 agent 运行时活跃，以它为路由 sessionId 的
    // sendCommand 会被 ACK 拒绝 reasonCode=proto.sessionNotFound（2026-10-18 桌面 dev 实机：
    // 打开工作流 tab 落「加载失败」，renderer 日志 error 即该 reasonCode）。这是路由键失效，
    // 不是数据读不到——按 spec §3.3 逐候选回退：某候选任一 ACK 是 sessionNotFound 就换下一个；
    // 全部候选耗尽仍是 sessionNotFound → 与「查不到候选」同形落 noSession 引导。
    // 其他失败原因（能力缺席、zod 校验失败等）不回退，照旧 throw → error 态（错误态不伪造空）。
    for (const candidate of anchorCandidates) {
      const [runsAck, definitionsAck] = await Promise.all([
        lease.transport.sendCommand(
          createCommandEnvelope({
            type: "listScriptWorkflowRuns",
            payload: { workspace, limit: SCRIPT_WORKFLOW_RUNS_PAGE },
            sessionId: candidate.sessionId,
          }),
        ),
        lease.transport.sendCommand(
          createCommandEnvelope({
            type: "listScriptWorkflowDefinitions",
            payload: { workspace },
            sessionId: candidate.sessionId,
          }),
        ),
      ]);
      if (isSessionNotFoundRejection(runsAck) || isSessionNotFoundRejection(definitionsAck)) {
        continue;
      }
      if (runsAck.status !== "accepted" || runsAck.result?.type !== "listScriptWorkflowRuns") {
        throw new Error(ackFailureMessage(runsAck.reasonCode, runsAck.message));
      }
      if (
        definitionsAck.status !== "accepted" ||
        definitionsAck.result?.type !== "listScriptWorkflowDefinitions"
      ) {
        throw new Error(ackFailureMessage(definitionsAck.reasonCode, definitionsAck.message));
      }
      // 严格 zod 结果校验（spec §6：result 校验用 v4 result schema）——形状漂移在消费前暴露。
      const runs = listScriptWorkflowRunsResultSchema.parse(runsAck.result);
      const definitions = listScriptWorkflowDefinitionsResultSchema.parse(definitionsAck.result);
      return {
        runs: runs.runs,
        truncated: runs.truncated,
        definitions: definitions.definitions,
        error: null,
        noSession: false,
      };
    }
    return { runs: [], truncated: false, definitions: [], error: null, noSession: true };
  } finally {
    lease.release();
  }
}

export const useScriptWorkflowStore = create<ScriptWorkflowStoreState>((set) => ({
  byWorkspaceKey: {},
  async load(target, agentService, options = {}) {
    const key = scriptWorkflowStoreKey(target);
    if (!options.bypassCache) {
      const current = inFlight.get(key);
      if (current) return current;
    }
    set((state) => ({
      byWorkspaceKey: {
        ...state.byWorkspaceKey,
        [key]: { ...(state.byWorkspaceKey[key] ?? EMPTY_SCRIPT_WORKFLOW_STATE), loading: true },
      },
    }));
    const request = fetchScriptWorkflows(target, agentService)
      .then((result) => {
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: { ...result, loading: false, loaded: true },
          },
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[scriptWorkflowStore] 拉取脚本工作流数据失败", { error: message });
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              ...(state.byWorkspaceKey[key] ?? EMPTY_SCRIPT_WORKFLOW_STATE),
              loading: false,
              loaded: true,
              error: message,
              noSession: false,
            },
          },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
}));

export function selectScriptWorkflowState(
  state: ScriptWorkflowStoreState,
  target: { workspacePath: string; workspaceIdentity?: string } | null,
): ScriptWorkflowWorkspaceState {
  if (!target) return EMPTY_SCRIPT_WORKFLOW_STATE;
  return state.byWorkspaceKey[scriptWorkflowStoreKey(target)] ?? EMPTY_SCRIPT_WORKFLOW_STATE;
}
