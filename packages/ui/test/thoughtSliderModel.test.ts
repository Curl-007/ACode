import assert from "node:assert/strict";
import test from "node:test";
import {
  canRenderThoughtSlider,
  getThoughtSliderLevels,
  resolveThoughtKeyboardLevelIndex,
  resolveThoughtSliderCommitValue,
  resolveThoughtSliderPosition,
  snapThoughtSliderPosition,
  THOUGHT_SLIDER_DRAG_STEP,
} from "../src/chat-input-toolbar/thoughtSliderModel.js";
import type { ACodeConfigOption } from "@acode/shared";

/**
 * 思考滑条纯逻辑契约（specs/composer-thought-slider.md 验收场景 1 的模型层）：
 * 档位映射（3/5/8 档动态）、拖动吸附（round+clamp）、键盘整档、隐藏条件。
 * 组件层无 React 测试基建（ui 测试无 jsdom 先例），渲染冒烟由 typecheck 兜底。
 */

function selectOption(values: readonly string[], currentValue: string): ACodeConfigOption {
  return {
    id: "thought",
    name: "thought",
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

test("档位映射：按声明序生成 0..n-1 轨道，档数动态跟随", () => {
  for (const values of [
    ["off", "low", "high"],
    ["minimal", "low", "medium", "high", "xhigh"],
    ["off", "on", "low", "medium", "high", "xhigh", "max", "ultra"],
  ]) {
    assert.deepEqual(getThoughtSliderLevels(selectOption(values, values[0])), [...values]);
  }
  // boolean 型没有档位轨道。
  assert.deepEqual(
    getThoughtSliderLevels({ id: "t", name: "t", type: "boolean", currentValue: true }),
    [],
  );
});

test("隐藏条件：无档位/单档位不渲染，双档起可渲染", () => {
  assert.equal(canRenderThoughtSlider(selectOption([], "")), false);
  assert.equal(canRenderThoughtSlider(selectOption(["high"], "high")), false);
  assert.equal(canRenderThoughtSlider(selectOption(["low", "high"], "low")), true);
  assert.equal(canRenderThoughtSlider({ id: "t", name: "t", type: "boolean", currentValue: false }), false);
});

test("当前位置：命中档位返回声明序下标；未命中投影 0 且 matched=false", () => {
  const levels = ["off", "low", "medium", "high"];
  assert.deepEqual(resolveThoughtSliderPosition(levels, "medium"), { position: 2, matched: true });
  assert.deepEqual(resolveThoughtSliderPosition(levels, "off"), { position: 0, matched: true });
  // 空值/失效值不能伪装成首档已选（与工具条进度条投影同语义）。
  assert.deepEqual(resolveThoughtSliderPosition(levels, ""), { position: 0, matched: false });
  assert.deepEqual(resolveThoughtSliderPosition(levels, "nonexistent"), {
    position: 0,
    matched: false,
  });
  assert.deepEqual(resolveThoughtSliderPosition(levels, undefined), {
    position: 0,
    matched: false,
  });
});

test("拖动吸附：round 到最近档并 clamp 在轨道内", () => {
  const levels = ["off", "low", "medium", "high"];
  assert.equal(snapThoughtSliderPosition(levels, 0), 0);
  assert.equal(snapThoughtSliderPosition(levels, 0.4), 0);
  assert.equal(snapThoughtSliderPosition(levels, 0.6), 1);
  assert.equal(snapThoughtSliderPosition(levels, 2.5), 3);
  assert.equal(snapThoughtSliderPosition(levels, -1.2), 0);
  assert.equal(snapThoughtSliderPosition(levels, 99), 3);
  assert.equal(snapThoughtSliderPosition(levels, Number.NaN), 0);
  assert.equal(snapThoughtSliderPosition([], 1), -1);
});

test("提交值：吸附坐标映射回档位值，越界/空轨道为 null", () => {
  const levels = ["off", "low", "high"];
  assert.equal(resolveThoughtSliderCommitValue(levels, 1.4), "low");
  assert.equal(resolveThoughtSliderCommitValue(levels, 2.9), "high");
  assert.equal(resolveThoughtSliderCommitValue(levels, -5), "off");
  assert.equal(resolveThoughtSliderCommitValue([], 0), null);
});

test("键盘切档：←→/Home/End 整档移动，首尾 clamp，非切档键交还默认行为", () => {
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowRight", 1, 5), 2);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowUp", 1, 5), 2);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowLeft", 1, 5), 0);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowDown", 1, 5), 0);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowRight", 4, 5), 4);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowLeft", 0, 5), 0);
  assert.equal(resolveThoughtKeyboardLevelIndex("Home", 3, 5), 0);
  assert.equal(resolveThoughtKeyboardLevelIndex("End", 1, 5), 4);
  assert.equal(resolveThoughtKeyboardLevelIndex("Enter", 1, 5), null);
  assert.equal(resolveThoughtKeyboardLevelIndex("Tab", 1, 5), null);
  // 单档/无档不提供键盘切档。
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowRight", 0, 1), null);
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowRight", 0, 0), null);
  // 越界当前下标先 clamp 再移动。
  assert.equal(resolveThoughtKeyboardLevelIndex("ArrowRight", 9, 5), 4);
});

test("拖动步长为小于 1 档的连续步长（预览跟手、松手吸附的前提）", () => {
  assert.ok(THOUGHT_SLIDER_DRAG_STEP > 0);
  assert.ok(THOUGHT_SLIDER_DRAG_STEP < 1);
});
