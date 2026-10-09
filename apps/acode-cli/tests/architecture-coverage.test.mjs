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

