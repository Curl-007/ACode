// 用量状态栏偏好的 store 切片（specs/usage-statusbar.md「设置齿轮」行；接线登记：
// store/index.ts 四处单行——namespace import、ACodeState extends、单行 spread、
// BROADCAST_FIELDS 加名，另加 onMessage 收件单行分支，按 appearancePreferencesState
// 先例）。切片实现收在本姊妹模块——store/index.ts 逼近 max-lines 闸。
// 状态所有权：唯一事实源 = localStorage（lib/usageStatusbarPreferences.ts 唯一写入口）；
// store 字段只做 UI 回显与跨窗广播载体，不是服务端事实（AGENTS.md 广播字段纪律）。
import {
  getUsageStatusbarPreferencesSnapshot,
  isSameUsageStatusbarPreferences,
  loadUsageStatusbarPreferences,
  setUsageStatusbarPreferences as writeUsageStatusbarPreferences,
  subscribeToUsageStatusbarPreferences,
  type UsageStatusbarPreferences,
  type UsageStatusbarPreferencesPatch,
} from "@/lib/usageStatusbarPreferences.js";

export type { UsageStatusbarPreferences, UsageStatusbarPreferencesPatch };

export interface UsageStatusbarPreferencesSlice {
  /** 用量状态栏偏好（逐项显隐 + 速率行开关），归一化闭集值。 */
  usageStatusbarPreferences: UsageStatusbarPreferences;
  setUsageStatusbarPreferences: (patch: UsageStatusbarPreferencesPatch) => void;
}

export function createSlice(params: {
  readState: () => UsageStatusbarPreferencesSlice;
  writeState: (patch: Partial<UsageStatusbarPreferencesSlice>) => void;
}): UsageStatusbarPreferencesSlice {
  const { readState, writeState } = params;
  // 同窗收口：状态栏齿轮经 lib 唯一写入口直写（组件不依赖本切片接线即可工作），
  // 这里订阅 lib 通知把 zustand 字段拉齐——BROADCAST_FIELDS 的跨窗广播以字段变化为触发，
  // 不订阅则齿轮写入永远不会广播。store 与窗口同生命周期，订阅不退还。
  subscribeToUsageStatusbarPreferences(() => {
    const next = getUsageStatusbarPreferencesSnapshot();
    if (isSameUsageStatusbarPreferences(readState().usageStatusbarPreferences, next)) {
      return;
    }
    writeState({ usageStatusbarPreferences: next });
  });
  return {
    usageStatusbarPreferences: loadUsageStatusbarPreferences(),
    setUsageStatusbarPreferences: (patch) => {
      // lib 是唯一写入口：归一化 → localStorage → 通知订阅者（含上面的拉齐回调）。
      const next = writeUsageStatusbarPreferences(patch);
      if (isSameUsageStatusbarPreferences(readState().usageStatusbarPreferences, next)) return;
      writeState({ usageStatusbarPreferences: next });
    },
  };
}

/**
 * 广播收件（store/index.ts 的 onMessage 分支调用；applyingBroadcast 防回环标记由
 * index.ts 外层统一承担）：只认对象载荷；键值归一在 lib setter 内收口——垃圾值
 * 收敛默认、缺席键保持本窗持久值，广播值不直接信任。
 */
export function applyBroadcast(
  setUsageStatusbarPreferences: (patch: UsageStatusbarPreferencesPatch) => void,
  payload: unknown,
): void {
  if (typeof payload !== "object" || payload === null) return;
  setUsageStatusbarPreferences(payload as UsageStatusbarPreferencesPatch);
}
