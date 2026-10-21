import type { ToolDefinition } from "./registry.js";
import { captainTaskTools } from "./tasks-captain.js";
import { memberTaskTools } from "./tasks-progress.js";

/**
 * 任务工具集合（组合导出）：队长侧 create/amend/reassign 与成员侧 claim/update。
 * 拆分原因：合并单文件超仓库 400 行上限；两侧的鉴权模型本就不同（memberAllowed
 * 全 false vs 全 true），边界天然清晰。
 */
export const taskTools: readonly ToolDefinition[] = [...captainTaskTools, ...memberTaskTools];
