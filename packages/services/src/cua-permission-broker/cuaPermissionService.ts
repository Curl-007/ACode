// Computer Use Helper macOS permission service — services-side descriptor registration.
//
// As part of the single-package merge the type definitions + functional helpers
// (CuaPermissionStatus, CuaPermissionStatusResult, isCuaPermissionStatusAvailable,
// shouldRunCuaScreenCaptureProbe, ICuaPermissionService interface, etc.) moved
// to @acode/acode-cua/src/broker/ports.ts. The descriptor registration itself stays in
// services (host control plane — depends on services' createServiceDescriptor
// + @acode/shared ServiceChannels), so services internal callers (node.ts,
// accessor.ts, services/index.ts) and ui consumers (via @acode/services root
// export) keep importing `ICuaPermissionService` from this exact path.
//
// producer 只拥有 type contract；VALUE descriptor 继续由 services 的
// createServiceDescriptor 创建，避免 producer 反向依赖 RPC/service registry。

import { ServiceChannels } from "@acode/shared";

import { createServiceDescriptor } from "../descriptors.js";

// Type layer — type-only imports from the consolidated package (erased by TS
// at compile time; Vite never resolves @acode/acode-cua for these).
import type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
  ICuaPermissionService as BrokerICuaPermissionService,
} from "@acode/acode-cua/broker";

// Re-export types for consumers.
export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
};

// 只从 producer 的纯 ports subpath 复用值谓词。这里不能从 Node-only broker barrel
// re-export，否则 renderer bundle 会引入 process/node:path/node:crypto；也不能再复制实现，
// 否则“省略 options 是否主动抓屏”这种隐私契约会再次漂移。
export {
  isCuaPermissionStatusAvailable,
  shouldRunCuaScreenCaptureProbe,
} from "@acode/acode-cua/broker/ports";

export interface ICuaPermissionService extends BrokerICuaPermissionService {}

export const ICuaPermissionService = createServiceDescriptor<BrokerICuaPermissionService>(
  ServiceChannels.CuaPermission,
  {
    allowedMethods: ["getStatus", "restartHelper"],
    argumentValidators: {
      getStatus: (args) => {
        if (args.length > 3) throw new Error("expected at most three arguments");
        requireString(args[0], "workspacePath");
        requireOptionalString(args[1], "workspaceIdentity");
        if (args[2] !== undefined) {
          const options = requireRecordField(args[2], "options");
          requireOptionalBoolean(options.probeScreenCapture, "probeScreenCapture");
        }
      },
      restartHelper: (args) => {
        // 三个参数均可选；显式传 undefined 与缺省等价。
        if (args.length > 3) throw new Error("expected at most three arguments");
        requireOptionalString(args[0], "workspacePath");
        requireOptionalString(args[1], "workspaceIdentity");
        if (args[2] !== undefined) {
          const options = requireRecordField(args[2], "options");
          requireOptionalString(options.onboardingSessionId, "onboardingSessionId");
          requireOptionalString(options.reason, "reason");
          // beforeFreshStart 为本地直调回调：RPC JSON 序列化不传输函数，
          // 显式传 undefined 与缺省等价；其他类型属契约违规。
          const beforeFreshStart = options.beforeFreshStart;
          if (beforeFreshStart !== undefined && typeof beforeFreshStart !== "function") {
            throw new Error("invalid beforeFreshStart");
          }
        }
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

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
