// 编排方案 Phase 1（specs/subagent-topology-persistence.md R2/R3/R8/R9）：子代理拓扑
// 边的 core 侧绑定面——持久化 seam 的 duck-typing 能力探测（swarm/runtime-binding.ts
// 的 K4 先例形状：能力方法全有或全无，缺席按「无持久化」降级、不伪装成功）+ 事件 →
// 边命令的纯函数派生（防御性读 payload，未知状态词丢弃）。
//
// 本文件零 IO：写入经 bind 出的 persist 闭包（调用方注入 store 能力面），派生是纯函数。
// 为什么 duck-typing 而不是扩 contracts SessionStorePort：spec R8——端口方法不随功能进
// contracts（swarm K4 先例）；claimWorkflowSessionOwner 的破例是跨进程 owner lease 的
// 端口级语义，边表是单 store 的投影存储，不适用（spec「未做与取舍」#2）。

import { SessionEventType, type SessionId, type SubagentRunRequest } from "@acode/contracts";

/**
 * 边状态词表 = registry 词表（R9）：running + runtime-task 的终态集
 * （runtime-task/registry.ts TERMINAL_STATUSES，两个投影面同一套真话）。
 */
export type SubagentEdgeTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";
export type SubagentEdgeStatus = "running" | SubagentEdgeTerminalStatus;

const TERMINAL_EDGE_STATUSES: ReadonlySet<string> = new Set<SubagentEdgeTerminalStatus>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

function terminalEdgeStatus(value: unknown): SubagentEdgeTerminalStatus | undefined {
  return typeof value === "string" && TERMINAL_EDGE_STATUSES.has(value)
    ? (value as SubagentEdgeTerminalStatus)
    : undefined;
}

/** spawn / 重臂命令（R2：无条件 upsert，整行重置为 running）。 */
export interface SubagentEdgeSpawnCommand {
  kind: "spawn";
  agentId: string;
  agentType: string | null;
  background: boolean;
  childSessionId: string | null;
  description: string | null;
  model: string | null;
  outputFile: string | null;
  parentSessionId: SessionId;
  parentToolCallId: string | null;
  startedAt: number | null;
}

/** 终态结算命令（R2：first-wins 守卫在 repository 的 SQL 里）。 */
export interface SubagentEdgeSettleCommand {
  kind: "settle";
  agentId: string;
  background: boolean;
  childSessionId: string | null;
  endedAt: number;
  error: string | null;
  outputFile: string | null;
  parentSessionId: SessionId;
  status: SubagentEdgeTerminalStatus;
  totalTokens: number | null;
}

export type SubagentEdgeCommand = SubagentEdgeSpawnCommand | SubagentEdgeSettleCommand;

export interface SubagentEdgePersistence {
  persist(command: SubagentEdgeCommand): Promise<void>;
}

/** SqliteSessionStore 的边表写入能力面（委托方法，structural 探测）。 */
interface SubagentEdgeCapableSessionStore {
  upsertSubagentEdge?: (input: {
    agentId: string;
    agentType?: string | null;
    background?: boolean;
    childSessionId?: string | null;
    description?: string | null;
    model?: string | null;
    outputFile?: string | null;
    parentSessionId: SessionId;
    parentToolCallId?: string | null;
    startedAt?: number | null;
    status: string;
  }) => Promise<void>;
  settleSubagentEdge?: (input: {
    agentId: string;
    background?: boolean;
    childSessionId?: string | null;
    endedAt: number;
    error?: string | null;
    outputFile?: string | null;
    parentSessionId: SessionId;
    status: string;
    totalTokens?: number | null;
  }) => Promise<unknown>;
}

/**
 * 能力探测（R8）：写入双方法必须齐备——只有 upsert 没有 settle 会让边表永远停在
 * running（比没有表更糟，读侧会把死代理当活的），按能力缺席整体降级。
 */
