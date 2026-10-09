import type { Event } from "@acode/rpc";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 广播消息
 *
 * 用于跨窗口状态同步。从 Renderer 发出后经 host → main → 其他 host → 对应 Renderer。
 */
export interface BroadcastMessage {
  /** 频道名，如 "state:theme"、"state:locale" */
  channel: string;
  /** 消息负载 */
  payload: unknown;
  /** 发送源窗口 ID（由 BroadcastHub 填充，接收端可用来跳过自己） */
  sourceWindowId?: number;
}

/** 跨窗口 opaque claim 的临时 reservation；token 用于安全 commit/release。 */
export interface BroadcastClaimLease {
  key: string;
  token: string;
}

export type BroadcastClaimAcquireResult =
  | { status: "acquired"; lease: BroadcastClaimLease }
  | { status: "busy"; retryAfterMs: number }
  | { status: "committed" }
  | { status: "unavailable" };

/**
 * 广播服务接口
 *
 * 路径：Renderer → (RPC call) → Host → (parentPort) → Main(BroadcastHub)
 *       → (postMessage) → 其他 Host → (RPC event onMessage) → 对应 Renderer
 */
export interface IBroadcastService {
  /** 发送广播消息 */
  send(message: BroadcastMessage): Promise<void>;
  /** 申请带 token 的临时 reservation；busy 可在 retryAfterMs 后重试。 */
  acquireClaim(key: string): Promise<BroadcastClaimAcquireResult>;
  /** 把 reservation 提交为应用进程生命周期内的永久 claim。 */
  commitClaim(lease: BroadcastClaimLease): Promise<void>;
  /** 按 token 释放尚未 commit 的 reservation；迟到 token 不影响后来 winner。 */
  releaseClaim(lease: BroadcastClaimLease): Promise<void>;
  /** 在当前应用进程内原子占用 opaque key；同一 key 仅首次返回 true。 */
  tryClaim(key: string): Promise<boolean>;
  /** 接收来自其他窗口的广播 */
  onMessage: Event<BroadcastMessage>;
}

export const IBroadcastService = createServiceDescriptor<IBroadcastService>(
  ServiceChannels.Broadcast,
  {
    allowedMethods: [
      "send",
      "acquireClaim",
      "commitClaim",
      "releaseClaim",
      "tryClaim",
      "onMessage",
    ],
    argumentValidators: {
      send: (args) => {
        if (args.length !== 1) throw new Error("expected one broadcast message");
        const message = requireRecordField(args[0], "message");
        requireNonEmptyString(message.channel, "channel");
        // payload 类型为 unknown：任意值（含缺省）都合法，由接收端按 channel 语义解释。
      },
      acquireClaim: (args) => requireClaimKey(args),
      commitClaim: (args) => requireClaimLease(args),
      releaseClaim: (args) => requireClaimLease(args),
      tryClaim: (args) => requireClaimKey(args),
      // onMessage 是普通事件：订阅走 listen 缓存路径、没有调用参数面，此校验器运行时
      // 不会执行；登记它只为补全 allowedMethods 全成员的参数校验器声明（ARCH-01 迁移规则）。
      onMessage: (args) => requireNoArguments(args),
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireClaimKey(args: readonly unknown[]): void {
  if (args.length !== 1) throw new Error("expected one claim key");
  requireNonEmptyString(args[0], "key");
}

function requireClaimLease(args: readonly unknown[]): void {
  if (args.length !== 1) throw new Error("expected one claim lease");
  const lease = requireRecordField(args[0], "lease");
  requireNonEmptyString(lease.key, "key");
  requireNonEmptyString(lease.token, "token");
}
