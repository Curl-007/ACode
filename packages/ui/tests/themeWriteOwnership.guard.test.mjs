import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// R2-07 守护：`acode-theme` 的写入点全局唯一（packages/ui/src/store/index.ts 的 setTheme），
// useTheme() hook 已删除且不再从 @acode/ui 公共入口导出，消除绕过 store 广播防回环的 theme 双写旁路。
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function sources(dir, exts = /\.(ts|tsx|html)$/) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? sources(`${dir}/${e.name}`, exts)
        : exts.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [],
    ),
  );
  return nested.flat();
}

// 写入 = setItem / writeSafeLocalStorage 且键为 "acode-theme"（或先赋给 STORAGE_KEY 再 setItem(STORAGE_KEY)）。
// 读取（getItem）不算写入。web/index.html 用 STORAGE_KEY 但只 getItem，属首屏读取引导，非写入方。
const THEME_WRITE = /(setItem|writeSafeLocalStorage)\s*\(\s*["']acode-theme["']/;
const THEME_KEY_WRITE_VIA_CONST =
  /(?:const|let|var)\s+STORAGE_KEY\s*=\s*["']acode-theme["'][\s\S]{0,400}?(setItem|writeSafeLocalStorage)\s*\(\s*STORAGE_KEY/;

test("acode-theme 的写入点全局唯一（store/index.ts 的 setTheme）", async () => {
  const writers = [];
  const dirs = ["packages/ui/src", "packages/web/src", "packages/web/index.html", "packages/desktop/src/renderer"];
  for (const dir of dirs) {
    const target = root + dir;
    const files = target.endsWith(".html") ? [target] : await sources(target);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (THEME_WRITE.test(source) || THEME_KEY_WRITE_VIA_CONST.test(source)) {
        writers.push(file.slice(root.length).replace(/\\/g, "/"));
      }
    }
  }
  assert.deepEqual(
    writers,
    ["packages/ui/src/store/index.ts"],
    `acode-theme 只允许 store/index.ts 的 setTheme 写入（走广播防回环）。实际写入方：${writers.join(", ") || "无"}`,
  );
});

test("useTheme() hook 已删除，不再从 @acode/ui 公共入口导出", async () => {
  const indexSource = await readFile(root + "packages/ui/src/index.ts", "utf8");
  assert.doesNotMatch(
    indexSource,
    /export\s*\{\s*useTheme\s*\}/,
    "index.ts 不得再导出 useTheme()（theme 写入唯一收口 store.setTheme）",
  );
  const useThemeSource = await readFile(root + "packages/ui/src/useTheme.ts", "utf8");
  assert.doesNotMatch(
    useThemeSource,
    /export\s+function\s+useTheme\s*\(/,
    "useTheme.ts 不得再定义并导出 useTheme() hook 本体",
  );
  // 纯函数仍保留（store 与 App/PreviewPane 等消费）。
  assert.match(useThemeSource, /export\s+function\s+applyTheme\s*\(/, "applyTheme 应保留");
  assert.match(useThemeSource, /export\s+function\s+resolveTheme\s*\(/, "resolveTheme 应保留");
  assert.match(
    useThemeSource,
    /export\s+function\s+normalizeThemePreference\s*\(/,
    "normalizeThemePreference 应保留",
  );
});
