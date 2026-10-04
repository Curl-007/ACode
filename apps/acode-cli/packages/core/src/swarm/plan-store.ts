// K2 对话内 Swarm 任务图 R6（specs/swarm-task-graph.md）：runtime 内 plan store——
// 单任务单图（plan 随单任务生命周期，不做跨会话/跨进程共享）。
//
// 持久化对齐（spec R6「实施首日核实 todo 落盘链路并对齐」，已核实）：
//   todo 链路 = todo handler → context.sessionStore（SessionStorePort.readTodos/
//   updateTodos，contracts/src/interfaces/session-store.port.ts）→ adapters
//   sqlite-session-store → repositories/todos.ts（每 session 一行的专用存储）。
//   todo 有独立落盘，故 plan 对齐其「端口注入 + 写穿」形态而不是退回纯 transcript 状态。
//   SessionStorePort 住在 contracts，而本段契约面冻结（第一段已交付、2a 不改协议）——
//   因此按 session-search.ts 的既有先例（K4：端口方法不随功能进 contracts，core 侧做
//   结构化 duck-typing seam）定义 SwarmPlanPersistence 注入面；缺省无注入 = 纯内存
//   runtime 状态面。2b 接线（turn.ts 调度点 + 工具注册门）时把 SQLite 行（对齐
//   repositories/todos.ts 的每 session 一行形态）绑到该 seam，不在本文件新建第二存储引擎。
//
// 不变量（R6）：图只经 R2 ops 变更——本 store 不提供任何图编辑原语，只持有/提交 op 的
// 产物（mutation 闭包包着 ops 调用）；读者永远见一致快照（getPlan 返回深拷贝，
// 写穿失败不污染内存态）；克隆提交保证调用方拿不到内部引用。

import {
  SwarmTaskPlanSchema,
  type Logger,
  type SwarmGraphError,
  type SwarmTaskPlan,
} from "@acode/contracts";

/**
 * plan 持久化 seam（todo 链路 readTodos/updateTodos 的同形端口；2b 绑定 SQLite 行）。
 * readPlan 返回存储行原值（unknown）：经 SwarmTaskPlanSchema 校验后才采用——持久化边界
 * 必须过运行时校验（AGENTS「数据跨存储边界时优先可运行时校验的 schema」），坏行不得
 * 静默进入 runtime 状态面。
 */
export interface SwarmPlanPersistence {
  clearPlan(): Promise<void>;
  readPlan(): Promise<unknown>;
  writePlan(plan: SwarmTaskPlan): Promise<void>;
}

/**
 * 图变更闭包：包着 R2 ops（seed/expand/complete/requeue 等）或 runner 的执行状态转移
 * （claim/no-artifact 计数——owner 只由 runner 分配/清空，R6）。输入是当前图（或 null），
 * ok 分支返回**新图**（ops 已做 clone-stage-commit，这里原样采用），错误分支透传具名错误。
 */
export type SwarmPlanMutation<TExtra extends object = object> = (
  plan: SwarmTaskPlan | null,
) => ({ ok: true; plan: SwarmTaskPlan } & TExtra) | { ok: false; error: SwarmGraphError };

export type SwarmPlanMutationOutcome<TExtra extends object = object> =
  | ({ ok: true; plan: SwarmTaskPlan } & TExtra)
  | { ok: false; error: SwarmGraphError };

/**
 * 提交后观测（2b 接线面）：每次内存态提交（mutate ok / clear）后同步回调一次。
 * 为什么加在这里而不是让接线方轮询：R6「图只经 ops 变更」意味着 mutate/clear 是唯一
 * 写路径，挂在写路径终点 = 每次图变化恰好观测一次（runtime-task 投影刷新、cancel 的
 * 在飞执行 abort 推导都吃这一个口，不会出现第二份真相）。previous 是提交前的读者快照
 * 深拷贝（或 null）；回调抛错不回滚提交（观测面不是事实源），由调用方自行兜错。
 */
export type SwarmPlanChangeListener = (event: {
  plan: SwarmTaskPlan | null;
  previous: SwarmTaskPlan | null;
}) => void;

export interface SwarmPlanStore {
  /** 只读快照（深拷贝）：读者改返回值不写穿 store，读者也永远见不到半提交状态。 */
  getPlan(): SwarmTaskPlan | null;
  /**
   * 应用一次图变更并写穿持久化。串行化执行（promise 链）：mutation 闭包是
   * read-modify-write，并发交错会让两个 caller 基于同一旧图各提交一次（后写覆盖前写）。
   * 写穿失败：内存态仍提交（图是事实源，存储是投影），错误作为 writeError 附加返回——
   * 调用方（工具面）决定是否向模型披露；不回滚内存（回滚需要第二份图编辑路径，违反
   * 「图只经 ops 变更」）。
   */
  mutate<TExtra extends object = object>(
    mutation: SwarmPlanMutation<TExtra>,
  ): Promise<SwarmPlanMutationOutcome<TExtra> & { writeError?: Error }>;
  /** 清除 plan（cancel-plan 的存储面；不清 runtime-task 投影——那是 registry 的所有者）。 */
  clear(): Promise<void>;
  /**
   * 从持久化 seam 恢复（任务启动/恢复时一次性）。结果面而不是抛错：坏行是数据完整性
   * 事件，采用与否由 2b 接线方决定（warn + 空图起步），store 不替它选。
   */
  hydrate(): Promise<{ adopted: boolean; error?: string }>;
}

