/**
 * OTel port 的对外类型（叶子类型文件，无任何运行时 import）。
 *
 * init.ts（静态图）需要向 bootstrap 暴露 handle.port 的类型，但不能 import
 * impl.ts——懒加载边界必须是物理边界。类型放这里，impl.ts 与 init.ts 共享。
 */
import type { AgentExecutionTelemetryPort } from "@acode/contracts";
import type { ModelRequestTelemetryRecorder } from "./model-request-fact.js";

/** OTel 实现的 port 面 = 契约 port + 模型请求事实收口（结构化能力探测）。 */
export type OtelAgentTelemetryPort = AgentExecutionTelemetryPort &
  ModelRequestTelemetryRecorder;
