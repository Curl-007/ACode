import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory, {
  allowedMethods: ["listProjectMemories", "readProjectMemoryFile"],
  argumentValidators: {
    listProjectMemories: (args) => requireNoArguments(args),
    readProjectMemoryFile: (args) => {
      const params = requireParams(args);
      // workspaceId/fileName 为定位标识：空值属明显异常。
      // 路径包含性（防越界）由 MemoryService 实现校验，边界只挡畸形形状。
      requireNonEmptyString(params.workspaceId, "workspaceId");
      requireNonEmptyString(params.fileName, "fileName");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected one params object");
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}
