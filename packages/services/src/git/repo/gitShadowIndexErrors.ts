/**
 * shadow git 私有 index 加固管线的错误分类（specs/shadow-git-index.md R2/R6）。
 *
 * 蓝本：Claude Desktop 2.37337 `index.chunk-CHbrg8it.js:207-253`——EGITSHADOW 错误码、
 * 20 值 stage 闭集与成员判定、EGITINDEXCOPY/EGITINDEXINSTALL 同族错误码。
 */

/** 蓝本错误码闭集（CHbrg8it.js:207,251）。EGITINDEXINSTALL 不移植：ACode 从不写真实 index。 */
export const SHADOW_INDEX_ERROR_CODE = {
  /** 校验拒绝/源检查失败/shadow-root 失败：源与目的地均未被污染。 */
  validation: "EGITSHADOW",
  /** 排队超时、abort、复制/lock/utimes 基础设施失败：私有副本制作中途失败。 */
  copy: "EGITINDEXCOPY",
} as const;

export type ShadowIndexErrorCode =
  (typeof SHADOW_INDEX_ERROR_CODE)[keyof typeof SHADOW_INDEX_ERROR_CODE];

/**
 * ACode 采用的 stage 闭集 = 蓝本 20 值闭集（CHbrg8it.js:208-228）的交集子集，
 * 差集 17 值登记在 specs/shadow-git-index.md R6，禁止在 ACode 侧新增闭集外取值。
 */
export const SHADOW_INDEX_STAGES = ["shadow-root", "private-index", "real-index"] as const;

export type ShadowIndexStage = (typeof SHADOW_INDEX_STAGES)[number];

export function isShadowIndexStage(value: unknown): value is ShadowIndexStage {
  return typeof value === "string" && (SHADOW_INDEX_STAGES as readonly string[]).includes(value);
}

export interface ShadowIndexError extends Error {
  code: ShadowIndexErrorCode;
  stage?: ShadowIndexStage;
  cause?: unknown;
}

/** 源 index 上限：512 MiB（蓝本 T=536870912，PMGadqIZ.js:166）。 */
export const SHADOW_INDEX_MAX_BYTES_DEFAULT = 512 * 1024 * 1024;

export function createShadowIndexError(
  message: string,
  code: ShadowIndexErrorCode,
  options?: { stage?: ShadowIndexStage; cause?: unknown },
): ShadowIndexError {
  return Object.assign(new Error(message), {
    code,
    ...(options?.stage ? { stage: options.stage } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  }) as ShadowIndexError;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isShadowIndexError(error: unknown): error is ShadowIndexError {
  return (
    error instanceof Error &&
    Object.values(SHADOW_INDEX_ERROR_CODE).includes(
      (error as ShadowIndexError).code as ShadowIndexErrorCode,
    )
  );
}

/** 校验拒绝文案（蓝本 ie()，PMGadqIZ.js:237-242）：refusing to read + 原因 + stage。 */
export function refusingToRead(
  path: string,
  reason: string,
  stage: ShadowIndexStage,
): ShadowIndexError {
  return createShadowIndexError(`[git] refusing to read ${path}: ${reason}`, "EGITSHADOW", {
    stage,
  });
}
