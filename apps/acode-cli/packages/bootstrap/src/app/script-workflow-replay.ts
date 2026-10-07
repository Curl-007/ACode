import type { DynamicWorkflowRunProgressPayload } from "@acode/contracts";
import { WORKFLOW_RUNS_LIMITS } from "@acode/shared/acode-protocol-v4";
import type { ScriptWorkflowStorePort } from "@acode/contracts";
import { createScriptWorkflowProgressAdapter } from "./script-workflow-progress-adapter.js";

/**
 * 脚本工作流 run 的**冷回放**：把历史 run 的事件重新翻译成 dwf 进度信封。
 *
 * ## 为什么需要它
 *
 * `workflowRuns` 投影有两条来源：实时事件，以及冷启动时的回放。dwf 那半边由
 * `dynamic-workflow-run-service.ts` 的 `replayProgressForSession` 从 journal 还原；脚本
 * 工作流的 run 不在那份 journal 里——它有自己的 `workflow_run` / `workflow_event` 表。
 * 缺了本模块，进程重启后历史脚本 run 就从投影里彻底消失：状态面板不列它、侧栏打不开它、
 * 而它的真相其实一直好好躺在自己的表里。
 *
 * ## 一条写入路径，两套来源
 *
 * 刻意复用**同一个**适配器（`createScriptWorkflowProgressAdapter`）而不是为冷态另写一份映射。
 * 两份映射就会漂移：live 时 `activity_failed` 翻成 `node-settled{failed}`、冷回放时翻成别的，
 * 同一条 run 重启前后于是长得不一样。适配器本身是无状态的（序号按 runId 各自起算），
 * 所以冷态只要每个 run 用一个新实例、按存储顺序喂事件，产出的信封与 live 逐条同形。
 *
 * ## 与 dwf 回放的三条同款约定
 *
 *   - **上界与投影的淘汰同一个常量**（`WORKFLOW_RUNS_LIMITS.maxRuns`）：冷态应当等于
 *     「一个长寿进程此刻会持有的状态」，而不是把整张历史表灌进去；
 *   - **最旧优先**：枚举面是最近更新在前，回放要反过来，reducer 的淘汰才与 live 的到达序同形；
 *   - **`excludeRunIds` 跳过调用方内存里已有事件的 run**：本进程跑过 / 正在跑的 run 再喂一遍，
 *     只会让 `run-started` 把相位打回起点。
 *
 * ## 非终态行按 interrupted 合成结算
 *
 * 进程死亡时正在飞的 run，它的事件表里**没有**任何终态事件，而行还停在 `running`。
 * 原样回放的话投影会永远亮着 running——卡片亮灯、Cancel 可点而后端无事可取消，
 * 正是 dwf reducer 注释里记过的那个静默失败。所以这里给非终态行补一条
 * `run-settled { status: "stopped", stopReason: "interrupted" }`（渲染成「stopped (process
 * exited)」），与 dwf 的 harness 沙箱故障归一同一笔语义。
 *
 * 这条合成**只在内存里**，绝不写回 `workflow_run` 行——回放是读路径，不该有写副作用
 * （dwf 的同款约定：「追加一条内存态合成 settle 载荷，绝不写进 journal」）。
 * 残留的边界如实记在 spec：行本身仍是 `running`，所以 `scriptWorkflowStatus` 与后台任务
 * 快照这两个**模型面**读到的仍是旧词。给脚本工作流补一套孤儿收敛（像 dwf 那样改写行）
 * 是另一件事。
 */
export interface ScriptWorkflowReplayDeps {
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
  parentSessionId: string;
  store: ScriptWorkflowStorePort;
}

/** 非终态：进程死亡时会停在这三个词上的行。 */
const NON_TERMINAL_STATUSES = new Set(["pending", "running", "paused"]);

