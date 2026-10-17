import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；dontAsk 为无人值守档
 * （permission-adjudication-batch2 R1）——此前缺位导致 --mode dontAsk 在提交
 * 规范化边界被 safeParse 静默丢弃回落 build（E2E 决策日志实证），扩集修复。 */
export const executionPermissionModeSchema = z.enum(["build", "edit", "yolo", "auto", "dontAsk"]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** 在接纳边界固定旧请求语义，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "build", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}
