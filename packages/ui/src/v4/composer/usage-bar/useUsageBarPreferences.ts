import { useSyncExternalStore } from "react";
import {
  getUsageStatusbarPreferencesSnapshot,
  subscribeToUsageStatusbarPreferences,
  type UsageStatusbarPreferences,
} from "@/lib/usageStatusbarPreferences.js";

/**
 * 目标设置切片（lib/usageStatusbarPreferences.ts）的只读 React 面。
 * 唯一写入口仍是 `setUsageStatusbarPreferences`；本 hook 不持有第二份状态。
 */
export function useUsageBarPreferences(): UsageStatusbarPreferences {
  return useSyncExternalStore(
    subscribeToUsageStatusbarPreferences,
    getUsageStatusbarPreferencesSnapshot,
    getUsageStatusbarPreferencesSnapshot,
  );
}
