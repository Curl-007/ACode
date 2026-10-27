import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 模型选择器工具的**唯一定义点**守护（legacy M1 第一批搬迁的防回归门禁）。
 *
 * 为什么需要：`parseModelPickerValue` 的 UI 版与 shared 版**语义不同**——UI 版先解码展示态
 * `custom:provider:model`，shared 版遇 `custom:` 串会抛错（`packages/shared/src/model-selection.ts:48`）。
 * 2026-10-28 把这两个函数从 `lib/acodeSessionProjection.ts` 搬到 `lib/modelPickerValue.ts` 时，
 * 若桥里保留一份旧定义（或有人日后「顺手」在别处再写一份），两份 custom 解码逻辑就会独立漂移：
 * 一份支持某个 legacy 形态、另一份不支持，而 typecheck 与现有测试都不会红（两个函数名不同源，
 * 各自自洽）。本守护把「一个语义一份实现」（AGENTS.md）从纪律变成门禁。
 *
 * 判据：`export function parseModelPickerValue` / `export function formatModelPickerValue`
 * 在 packages/ui/src 内**各恰好 1 处定义**，且都在 `lib/modelPickerValue.ts`。
 * 允许 re-export（`export { … } from`）——那是转发不是第二份实现；
 * 桥文件 `acodeSessionProjection.ts` 现在正是以 import 方式取用 formatModelPickerValue。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const uiSrc = `${root}packages/ui/src`;
const CANONICAL_FILE = "lib/modelPickerValue.ts";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "out", ".git", "coverage"]);

async function collectSources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((e) => {
      if (SKIP_DIRECTORIES.has(e.name)) return [];
      return e.isDirectory()
        ? collectSources(`${dir}/${e.name}`)
        : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [];
    }),
  );
  return nested.flat();
}

/** 本地定义（不是 re-export）：`export function NAME(` 或 `export const NAME = (` 形态。 */
function localDefinitions(source, name) {
  const patterns = [
    new RegExp(`^export\\s+function\\s+${name}\\s*[<(]`, "m"),
    new RegExp(`^export\\s+const\\s+${name}\\s*=`, "m"),
  ];
  return patterns.filter((re) => re.test(source)).length;
}

test("parseModelPickerValue / formatModelPickerValue 在 packages/ui/src 内各只有 1 处本地定义", async () => {
  const results = {};
  for (const name of ["parseModelPickerValue", "formatModelPickerValue"]) {
    const sites = [];
    for (const file of await collectSources(uiSrc)) {
      const source = await readFile(file, "utf8");
      if (localDefinitions(source, name) > 0) {
        sites.push(file.slice(uiSrc.length + 1).replace(/\\/g, "/"));
      }
    }
    results[name] = sites;
  }

  for (const [name, sites] of Object.entries(results)) {
    assert.deepEqual(
      sites,
      [CANONICAL_FILE],
      `${name} 的本地定义必须唯一且落在 ${CANONICAL_FILE}（唯一定义点），实测：` +
        `${JSON.stringify(sites)}。` +
        `出现第二份定义会让 custom: 解码逻辑独立漂移——UI 版解码 custom:provider:model，` +
        `shared 版对 custom: 串抛错（model-selection.ts:48），两份实现一旦分叉，` +
        `typecheck 与行为测试都不会红。桥文件 acodeSessionProjection.ts 应以 import 取用，` +
        `不得本地重定义（re-export 转发是允许的）。`,
    );
  }
});

test("acodeSessionProjection.ts 不再本地定义 picker 函数（以 import 取用）", async () => {
  const source = await readFile(`${uiSrc}/lib/acodeSessionProjection.ts`, "utf8");
  // 桥仍需要 formatModelPickerValue 做投影，但必须是 import，不是本地定义。
  assert.match(
    source,
    /import \{[^}]*\bformatModelPickerValue\b[^}]*\} from "\.\/modelPickerValue\.js"/,
    "桥应从 ./modelPickerValue.js import formatModelPickerValue（唯一定义点在叶子）",
  );
  assert.equal(
    localDefinitions(source, "formatModelPickerValue"),
    0,
    "桥不得本地重定义 formatModelPickerValue",
  );
  assert.equal(
    localDefinitions(source, "parseModelPickerValue"),
    0,
    "桥不得本地重定义 parseModelPickerValue",
  );
});

test("picker 叶子不得从 shared 直接透出未解码的 parseModelPickerValue（陷阱守护）", async () => {
  const source = await readFile(`${uiSrc}/${CANONICAL_FILE}`, "utf8");
  // 叶子必须自己实现 custom 解码：若它只是 re-export shared 的 parseModelPickerValue，
  // custom: 形态会当场抛错。断言 decodeCustomModelValue 确实在叶子里被调用。
  assert.match(
    source,
    /decodeCustomModelValue\(/,
    `${CANONICAL_FILE} 必须调用 decodeCustomModelValue——它是 UI 版与 shared 版语义不同的全部理由。` +
      `删掉它（或改成直接 re-export shared 版）会让自定义模型选择静默抛错，` +
      `见 packages/ui/test/modelPickerValue.test.ts 的【陷阱】测试。`,
  );
});
