import { useSyncExternalStore } from "react";
import {
  getUsageStatusbarPreferencesSnapshot,
  subscribeToUsageStatusbarPreferences,
  type UsageStatusbarPreferences,
} from "@/lib/usageStatusbarPreferences.js";

/**
 * 用量状态栏偏好的只读消费面：直接订阅 lib 事实源（localStorage 唯一事实源），
 * 不依赖 store/index.ts 的切片接线；跨窗一致性由 lib 的 storage 同步与
 * store 切片的 BroadcastService 广播共同保证。
 */
export function useUsageStatusbarPreferences(): UsageStatusbarPreferences {
  return useSyncExternalStore(
    subscribeToUsageStatusbarPreferences,
    getUsageStatusbarPreferencesSnapshot,
    getUsageStatusbarPreferencesSnapshot,
  );
}
