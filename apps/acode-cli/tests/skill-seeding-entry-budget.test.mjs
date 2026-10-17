import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * 播种条目预算（specs/skill-seeding-registration.md R2，验收场景 3）。
 *
 * 官方插件 seed（filesystem/SEA 两源同点把关）与 bundled 技能包 SEA 物化都必须有
 * maxEntries 上限（对齐外部范式 2000）：超限拒绝写缓存/物化并走既有降级协议，
 * 不毁既有代、不静默丢插件。
 */

const {
  MAX_OFFICIAL_PLUGIN_SEED_ENTRIES,
  OFFICIAL_PLUGIN_SEED_INCOMPLETE_CODE,
  OFFICIAL_PLUGIN_SEED_TOO_LARGE_CODE,
  findOfficialPluginSeedRejection,
} = await import("../packages/bootstrap/src/app/official-plugin-seed-guard.ts");
const { MAX_BUNDLED_SKILL_PACK_ENTRIES } =
  await import("../packages/bootstrap/src/app/bundled-skills.ts");

test("预算常量：两处 seed 上限一致为 2000（调整需在 spec R2 登记）", () => {
  assert.equal(MAX_OFFICIAL_PLUGIN_SEED_ENTRIES, 2000);
  assert.equal(MAX_BUNDLED_SKILL_PACK_ENTRIES, 2000);
});

test("预算内放行：fileCount 恰为上限不拒绝", () => {
  assert.equal(
    findOfficialPluginSeedRejection({
      fileCount: MAX_OFFICIAL_PLUGIN_SEED_ENTRIES,
      missingSeedPaths: [],
      pluginName: "demo",
    }),
    undefined,
  );
});

test("超预算拒绝：错误码 ACODE_PLUGIN_SEED_TOO_LARGE，消息含计数与上限", () => {
  const rejection = findOfficialPluginSeedRejection({
    fileCount: MAX_OFFICIAL_PLUGIN_SEED_ENTRIES + 1,
    missingSeedPaths: [],
    pluginName: "demo",
  });
  assert.ok(rejection);
  assert.equal(rejection.error.code, OFFICIAL_PLUGIN_SEED_TOO_LARGE_CODE);
  assert.match(rejection.error.message, /2001\/2000/u);
  assert.equal(rejection.missingSeedPaths, undefined);
});

test("required 路径缺失优先于超预算报告（更具体），错误码保持既有 ACODE_PLUGIN_SEED_INCOMPLETE", () => {
  const rejection = findOfficialPluginSeedRejection({
    fileCount: MAX_OFFICIAL_PLUGIN_SEED_ENTRIES + 500,
    missingSeedPaths: ["dist/mcp/server.js"],
    pluginName: "demo",
  });
  assert.ok(rejection);
  assert.equal(rejection.error.code, OFFICIAL_PLUGIN_SEED_INCOMPLETE_CODE);
  assert.deepEqual(rejection.missingSeedPaths, ["dist/mcp/server.js"]);
  assert.match(rejection.error.message, /dist\/mcp\/server\.js/u);
});

test("bundled 技能包 SEA 物化在超预算时拒绝（源文本钉住守卫存在，惯例同 sea-bundled-skill-assets.test.mjs）", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../packages/bootstrap/src/app/bundled-skills.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /manifest\.files\.length > MAX_BUNDLED_SKILL_PACK_ENTRIES/u,
    "materializeSeaBundledSkillPack 必须有条目预算守卫",
  );
  assert.match(
    source,
    /Bundled skill pack seed manifest oversize/u,
    "超预算必须走 warn 降级（不静默）",
  );
});
