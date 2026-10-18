// 脚本工作流管理面命令组：listScriptWorkflowRuns / listScriptWorkflowDefinitions。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §4/§8.2。
// 每个命令组一个文件：handler 纯函数 (host, envelope) → CommandResult|undefined。
//
// 两个命令都是**纯只读**：不写任何行、不触发孤儿收敛、不碰 owner lease；幂等由存储层
// 天然保证（同一时刻重复查询同一快照）。错误面：能力缺席 → V4CapabilityUnsupportedError；
// store 读失败 → error 上行进 ack.message（查询失败不伪造空列表——空列表和「读不到」
// 是两个事实，UI 文案要能区分：空态引导创作，错误态引导重试）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@acode/shared/acode-protocol-v4";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

async function listScriptWorkflowRuns(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["listScriptWorkflowRuns"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.listScriptWorkflowRuns) {
    throw new V4CapabilityUnsupportedError("listScriptWorkflowRuns", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  // 数据本身是 workspace 级（按 workspacePath 精确过滤），锚会话只是路由键。
  return await record.app.listScriptWorkflowRuns({
    cwd: payload.workspace.workspacePath,
    ...(payload.limit === undefined ? {} : { limit: payload.limit }),
    ...(payload.statuses === undefined ? {} : { statuses: payload.statuses }),
  });
}

async function listScriptWorkflowDefinitions(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.listScriptWorkflowDefinitions) {
    throw new V4CapabilityUnsupportedError("listScriptWorkflowDefinitions", record.app.sessionId);
  }
  return await record.app.listScriptWorkflowDefinitions();
}

export const scriptWorkflowManagementHandlers = {
  listScriptWorkflowRuns,
  listScriptWorkflowDefinitions,
};