export async function replayScriptWorkflowRuns(
  deps: ScriptWorkflowReplayDeps,
  input: { excludeRunIds: ReadonlySet<string> },
): Promise<DynamicWorkflowRunProgressPayload[]> {
  let rows;
  try {
    // 会话作用域：投影按会话物化，把别的会话的 run 回放进来等于让一个会话看见另一个的工作流。
    // 一个项目目录会被许多会话共用，所以 cwd 顶不掉这个作用域（该过滤是本批新加的）。
    rows = await deps.store.listScriptWorkflowRuns({
      limit: WORKFLOW_RUNS_LIMITS.maxRuns,
      parentSessionId: deps.parentSessionId,
    });
  } catch (error) {
    // 枚举失败不致命：冷回放是**补齐**观察面，不是启动路径。降级成「没有历史 run」，
    // 与 dwf 回放同款（那边 catch 之后也是 return []）。
    deps.logger?.warn?.("Script workflow run replay enumeration failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "script_workflow.run.replay_failed",
      module: "bootstrap.app",
    });
    return [];
  }

  const payloads: DynamicWorkflowRunProgressPayload[] = [];
  // 枚举面最近更新在前；回放要最旧优先。
  for (const row of [...rows].reverse()) {
    if (input.excludeRunIds.has(row.id)) continue;
    try {
      payloads.push(...(await replayOneRun(deps, row)));
    } catch (error) {
      // 单条 run 回放失败不牵连其余：一条损坏的历史 run 不该让整个会话的观察面空白。
      deps.logger?.warn?.("Script workflow run replay failed for one run", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "script_workflow.run.replay_run_failed",
        module: "bootstrap.app",
        runId: row.id,
      });
    }
  }
  return payloads;
}

async function replayOneRun(
  deps: ScriptWorkflowReplayDeps,
  row: { id: string; status: string; toolCallId?: string },
): Promise<DynamicWorkflowRunProgressPayload[]> {
  const captured: DynamicWorkflowRunProgressPayload[] = [];
  const adapter = createScriptWorkflowProgressAdapter({
    emit: (progress) => {
      captured.push(progress);
    },
  });
  // toolCallId 来自 run 记录（migration 0027 起才落库）：有它，冷恢复的 run 就能联回发起它
  // 的那一行工具调用，聊天里的工具卡与目录行都据此工作。存量行没有这个事实，缺席即缺席——
  // 那种 run 仍进投影（状态面板与侧栏按 runId 工作），只是联不回工具卡，与 dwf 那些
  // `tool_call_id` 落库之前的老 run 同一个处境。
  adapter.registerRun({
    parentSessionId: deps.parentSessionId,
    runId: row.id,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
  });

  const events = await deps.store.listScriptWorkflowEvents({ runId: row.id });
  for (const event of events) {
    adapter.onEvent({ payload: event.payload, runId: row.id, type: event.type });
  }
  // 非终态行补一条内存态结算（理由见文件头）。已经终态的行不补：它的事件流里
  // 必有一条 workflow_completed / workflow_failed / workflow_cancelled。
  // `workflow_interrupted` 是适配器的**合成**事件型（事件表里不存在），专供这条路径。
  if (NON_TERMINAL_STATUSES.has(row.status) && !hasSettledEvent(events)) {
    adapter.onEvent({ payload: {}, runId: row.id, type: "workflow_interrupted" });
  }
  adapter.forgetRun(row.id);
  return captured;
}

/**
 * 事件流里是否已有终态。
 *
 * 用「有没有终态事件」而不是「行是不是非终态」作判据的另一半：两者本该一致，但进程可能在
 * 写完终态事件与改写行之间死掉，那时行还是 running 而事件已经结算。以事件为准，
 * 否则会补出第二条 `run-settled`，把一条已经 errored 的 run 改写成 stopped。
 */
function hasSettledEvent(events: readonly { type: string }[]): boolean {
  return events.some(
    (event) =>
      event.type === "workflow_completed" ||
      event.type === "workflow_failed" ||
      event.type === "workflow_cancelled",
  );
}
