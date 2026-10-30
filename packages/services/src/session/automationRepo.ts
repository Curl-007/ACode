// automation 仓库 facade（2026-10-30 拆分）：导出面与原 automationRepo.ts 逐名一致，
// 消费方（contract.ts / tasksDatabase startup / 测试）导入路径零改动。
// 实现按职责拆进 automation/ 子目录的 Node-only 分段（单继承链共享同一库连接，
// 不复制状态、不新增写入路径）：
//   automationRows.ts            行形状 / 行映射器 / model selection 序列化（纯）
//   automationDispatchPolicy.ts  退避常量 / 创建上限错误 / computeRetryAt（纯）
//   automationRepoBase.ts        连接生命周期 + getRow/writeRow（node:sqlite 边所在）
//   automationRepoCrud.ts        管理面 CRUD
//   automationRepoClaiming.ts    single-flight 认领（claimDue/runNow/claimManualRuns）
//   automationRepoDispatch.ts    派发结算与跳过（markDispatched/markDispatchFailed/...）
//   automationRepoRuns.ts        运行历史 automation_runs 台账与保留策略
import { AutomationRepoRuns } from "#src/session/automation/automationRepoRuns.js";

/**
 * automation 存储仓库：automations（定义 + 调度状态）与 automation_runs（运行历史 + runId 幂等台账），
 * 与 task index 同库 tasks-index.sqlite（WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移；cron 表达式解析 / next_run_at 计算由调用方（scheduler / 管理层）
 * 用 cron 库算好后传入，仓库不感知 cron 语义。
 */
export class AutomationRepo extends AutomationRepoRuns {}

export {
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  AutomationCreateLimitError,
  computeRetryAt,
} from "#src/session/automation/automationDispatchPolicy.js";
