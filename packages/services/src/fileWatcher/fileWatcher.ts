import type { Event } from "@acode/rpc";
import type { FileWatchEvent } from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 文件系统监视服务
 *
 * 按路径粒度管理 watcher 实例。UI 展开目录时调用非递归 watch()，
 * Git 这类工作区级状态可调用递归 watch()。事件通过 onDynamicChange 以 RPC event 流式传输。
 */
export interface IFileWatcherService {
  /** 开始监视路径。返回 watcherId，用于 unwatch 和事件订阅 */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** 停止监视。释放 watcher 和相关资源 */
  unwatch(params: { id: string }): Promise<void>;
  /** 停止全部监视。host 退出清理时用于统一释放底层 fs.watch 句柄 */
  disposeAll(): void;
  /** 按 watcherId 订阅变更事件（onDynamic* 模式，RPC 自动路由） */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
  {
    allowedMethods: ["watch", "unwatch", "disposeAll", "onDynamicChange"],
    argumentValidators: {
      watch: (args) => {
        const params = requireParams(args);
        requireString(params.path, "path");
        requireOptionalBoolean(params.recursive, "recursive");
      },
      unwatch: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.id, "id");
      },
      disposeAll: (args) => requireNoArguments(args),
      // 动态事件订阅参数：与 terminal.ts onDynamicData 相同的校验方式。
      onDynamicChange: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string") {
          throw new Error("expected watcher id");
        }
      },
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

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

function requireOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${field}`);
}
