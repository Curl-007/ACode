import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkArchitecture,
  formatMarkdownReport,
  formatReport,
  generateContext,
} from "../../../scripts/architecture/index.mjs";

async function fixture(t, legacySources = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-coverage-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        {
          id: "managed",
          roots: ["managed/src"],
          managed: true,
          publicEntrypoints: ["managed/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        { id: "legacy", roots: ["legacy/src"], managed: false },
      ],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}\n',
    "managed/src/module.ts": 'export const module = { id: "managed", requires: [] };\n',
    "managed/src/contract.ts": "export interface Counter { read(): number; }\n",
    "managed/src/implementation.ts": "export const implementation = 1;\n",
    ...legacySources,
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

async function protocolBoundaryFixture(t, commandImport) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-protocol-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [{ id: "shared", roots: ["packages/shared/src"], managed: false }],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}\n',
    "packages/shared/src/acode-protocol-v4/command.ts":
      `import { schema } from "${commandImport}";\nexport { schema };\n`,
    "packages/shared/src/acode-protocol/index.ts": "export const schema = {};\n",
    "packages/shared/src/acode-protocol-shared.ts": "export const schema = {};\n",
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

async function workspaceResolutionFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-workspace-resolution-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        {
          id: "a",
          roots: ["packages/a/src"],
          managed: true,
          requires: ["b"],
          publicEntrypoints: ["packages/a/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        {
          id: "b",
          roots: ["packages/b/src"],
          managed: true,
          publicEntrypoints: ["packages/b/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
      ],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}',
    "packages/a/package.json": JSON.stringify({ name: "@fixture/a" }),
    "packages/b/package.json": JSON.stringify({ name: "@fixture/b" }),
    "packages/a/src/module.ts": 'export const module = { id: "a", requires: ["b"] };\n',
    "packages/a/src/contract.ts": "export interface A { run(): void; }\n",
    "packages/a/src/consumer.ts":
      'import "@fixture/b/private.js";\nvoid import("@fixture/b/private.js");\n',
    "packages/b/src/module.ts": 'export const module = { id: "b", requires: [] };\n',
    "packages/b/src/contract.ts": "export interface B { read(): void; }\n",
    "packages/b/src/tools/contract.ts": "export interface PrivateContract { debug(): void; }\n",
    "packages/b/src/private.ts": "export const privateValue = 1;\n",
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

test("architecture coverage: OK 明确 managed/legacy 覆盖与未检查规则，changed 不改变分母", async (t) => {
  const cwd = await fixture(t, { "legacy/src/consumer.ts": "export const legacy = 1;\n" });
  const result = await checkArchitecture({ cwd, changedFiles: ["legacy/src/consumer.ts"] });
  assert.equal(result.newViolations.length, 0);
  assert.deepEqual(result.coverage.managed.moduleIds, ["managed"]);
  assert.deepEqual(result.coverage.legacy.moduleIds, ["legacy"]);
  assert.equal(result.coverage.managed.fileCount, 3);
  assert.equal(result.coverage.legacy.fileCount, 1);
  assert.equal(result.coverage.totalFiles, 4);
  assert.ok(result.coverage.legacy.uncheckedRules.includes("module-dependency"));
  assert.ok(result.coverage.legacy.uncheckedRules.includes("cycle"));
  assert.ok(result.coverage.legacy.uncheckedRules.includes("unresolved-workspace-import"));
  assert.match(formatReport(result), /已检查范围/);
  assert.match(formatReport(result), /managed: 1 modules, 3 files/);
  assert.match(formatReport(result), /managed checked:.*unresolved-workspace-import/);
  assert.match(formatReport(result), /legacy unchecked:.*cycle/);
  assert.match(formatMarkdownReport(result), /未检查/);
  assert.equal(
    await readFile(join(cwd, ".architecture-baseline.json"), "utf8"),
    '{"version":1,"violations":[]}\n',
  );
});

test("architecture coverage: legacy 生产 consumer 不能绕过 managed public contract", async (t) => {
  const cwd = await fixture(t, {
    "legacy/src/consumer.ts":
      'import { implementation } from "../../managed/src/implementation.js";\nexport { implementation };\n',
  });
  const refused = await checkArchitecture({ cwd });
  assert.equal(refused.newViolations.filter((item) => item.rule === "deep-import").length, 1);
  await writeFile(
    join(cwd, "legacy/src/consumer.ts"),
    'import type { Counter } from "../../managed/src/contract.js";\nexport type { Counter };\n',
  );
  const accepted = await checkArchitecture({ cwd });
  assert.equal(accepted.newViolations.length, 0);
});

test("architecture coverage: legacy 白盒测试可读实现，reverse graph 仍跟踪生产 consumer", async (t) => {
  const cwd = await fixture(t, {
    "legacy/src/tests/consumer.test.ts":
      'import { implementation } from "../../../managed/src/implementation.js";\nexport { implementation };\n',
    "legacy/src/consumer.ts":
      'import { implementation } from "../../managed/src/implementation.js";\nexport { implementation };\n',
  });
  const result = await checkArchitecture({ cwd, changedFiles: ["managed/src/implementation.ts"] });
  const privateImports = result.newViolations.filter((item) => item.rule === "deep-import");
  assert.equal(privateImports.length, 1);
  assert.ok(privateImports[0].file.endsWith("legacy/src/consumer.ts"));
});

test("architecture boundary: shared v4 cannot import the legacy protocol barrel", async (t) => {
  const cwd = await protocolBoundaryFixture(t, "../acode-protocol/index.js");
  const refused = await checkArchitecture({ cwd });
  assert.equal(refused.newViolations.filter((item) => item.rule === "v4-imports-legacy-protocol").length, 1);

  await writeFile(
    join(cwd, "packages/shared/src/acode-protocol-v4/command.ts"),
    'import { schema } from "../acode-protocol-shared.js";\nexport { schema };\n',
  );
  const accepted = await checkArchitecture({ cwd });
  assert.equal(accepted.newViolations.length, 0);
});

test("architecture resolution follows workspace package names through static and dynamic imports", async (t) => {
  const cwd = await workspaceResolutionFixture(t);
  const result = await checkArchitecture({ cwd });
  const deepImports = result.newViolations.filter((item) => item.rule === "deep-import");
  assert.equal(deepImports.length, 2);
  assert.ok(deepImports.every((item) => item.file.endsWith("packages/a/src/consumer.ts")));
});

test("architecture context reports dependency public entrypoints before nested contracts", async (t) => {
  const cwd = await workspaceResolutionFixture(t);
  const context = await generateContext({ cwd, moduleId: "a" });
  assert.match(context, /packages\/b\/src\/contract\.ts/);
  assert.doesNotMatch(context, /packages\/b\/src\/tools\/contract\.ts/);
});

// --- ARCH-04 resolver 缺口 fixture（2026-10-22）---
// 通配公开入口 / asset 豁免 / exports map remap / session 内部边白名单，各自独立 fixture。

/** 缺口②：publicEntrypointPatterns 通配入口。managed "wild" 用通配放行 remote/*，范围外仍报违规。 */
async function wildcardEntrypointFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-wildcard-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        {
          id: "wild",
          roots: ["packages/wild/src"],
          managed: true,
          publicEntrypoints: ["packages/wild/src/contract.ts"],
          publicEntrypointPatterns: ["packages/wild/src/remote/*.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        { id: "legacy", roots: ["legacy/src"], managed: false, requires: ["wild"] },
      ],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}',
    "packages/wild/package.json": JSON.stringify({ name: "@fixture/wild" }),
    "packages/wild/src/module.ts": 'export const module = { id: "wild", requires: [] };\n',
    "packages/wild/src/contract.ts": "export interface Wild { run(): void; }\n",
    "packages/wild/src/remote/allowed.ts": "export const allowed = 1;\n",
    "packages/wild/src/deep/private.ts": "export const privateValue = 1;\n",
    // 四种写法都指向 remote/allowed（通配放行）与 deep/private（范围外违规）：
    // 相对路径、包名子路径、动态 import、以及 re-export（export ... from）。
    "legacy/src/relative.ts":
      'import { allowed } from "../../packages/wild/src/remote/allowed.js";\n' +
      'import { privateValue } from "../../packages/wild/src/deep/private.js";\n' +
      "export { allowed, privateValue };\n",
    "legacy/src/packageName.ts":
      'import { allowed } from "@fixture/wild/remote/allowed.js";\n' +
      'import { privateValue } from "@fixture/wild/deep/private.js";\n' +
      "export { allowed, privateValue };\n",
    "legacy/src/dynamic.ts":
      'export async function load() {\n' +
      '  const a = await import("@fixture/wild/remote/allowed.js");\n' +
      '  const p = await import("../../packages/wild/src/deep/private.js");\n' +
      "  return [a, p];\n}\n",
    "legacy/src/reexport.ts":
      'export { allowed } from "../../packages/wild/src/remote/allowed.js";\n' +
      'export { privateValue } from "../../packages/wild/src/deep/private.js";\n',
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

test("wildcard publicEntrypointPatterns: 范围内 4 种写法放行，范围外 deep-import 仍报违规", async (t) => {
  const cwd = await wildcardEntrypointFixture(t);
  const result = await checkArchitecture({ cwd });
  const deepImports = result.newViolations.filter((item) => item.rule === "deep-import");
  // 每个 importer 文件对 deep/private 各产生 1 条违规；remote/allowed 全部被通配放行。
  // target 走 message（posix 相对路径），detail 在 Windows 是反斜杠绝对路径不可直接 endsWith。
  assert.equal(deepImports.length, 4);
  assert.ok(deepImports.every((item) => item.message.includes("packages/wild/src/deep/private.ts")));
  assert.ok(deepImports.some((item) => item.file.endsWith("legacy/src/relative.ts")));
  assert.ok(deepImports.some((item) => item.file.endsWith("legacy/src/packageName.ts")));
  assert.ok(deepImports.some((item) => item.file.endsWith("legacy/src/dynamic.ts")));
  assert.ok(deepImports.some((item) => item.file.endsWith("legacy/src/reexport.ts")));
  // 通配范围内的入口不产生任何 deep-import。
  assert.ok(!deepImports.some((item) => item.message.includes("remote/allowed.ts")));
});

/** 缺口③：asset 导入豁免。global.assetExtensions 声明 .css/.svg；workspace-specifier asset 放行。 */
async function assetExemptionFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-asset-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        {
          id: "app",
          roots: ["packages/app/src"],
          managed: true,
          requires: ["ui"],
          publicEntrypoints: ["packages/app/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        {
          id: "ui",
          roots: ["packages/ui/src"],
          managed: true,
          publicEntrypoints: ["packages/ui/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
      ],
      global: { managedOnly: true, assetExtensions: [".css", ".svg"] },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}',
    "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
    "packages/ui/package.json": JSON.stringify({ name: "@fixture/ui" }),
    "packages/app/src/module.ts": 'export const module = { id: "app", requires: ["ui"] };\n',
    "packages/app/src/contract.ts": "export interface App { run(): void; }\n",
    "packages/ui/src/module.ts": 'export const module = { id: "ui", requires: [] };\n',
    "packages/ui/src/contract.ts": "export interface Ui { render(): void; }\n",
    // workspace-specifier asset（无豁免时会触发 unresolved-workspace-import：@fixture/ui 是
    // 已知包名，styles.css 却解析不到源码文件）；.css/.svg 在 assetExtensions 内 → 豁免。
    "packages/app/src/consumer.ts":
      'import "@fixture/ui/styles.css";\n' +
      'import logoUrl from "@fixture/ui/logo.svg";\n' +
      "export { logoUrl };\n",
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

test("asset 导入豁免：workspace-specifier .css/.svg 不报 unresolved/deep-import", async (t) => {
  const cwd = await assetExemptionFixture(t);
  const result = await checkArchitecture({ cwd });
  assert.equal(result.newViolations.length, 0);
});

test("伪装成 asset 的 TS deep-import 不豁免：side-effect .ts 跨模块仍报违规", async (t) => {
  const cwd = await assetExemptionFixture(t);
  // 把 consumer 改成 side-effect import 一个跨模块 .ts 实现文件（.ts 不在 assetExtensions）。
  await writeFile(
    join(cwd, "packages/app/src/consumer.ts"),
    'import "@fixture/ui/styles.css";\n' +
      'import "../../ui/src/secret.js";\n',
  );
  await writeFile(join(cwd, "packages/ui/src/secret.ts"), "export const secret = 1;\n");
  const result = await checkArchitecture({ cwd });
  const deepImports = result.newViolations.filter((item) => item.rule === "deep-import");
  // asset .css 仍豁免；伪装成 side-effect 的 .ts deep-import 被抓出。
  assert.equal(deepImports.length, 1);
  assert.ok(deepImports[0].message.includes("packages/ui/src/secret.ts"));
});

/** 缺口①：exports map remap 解析。子路径名 != src 文件名时按 exports 表解析；.d.ts 不作依赖边。 */
async function exportsRemapFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-exports-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        {
          id: "host",
          roots: ["packages/host/src"],
          managed: true,
          requires: ["lib"],
          publicEntrypoints: ["packages/host/src/contract.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        {
          id: "lib",
          roots: ["packages/lib/src"],
          managed: true,
          // remapped 子路径解析到 deep/real.ts，把它登记为入口 → 合法；
          // other 子路径解析到 deep/other.ts，未登记 → deep-import 违规（边界仍严）。
          publicEntrypoints: ["packages/lib/src/contract.ts", "packages/lib/src/deep/real.ts"],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
        // legacy 消费方：复现真实 desktop(legacy)→@acode/client/globals(.d.ts) 场景——
        // legacy importer 对 null target 不做 unresolved 检查，能干净隔离「.d.ts 不作依赖边」，
        // 不与 managed importer 的 unresolved-workspace-import 语义混淆。
        { id: "app", roots: ["packages/app/src"], managed: false, requires: ["lib"] },
      ],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}',
    "packages/host/package.json": JSON.stringify({ name: "@fixture/host" }),
    "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
    "packages/lib/package.json": JSON.stringify({
      name: "@fixture/lib",
      exports: {
        ".": "./src/index.ts",
        // remap 型：子路径名与 src 文件名不一致，src/<subpath> 约定推不出，必须查 exports。
        "./remapped": "./src/deep/real.ts",
        "./other": "./src/deep/other.ts",
        // 纯类型声明：不构成架构依赖边，resolveImport 不解析（回退 src 约定也找不到 .ts）。
        "./types": "./src/types.d.ts",
      },
    }),
    "packages/host/src/module.ts": 'export const module = { id: "host", requires: ["lib"] };\n',
    "packages/host/src/contract.ts": "export interface Host { run(): void; }\n",
    "packages/lib/src/module.ts": 'export const module = { id: "lib", requires: [] };\n',
    "packages/lib/src/contract.ts": "export interface Lib { read(): void; }\n",
    "packages/lib/src/index.ts": "export const index = 1;\n",
    "packages/lib/src/deep/real.ts": "export const real = 1;\n",
    "packages/lib/src/deep/other.ts": "export const other = 1;\n",
    "packages/lib/src/types.d.ts": "export type Types = { a: number };\n",
    // 注意：packages/lib/src/remapped.ts 不存在——src 约定解析不到，只有 exports map 能解析。
    "packages/host/src/consumer.ts":
      'import { real } from "@fixture/lib/remapped";\n' +
      'export { real };\n',
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

test("exports map remap：子路径经 exports 表解析到登记入口，不报违规", async (t) => {
  const cwd = await exportsRemapFixture(t);
  const result = await checkArchitecture({ cwd });
  assert.equal(result.newViolations.length, 0);
});

test("exports map remap：解析到未登记文件仍报 deep-import（边界不因 exports 放宽）", async (t) => {
  const cwd = await exportsRemapFixture(t);
  await writeFile(
    join(cwd, "packages/host/src/consumer.ts"),
    'import { other } from "@fixture/lib/other";\nexport { other };\n',
  );
  const result = await checkArchitecture({ cwd });
  const deepImports = result.newViolations.filter((item) => item.rule === "deep-import");
  assert.equal(deepImports.length, 1);
  assert.ok(deepImports[0].message.includes("packages/lib/src/deep/other.ts"));
});

test("exports map：纯 .d.ts 子路径不作依赖边（无 deep-import / unresolved）", async (t) => {
  const cwd = await exportsRemapFixture(t);
  // 用 legacy app 消费方（复现 desktop→client/globals 真实场景）：@fixture/lib/types 的
  // exports target 是 .d.ts，resolveImport 返回 null 而非解析成 globals.d.ts。若被解析，
  // 因 types.d.ts 未登记为入口会误报 deep-import；legacy importer 又不做 unresolved 检查，
  // 故 result 必须干净。
  await mkdir(join(cwd, "packages/app/src"), { recursive: true });
  await writeFile(
    join(cwd, "packages/app/src/consumer.ts"),
    'import type { Types } from "@fixture/lib/types";\nexport type { Types };\n',
  );
  const result = await checkArchitecture({ cwd });
  assert.equal(result.newViolations.length, 0);
});

/** 缺口④：session 式内部边白名单。publicEntrypoints 留空 + internalEdgeAllowlist 逐条冻结。 */
async function internalEdgeAllowlistFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-allowlist-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const files = {
    "architecture-policy.yaml": JSON.stringify({
      version: 1,
      modules: [
        { id: "svc", roots: ["packages/svc/src"], managed: false },
        {
          id: "sess",
          roots: ["packages/sess/src"],
          managed: true,
          // publicEntrypoints 留空；靠 internalEdgeAllowlist 承载存量边（session 迁移态）。
          publicEntrypoints: [],
          internalEdgeAllowlist: [
            { from: "packages/svc/src/registered.ts", to: "packages/sess/src/impl.ts" },
          ],
          layers: { domain: "." },
          layerOrder: ["domain"],
        },
      ],
      global: { managedOnly: true },
    }),
    ".architecture-baseline.json": '{"version":1,"violations":[]}',
    "packages/sess/src/module.ts": 'export const module = { id: "sess", requires: [] };\n',
    "packages/sess/src/contract.ts": "export interface Sess { read(): void; }\n",
    "packages/sess/src/impl.ts": "export const impl = 1;\n",
    // 已登记的边 → 放行。
    "packages/svc/src/registered.ts":
      'import { impl } from "../../sess/src/impl.js";\nexport { impl };\n',
    // 未登记的新边（同 target，不同 importer）→ deep-import 违规：新增需显式登记。
    "packages/svc/src/unregistered.ts":
      'import { impl } from "../../sess/src/impl.js";\nexport { impl };\n',
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), source);
  }
  return cwd;
}

test("internalEdgeAllowlist：登记边放行，未登记新边报 deep-import（止住增长）", async (t) => {
  const cwd = await internalEdgeAllowlistFixture(t);
  const result = await checkArchitecture({ cwd });
  const deepImports = result.newViolations.filter((item) => item.rule === "deep-import");
  assert.equal(deepImports.length, 1);
  assert.ok(deepImports[0].file.endsWith("packages/svc/src/unregistered.ts"));
  assert.ok(deepImports[0].message.includes("packages/sess/src/impl.ts"));
});


