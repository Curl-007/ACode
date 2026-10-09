import type { AppSettings } from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingService {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting, {
  allowedMethods: ["get", "update", "updateDataBaseDir", "ensureDefaultProject"],
  argumentValidators: {
    get: (args) => requireNoArguments(args),
    update: (args) => {
      // patch 为 Partial<AppSettings>：空对象也是合法调用；字段级校验由设置持久化层负责。
      if (args.length > 2) throw new Error("expected patch and optional account settings");
      requireRecordField(args[0], "patch");
      // expectedAccountSettings 可选；显式传 undefined 与不传等价。
      if (args.length === 2 && args[1] !== undefined) {
        requireRecordField(args[1], "expectedAccountSettings");
      }
    },
    updateDataBaseDir: (args) => {
      // 签名显式允许 undefined（保持现目录语义由实现解释）；有值时必须是字符串。
      // 边界不额外拒绝空字符串，目录合法性由服务实现校验。
      if (args.length > 1) throw new Error("expected one new directory");
      if (args[0] !== undefined) requireString(args[0], "newDir");
    },
    ensureDefaultProject: (args) => {
      if (args.length !== 1) throw new Error("expected one homedir");
      requireString(args[0], "homedir");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}
