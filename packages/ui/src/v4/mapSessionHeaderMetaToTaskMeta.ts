// v4 归档 header 冷读的 meta → ACodeTaskMeta 映射（apps/acode-cli/specs/v4-session-header-meta.md §4.4）。
//
// 这是 M1 迁移里 useActiveTaskSnapshotMeta 的新投影：替代 legacy
// `acodeSessionSnapshotToTaskMeta(acodeSessionStateSnapshot)`。输入是 v4 header meta
// （身份信封 + 投影字段的合成体，见 shared 叶子 session-header-meta.ts），输出与 legacy 逐字段
// parity（14 项子集，spec R8）——故 useActiveTaskSnapshotMeta 的下游消费面（渲染 5 字段 +
// areResolvedTaskMetasEqual 15 字段等价判定）语义完全不变。
//
// 与 mapSessionSummaryToTaskMeta 的区别（不合并，见 spec §4.4）：
//   • 那个吃 sessions-index 的 SessionSummary（列表实时 detail），summary **不带** workspace 事实，
//     必须靠 options.workspacePath + previous?.traceId **外部注入**，还要用 previous 保留手动标题；
//   • 这个吃冷读 header meta，meta **已含** workspacePath/workspaceIdentity/traceId（服务端从持久
//     SessionInfo 填好），故映射器是纯字段搬运，**无需 options、无需 previous**。
// 合并两者会把「是否需要外部注入身份」「标题权威是 previous 还是持久 titleSource」两组不同判据
// 塞进一个函数，引入分支耦合。
import type { ACodeProvider, ACodeTaskMeta, TraceId } from "@acode/shared";
import type { V4SessionHeaderMeta } from "@acode/shared/acode-protocol-v4";

/**
 * header meta → ACodeTaskMeta。纯函数、无 IO。
 *
 * 只搬运 meta 已有的字段；meta 缺席的可选字段（model/thoughtLevel/workspaceIdentity/status/target）
 * 在产出里同样缺席，不补默认（spec R5/R11：不伪造缺失事实）。`provider` 直接取 meta.provider
 * （wire schema 已把它约束成 ACodeProvider 字面量 "glm"）。
 *
 * traceId 是 meta 里的确定性派生值（session-<id>，非每次新 UUID，spec R5），故本映射对同输入
 * 幂等——这正是 useActiveTaskSnapshotMeta 的 areResolvedTaskMetasEqual 成立、header 不抖的前提。
 */
export function mapSessionHeaderMetaToTaskMeta(meta: V4SessionHeaderMeta): ACodeTaskMeta {
  return {
    taskId: meta.taskId,
    traceId: meta.traceId as TraceId,
    title: meta.title,
    workspacePath: meta.workspacePath,
    ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    mode: meta.mode,
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.thoughtLevel ? { thoughtLevel: meta.thoughtLevel } : {}),
    provider: meta.provider as ACodeProvider,
    ...(meta.status ? { status: meta.status } : {}),
    ...(meta.target !== undefined && meta.target !== null ? { target: meta.target } : {}),
  };
}
