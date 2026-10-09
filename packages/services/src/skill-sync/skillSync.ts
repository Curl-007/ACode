import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillSyncService {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
  {
    allowedMethods: [
      "listLocalUserSkillCandidates",
      "listRemoteUserSkillStatuses",
      "exportSkillsArchive",
      "checkRemoteUserSkillWriteAccess",
      "importSkillsArchive",
    ],
    argumentValidators: {
      listLocalUserSkillCandidates: (args) => requireNoArguments(args),
      listRemoteUserSkillStatuses: (args) => {
        const params = requireParams(args);
        requireStringArray(params.directoryNames, "directoryNames");
        // skills 可选；元素为 { directoryName, name } 对象，成员级差异由实现校验。
        const skills = params.skills;
        if (skills !== undefined) {
          if (
            !Array.isArray(skills) ||
            !skills.every(
              (skill) =>
                isRecord(skill) &&
                typeof skill.directoryName === "string" &&
                typeof skill.name === "string",
            )
          ) {
            throw new Error("invalid skills");
          }
        }
      },
      exportSkillsArchive: (args) => {
        const params = requireParams(args);
        requireStringArray(params.skillIds, "skillIds");
      },
      checkRemoteUserSkillWriteAccess: (args) => requireNoArguments(args),
      importSkillsArchive: (args) => {
        const params = requireParams(args);
        requireBinaryArchive(params.archive, "archive");
        // 类型只允许字面量 false：显式传 true 属契约违规，边界直接拒绝。
        if (params.overwrite !== undefined && params.overwrite !== false) {
          throw new Error("invalid overwrite");
        }
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

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

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`invalid ${field}`);
  }
}

function requireBinaryArchive(value: unknown, field: string): void {
  // 归档在线上是嵌套 Uint8Array：RPC 序列化会在接收端还原为真实二进制视图
  // （rpc serialization.ts 的 encode/decodeRpcJsonValue）。这里放宽到 ArrayBuffer.isView，
  // 避免跨 realm 的 instanceof 差异造成误拒；归档字节合法性由服务解压实现校验。
  if (!ArrayBuffer.isView(value)) throw new Error(`invalid ${field}`);
}
