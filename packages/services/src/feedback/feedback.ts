import type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import type { Event } from "@acode/rpc";
import { createServiceDescriptor } from "../descriptors.js";

export interface FeedbackUploadProgress {
  id: string;
  phase: "preparing" | "uploading" | "complete" | "canceled";
  uploadedBytes: number;
  totalBytes: number;
}

export interface FeedbackCreateOptions {
  operationId?: string;
}

export interface IFeedbackService {
  create(
    input: CreateFeedbackTicketInput,
    options?: FeedbackCreateOptions,
  ): Promise<FeedbackTicketDetail>;
  cancelCreate(operationId: string): Promise<void>;
  list(query?: FeedbackListQuery): Promise<FeedbackListResult>;
  get(id: string): Promise<FeedbackTicketDetail>;
  comment(id: string, body: string): Promise<FeedbackComment>;
  uploadAttachment(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
  ): Promise<FeedbackAttachment>;
  uploadAttachmentWithProgress(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
    progressId: string,
  ): Promise<FeedbackAttachment>;
  cancelUpload(progressId: string): Promise<void>;
  onDynamicUploadProgress(id: string): Event<FeedbackUploadProgress>;
  uploadAttachmentData(
    id: string,
    kind: FeedbackAttachmentKind,
    file: {
      dataBase64: string;
      filename: string;
      contentType: string;
      messageId?: string;
    },
  ): Promise<FeedbackAttachment>;
  attachLogsFromExport(id: string, options?: { full?: boolean }): Promise<FeedbackAttachment>;
  getDeviceSnapshot(): Promise<import("@acode/shared").FeedbackDeviceInfo>;
  prepareCompactLogArchive(options?: { full?: boolean; progressId?: string }): Promise<{
    path: string;
    size: number;
  }>;
  cleanupPreparedLogArchive(path: string): Promise<void>;
  revealLogArchive(path: string): Promise<void>;
}

export const IFeedbackService = createServiceDescriptor<IFeedbackService>(
  ServiceChannels.Feedback,
  {
    allowedMethods: [
      "create",
      "cancelCreate",
      "list",
      "get",
      "comment",
      "uploadAttachment",
      "uploadAttachmentWithProgress",
      "cancelUpload",
      "onDynamicUploadProgress",
      "uploadAttachmentData",
      "attachLogsFromExport",
      "getDeviceSnapshot",
      "prepareCompactLogArchive",
      "cleanupPreparedLogArchive",
      "revealLogArchive",
    ],
    argumentValidators: {
      // 写入入口 create：input 必填对象、options 可选；只做顶层形态检查，
      // title/description/type 等业务字段的完整校验留在 service 层。
      create: (args) => {
        if (args.length < 1 || args.length > 2) {
          throw new Error("expected input and optional options");
        }
        const input = args[0];
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error("expected feedback input object");
        }
        optionalObjectArg(args, 1);
      },
      cancelCreate: (args) => requireStringArg(args, "invalid operationId"),
      list: (args) => optionalSingleObjectArg(args),
      get: (args) => requireStringArg(args, "invalid id"),
      comment: (args) => {
        if (args.length !== 2) throw new Error("expected id and body");
        if (typeof args[0] !== "string" || args[0].length === 0) throw new Error("invalid id");
        if (typeof args[1] !== "string") throw new Error("invalid body");
      },
      uploadAttachment: (args) => {
        requireIdKind(args, 3);
        requireFileWithPath(args[2]);
      },
      uploadAttachmentWithProgress: (args) => {
        requireIdKind(args, 4);
        requireFileWithPath(args[2]);
        if (typeof args[3] !== "string" || args[3].length === 0) {
          throw new Error("invalid progressId");
        }
      },
      cancelUpload: (args) => requireStringArg(args, "invalid progressId"),
      // 动态事件：listen 传入单一 id（对齐 terminal 动态事件）。
      onDynamicUploadProgress: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
          throw new Error("expected progress id");
        }
      },
      uploadAttachmentData: (args) => {
        requireIdKind(args, 3);
        // file 携带 dataBase64/filename/contentType（内容字段）；保持宽容只校验对象形态。
        const file = args[2];
        if (!file || typeof file !== "object" || Array.isArray(file)) {
          throw new Error("expected a file object");
        }
      },
      attachLogsFromExport: (args) => {
        if (args.length < 1 || args.length > 2) {
          throw new Error("expected id and optional options");
        }
        if (typeof args[0] !== "string" || args[0].length === 0) throw new Error("invalid id");
        optionalObjectArg(args, 1);
      },
      getDeviceSnapshot: (args) => requireNoArguments(args),
      prepareCompactLogArchive: (args) => optionalSingleObjectArg(args),
      cleanupPreparedLogArchive: (args) => requireStringArg(args, "invalid path"),
      revealLogArchive: (args) => requireStringArg(args, "invalid path"),
    },
  },
);

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function requireStringArg(args: readonly unknown[], message: string): void {
  if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
    throw new Error(message);
  }
}

function optionalObjectArg(args: readonly unknown[], index: number): void {
  if (args.length <= index) return;
  const value = args[index];
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an optional parameter object");
  }
}

function optionalSingleObjectArg(args: readonly unknown[]): void {
  if (args.length > 1) throw new Error("expected at most one argument");
  optionalObjectArg(args, 0);
}

function requireIdKind(args: readonly unknown[], expectedLength: number): void {
  if (args.length !== expectedLength) {
    throw new Error(`expected ${expectedLength} arguments`);
  }
  if (typeof args[0] !== "string" || args[0].length === 0) throw new Error("invalid id");
  if (typeof args[1] !== "string" || args[1].length === 0) throw new Error("invalid kind");
}

function requireFileWithPath(file: unknown): void {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("expected a file object");
  }
  const path = (file as Record<string, unknown>).path;
  if (typeof path !== "string" || path.length === 0) throw new Error("invalid file path");
}
