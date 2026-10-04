// ============================================================
// ApplyPatch Tool - Structured patch editing tool
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { EditDiffHunkSchema, type DiffHunk } from "./edit.js";
import { toToolJsonSchema } from "./json-schema.js";

export const ApplyPatchInputSchema = z
  .object({
    patch_text: z.string().describe("The full structured patch text to apply"),
  })
  .strict();

export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export const ApplyPatchInputJsonSchema = toToolJsonSchema(ApplyPatchInputSchema);

export const ApplyPatchFileChangeSchema = z
  .object({
    filePath: z.string(),
    type: z.enum(["add", "update", "delete", "move"]),
    movePath: z.string().optional(),
    structuredPatch: z.array(EditDiffHunkSchema),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

export interface ApplyPatchFileChange {
  filePath: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  structuredPatch: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ApplyPatchOutput {
  files: ApplyPatchFileChange[];
  structuredPatch: DiffHunk[];
  summary: string;
}

export const ApplyPatchOutputSchema = z
  .object({
    files: z.array(ApplyPatchFileChangeSchema),
    structuredPatch: z.array(EditDiffHunkSchema),
    summary: z.string(),
  })
  .strict();

export const ApplyPatchOutputJsonSchema = toToolJsonSchema(ApplyPatchOutputSchema);

export interface ApplyPatchToolCall {
  id: ToolCallId;
  name: "ApplyPatch";
  input: ApplyPatchInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface ApplyPatchToolResult {
  toolCallId: ToolCallId;
  output: ApplyPatchOutput;
  traceId: TraceId;
  durationMs: number;
}

// 修订依据（批次 4/S2，specs/apply-patch-tool.md R3）：原字符串码值随悬空 contract 遗留、
// 全仓零消费者；而 ToolHandlerFailure.errorCode 全仓为 number（executor/errors.ts 强校验
// typeof === "number"）。落地 handler 时改为数字码，语义与 EditErrorCode 同值对齐
// （FILE_NOT_EXIST=4、NOTEBOOK_FILE=5、FILE_NOT_READ=6、STALE_FILE=7、FILE_TOO_LARGE=10、
// INVALID_PATH=13），跨工具同语义同码。
export const ApplyPatchErrorCode = {
  INVALID_PATCH: 1,
  EMPTY_PATCH: 2,
  FILE_EXISTS: 3,
  FILE_NOT_EXIST: 4,
  NOTEBOOK_FILE: 5,
  FILE_NOT_READ: 6,
  STALE_FILE: 7,
  HUNK_NOT_FOUND: 8,
  AMBIGUOUS_HUNK: 9,
  FILE_TOO_LARGE: 10,
  IO_ERROR: 11,
  INVALID_PATH: 13,
} as const;

export type ApplyPatchErrorCode = (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode];
