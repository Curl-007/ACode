import assert from "node:assert/strict";
import test from "node:test";

import { getACodeAgentModeSelectOptions, normalizeAvailableACodeMode } from "@acode/shared";
import { acodeWorkspacePresentationToConfigOptions } from "../src/lib/workspaceModeConfigOptions.js";

/**
 * workspace presentation → mode configOption 的纯格式化（legacy M1 最后一个消费方
 * `hooks/workspacePrepareRpc.ts` 所用）。原住 `lib/acodeSessionProjection.ts`，2026-10-28
 * 随投影桥退役搬到本模块，并改用 shared 的权威 helper。
 *
 * 本文件钉住两件搬迁时必须成立的事：
 *   ① **形状与 legacy 逐字一致**（单项 mode option，id/name/category/type 不变）——
 *      prepare 的输出会进 store 的 configOptions，下游 `useDraftConfigControl.ts:418`
 *      按 `category === "mode" && type === "select"` 找它并读 `currentValue`；
 *   ② **档位表来自 shared 单一事实源**（5 档含 dontAsk），不再是桥里那份已漂移的 4 档本地副本。
 *      桥的旧副本缺 dontAsk，导致 `normalizeAvailableACodeMode("dontAsk")` 静默回落 "build"
 *      ——那是潜在缺陷，搬迁顺带修掉。
 */

test("产出单个 mode configOption，形状与 legacy 逐字一致", () => {
  const options = acodeWorkspacePresentationToConfigOptions("plan");
  assert.equal(
    options.length,
    1,
    "prepare 的 configOptions 只有 mode 一项（模型目录来自 Host ModelSelectionView）",
  );
  const mode = options[0]!;
  assert.equal(mode.id, "mode");
  assert.equal(mode.name, "Mode");
  assert.equal(mode.category, "mode");
  assert.equal(mode.type, "select");
  assert.equal(mode.currentValue, "plan");
});

test("档位表 = shared 权威表（含 dontAsk），不再是桥里那份 4 档副本", () => {
  const options = acodeWorkspacePresentationToConfigOptions("build");
  const values = options[0]!.options?.map((o) => o.value);
  // 与 shared 权威逐字相等——单一事实源，桥的本地副本已删除。
  assert.deepEqual(
    values,
    getACodeAgentModeSelectOptions().map((o) => o.value),
  );
  assert.ok(values?.includes("dontAsk"), "必须含 dontAsk（shared 权威 5 档；桥的旧副本只有 4 档）");
  assert.equal(values?.length, 5);
});

test("dontAsk 不再被静默回落成 build（搬迁修掉的潜在缺陷）", () => {
  // 桥的本地 normalizeAvailableACodeMode 因 4 元素集合不含 dontAsk 而回落 "build"；
  // 改用 shared 后 dontAsk 原样透传。这是行为**修正**，非回归——legacy 协议路径
  // 恒传 mode:"build"（workspace-model-runtime.ts:26 硬编码），故线上从未出现 dontAsk。
  assert.equal(acodeWorkspacePresentationToConfigOptions("dontAsk")[0]!.currentValue, "dontAsk");
  assert.equal(normalizeAvailableACodeMode("dontAsk"), "dontAsk", "shared 权威不做该回落");
});

test("未知/auto 档位仍归一到 build（与 legacy 一致，不产出空 currentValue）", () => {
  // v4 值域刻意排除 auto（acode-protocol/index.ts:3529），故 'auto' 落到这里必须归一，
  // 否则工具栏会拿到没有档位被选中的 UI。这条是 legacy 行为的**保持**，不是修改。
  assert.equal(acodeWorkspacePresentationToConfigOptions("auto")[0]!.currentValue, "build");
  // 未知字符串同样归一（类型上不可达，但 normalize 的兜底语义要钉住）。
  assert.equal(
    acodeWorkspacePresentationToConfigOptions("not-a-mode" as never)[0]!.currentValue,
    "build",
  );
});

test("每个档位都带 name 与 description（display.tsx 渲染需要）", () => {
  const options = acodeWorkspacePresentationToConfigOptions("build")[0]!.options ?? [];
  for (const option of options) {
    assert.ok(typeof option.value === "string" && option.value.length > 0);
    assert.ok(typeof option.name === "string" && option.name.length > 0);
    assert.ok(typeof option.description === "string" && option.description.length > 0);
  }
});

test("currentValue 与 shared normalizeAvailableACodeMode 同源（无本地重复实现）", () => {
  for (const mode of ["build", "edit", "plan", "yolo", "dontAsk"] as const) {
    assert.equal(
      acodeWorkspacePresentationToConfigOptions(mode)[0]!.currentValue,
      normalizeAvailableACodeMode(mode),
      `${mode}: 必须直接等于 shared helper 的结果，不得有本地分支`,
    );
  }
});
