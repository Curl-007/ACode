// v4 归档会话 header 冷读（apps/acode-cli/specs/v4-session-header-meta.md）。
//
// 为什么需要这条**一次性冷读**：v4 侧只有 subscribe 形态（conversationSubscribe）与窄查询
// （usageStats / conversationUsage / conversationRowsRange），没有「按 sessionId 取一份 header
// 元数据」的方法。UI 的 useActiveTaskSnapshotMeta 为**归档任务**提供 header 兜底（归档任务
// 不在 sessions-index 里——v4 侧 includeArchived: false），此前只能走 legacy sessionRead。
// 本叶子是 legacy M1 的前置件：给该消费方一条 v4 读路径。
//
// 为什么响应**不是**裸 ConversationSnapshot：ACodeTaskMeta 有 7 个必填字段，而
// conversationSnapshotSchema 的顶层**没有** traceId / workspacePath / createdAt / updatedAt
// 四个身份字段（实测 snapshot.ts:524-560）。裸快照只能供出 7 个必填里的 4 个，无法构造合法
// TaskMeta。故响应是「身份信封 + 投影字段」的合成体，身份事实由 handler 从持久层读来填入。
//
// 字段集纪律（spec R8）：与 legacy acodeSessionSnapshotToTaskMeta 的产出**逐字 parity**，
// 不多不少。刻意不含 titleOverridden / forkedFromTaskId / lastError——legacy 映射器不产出前两者，
// 后者的权威源是 runtime 投影（持久层无等价权威，spec R11）。多产出会让冷/热两条路径的
// areResolvedTaskMetasEqual（15 字段等价判定）永远不成立 → header 抖动。
import { z } from "zod";
// ACODE_AGENT_PROVIDER 的唯一定义在 acode-agent-policy.ts（实测），不在 acode-task-types-core.ts；
// ModelSelection 在 model-selection.ts（command.ts 同样从该叶子 import，既有先例）。
// 依赖方向是 DAG：本叶子 → acode-agent-policy → acode-task-types-core（type-only），无环。
import { ACODE_AGENT_PROVIDER } from "../acode-agent-policy.js";
import type { ModelSelection } from "../model-selection.js";
import type {
  ACodeProvider,
  ACodeTaskGoal,
  ACodeTaskMeta,
  ACodeTaskMode,
} from "../acode-task-types-core.js";
import { timestampSchema } from "./core.js";

/**
 * params **只有 sessionId**——与 legacy acodeSessionReadParamsSchema 的定域模型逐字一致
 * （实测 index.ts:1586-1593：sessionId + deliveryKind/messageLimit/afterSeq，无 workspace 字段）。
 * 不加服务端 workspace 闸的三条理由见 spec §4.2：① workspace 边界由进程拓扑承担（一个 CLI
 * agent 子进程绑一个 workspace，其 session 库路径由 configResult 派生）；② UI 侧定域发生在
 * 「选哪个 client」那层；③ 在 params 里再比一次路径会引入假阴性（路径归一化差异就能让合法读取
 * 判成 notFound——core/runtime/methods/events.ts:579-582 记载过这类末尾 `/` 漂移事故）。
 */
export const v4SessionHeaderMetaParamsSchema = z
  .strictObject({
    sessionId: z.string().min(1),
  });
export type V4SessionHeaderMetaParams = z.infer<typeof v4SessionHeaderMetaParamsSchema>;

/**
 * goal 的 wire 形态：字段与 ACodeTaskGoal 逐一对应（spec R12）。持久 SessionGoal
 * （contracts/src/tools/target.ts:46-63）与 ACodeTaskGoal 字段名/类型/值域都相同，故零转换直通。
 */
const sessionHeaderGoalSchema = z.strictObject({
  sessionID: z.string(),
  targetID: z.string(),
  objective: z.string(),
  summaryTitle: z.string().nullable(),
  status: z.enum(["active", "paused", "budget_limited", "complete"]),
  tokenBudget: z.number().int().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: z.string().nullable().optional(),
  activeRunStartedAtMs: z.number().nullable().optional(),
  activeRunLastSeenAtMs: z.number().nullable().optional(),
  time: z.strictObject({
    created: timestampSchema,
    updated: timestampSchema,
  }),
});

