export { prepareTasksIndexStorage } from "#src/session/tasksDatabase/startup.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultACodeAgentCommand } from "#src/acode-agent/acodeAgentProcessManager.js";
// R6（host-startup-storage-cwd.md）：storage 入口解析独立于会话命令解析且不吃 env 覆盖。
// 桌面 Host 的 prepareSessionStorage 必须用这个，不能用上面那个的返回值。
export {
  resolveACodeStoragePreparationEntry,
  describeStorageEntryResolutionFailure,
  type ACodeStoragePreparationEntry,
} from "#src/acode-agent/storageEntryResolver.js";
export { resolveACodeAgentSpawnCwd } from "#src/acode-agent/acodeAgentSpawnCwd.js";
