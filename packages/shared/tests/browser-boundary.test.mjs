import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 浏览器边界守护测试（安全加固 P0-4 衍生）。
 *
 * `@acode/shared/node` 子路径的文件头写着「This subpath must not be imported by
 * renderer/browser bundles」，但那**只是文档约定**：`architecture-policy.yaml` 里
 * `shared` 是 `managed: false`，global 规则只有 forbidCycles / forbidDeepImports /
 * maxFileLines / maxPublicMethods，没有任何一条禁止 renderer 引用该子路径。
 *
 * 为什么这值得钉成测试：`credentialMasterKey.ts` 用 `Atomics.wait` 做**同步阻塞**退避
 * （cipher 接口必须保持同步，被文件锁内联调用，无法用 await）。浏览器主线程上
 * `Atomics.wait` 会抛 TypeError，即便不抛也会硬阻塞 UI 线程。若将来某个 renderer
 * 组件顺手 import 了这个子路径，故障会出现在运行时而非编译期。
 *
 * 覆盖范围刻意包含**深引用**（`@acode/shared/node/credentialMasterKey` 之类），
 * 否则绕过 barrel 直接深引就漏网。同时覆盖 preload：它与 renderer 同进程，
 * 阻塞它同样冻结 UI 线程。
 *
 * 写法沿用仓库既有的不变量守护测试风格（packages/ui/tests/no-telemetry.test.mjs）：
 * 纯源码扫描，不加载被测模块，不触碰真实 ~/.acode。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** 浏览器侧源码目录：这些目录里的代码跑在 renderer / 浏览器 bundle 中。 */
const BROWSER_SIDE_DIRS = [
  "packages/ui/src",
  "packages/web/src",
  "packages/desktop/src/renderer",
  "packages/desktop/src/preload",
];

/**
 * 匹配 `@acode/shared/node` 及其任意深路径在**模块说明符位置**的出现：
 * 静态 `from "..."`、动态 `import("...")`、`require("...")`。
 * 只匹配说明符位置而非裸字符串，避免注释/文档里提及该路径就误报。
 */
const NODE_SUBPATH_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@acode\/shared\/node(?:\/[^"']*)?["']/;

async function collectSources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在（例如某些包未检出）不构成违规。
    return [];
  }
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? collectSources(`${dir}/${entry.name}`)
        : /\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
          ? [`${dir}/${entry.name}`]
          : [],
    ),
  );
  return nested.flat();
}

test("browser-side code never imports the Node-only @acode/shared/node subpath", async () => {
  const offenders = [];
  for (const dir of BROWSER_SIDE_DIRS) {
    for (const file of await collectSources(root + dir)) {
      const source = await readFile(file, "utf8");
      if (NODE_SUBPATH_IMPORT.test(source)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Node-only @acode/shared/node (uses Atomics.wait / node:fs / node:crypto) was imported from ` +
      `browser-side code: ${offenders.join(", ")}. ` +
      `Move the needed helper behind a browser-safe entrypoint instead.`,
  );
});

test("the Node-only barrel still declares the browser boundary", async () => {
  // 边界声明必须留在 barrel 的文件头注释上：删掉它等于把「为什么禁止」的线索一起删了，
  // 将来的人会以为这条守护测试是多余的、顺手把它也删掉。
  const barrel = await readFile(root + "packages/shared/src/node.ts", "utf8");
  assert.match(
    barrel,
    /must not be imported by (?:the )?renderer\/browser bundles/i,
    "packages/shared/src/node.ts must keep its browser-boundary declaration comment",
  );
});

test("no synchronous blocking (Atomics.wait) in browser-side code", async () => {
  // 真正要钉住的不是「Atomics.wait 全局唯一」——它在 Node-only 的 CLI 包里已有三处合法用法
  // （adapters/session-store/migration-runner、bootstrap/official-plugin-cache-fs、
  // bootstrap/official-plugin-seed-lock）。要钉住的是它**不得出现在浏览器侧代码**里：
  // 浏览器主线程上 Atomics.wait 要么抛 TypeError，要么硬阻塞 UI 线程。
  // 这条与上面的 import 守护互补——import 守护挡路径，本条挡行为本身（含内联/复制的情形）。
  const pattern = /Atomics\s*\.\s*wait/;
  const offenders = [];
  for (const dir of BROWSER_SIDE_DIRS) {
    for (const file of await collectSources(root + dir)) {
      const source = await readFile(file, "utf8");
      if (pattern.test(source)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Atomics.wait (synchronous blocking) appeared in browser-side code: ${offenders.join(", ")}. ` +
      `It must stay confined to Node-only modules reached via @acode/shared/node.`,
  );
});
