/* off-peak 创建入口的校验与失败分类：权限档门（手写闭集，须与 shared
   acodeTaskModeSchema 同步）、参数形状检查与 ticket_request/local_persist 等
   稳定失败分类。原为 offPeakTaskService.ts 模块级实现，拆分后供本体与编排叶子共用。 */
import { ZodError } from "zod";
import {
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ACodeOffPeakTaskCreateParams,
} from "@acode/shared";
import { OffPeakServerError } from "#src/session/offPeakServerClient.js";

export const VALID_CREATE_PERMISSION_MODES = new Set([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
  // dontAsk（权限批 2 R1，拒绝代替询问）：shared acodeTaskModeSchema / ACodeTaskMode
  // 已扩集该档，本门是手写字面副本，漏扩会让 Off-peak 表单选 dontAsk 保存被误判
  // client_validation（静默拒绝）。值域与 acodeTaskModeSchema 保持同步。
  "dontAsk",
]);

export function isValidCreateParams(params: ACodeOffPeakTaskCreateParams): boolean {
  return (
    typeof params.title === "string" &&
    params.title.trim().length > 0 &&
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    typeof params.workspacePath === "string" &&
    params.workspacePath.trim().length > 0 &&
    typeof params.permissionMode === "string" &&
    VALID_CREATE_PERMISSION_MODES.has(params.permissionMode)
  );
}

export function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") {
    errorCategory = "client_validation";
  } else if (failureStage === "local_persist") {
    errorCategory = "local_persist";
  } else if (error instanceof OffPeakServerError) {
    errorCode = error.biaCode === undefined ? "" : String(error.biaCode);
    if (error.biaCode === 3101) errorCategory = "eligibility_3101";
    else if (error.biaCode === 3103) errorCategory = "quota_3103";
  } else if (error instanceof ZodError) {
    errorCategory = "invalid_response";
  } else {
    // ticket client 内的 credential/RPC/fetch/abort 都可能以普通 Error 跨层抛出；
    // 它们仍属于 ticket_request，不能靠 raw message 猜测或泄漏服务端响应。
    errorCategory = "network";
  }
  return { failureStage, errorCategory, errorCode };
}

export const OFF_PEAK_SESSION_BOUND_FAILURE = {
  failureStage: "client_validation",
  errorCategory: "client_validation",
  errorCode: "session_bound",
} as const;
