import type { Event } from "@acode/rpc";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type PromptAttachmentTransferPhase = "uploading" | "committing" | "complete" | "canceled";

export interface PromptAttachmentTransferProgress {
  operationId: string;
  phase: PromptAttachmentTransferPhase;
  uploadedBytes: number;
  totalBytes: number;
}

export interface PromptAttachmentStageParams {
  operationId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  localPath: string;
  fileName: string;
  mime: string;
  sizeBytes?: number;
}

export interface PromptAttachmentStageResult {
  operationId: string;
  ref: string;
  bytes: number;
  staged: boolean;
}

/**
 * Renderer 只消费这个 host 服务，不直接依赖 SSH/WSL/Docker backend。
 * 本地 host 返回零拷贝路径，remote host wrapper 则先完成跨机暂存。
 */
export interface IPromptAttachmentTransferService {
  stage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult>;
  adopt(operationId: string): Promise<void>;
  cancel(operationId: string): Promise<void>;
  cleanup(operationId: string): Promise<void>;
  onDynamicProgress(operationId: string): Event<PromptAttachmentTransferProgress>;
}

export const IPromptAttachmentTransferService =
  createServiceDescriptor<IPromptAttachmentTransferService>(
    ServiceChannels.PromptAttachmentTransfer,
    {
      allowedMethods: ["stage", "adopt", "cancel", "cleanup", "onDynamicProgress"],
      argumentValidators: {
        stage: (args) => {
          const params = requireParams(args);
          requireNonEmptyString(params.operationId, "operationId");
          requireNonEmptyString(params.sessionId, "sessionId");
          requireString(params.workspacePath, "workspacePath");
          requireOptionalString(params.workspaceIdentity, "workspaceIdentity");
          requireOptionalString(params.remoteSessionId, "remoteSessionId");
          requireString(params.localPath, "localPath");
          requireNonEmptyString(params.fileName, "fileName");
          requireString(params.mime, "mime");
          requireOptionalNumber(params.sizeBytes, "sizeBytes");
        },
        adopt: (args) => requireOperationId(args),
        cancel: (args) => requireOperationId(args),
        cleanup: (args) => requireOperationId(args),
        // 动态事件订阅参数：与 terminal.ts onDynamicData 相同的校验方式。
        onDynamicProgress: (args) => {
          if (args.length !== 1 || typeof args[0] !== "string") {
            throw new Error("expected operation id");
          }
        },
      },
    },
  );

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireOperationId(args: readonly unknown[]): void {
  if (args.length !== 1) throw new Error("expected one operation id");
  requireNonEmptyString(args[0], "operationId");
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireOptionalNumber(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`invalid ${field}`);
  }
}
