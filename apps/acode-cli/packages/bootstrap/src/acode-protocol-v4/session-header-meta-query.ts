// v4 归档会话 header 冷读的 handler（apps/acode-cli/specs/v4-session-header-meta.md §4.3）。
//
// 实体放 v4 目录、server.ts 只留一行转发：server.ts 属于 M3 待搬迁的 legacy 目录，而它是
// **整个 agent 协议的唯一入口**（acode-protocol-entrypoint.ts:349 的 handleMessage 绑到
// ACodeProtocolAgentServer，同一 switch 里既有 59 个 legacy case 也有 31 个 v4 case）。
// 新增 v4 方法当前只能在那里接线；把实体放这里使 M3 搬迁时只需移动那一行 dispatch，
// 不在待删目录里新增实体债（对比 U08 provider 诊断把 431 行实体放进 legacy 目录，使 M3 范围 +2 文件）。
//
// 只读、无状态、**不激活会话**（spec R1/R2）：只走持久层，不经 getReadOnlyClient，
// 故不会为一次 header 兜底读拉起 agent runtime。
import type { SessionGoal, SessionId } from "@acode/contracts";
import type { ACodeTaskGoal } from "@acode/shared";
import {
  buildSessionHeaderMeta,
  v4SessionHeaderMetaParamsSchema,
  type SessionHeaderMetaSource,
  type V4SessionHeaderMetaResult,
} from "@acode/shared/acode-protocol-v4";
import { readSessionModelSelection } from "../app/session-store.js";
import { parseParams, type ACodeProtocolAgentServerContext } from "../acode-protocol/server-types.js";

/**
 * `SessionGoal`（contracts）与 `ACodeTaskGoal`（shared）字段名/类型/值域逐字相同
 * （spec R12 实测：sessionID/targetID/objective/summaryTitle/status/tokenBudget/tokensUsed/
 * timeUsedSeconds/activeInputId/activeRunStartedAtMs/activeRunLastSeenAtMs/time.{created,updated}），
 * 故 goal **零转换直通**——不需要 legacy fromACodeGoal 那套 snake_case 兼容与非法值回落
 * （那些分支对经 strict schema 校验的输入不可达，已由 ui 侧专测钉住）。
 * 这里显式列字段而不是整体断言，是为了让契约漂移在编译期暴露。
 */
function toTaskGoal(goal: SessionGoal): ACodeTaskGoal {
  return {
    sessionID: String(goal.sessionID),
    targetID: goal.targetID,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    ...(goal.activeInputId === undefined ? {} : { activeInputId: goal.activeInputId }),
    ...(goal.activeRunStartedAtMs === undefined
      ? {}
      : { activeRunStartedAtMs: goal.activeRunStartedAtMs }),
    ...(goal.activeRunLastSeenAtMs === undefined
      ? {}
      : { activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs }),
    time: { created: goal.time.created, updated: goal.time.updated },
  };
}

/**
 * 把持久层事实收窄成 shared 叶子的结构化窄输入（spec §4.3：shared 拿不到 @acode/contracts，
 * 故由本 handler 负责收窄，「哪些持久事实参与投影」在此一处可见）。
 */
function toHeaderMetaSource(input: {
  sessionId: string;
  session: {
    id: SessionId;
    title: string;
    traceID?: string;
    workspaceID?: string;
    path?: string;
    directory: string;
    permissionMode?: string;
    time: { created: number; updated: number };
  };
  modelSelection: SessionHeaderMetaSource["modelSelection"];
  goal: SessionGoal | null;
}): SessionHeaderMetaSource {
  return {
    sessionId: input.sessionId,
    title: input.session.title,
    traceId: input.session.traceID,
    // workspacePath 优先 path（协议入口路径），回落 directory——与 legacy 投影读
    // snapshot.session.workspace.workspacePath 同源，也与 events.ts:579-582 记载的
    // 「持久化必须保留协议入口路径」一致。
    workspacePath: input.session.path?.trim()
      ? input.session.path.trim()
      : input.session.directory,
    workspaceIdentity: input.session.workspaceID,
    createdAt: input.session.time.created,
    updatedAt: input.session.time.updated,
    permissionMode: input.session.permissionMode,
    modelSelection: input.modelSelection,
    goal: input.goal ? toTaskGoal(input.goal) : null,
  };
}

/**
 * `v4/session/headerMeta` 的实现：按 sessionId 读持久层，产 header meta 或结构化 notFound。
 *
 * **不用 `requireSession`**（spec R3）：那个 helper 要求 `context.sessions` 里有 live record，
 * 缺席即抛 sessionUnavailable——而本方法的存在理由正是归档任务不在任何实时数据源里。
 */
export async function querySessionHeaderMeta(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionHeaderMetaResult> {
  const params = parseParams(v4SessionHeaderMetaParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  if (!store) {
    // 无持久层（测试/极端形态）：按查无此会话处理，不抛错（spec R4 同一纪律）。
    return { found: false };
  }
  const sessionId = params.sessionId as SessionId;
  const session = await store.getSession(sessionId);
  if (!session) {
    // 归档 ID 已被清理 + 列表数据源缺席是正常竞态（UI 侧 .catch(()=>setSnapshotMeta(null))
    // 就是这个语义），故不抛协议错误、也不打 warn——避免正常竞态刷日志（spec R4）。
    return { found: false };
  }
  // 三个持久读取并发发出（互不依赖）。readSessionModelSelection 是 bootstrap 的规范读取器
  // （app/session-store.ts:54），吃 Pick<SessionStorePort,"sessionEntries">，返回
  // ModelSelection | undefined——不自写第二份 entry 解析（避免重复状态）。
  const [modelSelection, goal] = await Promise.all([
    readSessionModelSelection(store, sessionId),
    store.readTarget({ sessionID: sessionId }),
  ]);
  return {
    found: true,
    meta: buildSessionHeaderMeta(
      toHeaderMetaSource({
        sessionId: params.sessionId,
        session: {
          id: session.id,
          title: session.title,
          traceID: session.traceID,
          workspaceID: session.workspaceID,
          path: session.path,
          directory: session.directory,
          permissionMode: session.permission?.mode,
          time: session.time,
        },
        modelSelection,
        goal,
      }),
    ),
  };
}
