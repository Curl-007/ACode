import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

// 多轴外观偏好（specs/appearance-preference-axes.md）：三轴上收为根 DOM data-* 属性，
// CSS 属性选择器消费，零 JS 重算、零 prop 钻透。持久化走与 theme（acode-theme）、
// UI 字号（acode-ui-font-size-px）同一 localStorage 设置面；写入路径照
// lib/uiFontSize.ts 先例。本模块是三属性的唯一写入者（spec R6）。

export const DENSITY_PREFERENCE_VALUES = ["comfortable", "compact"] as const;
export const TEXT_SIZE_PREFERENCE_VALUES = ["sm", "md", "lg"] as const;
export const REDUCE_MOTION_PREFERENCE_VALUES = ["auto", "reduce"] as const;

export type DensityPreference = (typeof DENSITY_PREFERENCE_VALUES)[number];
export type TextSizePreference = (typeof TEXT_SIZE_PREFERENCE_VALUES)[number];
export type ReduceMotionPreference = (typeof REDUCE_MOTION_PREFERENCE_VALUES)[number];

export interface AppearancePreferences {
  density: DensityPreference;
  textSize: TextSizePreference;
  reduceMotion: ReduceMotionPreference;
}

export const DENSITY_STORAGE_KEY = "acode-density";
export const TEXT_SIZE_STORAGE_KEY = "acode-text-size";
export const REDUCE_MOTION_STORAGE_KEY = "acode-reduce-motion";

export const DENSITY_ATTRIBUTE = "data-acode-density";
export const TEXT_SIZE_ATTRIBUTE = "data-acode-text-size";
export const REDUCE_MOTION_ATTRIBUTE = "data-acode-reduce-motion";

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  density: "comfortable",
  textSize: "md",
  reduceMotion: "auto",
};

/** 闭集校验（spec R1）：集外值（含 null/垃圾字符串）一律收敛默认，不抛错。 */
function normalizeClosedSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function normalizeDensityPreference(value: unknown): DensityPreference {
  return normalizeClosedSet(
    value,
    DENSITY_PREFERENCE_VALUES,
    DEFAULT_APPEARANCE_PREFERENCES.density,
  );
}

export function normalizeTextSizePreference(value: unknown): TextSizePreference {
  return normalizeClosedSet(
    value,
    TEXT_SIZE_PREFERENCE_VALUES,
    DEFAULT_APPEARANCE_PREFERENCES.textSize,
  );
}

export function normalizeReduceMotionPreference(value: unknown): ReduceMotionPreference {
  return normalizeClosedSet(
    value,
    REDUCE_MOTION_PREFERENCE_VALUES,
    DEFAULT_APPEARANCE_PREFERENCES.reduceMotion,
  );
}

export function loadAppearancePreferences(): AppearancePreferences {
  return {
    density: normalizeDensityPreference(readSafeLocalStorage(DENSITY_STORAGE_KEY)),
    textSize: normalizeTextSizePreference(readSafeLocalStorage(TEXT_SIZE_STORAGE_KEY)),
    reduceMotion: normalizeReduceMotionPreference(readSafeLocalStorage(REDUCE_MOTION_STORAGE_KEY)),
  };
}

/** 属性写入目标的最小结构面：真实环境是 documentElement，测试注入假根。 */
export interface AppearanceAttributeTarget {
  setAttribute(name: string, value: string): void;
}

function resolveAttributeTarget(
  root?: AppearanceAttributeTarget | null,
): AppearanceAttributeTarget | null {
  if (root) return root;
  if (typeof document === "undefined") return null;
  return document.documentElement ?? null;
}

/**
 * 三轴写满根属性（spec R2）：默认档也显式写出——CSS 只 gate 需要的值
 * （如 [data-acode-reduce-motion="reduce"]），显式属性利于调试与未来加档。
 * 无 document 环境（SSR/裸 node 测试）静默跳过，与 uiFontSize 同契约。
 */
export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root?: AppearanceAttributeTarget | null,
): void {
  const target = resolveAttributeTarget(root);
  if (!target?.setAttribute) return;
  target.setAttribute(DENSITY_ATTRIBUTE, preferences.density);
  target.setAttribute(TEXT_SIZE_ATTRIBUTE, preferences.textSize);
  target.setAttribute(REDUCE_MOTION_ATTRIBUTE, preferences.reduceMotion);
}

/** 读持久值并应用；启动收口（applyTheme 内）与 storage 同步共用。 */
export function applyPersistedAppearancePreferences(root?: AppearanceAttributeTarget | null): void {
  applyAppearancePreferences(loadAppearancePreferences(), root);
}

/**
 * 设置面写入口（未来设置页控件直接调用，spec R6）：归一化 → localStorage →
 * 应用，返回归一化后的全量值供 UI 回显。部分补丁只覆盖传入轴。
 */
export function setAppearancePreferences(
  patch: Partial<AppearancePreferences>,
  root?: AppearanceAttributeTarget | null,
): AppearancePreferences {
  const next: AppearancePreferences = {
    density:
      patch.density === undefined
        ? normalizeDensityPreference(readSafeLocalStorage(DENSITY_STORAGE_KEY))
        : normalizeDensityPreference(patch.density),
    textSize:
      patch.textSize === undefined
        ? normalizeTextSizePreference(readSafeLocalStorage(TEXT_SIZE_STORAGE_KEY))
        : normalizeTextSizePreference(patch.textSize),
    reduceMotion:
      patch.reduceMotion === undefined
        ? normalizeReduceMotionPreference(readSafeLocalStorage(REDUCE_MOTION_STORAGE_KEY))
        : normalizeReduceMotionPreference(patch.reduceMotion),
  };
  writeSafeLocalStorage(DENSITY_STORAGE_KEY, next.density);
  writeSafeLocalStorage(TEXT_SIZE_STORAGE_KEY, next.textSize);
  writeSafeLocalStorage(REDUCE_MOTION_STORAGE_KEY, next.reduceMotion);
  applyAppearancePreferences(next, root);
  return next;
}

/**
 * 跨窗口同步（spec R5）：storage 事件只在同源**其他**窗口触发，天然防回环
 * （AGENTS.md 广播字段纪律）；与 uiFontSize 的 subscribe 同款 API 形状。
 * 只响应本模块三键；返回退订函数。
 */
export function subscribeToAppearanceStorageChanges(): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key !== DENSITY_STORAGE_KEY &&
      event.key !== TEXT_SIZE_STORAGE_KEY &&
      event.key !== REDUCE_MOTION_STORAGE_KEY
    ) {
      return;
    }
    applyPersistedAppearancePreferences();
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
