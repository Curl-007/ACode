import type { ACodeProvider, SkillsPromptContext, SkillsListResult } from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** 将指定 skill 复制到通用目录（.acode/skills），成功后返回新 skill 的路径。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** 从通用目录中移除指定 skill（仅当 skill 位于 .acode/skills 时有效）。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 删除本地技能（仅 workspace/user 作用域；plugin 作用域拒绝）。
   * 删除技能所在目录，仅允许命中 .acode/skills 或 .agents/skills 根，越界则拒绝。
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills, {
  allowedMethods: [
    "list",
    "setEnabled",
    "buildPromptContext",
    "copyToCommon",
    "removeFromCommon",
    "deleteSkill",
  ],
  argumentValidators: {
    list: (args) => {
      const params = requireWorkspaceParams(args);
      requireOptionalString(params.provider, "provider");
    },
    setEnabled: (args) => {
      const params = requireWorkspaceParams(args);
      requireOptionalString(params.provider, "provider");
      requireOptionalString(params.scope, "scope");
      requireNonEmptyString(params.skillId, "skillId");
      requireBoolean(params.enabled, "enabled");
    },
    buildPromptContext: (args) => {
      const params = requireWorkspaceParams(args);
      requireOptionalString(params.provider, "provider");
      // prompt 允许空字符串（由实现决定语义），只校验类型。
      requireString(params.prompt, "prompt");
    },
    copyToCommon: (args) => {
      const params = requireWorkspaceParams(args);
      requireNonEmptyString(params.skillId, "skillId");
    },
    removeFromCommon: (args) => {
      const params = requireWorkspaceParams(args);
      requireNonEmptyString(params.skillId, "skillId");
    },
    deleteSkill: (args) => {
      const params = requireWorkspaceParams(args);
      requireNonEmptyString(params.skillId, "skillId");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 全部方法共享 workspacePath（必选）+ workspaceIdentity（可选）前缀字段。 */
function requireWorkspaceParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  requireString(value.workspacePath, "workspacePath");
  requireOptionalString(value.workspaceIdentity, "workspaceIdentity");
  return value;
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

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
