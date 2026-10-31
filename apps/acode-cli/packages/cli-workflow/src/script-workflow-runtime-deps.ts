// ============================================================
// ScriptWorkflowRuntime：依赖面与共享类型叶（无回边）
// ============================================================
// script-workflow-runtime.ts 偿还 W1-R3 max-lines 例外的配套：把叶子文件之间共享的类型集中到本文件，
// 让所有叶子的类型引用指向这里而不是指回主类外壳——架构检查器把 `import type` 也算作依赖边，
// 叶子 → 外壳的类型回边会被判成循环依赖，因此共享类型必须住在依赖图的最低点。
//
// 依赖方向：主类外壳与各叶子 → 本文件；本文件只指向 contracts / host-types / child-runtime /
// progress-adapter / utils / worktree-manager，不指向任何叶子或外壳。
//
// 公开面：`ScriptWorkflowRuntimeDeps` 仍由主类外壳 re-export（contract.ts 从外壳 re-export，形状不变）；
// `ScriptWorkflowRunOptions` / `ScriptWorkflowSettleStatus` 同理由外壳 re-export。

import type { ScriptWorkflowStorePort, TraceContext } from "@acode/contracts";
import type { PrepareUserExecutionBoundary } from "./host-types.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";
import type { ScriptWorkflowProgressAdapter } from "./script-workflow-progress-adapter.js";
import type { WorkflowLimiter } from "./script-workflow-utils.js";
import type { WorkflowWorktreeManager } from "./workflow-worktree-manager.js";

export interface ScriptWorkflowRuntimeDeps extends ScriptWorkflowAgentRuntimeDeps {
  /** child runtime 的注入工厂；缺省使用与 Dynamic Workflow 相同的生产配置。 */
  createAgentRuntime?: typeof createScriptWorkflowAgentRuntime;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  /** Owner identity used to bind persisted runs to this session/workspace. */
  remoteSessionId?: string;
  /** Durable workflow owner facts captured by the bridge; legacy test hosts may omit them. */
  ownerGeneration?: number;
  ownerToken?: string;
  ownerReady?: Promise<{ ownerGeneration: number; ownerToken: string } | null | undefined>;
  /**
   * 租约的惰性重试（specs/workflow-owner-lease.md R3）：`ownerReady` 为 null（启动窗口
   * 内他人活跃租约/瞬时 DB 错误）时经它重试一次；缺席则 null 仍即时抛错（旧语义）。
   */
  ownerReclaim?: () => Promise<
    { ownerGeneration: number; ownerToken: string } | null | undefined
  >;
  traceContext: TraceContext;
  workspaceIdentity?: string;
  /** 测试注入点；缺省惰性构造真实 manager（S1，workflow-worktree-isolation.md R2）。 */
  worktreeManager?: WorkflowWorktreeManager;
  /**
   * dwf 进度投影的适配器（可选）。缺席时脚本工作流照跑，只是不进 `workflowRuns` 投影——
   * 那是观察面，绝不该有能力影响 run 本身。
   * 为什么复用 dwf 的投影而不是另建一套，以及「只有运行期实时可见」这条边界，
   * 见 script-workflow-progress-adapter.ts 的文件头。
   */
  progressAdapter?: ScriptWorkflowProgressAdapter;
}

/**
 * `run()` / `resume()` 返回值里的状态词——只有这两个方法**自己会写**的那三个。
 *
 * 为什么不直接用 `ScriptWorkflowRunStatus`：那个词表还含 `interrupted`（孤儿收敛写的，
 * 见 script-workflow-reconcile.ts）与 `pending`/`running`/`paused`（起跑前 / 在飞）。
 * 这两个方法在返回之前一定已经亲手结算过这条 run，所以返回值只可能是三者之一。
 *
 * 收窄不是装饰：facade 的返回类型是 `ExpertWorkflowCommandResult`，它的 `status` 用的是
 * **expert workflow 自己的**词汇（`WorkflowRunStatus`）。把更宽的词表塞过去编译不过，
 * 而为了迁就它去给另一套系统的词表加值是错的耦合——两套工作流系统各有各的状态词，
 * 只在投影/目录那一层翻译（script-workflow-run-summary.ts）。
 */
export type ScriptWorkflowSettleStatus = "cancelled" | "completed" | "failed";

export type ScriptWorkflowRunOptions = {
  abortSignal?: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
} & Parameters<PrepareUserExecutionBoundary>[0];

/** run() 的入参形状（原方法签名的内联类型，随迁后命名）。 */
export type ScriptWorkflowRunInput = {
  args?: unknown;
  resumeFromRunId?: string;
  runId?: string;
  scriptPath: string;
  /** 发起这次 run 的工具调用；dwf 投影靠它把 run 卡联接到聊天里的那一行。 */
  toolCallId?: string;
};

/**
 * run 编排经此接触 runtime 的私有状态。与主类的 `host` 字段是同一个对象：
 * agentCallCounts / statsWrites 按引用共享（清理点在 run 结算的 finally），store / ownerFacts /
 * appendEvent / worktrees 是主类私有方法的转发。
 */
export interface ScriptWorkflowRunHost {
  readonly agentCallCounts: Map<string, number>;
  /** 事件追加：先落库再投影，观察面永不失败 run（纪律见 {@link appendRunEvent}）。 */
  appendEvent(runId: string, type: string, payload?: unknown): Promise<void>;
  readonly deps: ScriptWorkflowRuntimeDeps;
  readonly limiter: WorkflowLimiter;
  ownerFacts(): { ownerGeneration: number; ownerToken: string } | Record<string, never>;
  readonly statsWrites: Map<string, Promise<void>>;
  store(): ScriptWorkflowStorePort;
  worktrees(): WorkflowWorktreeManager;
}
