import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  ProviderBalanceRequest,
  ProviderBalanceSnapshot,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
  /** 外部 API Key Provider 的账户余额；未识别/未配置时返回带 status 的空快照。 */
  getProviderBalanceSnapshot(request: ProviderBalanceRequest): Promise<ProviderBalanceSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
  {
    allowedMethods: [
      "getAppUsageSnapshot",
      "getCodingPlanUsageSnapshot",
      "getCodingPlanResetStatus",
      "requestCodingPlanResetOpportunity",
      "useCodingPlanReset",
      "markCodingPlanResetHistoryRead",
      "getSnapshot",
      "getEntitlementSnapshot",
      "getProviderBalanceSnapshot",
    ],
    argumentValidators: {
      // range/resetType 为封闭字符串枚举，accountAccess 两个 union 成员均为对象；
      // 成员级校验由服务端 zod/业务分支负责，边界只做 typeof 检查，避免枚举演进时误拒。
      getAppUsageSnapshot: (args) => {
        const request = requireParams(args);
        requireString(request.range, "range");
      },
      getCodingPlanUsageSnapshot: (args) => {
        const request = requireParams(args);
        requireString(request.range, "range");
        requireNonEmptyString(request.preferredProviderId, "preferredProviderId");
        requireRecordField(request.accountAccess, "accountAccess");
      },
      getCodingPlanResetStatus: (args) => {
        const request = requireParams(args);
        requireNonEmptyString(request.preferredProviderId, "preferredProviderId");
        requireRecordField(request.accountAccess, "accountAccess");
      },
      requestCodingPlanResetOpportunity: (args) => {
        const request = requireParams(args);
        requireNonEmptyString(request.preferredProviderId, "preferredProviderId");
        requireRecordField(request.accountAccess, "accountAccess");
        requireNonEmptyString(request.idempotencyKey, "idempotencyKey");
      },
      useCodingPlanReset: (args) => {
        const request = requireParams(args);
        requireNonEmptyString(request.preferredProviderId, "preferredProviderId");
        requireRecordField(request.accountAccess, "accountAccess");
        requireNonEmptyString(request.idempotencyKey, "idempotencyKey");
        requireString(request.resetType, "resetType");
      },
      markCodingPlanResetHistoryRead: (args) => {
        const request = requireParams(args);
        requireNonEmptyString(request.preferredProviderId, "preferredProviderId");
        requireRecordField(request.accountAccess, "accountAccess");
      },
      getSnapshot: (args) => {
        const request = requireParams(args);
        requireString(request.range, "range");
      },
      getEntitlementSnapshot: (args) => {
        // request 可选（字段全部可选）；显式传 undefined 与不传等价。
        if (args.length > 1) throw new Error("expected at most one request object");
        if (args[0] !== undefined) requireRecordField(args[0], "request");
      },
      getProviderBalanceSnapshot: (args) => {
        const request = requireParams(args);
        requireNonEmptyString(request.providerId, "providerId");
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

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}
