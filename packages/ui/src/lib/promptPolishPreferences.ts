import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

// 润色模型偏好（specs/prompt-polish.md 产品规则 6）：照 lib/appearancePreferences.ts
// 模式——localStorage 是唯一事实源，本模块是唯一写入口，跨窗同步走 storage 事件 +
// store 广播载体（store/promptPolishPreferencesState.ts 只做回显与防回环）。

export interface PromptPolishModelSelection {
  providerId: string;
  modelId: string;
}

export const PROMPT_POLISH_MODEL_STORAGE_KEY = "acode-prompt-polish-model";

/** 垃圾值归一：非对象/缺字段/空白字符串一律收敛 null（未设置），不抛错。 */
export function normalizePromptPolishModelSelection(
  value: unknown,
): PromptPolishModelSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PromptPolishModelSelection>;
  const providerId = typeof candidate.providerId === "string" ? candidate.providerId.trim() : "";
  const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function loadPromptPolishModelPreference(): PromptPolishModelSelection | null {
  const raw = readSafeLocalStorage(PROMPT_POLISH_MODEL_STORAGE_KEY);
  if (!raw) return null;
  try {
    return normalizePromptPolishModelSelection(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 唯一写入口：归一化 → localStorage，返回归一化后的值供 UI 回显。
 * null 写空串表示清除（readSafeLocalStorage 对空串返回 null 语义由 load 端收敛）。
 */
export function setPromptPolishModelPreference(
  selection: PromptPolishModelSelection | null,
): PromptPolishModelSelection | null {
  const next = normalizePromptPolishModelSelection(selection);
  writeSafeLocalStorage(PROMPT_POLISH_MODEL_STORAGE_KEY, next ? JSON.stringify(next) : "");
  return next;
}

/**
 * 跨窗口同步：storage 事件只在同源**其他**窗口触发，天然防回环（AGENTS.md 广播字段
 * 纪律）；与 appearancePreferences 的 subscribe 同款 API 形状。返回退订函数。
 */
export function subscribeToPromptPolishStorageChanges(
  handler: (next: PromptPolishModelSelection | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== PROMPT_POLISH_MODEL_STORAGE_KEY) return;
    handler(loadPromptPolishModelPreference());
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
