// ============================================================
// Dynamic Workflow Run Service：读面（11 条只读端口方法）
// ============================================================
// 从 dynamic-workflow-run-service.ts 拆出：`DynamicWorkflowRunPort` 上的全部只读方法——
// 会话枚举/回放（listRunsForSession / replayProgressForSession）、任务快照与等待
// （getTask / getScript / waitForTask）、事件分页（listEvents）与产物 / 工作区读取五条。
//
// 它们不经过关闭门与 owner 门（读不启动引擎、不写边界），与四条写入口刻意分开住；
// 所有运行态事实仍读 service 的同一份注册表 / 停驻表 / 天花板，经 host 显式递进来，
// 本叶不持有自己的状态。

import type { DwfRunSessionListItem } from "@acode/adapters/storage";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "@acode/contracts";
import {
  artifactsOf,
  listArtifactItemsFrom,
  listWorkspaceNodesFrom,
  readWorkflowArtifactBytes,
  readWorkspaceNodeResultFrom,
  supportsRunEnumeration,
} from "@acode/workflow-run-read/contract";
import { WORKFLOW_RUNS_LIMITS } from "@acode/shared/acode-protocol-v4";
import { toProtocolEvent } from "./dynamic-workflow-launch-event-adapter.js";
import { replayRunProgress } from "./dynamic-workflow-run-replay.js";
import {
  settleOrAbort,
  snapshotOf,
  toSessionSummary,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-deps.js";

/** listRunsForSession 的默认/上限条数（枚举面有界，绝不无界扫库）。 */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;

/** 拆出的 11 条读面方法，供 service 工厂整体铺开。 */
export type RunReadSideMethods = Pick<
  DynamicWorkflowRunPort,
  | "listRunsForSession"
  | "replayProgressForSession"
  | "getTask"
  | "getScript"
  | "waitForTask"
  | "listEvents"
  | "listArtifacts"
  | "listArtifactItems"
  | "readArtifact"
  | "listWorkspaceNodes"
  | "readWorkspaceNodeResult"
>;

/**
 * service 借给读面的全部运行态事实：注册表、停驻表、并发天花板与外来终态行留痕口。
 * 全是引用，不是副本——读面与写入口读的是同一份事实。
 */
export interface RunReadSideHost {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  escalations: WorkflowEscalationRegistry;
  concurrencyCeiling: () => number;
  noteForeignTerminalRow: (runId: string) => void;
}

/** 造 11 条只读端口方法（见文件头）。 */
export function createRunReadSideMethods(host: RunReadSideHost): RunReadSideMethods {
  const { deps, runs, escalations, concurrencyCeiling, noteForeignTerminalRow } = host;
  return {
    async listRunsForSession(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (!supportsRunEnumeration(deps.journal)) {
        // 无枚举查询（如内存 journal）：空列表是诚实答案——内存 journal 里的 run 本就
        // 不会活过进程，重启后的发现面没有可还原的东西。
        return [];
      }
      const capped = Math.max(1, Math.min(limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      let rows: DwfRunSessionListItem[];
      try {
        rows = deps.journal.listRunsByParentSession(deps.parentSessionId, capped);
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.list_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      // 活条目一并交给摘要：会话枚举面与快照 / 列表 / 详情共用同一条优先级（规则三），
      // 否则这一面会独自显示一个被外来写入标死的 run。
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // 上界与投影的淘汰同一个常量：冷态 = 一个长寿进程此刻会持有的状态。
        rows = deps.journal.listRunsByParentSession(
          deps.parentSessionId,
          WORKFLOW_RUNS_LIMITS.maxRuns,
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run replay enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.replay_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      const payloads: DynamicWorkflowRunProgressPayload[] = [];
      // 枚举面最近更新在前；回放要最旧优先，reducer 的淘汰才与 live 时的到达顺序同形。
      for (const row of [...rows].reverse()) {
        // 调用方内存里已有事件的 run（本进程跑过）与注册表在飞的 run 都不回放：
        // 它们的事件全在内存 store 里，再喂一遍只会让 run-started 把相位打回起点。
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // 天花板与 live 侧同源：冷回放的 `run-started` 载荷必须与 live 那一条逐字节相等。
        payloads.push(...replayRunProgress(row, deps.journal, concurrencyCeiling()));
      }
      return payloads;
    },

    async getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> {
      noteForeignTerminalRow(taskId);
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    /**
     * run 存档的脚本（端口契约见 {@link DynamicWorkflowRunPort.getScript}）。注册表条目在前：
     * submit → createRun 的间隙里 journal 还没有行，条目上的就是同一份字节。journal 那一份也是
     * resume 的哈希校验读的字节，所以 `AmendWorkflow` 的沿用、`script_unchanged` 预检与 resume
     * 对「这个 run 在跑什么」不会有两个答案。
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // 不在注册表里：可能是本进程之前的 run（journal 有记录）或全然未知。两种都不可等待。
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          concurrencyCeiling(),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // 停驻项在**等待之后**重新投影：等待期间问题可能已被作答或随取消撤下。
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    async listEvents(
      runId: string,
      options: DynamicWorkflowRunEventPage,
    ): Promise<DynamicWorkflowRunEvent[]> {
      const page = deps.journal.listEvents(runId, {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return page.map((stored) => toProtocolEvent(stored.sequence, stored.event));
    },

    /**
     * 本 run 的用户面产物清单。UI 冷恢复与中枢详情的
     * durable 读法：`workflowRuns.artifacts` 投影是 memory-only，重启后为空，而版本历史的
     * 持久家一直是 journal 的 `kind = "artifact"` 行。
     *
     * 归并规则整段复用 {@link artifactsOf}——终态快照（`getTask`）与本方法必须给出**同一份**
     * 清单，两处各归并一份迟早会在「失败行算不算一版」这种地方分叉。
     *
     * ⚠ 术语：这里的 artifact 是脚本发布给用户看的产出，不是端口上的 `output`（脚本顶层
     * 返回值，引擎内部也叫 artifact）。
     *
     * 未知 runId 与「本 journal 没有产物读面」都回 `undefined`：对调用方是同一个业务事实。
     */
    async listArtifacts(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined> {
      return artifactsOf(runId, deps.journal).artifacts;
    },

    /**
     * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
     * 越界 cursor 得到空页而不是错误——翻到尾巴是正常的翻页结局。
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<readonly DynamicWorkflowRunArtifactItem[]> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, {
        ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
        limit: page.limit,
      });
    },

    /**
     * 读某个产物版本的字节。授权链（run 属于本会话 ∧ journal 有该版本的 completed 行 ⇒ 取
     * 行上的 uri）整段在 {@link readWorkflowArtifactBytes}，那里画了链路图。
     *
     * `parentSessionId` 用**本服务的**那一个（= 本 app 的会话），刻意不收参数：服务实例本就
     * 按父会话构造，让调用方传任意会话等于开一个跨会话读洞——与 `listRunsForSession` 同一条
     * 论证，只是那边是枚举、这边是字节。
     */
    async readArtifact(
      runId: string,
      artifactId: string,
      version: number,
    ): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
      return readWorkflowArtifactBytes(
        {
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
        },
        runId,
        artifactId,
        version,
      );
    },

    /**
     * 工作区 transcript 的清单与正文。授权链
     * 与 readArtifact 同一条（run 属于本会话），两条都走——清单上的 args 已经是路径与命令行。
     * 整段在 @acode/workflow-run-read 的 workspace projection。
     */
    async listWorkspaceNodes(
      runId: string,
    ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
      return listWorkspaceNodesFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
      );
    },

    async readWorkspaceNodeResult(
      runId: string,
      siteId: string,
      ordinal: number,
      query: DynamicWorkflowRunWorkspaceNodeResultQuery,
    ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
      return readWorkspaceNodeResultFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
        siteId,
        ordinal,
        query,
      );
    },
  };
}
