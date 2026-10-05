import { basename } from "node:path";

/**
 * 导入侧路径段守卫（R2：路径穿越防护）。
 *
 * spec 要求复用 memoryService.ts 的既有私有实现；但本批次 `packages/services/src/memory/**`
 * 属于其它任务的互斥写区，无法在那里提取导出。为不越权改写，这里承载导入框架自己的
 * 唯一实现，判定条件与 memoryService.isValidPathSegment 逐条一致；memory 侧解禁后应
 * 合并为一份（见 spec 附录「路径段守卫」）。sourceSessionId / 文件名在进入 importedTaskId
 * 或任何拼路径操作之前必须先通过本校验。
 */
export function isValidImportPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** 拒绝非法路径段并抛出带上下文的错误（调用方将其归类为 skipped/failed，不崩导入）。 */
export function assertValidImportPathSegment(value: string, label: string): void {
  if (!isValidImportPathSegment(value)) {
    throw new Error(
      `[external-import] 非法路径段 ${label}: ${JSON.stringify(value.slice(0, 80))}`,
    );
  }
}
