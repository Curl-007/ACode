// StorageRootSpec 的定义在 @acode/shared（services 内部同样从 shared 导入该类型）；
// @acode/services 入口并未再导出它，这里修正导入来源（纯类型导入，无运行时影响）。
import type { StorageRootSpec } from "@acode/shared";
import type { StorageScanProgress } from "@acode/services/node";

export interface StorageScanWorkerData {
  roots: StorageRootSpec[];
  progressIntervalMs: number;
}

type StorageScanWorkerCommand = { type: "abort" };

export type StorageScanWorkerMessage =
  | { type: "progress"; progress: StorageScanProgress }
  | { type: "done"; progress: StorageScanProgress }
  | { type: "aborted"; message: string; code?: string }
  | { type: "error"; message: string; code?: string };

export function isStorageScanWorkerCommand(value: unknown): value is StorageScanWorkerCommand {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "abort"
  );
}

export function isStorageScanWorkerMessage(value: unknown): value is StorageScanWorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "progress" || type === "done" || type === "aborted" || type === "error";
}
