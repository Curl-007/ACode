import type { RpcArgumentValidator } from "@acode/rpc";
import type { IModelSelectionService, IProviderSettingsService } from "./providerFacadeServices.js";

/**
 * ProviderSettings / ModelSelection descriptor 的 RPC 参数校验表。
 *
 * 从 providerFacadeServices.ts 拆出，避免该文件超过架构与 lint 的 400 行上限；
 * 本文件不对外（包外）导出，也不进入 allowedMethods，只被同目录 descriptor 引用。
 *
 * 校验原则（对齐 rpc-service-boundary spec 规则 7）：只做顶层确定检查——
 * id/path 字符串、必需对象/数组形态；不解析 config 业务结构，保持宽容，
 * 避免误拒合法桌面调用。失败由 ProxyChannel 归一为 rpc-invalid-arguments，
 * details 使用固定文案，绝不回显传入值。
 */

// ---- 校验辅助（本文件私有）----

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function requireStringArg(args: readonly unknown[], message: string): void {
  if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
    throw new Error(message);
  }
}

function optionalObjectArg(args: readonly unknown[], index: number): void {
  if (args.length <= index) return;
  const value = args[index];
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an optional parameter object");
  }
}

function optionalSingleObjectArg(args: readonly unknown[]): void {
  if (args.length > 1) throw new Error("expected at most one argument");
  optionalObjectArg(args, 0);
}

function requireObjectArg(
  args: readonly unknown[],
  requiredStringFields: readonly string[],
): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected a single parameter object");
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a parameter object");
  }
  const record = value as Record<string, unknown>;
  for (const field of requiredStringFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(`invalid ${field}`);
    }
  }
  return record;
}

function requireStringArrayArg(args: readonly unknown[], index: number, message: string): void {
  if (args.length !== index + 1) throw new Error(message);
  requireStringArrayAt(args[index], message);
}

function requireStringArrayAt(value: unknown, message: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(message);
  }
}

// 位置参数写入方法的 arity 边界：允许可选尾参缺省（min）或存在（max）。
function requireOverlayArgs(args: readonly unknown[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new Error("unexpected argument count");
  }
}

function requireConfigObject(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${field}`);
  }
}

// ---- 校验表（键受 interface keyof 约束，拼写错误会被 typecheck 拦截）----

export const providerSettingsArgumentValidators: Partial<
  Record<Extract<keyof IProviderSettingsService, string>, RpcArgumentValidator>
> = {
  // onDidChange 是普通事件（无参订阅），listen 走 eventMap 直返，不经参数校验，故不登记校验器。
  getView: (args) => requireNoArguments(args),
  refresh: (args) => {
    // reason 是自由文本，保持宽容只校验字符串类型（允许空）。
    if (args.length !== 1 || typeof args[0] !== "string") throw new Error("invalid reason");
  },
  createPersonalProvider: (args) => optionalSingleObjectArg(args),
  resolveModelConfig: (args) => requireObjectArg(args, ["providerId", "modelId"]),
  savePersonalProviderOverlay: (args) => {
    requireOverlayArgs(args, 2, 3);
    if (typeof args[0] !== "string" || args[0].length === 0) {
      throw new Error("invalid providerId");
    }
    requireConfigObject(args[1], "config");
    optionalObjectArg(args, 2);
  },
  deletePersonalProvider: (args) => requireStringArg(args, "invalid providerId"),
  reorderPersonalProviders: (args) => requireStringArrayArg(args, 0, "invalid providerIds"),
  reorderPersonalModels: (args) => {
    if (args.length !== 2) throw new Error("expected providerId and modelIds");
    if (typeof args[0] !== "string" || args[0].length === 0) {
      throw new Error("invalid providerId");
    }
    requireStringArrayAt(args[1], "modelIds");
  },
  addPersonalModel: (args) => {
    requireOverlayArgs(args, 3, 4);
    if (typeof args[0] !== "string" || args[0].length === 0) {
      throw new Error("invalid providerId");
    }
    if (typeof args[1] !== "string" || args[1].length === 0) {
      throw new Error("invalid modelId");
    }
    requireConfigObject(args[2], "config");
    if (args.length === 4 && args[3] !== undefined && typeof args[3] !== "boolean") {
      throw new Error("invalid useRecommendedConfig");
    }
  },
  renamePersonalModel: (args) => {
    if (args.length !== 3) throw new Error("expected providerId and two model ids");
    for (const index of [0, 1, 2]) {
      if (typeof args[index] !== "string" || (args[index] as string).length === 0) {
        throw new Error("invalid model identifier");
      }
    }
  },
  deletePersonalModel: (args) => {
    if (args.length !== 2) throw new Error("expected providerId and modelId");
    for (const index of [0, 1]) {
      if (typeof args[index] !== "string" || (args[index] as string).length === 0) {
        throw new Error("invalid model identifier");
      }
    }
  },
  savePersonalModelDraft: (args) =>
    requireObjectArg(args, ["providerId", "originalModelId", "nextModelId"]),
  setPersonalModelEnabled: (args) => {
    if (args.length !== 3) throw new Error("expected providerId, modelId and enabled");
    if (typeof args[0] !== "string" || args[0].length === 0) {
      throw new Error("invalid providerId");
    }
    if (typeof args[1] !== "string" || args[1].length === 0) {
      throw new Error("invalid modelId");
    }
    if (typeof args[2] !== "boolean") throw new Error("invalid enabled");
  },
  testModelConnectivity: (args) =>
    requireObjectArg(args, ["workspacePath", "providerId", "modelId"]),
};

export const modelSelectionArgumentValidators: Partial<
  Record<Extract<keyof IModelSelectionService, string>, RpcArgumentValidator>
> = {
  // onDidChange 是普通事件（无参订阅），不经参数校验，故不登记校验器。
  // getView 的 input 可选（ModelSelectionViewInput），缺省时返回基础视图。
  getView: (args) => optionalSingleObjectArg(args),
};
