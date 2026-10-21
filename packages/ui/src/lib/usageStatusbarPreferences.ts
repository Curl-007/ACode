import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

// 用量状态栏偏好（apps/acode-cli/specs/usage-statusbar-port.md §7.1）：总开关 + 逐项显隐 +
// 回答末尾速率行开关。两件套模式照 lib/appearancePreferences.ts：
// - 唯一事实源 = localStorage（单键 JSON）；本模块 setUsageStatusbarPreferences 是唯一写入口。
// - 垃圾值归一：闭集键之外的字段丢弃，非 boolean 值收敛默认（全开），不抛错。
// - 迁移：旧 `rateLineEnabled` → `answerFooter`（只读回退）；写回新 schema，不再写旧键。
// - 跨窗同步：storage 事件只在同源**其他**窗口触发，天然防回环；BroadcastService 广播载体
//   在 store/usageStatusbarPreferencesState.ts。
// - 模块级外部 store（subscribe/getSnapshot）供组件经 useSyncExternalStore 只读消费。

export const USAGE_STATUSBAR_ITEM_IDS = [
  "generationSpeed",
  "turnUsage",
  "contextCapacity",
  "sessionCumulative",
  "toolCalls",
  "todayTotal",
  "subagents",
] as const;

export type UsageStatusbarItemId = (typeof USAGE_STATUSBAR_ITEM_IDS)[number];

/** 逐项显隐：七项固定闭集（含本次新增的 contextCapacity），与状态栏段一一对应。 */
export type UsageStatusbarVisibleItems = Record<UsageStatusbarItemId, boolean>;

export interface UsageStatusbarPreferences {
  /** 总开关：关闭后整条状态栏与回答末尾速率行都不渲染；子开关保持原样。 */
  enabled: boolean;
  visibleItems: UsageStatusbarVisibleItems;
  /** 回答末尾速率行开关（默认开）。 */
  answerFooter: boolean;
}

/** 补丁面：visibleItems 支持逐键部分覆盖（含新增的 contextCapacity）。 */
export interface UsageStatusbarPreferencesPatch {
  enabled?: boolean;
  visibleItems?: Partial<UsageStatusbarVisibleItems>;
  answerFooter?: boolean;
}

export const USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY = "acode-usage-statusbar-preferences";

export const DEFAULT_USAGE_STATUSBAR_PREFERENCES: UsageStatusbarPreferences = {
  enabled: true,
  visibleItems: {
    generationSpeed: true,
    turnUsage: true,
    contextCapacity: true,
    sessionCumulative: true,
    toolCalls: true,
    todayTotal: true,
    subagents: true,
  },
  answerFooter: true,
};

function normalizeItemVisibility(value: unknown, itemId: UsageStatusbarItemId): boolean {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_USAGE_STATUSBAR_PREFERENCES.visibleItems[itemId];
  }
  const candidate = (value as Partial<Record<UsageStatusbarItemId, unknown>>)[itemId];
  return typeof candidate === "boolean"
    ? candidate
    : DEFAULT_USAGE_STATUSBAR_PREFERENCES.visibleItems[itemId];
}
/** 垃圾值归一：非对象/坏 JSON 解析产物收敛默认；缺席键保持默认（全开）。 */
export function normalizeUsageStatusbarPreferences(value: unknown): UsageStatusbarPreferences {
  const source = (typeof value === "object" && value !== null ? value : {}) as {
    enabled?: unknown;
    visibleItems?: unknown;
    answerFooter?: unknown;
    rateLineEnabled?: unknown;
  };
  const visibleItems = {} as UsageStatusbarVisibleItems;
  for (const itemId of USAGE_STATUSBAR_ITEM_IDS) {
    visibleItems[itemId] = normalizeItemVisibility(source.visibleItems, itemId);
  }
  // 迁移：answerFooter 优先，旧 rateLineEnabled 作为只读回退；两者都缺 = 默认开。
  const answerFooter =
    typeof source.answerFooter === "boolean"
      ? source.answerFooter
      : typeof source.rateLineEnabled === "boolean"
        ? source.rateLineEnabled
        : DEFAULT_USAGE_STATUSBAR_PREFERENCES.answerFooter;
  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_USAGE_STATUSBAR_PREFERENCES.enabled,
    visibleItems,
    answerFooter,
  };
}

export function isSameUsageStatusbarPreferences(
  left: UsageStatusbarPreferences,
  right: UsageStatusbarPreferences,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.answerFooter === right.answerFooter &&
    USAGE_STATUSBAR_ITEM_IDS.every(
      (itemId) => left.visibleItems[itemId] === right.visibleItems[itemId],
    )
  );
}

export function loadUsageStatusbarPreferences(): UsageStatusbarPreferences {
  const raw = readSafeLocalStorage(USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY);
  if (!raw) {
    return {
      ...DEFAULT_USAGE_STATUSBAR_PREFERENCES,
      visibleItems: { ...DEFAULT_USAGE_STATUSBAR_PREFERENCES.visibleItems },
    };
  }
  try {
    return normalizeUsageStatusbarPreferences(JSON.parse(raw));
  } catch {
    // 坏 JSON 不抛错：收敛默认，下次写入会覆盖垃圾值。
    return {
      ...DEFAULT_USAGE_STATUSBAR_PREFERENCES,
      visibleItems: { ...DEFAULT_USAGE_STATUSBAR_PREFERENCES.visibleItems },
    };
  }
}

// ── 模块级外部 store（组件只读消费面）──

let cachedPreferences: UsageStatusbarPreferences | null = null;
const listeners = new Set<() => void>();
let storageListenerInstalled = false;

function readCachedPreferences(): UsageStatusbarPreferences {
  if (cachedPreferences === null) {
    cachedPreferences = loadUsageStatusbarPreferences();
  }
  return cachedPreferences;
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 跨窗 storage 同步：其他窗口写入后本窗口重读并（仅在值级变化时）通知订阅者。
 * 值相等不通知——防止「广播写入 → storage 事件 → 再广播」的回环放大。
 * 懒安装：首个订阅者出现时才挂 window 监听（裸 node 测试环境无 window，静默跳过）。
 */
function ensureStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") {
    return;
  }
  storageListenerInstalled = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY) {
      return;
    }
    const next = loadUsageStatusbarPreferences();
    const current = readCachedPreferences();
    if (isSameUsageStatusbarPreferences(current, next)) {
      return;
    }
    cachedPreferences = next;
    emitChange();
  });
}

export function subscribeToUsageStatusbarPreferences(listener: () => void): () => void {
  ensureStorageListener();
  // 预热缓存：订阅即固定快照引用，避免 useSyncExternalStore 首帧 getSnapshot 抖动。
  readCachedPreferences();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUsageStatusbarPreferencesSnapshot(): UsageStatusbarPreferences {
  return readCachedPreferences();
}

/**
 * 唯一写入口：合并补丁 → 归一 → localStorage → 更新模块缓存并通知。
 * 返回归一化后的全量值供 UI 回显；值级未变时不重复通知。
 */
export function setUsageStatusbarPreferences(
  patch: UsageStatusbarPreferencesPatch,
): UsageStatusbarPreferences {
  const current = loadUsageStatusbarPreferences();
  const next = normalizeUsageStatusbarPreferences({
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    visibleItems: { ...current.visibleItems, ...patch.visibleItems },
    answerFooter: patch.answerFooter ?? current.answerFooter,
  });
  writeSafeLocalStorage(USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  if (!isSameUsageStatusbarPreferences(readCachedPreferences(), next)) {
    cachedPreferences = next;
    emitChange();
  }
  return next;
}
