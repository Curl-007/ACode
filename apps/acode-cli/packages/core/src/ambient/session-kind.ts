// 机制参照 jcode (MIT)：crates/jcode-ambient-types（UsageLog 的 user/ambient 双 kind），
// 自撰 TypeScript 实现（apps/acode-cli/specs/ambient-budget-scheduler.md R1）。
//
// kind 区分是预算公式的前提：ambient 自身消耗必须从「用户 1h 速率」里剔除，
// 否则 ambient 跑得越多、预算越紧，最终把自己饿死（正反馈死锁）。
//
// 「当前会话是否 ambient」的判定：runtime config 的既有字段面没有 ambient 标记
// （AgentRuntimeConfig 扩展不在本批写面），而 ambient fork 出的周期任务 runtime 与
// 用户会话 runtime 同进程共存——因此用模块级标记登记面：fork 端口绑定处（bootstrap
// 装配）在创建 ambient runtime 时调用 markAmbientSession(sessionId)，turn 计量旁路写
// 处用 isAmbientSession(sessionId) 判定 kind。标记的生命周期 = 进程（fork runtime
// 不跨进程迁移），与 AdaptiveScheduler 状态的进程生命周期（R5 状态表）一致。

const ambientSessionIds = new Set<string>();

/** fork 端口绑定处登记：该 session 的 turn 用量按 kind="ambient" 记账。 */
export function markAmbientSession(sessionId: string): void {
  ambientSessionIds.add(sessionId);
}

export function isAmbientSession(sessionId: string): boolean {
  return ambientSessionIds.has(sessionId);
}

/** 测试隔离用：清空进程内标记（生产路径不调用）。 */
export function clearAmbientSessionMarkers(): void {
  ambientSessionIds.clear();
}

export type AmbientUsageKind = "user" | "ambient";
