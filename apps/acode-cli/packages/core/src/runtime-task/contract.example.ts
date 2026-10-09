import {
  InMemoryRuntimeTaskRegistry,
  formatTaskNotification,
  type RuntimeTaskRegistry,
} from "./contract.js";

/** 编译验证实现满足唯一 Registry port；示例不自动执行、不读时钟或触发 IO。 */
export function runtimeTaskContractExample(
  registry: RuntimeTaskRegistry = new InMemoryRuntimeTaskRegistry(),
): string {
  registry.register({
    taskId: "example-task",
    agentId: "example-agent",
    agentType: "general-purpose",
    description: "contract example",
    startedAt: new Date(0),
    status: "running",
    type: "local_agent",
  });
  registry.update("example-task", (task) => ({ ...task, status: "completed" }));
  const task = registry.get("example-task");
  return formatTaskNotification({
    taskId: "example-task",
    taskType: "local_agent",
    status: task?.status ?? "lost",
    summary: "The registry owns the terminal fact.",
  });
}
