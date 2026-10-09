import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncFirstRunPromptState,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncSelection,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToAcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  markFirstRunPromptHandled(): Promise<void>;
}

export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
  {
    allowedMethods: [
      "getClaudeAgentsFileMigrationStatus",
      "copyClaudeAgentsFileToAcodeAgentsFile",
      "detect",
      "importSelected",
      "getFirstRunPromptState",
      "markFirstRunPromptHandled",
    ],
    argumentValidators: {
      getClaudeAgentsFileMigrationStatus: (args) => {
        // request 字段全部可选；只校验对象形态。
        requireParams(args);
      },
      copyClaudeAgentsFileToAcodeAgentsFile: (args) => {
        // request 可选；显式传 undefined 与不传等价。
        if (args.length > 1) throw new Error("expected at most one request object");
        if (args[0] === undefined) return;
        const request = requireRecordField(args[0], "request");
        requireOptionalString(request.workspacePath, "workspacePath");
        requireOptionalString(request.workspaceIdentity, "workspaceIdentity");
        requireOptionalBoolean(request.overwrite, "overwrite");
      },
      detect: (args) => {
        const request = requireParams(args);
        requireOptionalString(request.workspacePath, "workspacePath");
        requireOptionalString(request.workspaceIdentity, "workspaceIdentity");
        if (request.categories !== undefined && !Array.isArray(request.categories)) {
          throw new Error("invalid categories");
        }
        requireOptionalString(request.intent, "intent");
      },
      importSelected: (args) => {
        const request = requireParams(args);
        requireOptionalString(request.workspacePath, "workspacePath");
        requireOptionalString(request.workspaceIdentity, "workspaceIdentity");
        // selections 元素为 SettingsSyncSelection 对象；成员级字段由导入实现校验。
        requireRecordArray(request.selections, "selections");
        // onProgress 为本地直调回调：RPC JSON 序列化不传输函数，显式传 undefined 与缺省等价。
        const onProgress = request.onProgress;
        if (onProgress !== undefined && typeof onProgress !== "function") {
          throw new Error("invalid onProgress");
        }
      },
      getFirstRunPromptState: (args) => requireNoArguments(args),
      markFirstRunPromptHandled: (args) => requireNoArguments(args),
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

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireRecordArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => isRecord(item))) {
    throw new Error(`invalid ${field}`);
  }
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