/**
 * header meta 的 wire schema = legacy 14 字段集的子集（不含 lastError，spec R11）。
 * `provider` 用字面量 enum 而不是 z.string()：ACodeProvider 实测是字面量类型 "glm"
 * （acode-task-types-core.ts:40），窄 schema 能在编译期钉住「不产出未知 provider」。
 */
export const v4SessionHeaderMetaSchema = z.strictObject({
  taskId: z.string().min(1),
  traceId: z.string().min(1),
  title: z.string(),
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().min(1).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  mode: z.enum(["yolo", "plan", "edit", "auto", "autoEdit", "build", "dontAsk"]),
  model: z.string().optional(),
  thoughtLevel: z.string().optional(),
  provider: z.enum(["glm"]),
  status: z.enum(["running", "completed", "error"]).optional(),
  target: sessionHeaderGoalSchema.nullable().optional(),
});
export type V4SessionHeaderMeta = z.infer<typeof v4SessionHeaderMetaSchema>;

/**
 * result：判别字段 `found` 表达「查无此会话」，**不抛协议错误**（spec R4）。
 * 归档 ID 已被清理 + 列表数据源缺席是正常竞态（现有 UI 的 .catch(()=>setSnapshotMeta(null))
 * 就是这个语义），用错误码表达会让正常竞态在日志里刷 warn。
 */
export const v4SessionHeaderMetaResultSchema = z.strictObject({
  found: z.boolean(),
  meta: v4SessionHeaderMetaSchema.optional(),
});
export type V4SessionHeaderMetaResult = z.infer<typeof v4SessionHeaderMetaResultSchema>;

/**
 * 投影的**结构化窄输入**（spec §4.3）。
 *
 * 为什么不吃 SessionInfo / SessionEntryInfo / SessionGoal：packages/shared 的依赖只有
 * @acode/model-option-map 与 zod，**拿不到** @acode/contracts（CLI 侧包）。让 shared 叶子吃
 * CLI 类型要么引入非法依赖方向，要么在 shared 里复制一份 CLI 类型（重复状态，AGENTS.md 禁止）。
 * 故由 bootstrap handler 负责把持久层事实收窄成这个纯字面量形状——「哪些持久事实参与投影」
 * 在 handler 一处可见，本叶子保持零 CLI 依赖、可离线单测。
 */
export interface SessionHeaderMetaSource {
  sessionId: string;
  title: string;
  /** 持久 traceID；缺席时投影回落确定性派生（spec R5）。 */
  traceId: string | undefined;
  /** SessionInfo.path ?? SessionInfo.directory。 */
  workspacePath: string;
  /** SessionInfo.workspaceID。 */
  workspaceIdentity: string | undefined;
  createdAt: number;
  updatedAt: number;
  /** SessionInfo.permission?.mode；值域是 ACodeTaskMode 的子集（spec R9，实测）。 */
  permissionMode: string | undefined;
  /** 持久 model_selection entry（readSessionModelSelection 的产物）；缺席则 model/thought 缺席。 */
  modelSelection: ModelSelection | undefined;
  /** store.readTarget 的产物；已按 ACodeTaskGoal 形状收窄（字段同名同型，spec R12）。 */
  goal: ACodeTaskGoal | null | undefined;
}

/** mode 的合法值集（= ACodeTaskMode）；持久 CollaborationMode 是它的子集，故只需回落缺省。 */
const ACODE_TASK_MODE_SET = new Set<string>([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
  "dontAsk",
]);
/** mode 缺省档（spec R9，与 legacy fromACodeMode 的缺省一致）。 */
const DEFAULT_ACODE_TASK_MODE: ACodeTaskMode = "build";

/**
 * traceId 的确定性派生（spec R5）。
 *
 * 为什么不用 legacy 的 generateTraceId(sessionId)：它内部是 createUuid()，**每次调用都产新值**，
 * 使 UI 的 areResolvedTaskMetasEqual 永远判不等 → header 每次刷新都重渲。冷读必须可重复，
 * 故改为确定性派生，口径与既有 mapSessionSummaryToTaskMeta.ts:58 一致。
 */
