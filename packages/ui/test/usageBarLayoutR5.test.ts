import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R5 布局稳定不变量的源码守卫（apps/acode-cli/specs/usage-statusbar-port.md §6.1）。
 *
 * 这几条无法在纯模型测试里表达（是 CSS 结构与 class），但回归代价很高：
 * 条件渲染脉冲点会让流式期间的段值 tick 推挤邻居，字号/槽位回退会重现旧条抖动。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const usageBarDir = path.join(here, "..", "src", "v4", "composer", "usage-bar");
const segmentView = fs.readFileSync(path.join(usageBarDir, "usageBarSegmentView.tsx"), "utf8");
const usageStatusBar = fs.readFileSync(path.join(usageBarDir, "UsageStatusBar.tsx"), "utf8");

test("pulse dot is an absolutely positioned, always-rendered badge toggled by opacity", () => {
  assert.match(segmentView, /absolute -right-1 -top-0\.5 size-1\.5/u);
  assert.match(segmentView, /segment\.dot === "live" \? "opacity-100" : "opacity-0"/u);
  // 旧形态：条件渲染的 flex 流内圆点（会占位）。
  assert.doesNotMatch(
    segmentView,
    /\{segment\.dot !== undefined \? \(\s*<span\s+aria-hidden\s+className="size-1\.5/u,
  );
});

test("each segment has a min-width slot, including context", () => {
  for (const id of ["speed", "turnUsage", "context", "session", "tools", "today", "subagents"]) {
    assert.match(segmentView, new RegExp(`${id}: "min-w-\\[[^\\]]+\\]"`, "u"));
  }
  assert.match(segmentView, /SEGMENT_MIN_WIDTH_CLASS\[segment\.id\]/u);
});

test("the bar keeps the compact container metrics with text-ui-sm", () => {
  assert.match(usageStatusBar, /@container\/usagebar flex h-7 w-full/u);
  assert.match(usageStatusBar, /font-mono text-ui-sm text-foreground-subtle/u);
  assert.doesNotMatch(usageStatusBar, /font-mono text-ui-xs/u);
});

test("hover lifecycle keeps the self-managed close paths (no pointerleave / HoverCard)", () => {
  const hoverDetail = fs.readFileSync(path.join(usageBarDir, "UsageBarHoverDetail.tsx"), "utf8");
  assert.match(hoverDetail, /window\.addEventListener\("mousemove"/u);
  assert.match(hoverDetail, /getBoundingClientRect\(\)/u);
  assert.doesNotMatch(hoverDetail, /onPointerLeave|event\.relatedTarget/u);
  assert.doesNotMatch(hoverDetail, /hover-card/u);
});
