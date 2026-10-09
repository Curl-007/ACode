// Dynamic Workflow Run Port：结构化失败类型（叶子文件）。
// 架构断环（specs/architecture-contracts-module.md）：这两个接口原住在
// dynamic-workflow-run.port.ts，而 dynamic-workflow-run-workspace.port.ts 的两个
// 字段引用 DynamicWorkflowRunError、主文件又 `export type * from` workspace 文件，
// 构成两文件级 import 环。下沉到本叶子文件断环；主文件原样再导出，
// `@acode/contracts` 的导入路径与导出面逐名不变。

/** 结构化失败。`code` 是稳定判别键——模型必须能分辨「进程死了」与「脚本真失败」。 */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** 只在 `code === "ProviderStop"` 时在场（引擎 `ProviderStopDetails` 的 JSON 镜像）。 */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** `ProviderStop` 的结构化明细（引擎 `ProviderStopDetails` 的镜像，端口只承载 JSON 形状）。 */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}
