import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
} from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 窗口级公开配置读取。业务模块只消费自己的字段，不拥有第二份请求缓存。 */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
  {
    allowedMethods: ["getSnapshot"],
    argumentValidators: {
      getSnapshot: (args) => {
        // options 可选（字段全部可选）；显式传 undefined 与不传等价。
        if (args.length > 1) throw new Error("expected at most one options object");
        if (args[0] === undefined) return;
        const options = requireRecordField(args[0], "options");
        requireOptionalBoolean(options.forceRefresh, "forceRefresh");
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