export function bindSubagentEdgePersistence(
  store: unknown,
): SubagentEdgePersistence | undefined {
  if (typeof store !== "object" || store === null) return undefined;
  const candidate = store as SubagentEdgeCapableSessionStore;
  if (
    typeof candidate.upsertSubagentEdge !== "function" ||
    typeof candidate.settleSubagentEdge !== "function"
  ) {
    return undefined;
  }
  return {
    persist: async (command) => {
      if (command.kind === "spawn") {
        await candidate.upsertSubagentEdge!({
          agentId: command.agentId,
          agentType: command.agentType,
          background: command.background,
          childSessionId: command.childSessionId,
          description: command.description,
          model: command.model,
          outputFile: command.outputFile,
          parentSessionId: command.parentSessionId,
          parentToolCallId: command.parentToolCallId,
          startedAt: command.startedAt,
          status: "running",
        });
        return;
      }
      await candidate.settleSubagentEdge!({
        agentId: command.agentId,
        background: command.background,
        childSessionId: command.childSessionId,
        endedAt: command.endedAt,
        error: command.error,
        outputFile: command.outputFile,
        parentSessionId: command.parentSessionId,
        status: command.status,
        totalTokens: command.totalTokens,
      });
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function dateToMs(value: unknown, fallback: number): number {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : fallback;
}

/**
 * 事件 → 边命令的纯函数派生（R2 单点的另一半：发射点有八个，铸边规则只有这一份）。
 * 防御性读 payload（事件 payload 无 contracts 级 schema，Record<string, unknown>）；
 * 不可派生（缺 agentId、非终态 settle、未知事件类型）返回 undefined，调用方跳过。
 */
export function subagentEdgeCommandFromEvent(input: {
  payload: Record<string, unknown>;
  request: Pick<SubagentRunRequest, "agentType" | "description" | "parentToolCallId" | "sessionId">;
  timestampMs: number;
  type: SessionEventType | string;
}): SubagentEdgeCommand | undefined {
  const { payload, request, timestampMs } = input;
  switch (input.type) {
    case SessionEventType.SubagentSpawned: {
      const agentId = stringOrNull(payload.agentId);
      if (!agentId) return undefined;
      return {
        kind: "spawn",
        agentId,
        agentType: stringOrNull(payload.agentType) ?? stringOrNull(request.agentType),
        background: payload.background === true,
        childSessionId: stringOrNull(payload.childSessionId),
        description: stringOrNull(payload.description) ?? stringOrNull(request.description),
        model: stringOrNull(payload.model),
        outputFile: stringOrNull(payload.outputFile),
        parentSessionId: request.sessionId,
        parentToolCallId: String(request.parentToolCallId),
        startedAt: timestampMs,
      };
    }
    case SessionEventType.SubagentStopped: {
      const agentId = stringOrNull(payload.agentId);
      const status = terminalEdgeStatus(payload.status);
      if (!agentId || !status) return undefined;
      return {
        kind: "settle",
        agentId,
        background: payload.background === true,
        childSessionId: stringOrNull(payload.childSessionId),
        endedAt: timestampMs,
        error: stringOrNull(payload.error),
        outputFile: stringOrNull(payload.outputFile),
        parentSessionId: request.sessionId,
        status,
        totalTokens: intOrNull(payload.totalTokens),
      };
    }
    case SessionEventType.BackgroundTaskCompleted: {
      // 后台停止/取消路径的终态事实（SubagentStopped 只覆盖 completed/failed；
      // stopped/killed 等经 registry 快照从本事件到达）。非 subagent 任务不铸边。
      if (stringOrNull(payload.taskKind) !== "subagent") return undefined;
      const agentId = stringOrNull(payload.taskId);
      const status = terminalEdgeStatus(payload.status);
      if (!agentId || !status) return undefined;
      return {
        kind: "settle",
        agentId,
        background: true,
        childSessionId: stringOrNull(payload.childSessionId),
        endedAt: dateToMs(payload.completedAt, timestampMs),
        error: stringOrNull(payload.error),
        // 该事件的输出路径字段名是 outputPath（不是 outputFile），按发射点原文读。
        outputFile: stringOrNull(payload.outputPath),
        parentSessionId: request.sessionId,
        status,
        totalTokens: null,
      };
    }
    default:
      return undefined;
  }
}

/** store 的 resume 收敛能力面（R4）。 */
interface SubagentEdgeConvergeCapableStore {
  convergeSubagentEdges?: (input: { now?: number; sessionID: SessionId }) => Promise<unknown>;
}

/**
 * resume 收敛入口（R4/R8）：能力缺席静默跳过返回 0；调用方负责 try/catch + warn
 * （收敛失败不阻断 resume——边表是投影权威，不是恢复路径的阻塞依赖）。
 */
export async function convergeSubagentEdgesOnResume(
  store: unknown,
  input: { now?: number; sessionID: SessionId },
): Promise<number> {
  if (typeof store !== "object" || store === null) return 0;
  const candidate = store as SubagentEdgeConvergeCapableStore;
  if (typeof candidate.convergeSubagentEdges !== "function") return 0;
  const converged = await candidate.convergeSubagentEdges(input);
  return typeof converged === "number" && Number.isFinite(converged) ? converged : 0;
}
