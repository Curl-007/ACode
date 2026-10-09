import type { PipSessionEvent } from "@acode/acode-cua/pip-session";
import { ServiceChannels } from "@acode/shared";

import { createServiceDescriptor } from "../descriptors.js";

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;
type LifecycleEvent = Exclude<PipSessionEvent, FocusEvent>;

export interface CuaPipSessionService {
  publishFocus(event: FocusEvent): Promise<void>;
  publishLifecycle(event: LifecycleEvent): Promise<void>;
  dispose(): void;
}

export const ICuaPipSessionService = createServiceDescriptor<CuaPipSessionService>(
  ServiceChannels.CuaPipSession,
  {
    allowedMethods: ["publishFocus", "publishLifecycle", "dispose"],
    argumentValidators: {
      publishFocus: (args) => {
        const event = requireParams(args);
        // FocusEvent 以 kind: "focus-changed" 判别；sessionId 显式可为 null（失焦）。
        if (event.kind !== "focus-changed") throw new Error("invalid kind");
        const sessionId = event.sessionId;
        if (sessionId !== null && typeof sessionId !== "string") {
          throw new Error("invalid sessionId");
        }
        requireNumber(event.revision, "revision");
        requireString(event.sourceWindowId, "sourceWindowId");
      },
      publishLifecycle: (args) => {
        const event = requireParams(args);
        // LifecycleEvent = Exclude<PipSessionEvent, FocusEvent>：拒绝 focus-changed 判别值；
        // 其余成员（turn-*/tool-*/session-closed）差异字段由服务实现按 kind 分支校验。
        const kind = event.kind;
        if (typeof kind !== "string" || kind.length === 0 || kind === "focus-changed") {
          throw new Error("invalid kind");
        }
        // 所有 Lifecycle 成员都要求 sessionId: string（非空类型，null 不合法）。
        requireString(event.sessionId, "sessionId");
      },
      dispose: (args) => requireNoArguments(args),
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one event object");
  const value = args[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected one event object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${field}`);
}
