import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。
 * dontAsk（无人值守档，permission-adjudication-batch2 R1）随权限批 2 进入用户可提交集，
 * 与 v4 switchCollaborationMode 枚举及 CollaborationMode 联合保持一致。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "dontAsk"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
