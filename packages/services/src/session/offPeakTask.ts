import type {
  OffPeakCodingPlanSupport,
  OffPeakTaskCreateResult,
  OffPeakTakeNumberAvailability,
  ACodeOffPeakTask,
  ACodeOffPeakTaskCreateParams,
  ModelSelection,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 闲时任务管理服务通道（与 automation 服务面互不复用）。
// renderer 经 ProxyChannel 直连（codingPlanSubscription 同款范式）；
// 轮询/取号/核销由服务内部驱动，不暴露给 renderer。

export interface OffPeakUpdateTaskParams {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  /** undefined=不改；Off-Peak Submission 不允许清空为跟随默认。 */
  modelSelection?: ModelSelection | null;
}

export interface IOffPeakTaskService {
  /** 当前 selected provider/connection 的脱敏支持快照；秘密不经过 renderer RPC。 */
  getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport>;
  /** 服务端取号额度即时快照；仅控制新建入口，POST /ticket 仍是最终准入权威。 */
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  /** 创建即取号（成功才落库）；失败返回稳定分类，不跨 RPC 传 raw error。 */
  createTask(params: ACodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult>;
  cancelTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null>;
  pauseTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null>;
  continueTask(offPeakTaskId: string): Promise<ACodeOffPeakTask | null>;
  deleteTask(offPeakTaskId: string): Promise<void>;
  /** 仅隐藏本地 History 行；不删除 task/session/执行字段。 */
  deleteHistory(offPeakTaskId: string): Promise<ACodeOffPeakTask | null>;
  updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ACodeOffPeakTask | null>;
  list(): Promise<ACodeOffPeakTask[]>;
  get(offPeakTaskId: string): Promise<ACodeOffPeakTask | null>;
}

export const IOffPeakTaskService = createServiceDescriptor<IOffPeakTaskService>(
  ServiceChannels.OffPeakTask,
  {
    allowedMethods: [
      "getCodingPlanSupport",
      "getTakeNumberAvailability",
      "createTask",
      "cancelTask",
      "pauseTask",
      "continueTask",
      "deleteTask",
      "deleteHistory",
      "updateTask",
      "list",
      "get",
    ],
    argumentValidators: {
      getCodingPlanSupport: (args) => requireNoArguments(args),
      getTakeNumberAvailability: (args) => requireNoArguments(args),
      // 写入入口：只做顶层确定检查（workspacePath 路径 + modelSelection 对象），
      // title/prompt/permissionMode 等业务字段的完整校验留在 service 层，不在此重复。
      createTask: (args) => {
        const value = requireObjectArg(args, ["workspacePath"]);
        const modelSelection = value.modelSelection;
        if (!modelSelection || typeof modelSelection !== "object" || Array.isArray(modelSelection)) {
          throw new Error("invalid modelSelection");
        }
      },
      cancelTask: (args) => requireStringArg(args, "invalid offPeakTaskId"),
      pauseTask: (args) => requireStringArg(args, "invalid offPeakTaskId"),
      continueTask: (args) => requireStringArg(args, "invalid offPeakTaskId"),
      deleteTask: (args) => requireStringArg(args, "invalid offPeakTaskId"),
      deleteHistory: (args) => requireStringArg(args, "invalid offPeakTaskId"),
      updateTask: (args) => {
        if (args.length !== 2) throw new Error("expected task id and params");
        if (typeof args[0] !== "string" || args[0].length === 0) {
          throw new Error("invalid offPeakTaskId");
        }
        const params = args[1];
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          throw new Error("expected params object");
        }
      },
      list: (args) => requireNoArguments(args),
      get: (args) => requireStringArg(args, "invalid offPeakTaskId"),
    },
  },
);

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function requireStringArg(args: readonly unknown[], message: string): void {
  if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
    throw new Error(message);
  }
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
