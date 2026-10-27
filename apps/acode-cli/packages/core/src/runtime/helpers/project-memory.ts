import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    workspacePath,
  });
}

function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    // overnight 隐藏 coordinator 沿用父会话语义（specs/overnight-execution.md R1：mode/分级
    // 不因挂机放宽），项目记忆与 "fork" 同档保持启用——它的 taskType 只是为了侧栏可见性
    // 而与 "fork" 区分，不改变运行期能力面。
    taskType === "overnight_coordinator" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
