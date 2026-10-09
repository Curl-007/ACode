import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  SystemInfo,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISystemService {
  info(): Promise<SystemInfo>;
  listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>;
  probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult>;
}

export const ISystemService = createServiceDescriptor<ISystemService>(ServiceChannels.System, {
  allowedMethods: ["info", "listIntegratedTerminalShells", "probeIntranet"],
  argumentValidators: {
    info: (args) => requireNoArguments(args),
    listIntegratedTerminalShells: (args) => requireNoArguments(args),
    probeIntranet: (args) => {
      const request = requireParams(args);
      // targets 为 union（tcp/service 两种对象形态）：边界只要求每项是对象，
      // 成员级字段（host/url 等）由探测实现解析，避免枚举演进误拒。
      const targets = request.targets;
      if (!Array.isArray(targets) || !targets.every((target) => isRecord(target))) {
        throw new Error("invalid targets");
      }
      requireOptionalNumber(request.attempts, "attempts");
      requireOptionalNumber(request.requiredSuccessCount, "requiredSuccessCount");
    },
  },
});

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one request object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one request object");
  return value;
}

function requireOptionalNumber(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`invalid ${field}`);
  }
}