export function createSwarmPlanStore(options?: {
  onChange?: SwarmPlanChangeListener;
  /** 存储边界事件（hydrate 复位 / clear 写穿失败）的生产告警面；缺省静默（测试可注入替身）。 */
  logger?: Logger;
  persistence?: SwarmPlanPersistence;
}): SwarmPlanStore {
  let current: SwarmTaskPlan | null = null;
  // 串行队列：mutation 是异步闭包（内含 ops 调用 + 可能的读旧图），链式排队防交错。
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  // 观测面同步派发（提交已落内存态后才回调；hydrate 是「采用既有事实」不是图变更，
  // 不触发——启动投影由接线方在 hydrate 后显式同步一次）。
  const notify = (previous: SwarmTaskPlan | null): void => {
    if (options?.onChange === undefined) return;
    try {
      options.onChange({ plan: current === null ? null : structuredClone(current), previous });
    } catch {
      // 观测者故障不写穿提交语义；接线方的观测器自己负责兜错（bootstrap 侧已兜）。
    }
  };

  return {
    clear: () =>
      enqueue(async () => {
        const previous = current === null ? null : structuredClone(current);
        current = null;
        try {
          await options?.persistence?.clearPlan();
        } catch (error) {
          // L2（批次B对抗复核）：clearPlan 写穿失败不吞进无告警的静默态——内存态是事实源、
          // 存储是投影（mutate 的 writeError 同款容错语义），warn 留诊断面后仍派发 onChange
          //（cancel 的 abort 推导与 runtime-task 投影收口都按内存态走，不能被投影失败卡住）。
          options?.logger?.warn("Swarm plan clear failed to persist; in-memory plan was cleared", {
            error: error instanceof Error ? error.message : String(error),
            event: "swarm.plan.clear_persist_failed",
            module: "core.swarm",
          });
        }
        notify(previous);
      }),
    getPlan: () => (current === null ? null : (structuredClone(current) as SwarmTaskPlan)),
    hydrate: () =>
      enqueue(async () => {
        if (options?.persistence === undefined) return { adopted: false };
        if (current !== null) return { adopted: true };
        let raw: unknown;
        try {
          raw = await options.persistence.readPlan();
        } catch (error) {
          return { adopted: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (raw === null || raw === undefined) return { adopted: false };
        const parsed = SwarmTaskPlanSchema.safeParse(raw);
        if (!parsed.success) {
          // 坏行不采用也不清存储：诊断信息（issues 摘要）回给接线方，数据留给人工排查。
          return {
            adopted: false,
            error: `persisted swarm plan failed schema validation: ${parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
              .join("; ")}`,
          };
        }
        // H2（批次B对抗复核）：崩溃残留的 running 节点是死执行实例的中间态——原样采纳会让
        // readyNodes 只选 queued（永不重派）、planTerminalState 恒 active。hydrate 边界把
        // 执行中间态复位：status→queued、owner 清空（owner 只属执行实例，进程已死）、expanded
        // 一并清（running+expanded 的合成中途态同样回可再规划面）；artifactRequeues 是 J2-3
        // 同款累计预算，保留不重置。计数 >0 记一次 warn（只报数量不列 id——plan 可达 1024
        // 节点，id 列表会写爆日志）。
        let resetRunningNodes = 0;
        for (const node of parsed.data.nodes) {
          if (node.status !== "running") continue;
          node.status = "queued";
          node.owner = null;
          node.expanded = false;
          resetRunningNodes += 1;
        }
        if (resetRunningNodes > 0) {
          options?.logger?.warn(
            "Swarm plan hydrate reset running nodes to queued (stale claims from an unclean shutdown)",
            {
              event: "swarm.plan.hydrate_reset",
              module: "core.swarm",
              resetRunningNodes,
            },
          );
        }
        current = parsed.data;
        return { adopted: true };
      }),
    mutate: <TExtra extends object = object>(mutation: SwarmPlanMutation<TExtra>) =>
      enqueue(async () => {
        const previous = current === null ? null : structuredClone(current);
        const outcome = mutation(current === null ? null : structuredClone(current));
        if (!outcome.ok) return outcome;
        // 存储边界校验：mutation 产物必须是合法 plan（ops 已保证；这是对绕过 ops 构造
        // 产物的防御性校验——fail-loud 而不是把坏图写穿到 SQLite）。
        const parsed = SwarmTaskPlanSchema.safeParse(outcome.plan);
        if (!parsed.success) {
          return {
            error: {
              kind: "invalid-state",
              message: `swarm plan mutation produced an invalid plan: ${parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
                .join("; ")}`,
            } satisfies SwarmGraphError,
            ok: false as const,
          };
        }
        current = parsed.data;
        let writeError: Error | undefined;
        if (options?.persistence !== undefined) {
          try {
            await options.persistence.writePlan(parsed.data);
          } catch (error) {
            writeError = error instanceof Error ? error : new Error(String(error));
          }
        }
        // 写穿失败也派发观测（内存态是事实源，存储是投影——cancel/投影推导按内存态走）。
        notify(previous);
        return writeError === undefined ? outcome : { ...outcome, writeError };
      }),
  };
}
