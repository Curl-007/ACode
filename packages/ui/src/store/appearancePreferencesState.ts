// 三轴外观偏好的 store 切片（specs/appearance-preference-axes.md R5/R6；波 2 接线登记：
// store 字段 + BROADCAST_FIELDS 广播分发 + applyingBroadcast 防回环，按 uiFontSizePx
// 先例）。切片实现按 codingPlanQuotaResetState 先例收在本姊妹模块——store/index.ts
// 逼近 max-lines 闸，接线点只保留：namespace import、ACodeState extends、单行 spread
// 与广播收件的单行分支。
// 状态所有权：唯一事实源 = localStorage；根 DOM 三属性唯一写入者 =
// lib/appearancePreferences.ts（spec R6）；store 字段只做 UI 回显与跨窗广播载体，
// 不是服务端事实（AGENTS.md 广播字段纪律）。
import {
  loadAppearancePreferences,
  setAppearancePreferences as writeAppearancePreferences,
  type AppearancePreferences,
} from "@/lib/appearancePreferences.js";

export type { AppearancePreferences };

export interface AppearancePreferencesSlice {
  /** 三轴外观偏好（density/text-size/reduce-motion），归一化闭集值。 */
  appearancePreferences: AppearancePreferences;
  setAppearancePreferences: (patch: Partial<AppearancePreferences>) => void;
}

/** 值级变化判定：lib setter 恒返回新对象，轴值全部未变时不写 store、不触发广播。 */
function isSamePreferences(left: AppearancePreferences, right: AppearancePreferences): boolean {
  return (
    left.density === right.density &&
    left.textSize === right.textSize &&
    left.reduceMotion === right.reduceMotion
  );
}

export function createSlice(params: {
  readState: () => AppearancePreferencesSlice;
  writeState: (patch: Partial<AppearancePreferencesSlice>) => void;
}): AppearancePreferencesSlice {
  const { readState, writeState } = params;
  return {
    appearancePreferences: loadAppearancePreferences(),
    setAppearancePreferences: (patch) => {
      // lib 是唯一写入口（spec R6）：归一化 → localStorage → 同窗应用根属性。
      const next = writeAppearancePreferences(patch);
      if (isSamePreferences(readState().appearancePreferences, next)) return;
      writeState({ appearancePreferences: next });
    },
  };
}

/**
 * 广播收件（store/index.ts 的 onMessage 分支调用；applyingBroadcast 防回环标记由
 * index.ts 外层统一承担）：只认对象载荷；轴值闭集归一在 setter 内收口——垃圾轴
 * 收敛默认、缺席轴保持本窗持久值，广播值不直接信任。
 */
export function applyBroadcast(
  setAppearancePreferences: (patch: Partial<AppearancePreferences>) => void,
  payload: unknown,
): void {
  if (typeof payload !== "object" || payload === null) return;
  setAppearancePreferences(payload as Partial<AppearancePreferences>);
}
