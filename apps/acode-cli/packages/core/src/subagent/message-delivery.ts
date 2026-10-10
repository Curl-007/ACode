import type { RuntimeTaskPendingMessage, RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/contract.js";

// 挂起消息的 sink 投递**单一实现**（specs/agent-peer-messaging.md R4「复用既有三语义，
// 不新增命令种类」）：父→子 SendMessage 与 peer→兄弟共用本函数，两条路径的投递语义
// 永不各自漂移。有 sink 即 steer；send 失败（含 no_active_turn 重试耗尽）或 sink 缺席
// → queued 回队——queued 的补投由 turn 起点 drain 钩子承担
// （specs/subagent-pending-message-drain.md R1，Phase 3 的阻塞前置正是它）。
export async function deliverPendingMessageViaSink(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<"queued" | "steered"> {
  if (task.messageSink) {
    try {
      return await task.messageSink.send(message);
    } catch {
      registry.queueMessage(task.taskId, message);
      return "queued";
    }
  }
  registry.queueMessage(task.taskId, message);
  return "queued";
}
