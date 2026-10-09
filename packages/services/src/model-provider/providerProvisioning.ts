import type { ProviderProvisioningEnvelope, ProviderProvisioningResult } from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 仅供 Window Host 调用的远端 Environment target，不加入 IServiceAccessor。 */
export interface IProviderProvisioningTargetService {
  apply(envelope: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult>;
}

export const IProviderProvisioningTargetService =
  createServiceDescriptor<IProviderProvisioningTargetService>(
    ServiceChannels.ProviderProvisioningTarget,
    {
      allowedMethods: ["apply"],
      argumentValidators: {
        apply: (args) => {
          const envelope = requireParams(args);
          // schemaVersion 字面量、credentials 成员及 personalConfig/accountSettings 的
          // strict 校验由服务端 providerProvisioningEnvelopeSchema.parse 完成；
          // 边界不复制枚举（避免 schema 版本演进时误拒），只挡顶层明显畸形输入。
          requireNumber(envelope.schemaVersion, "schemaVersion");
          requireNonEmptyString(envelope.syncId, "syncId");
          requireRecordField(envelope.personalConfig, "personalConfig");
          requireRecordField(envelope.accountSettings, "accountSettings");
          if (!Array.isArray(envelope.credentials)) {
            throw new Error("invalid credentials");
          }
        },
      },
    },
  );

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one provisioning envelope");
  const value = args[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected one provisioning envelope");
  }
  return value as Record<string, unknown>;
}

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${field}`);
}
