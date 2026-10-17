import type { ACodeConfigOption } from "@acode/shared";

// 思考滑条纯逻辑（specs/composer-thought-slider.md 产品规则 3/4/6）：
// 档位按配置声明序映射 0..n-1 离散轨道，动态跟随模型档数，不硬编码档位名。
// 组件层（ThoughtSliderPanel）只做渲染与事件转发，全部可测语义收敛在本模块。

/** 拖动阶段的连续浮点步长：视觉跟手，提交时 round 吸附到整档。 */
export const THOUGHT_SLIDER_DRAG_STEP = 0.01;

/** 档位值序列（声明序）。非 select 或无档位返回空数组。 */
export function getThoughtSliderLevels(
  option: Pick<ACodeConfigOption, "type" | "options">,
): string[] {
  if (option.type !== "select") return [];
  return (option.options ?? []).map((entry) => entry.value);
}

/** 无档位/单档位固定不渲染滑条（spec 产品规则 6，与既有控件隐藏条件一致）。 */
export function canRenderThoughtSlider(option: Pick<ACodeConfigOption, "type" | "options">): boolean {
  return getThoughtSliderLevels(option).length >= 2;
}

export interface ThoughtSliderPosition {
  /** 轨道坐标 0..n-1；未匹配时投影到 0（与 ThoughtLevelCycleControl 的进度投影同语义）。 */
  position: number;
  /** currentValue 是否命中已声明档位；未命中（含空值）不能伪装成首档已选。 */
  matched: boolean;
}

export function resolveThoughtSliderPosition(
  levels: readonly string[],
  currentValue: unknown,
): ThoughtSliderPosition {
  const index = levels.indexOf(String(currentValue ?? ""));
  return index >= 0 ? { position: index, matched: true } : { position: 0, matched: false };
}

/** 连续轨道坐标 → 最近档位下标（round + clamp）；拖动预览与松手吸附共用。 */
export function snapThoughtSliderPosition(levels: readonly string[], position: number): number {
  const maxIndex = levels.length - 1;
  if (maxIndex < 0) return -1;
  if (!Number.isFinite(position)) return 0;
  return Math.min(maxIndex, Math.max(0, Math.round(position)));
}

/** 轨道坐标 → 档位值；越界/空轨道返回 null（调用方不得提交）。 */
export function resolveThoughtSliderCommitValue(
  levels: readonly string[],
  position: number,
): string | null {
  const index = snapThoughtSliderPosition(levels, position);
  return index >= 0 ? (levels[index] ?? null) : null;
}

/**
 * ←→/Home/End 键盘切档：每次一档、首尾 clamp 不循环（与 Radix Slider 原生键盘语义一致，
 * 面板层以 capture 拦截保证「拖动连续步长」与「键盘整档步长」互不干扰）。
 * 非切档键返回 null，交还给 Radix/浏览器默认行为。
 */
export function resolveThoughtKeyboardLevelIndex(
  key: string,
  currentIndex: number,
  levelCount: number,
): number | null {
  if (levelCount < 2) return null;
  const clamped = Math.min(levelCount - 1, Math.max(0, currentIndex));
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(levelCount - 1, clamped + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, clamped - 1);
    case "Home":
      return 0;
    case "End":
      return levelCount - 1;
    default:
      return null;
  }
}
