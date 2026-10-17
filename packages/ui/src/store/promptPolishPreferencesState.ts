// 润色模型偏好的 store 切片（specs/prompt-polish.md 产品规则 6；照
// store/appearancePreferencesState.ts 先例收在姊妹模块——store/index.ts 逼近
// max-lines 闸，接线点只保留：namespace import、ACodeState extends、单行 spread
// 与广播收件的单行分支）。
// 状态所有权：唯一事实源 = localStorage（lib/promptPolishPreferences.ts 唯一写入口）；
// store 字段只做 UI 回显与跨窗广播载体，不是服务端事实（AGENTS.md 广播字段纪律）。
import {
  loadPromptPolishModelPreference,
  normalizePromptPolishModelSelection,
  setPromptPolishModelPreference as writePromptPolishModelPreference,
  type PromptPolishModelSelection,
} from "@/lib/promptPolishPreferences.js";

export type { PromptPolishModelSelection };

export interface PromptPolishPreferencesSlice {
  /** 持久化的润色模型偏好；null = 未设置（解析阶梯降档到 session）。 */
  promptPolishModel: PromptPolishModelSelection | null;
  setPromptPolishModel: (selection: PromptPolishModelSelection | null) => void;
}

/** 值级变化判定：lib setter 恒走归一化，值未变时不写 store、不触发广播。 */
function isSameSelection(
  left: PromptPolishModelSelection | null,
  right: PromptPolishModelSelection | null,
): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function createSlice(params: {
  readState: () => PromptPolishPreferencesSlice;
  writeState: (patch: Partial<PromptPolishPreferencesSlice>) => void;
}): PromptPolishPreferencesSlice {
  const { readState, writeState } = params;
  return {
    promptPolishModel: loadPromptPolishModelPreference(),
    setPromptPolishModel: (selection) => {
      // lib 是唯一写入口：归一化 → localStorage，返回归一化值供回显。
      const next = writePromptPolishModelPreference(selection);
      if (isSameSelection(readState().promptPolishModel, next)) return;
      writeState({ promptPolishModel: next });
    },
  };
}

/**
 * 广播收件（store/index.ts 的 onMessage 分支调用；applyingBroadcast 防回环标记由
 * index.ts 外层统一承担）：null 表示其他窗口清除了偏好；对象载荷先归一化，垃圾值
 * 直接忽略——不能让坏广播抹掉本窗持久值。
 */
export function applyBroadcast(
  setPromptPolishModel: (selection: PromptPolishModelSelection | null) => void,
  payload: unknown,
): void {
  if (payload === null) {
    setPromptPolishModel(null);
    return;
  }
  const normalized = normalizePromptPolishModelSelection(payload);
  if (!normalized) return;
  setPromptPolishModel(normalized);
}
