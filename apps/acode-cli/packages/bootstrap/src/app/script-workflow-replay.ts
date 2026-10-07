import type {
  DynamicWorkflowRunProgressPayload,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
} from "@acode/contracts";
import { WORKFLOW_RUNS_LIMITS } from "@acode/shared/acode-protocol-v4";
import { createScriptWorkflowProgressAdapter } from "./script-workflow-progress-adapter.js";
import { logicalScriptWorkflowStatus } from "./script-workflow-run-status.js";

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
 * ## 结算以**行**为准
 *
 * 事件流里没有终态事件时，按行的状态词铸造一条内存态结算。两种情况会走到这里：
 *
 *   - 行被孤儿收敛改写过（`script-workflow-reconcile.ts`）。收敛**只写行、不合成事件**
 *     ——事件表的契约是「运行期真发过什么」，清扫者无权往里写。于是一条收敛成
 *     `interrupted` 的行，事件流里永远没有终态；只看事件的话投影会停在 running：
 *     卡片亮灯、Cancel 可点而后端无事可取消，正是 dwf reducer 注释里记过的静默失败。
 *   - 收敛还没轮到它（或收敛失败了）而进程已经换过一世。冷回放只在冷物化时跑，此刻
 *     本进程名下零个在飞 run，所以一条非终态行只可能是遗物——把它说成 running 是那句
 *     永不自愈的谎言，说成 interrupted 是事实。
 *
 * 反过来，事件流里**已有**终态时绝不补第二条：进程可能在写完终态事件与改写行之间死掉，
 * 那时行还是 running 而事件已经 errored，补一条会把 errored 的 run 改写成 stopped。
 *
 * 这条铸造**只在内存里**，回放作为读路径绝不写库（dwf 同款约定：「追加一条内存态合成
 * settle 载荷，绝不写进 journal」）。改写行是收敛的职责，两者分工不重叠。
 */
export interface ScriptWorkflowReplayDeps {
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
  parentSessionId: string;
  store: ScriptWorkflowStorePort;
}

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
  row: {
    failure?: unknown;
    id: string;
    status: ScriptWorkflowRunStatus;
    toolCallId?: string;
  },
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
  // **结算以行为准**（dwf 的 dynamic-workflow-run-replay.ts 同一条纪律）：事件流里没有终态时，
  // 按行的状态词铸造一条内存态结算。
  //
  // 为什么不能只依赖事件：孤儿收敛（script-workflow-reconcile.ts）**只改写行、不合成事件**
  // ——事件表的契约是「运行期真发过什么」，清扫者无权往里写。于是一条被收敛成 `interrupted`
  // 的行，它的事件流里永远没有终态事件；只看事件的话投影会停在 running，卡片亮灯、
  // Cancel 可点而后端无事可取消。
  //
  // 反过来，事件流里**已有**终态时绝不补第二条：进程可能在写完终态事件与改写行之间死掉，
  // 那时行还是 running 而事件已经 errored——补一条会把一条已经 errored 的 run 改写成 stopped。
  if (!hasSettledEvent(events)) {
    adapter.onEvent({
      payload: settlePayloadForRow(row),
      runId: row.id,
      type: settleEventTypeForRow(row),
    });
  }
  adapter.forgetRun(row.id);
  return captured;
}

/**
 * 行的状态词 → 该补哪一种终态事件。
 *
 * 读的是**逻辑**状态（`logicalScriptWorkflowStatus`）：物理词 `cancelled` 同时承载
 * 「用户停的」与「宿主没了」，两者要翻成不同的 dwf 终态（`stopped/user` vs
 * `stopped/interrupted`），只看物理词就会把一次进程死亡报成用户取消。
 *
 * `pending` / `running` / `paused` 也归到 interrupted：冷回放只在冷物化时跑，此刻本进程名下
 * 零个在飞 run，所以一条非终态行只可能是死进程的遗物——只是收敛还没轮到它（或收敛失败了）。
 * 把它说成 running 是那句永不自愈的谎言，说成 interrupted 是事实。
 */
function settleEventTypeForRow(row: { failure?: unknown; status: ScriptWorkflowRunStatus }): string {
  switch (logicalScriptWorkflowStatus(row)) {
    case "completed":
      return "workflow_completed";
    case "failed":
      return "workflow_failed";
    case "cancelled":
      return "workflow_cancelled";
    case "interrupted":
      return "workflow_interrupted";
    default:
      // 一切非终态：宿主已经换过一世，它就是遗物。
      return "workflow_interrupted";
  }
}

/** 结算载荷：只搬行上真有的东西，缺就不带（适配器对缺席的 message 本来就不印错误行）。 */
function settlePayloadForRow(row: {
  failure?: unknown;
  status: string;
}): Record<string, unknown> {
  if (row.status !== "failed") return {};
  const failure = row.failure;
  if (typeof failure === "string") return { message: failure };
  if (failure && typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return { message };
  }
  return {};
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