function deriveDeterministicTraceId(sessionId: string): string {
  return `session-${sessionId}`;
}

/**
 * 纯投影：结构化窄输入 → header meta。无 IO、无 CLI 依赖、可离线单测。
 */
export function buildSessionHeaderMeta(source: SessionHeaderMetaSource): V4SessionHeaderMeta {
  const mode: ACodeTaskMode =
    source.permissionMode !== undefined && ACODE_TASK_MODE_SET.has(source.permissionMode)
      ? (source.permissionMode as ACodeTaskMode)
      : DEFAULT_ACODE_TASK_MODE;
  return {
    taskId: source.sessionId,
    traceId: source.traceId?.trim()
      ? source.traceId.trim()
      : deriveDeterministicTraceId(source.sessionId),
    title: source.title,
    workspacePath: source.workspacePath,
    ...(source.workspaceIdentity?.trim() ? { workspaceIdentity: source.workspaceIdentity.trim() } : {}),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    mode,
    // model/thoughtLevel 缺失即缺席，不补默认模型（spec R5/R10）：legacy 注释明写
    // 「未绑定是合法恢复状态；不能为满足协议而伪造模型」。
    ...(source.modelSelection
      ? {
          model: formatHeaderModelSelection(source.modelSelection),
          ...(source.modelSelection.options?.reasoningLevel
            ? { thoughtLevel: source.modelSelection.options.reasoningLevel }
            : {}),
        }
      : {}),
    provider: ACODE_AGENT_PROVIDER as ACodeProvider,
    // status 刻意缺席（spec R11）：legacy 权威源是 runtime 投影，持久层无等价权威；
    // 猜测会让归档任务显示错误运行态。由列表侧持久行 join 时决定。
    ...(source.goal !== undefined && source.goal !== null ? { target: source.goal } : {}),
  };
}

/** 与 UI 侧 formatModelPickerValue 同口径：`providerId/modelId`（+ reasoningLevel 时附后缀）。 */
function formatHeaderModelSelection(selection: ModelSelection): string {
  return selection.options?.reasoningLevel
    ? `${selection.providerId}/${selection.modelId}:${selection.options.reasoningLevel}`
    : `${selection.providerId}/${selection.modelId}`;
}

/**
 * 类型层 parity 钉法（spec §4.2 / 验收 H10）：断言 wire schema 的 infer 结果可赋值给
 * `Pick<ACodeTaskMeta, 同名字段>`。将来 ACodeTaskMeta 收窄、改名或改类型，这里会红，
 * 而不是让协议面与 UI 词汇静默漂移。用 `satisfies` 而非运行时断言，零开销。
 */
type HeaderMetaTaskMetaPick = Pick<
  ACodeTaskMeta,
  | "taskId"
  | "traceId"
  | "title"
  | "workspacePath"
  | "workspaceIdentity"
  | "createdAt"
  | "updatedAt"
  | "mode"
  | "model"
  | "thoughtLevel"
  | "provider"
  | "status"
  | "target"
>;
// 编译期校验：V4SessionHeaderMeta 必须是 HeaderMetaTaskMetaPick 的子类型（字段名+类型一致）。
// 这行不产生运行时代码，只让 tsc 在本文件里证明两者兼容——将来 ACodeTaskMeta 收窄/改名/改类型，
// 这条赋值断言会红，而不是让协议面与 UI 词汇静默漂移。
// 注：status 用 z.enum(["running","completed","error"])，与 ACodeTaskPersistStatus 联合逐字一致；
// mode 的 z.enum 与 ACodeTaskMode 同理——两者的值域一致性由这条 Pick 赋值断言在编译期一并钉住
// （若某个字面量增删导致 V4SessionHeaderMeta 不再是 Pick 的子类型，赋值即报错）。
export const sessionHeaderMetaIsTaskMetaCompatible: (
  meta: V4SessionHeaderMeta,
) => HeaderMetaTaskMetaPick = (meta) => meta;
