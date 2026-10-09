import type {
  GitCheckpointDiff,
  GitCheckpointDiffQuery,
  GitCheckpointMeta,
  GitCheckpointRequest,
  GitCheckpointRestoreQuery,
  GitCheckpointRestoreResult,
  GitRepositoryRequest,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IGitCheckpointService {
  createCheckpoint(params: GitRepositoryRequest): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: GitCheckpointDiffQuery): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: GitCheckpointRestoreQuery): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: GitCheckpointRequest): Promise<void>;
}

export const IGitCheckpointService = createServiceDescriptor<IGitCheckpointService>(
  ServiceChannels.GitCheckpoint,
  {
    allowedMethods: [
      "createCheckpoint",
      "diffCheckpoints",
      "restoreBetweenCheckpoints",
      "deleteCheckpoint",
    ],
    argumentValidators: {
      createCheckpoint: (args) => {
        requireGitRepositoryRequest(args);
      },
      diffCheckpoints: (args) => {
        const params = requireGitRepositoryRequest(args);
        requireNonEmptyString(params.fromCheckpointId, "fromCheckpointId");
        requireNonEmptyString(params.toCheckpointId, "toCheckpointId");
      },
      restoreBetweenCheckpoints: (args) => {
        const params = requireGitRepositoryRequest(args);
        requireNonEmptyString(params.fromCheckpointId, "fromCheckpointId");
        requireNonEmptyString(params.toCheckpointId, "toCheckpointId");
        requireOptionalBoolean(params.force, "force");
      },
      deleteCheckpoint: (args) => {
        const params = requireGitRepositoryRequest(args);
        requireNonEmptyString(params.checkpointId, "checkpointId");
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitRepositoryRequest：恰好一个参数对象，workspacePath 必选字符串。 */
function requireGitRepositoryRequest(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  requireString(value.workspacePath, "workspacePath");
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
