import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { discoverTsconfigAliases, discoverWorkspacePackages } from "../../../scripts/architecture/discovery.mjs";
import { loadPolicy } from "../../../scripts/architecture/policy.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "acode-architecture-discovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  await mkdir(join(cwd, "packages", "foo", "src"), { recursive: true });
  await mkdir(join(cwd, "packages", "bar", "src"), { recursive: true });
  await mkdir(join(cwd, "apps", "acode-cli", "packages", "contracts", "src"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "ignored", "src"), { recursive: true });
  await mkdir(join(cwd, ".acode", "ignored", "src"), { recursive: true });
  await writeFile(
    join(cwd, "architecture-policy.yaml"),
    [
      "version: 1",
      "modules:",
      "  - id: foo",
      "    roots: [packages/foo/src]",
      "    managed: false",
      "  - id: contracts",
      "    roots: [apps/acode-cli/packages/contracts/src]",
      "    managed: false",
      "global: {}",
    ].join("\n"),
  );
  await writeFile(join(cwd, "packages", "foo", "package.json"), JSON.stringify({ name: "@acme/foo" }));
  await writeFile(join(cwd, "packages", "bar", "package.json"), JSON.stringify({ name: "@acme/bar" }));
  await writeFile(join(cwd, "node_modules", "ignored", "package.json"), JSON.stringify({ name: "ignored" }));
  await writeFile(join(cwd, ".acode", "ignored", "package.json"), JSON.stringify({ name: "private-state" }));
  await writeFile(
    join(cwd, "tsconfig.json"),
    '{\n  // JSONC is accepted by TypeScript configs.\n  "compilerOptions": { "baseUrl": ".", "paths": { "@root/*": ["packages/*/src/*"] } },\n}\n',
  );
  await writeFile(
    join(cwd, "apps", "acode-cli", "tsconfig.test.json"),
    JSON.stringify({ compilerOptions: { baseUrl: "../..", paths: { "@cli/*": ["packages/*/src/*"] } } }),
  );
  return cwd;
}

test("architecture discovery searches package ancestors and sibling workspace packages", async (t) => {
  const cwd = await fixture(t);
  const policy = await loadPolicy(cwd);
  const packages = await discoverWorkspacePackages(policy);
  assert.equal(packages["@acme/foo"], join(cwd, "packages", "foo"));
  assert.equal(packages["@acme/bar"], join(cwd, "packages", "bar"));
  assert.equal(packages.ignored, undefined);
  assert.equal(packages["private-state"], undefined);
});

test("architecture discovery collects root and nested tsconfig aliases", async (t) => {
  const cwd = await fixture(t);
  const policy = await loadPolicy(cwd);
  const aliases = await discoverTsconfigAliases(policy);
  assert.deepEqual(
    aliases.map(({ pattern, target }) => ({ pattern, target })).sort((a, b) => a.pattern.localeCompare(b.pattern)),
    [
      { pattern: "@cli/*", target: join(cwd, "packages", "*", "src", "*") },
      { pattern: "@root/*", target: join(cwd, "packages", "*", "src", "*") },
    ],
  );
});

test("repository policy discovers the real UI tsconfig alias", async () => {
  let cwd = process.cwd();
  while (cwd !== dirname(cwd)) {
    try {
      await access(join(cwd, "architecture-policy.yaml"));
      break;
    } catch {
      cwd = dirname(cwd);
    }
  }
  const policy = await loadPolicy(cwd);
  const aliases = await discoverTsconfigAliases(policy);
  // 修复依据：原断言硬编码 Windows 反斜杠分隔（packages\\ui\\src\\*），Linux CI 上
  // discoverTsconfigAliases 产出斜杠形态 target 必然失配（dev/0.0.7 CI 红灯根因）。
  // 断言不应对分隔符形态做平台假设：统一归一到 posix 后比较，两平台同语义。
  const toPosix = (value) => value.split("\\").join("/");
  assert.ok(
    aliases.some(
      ({ pattern, target }) =>
        pattern === "@/*" && toPosix(target).endsWith("packages/ui/src/*"),
    ),
    "packages/ui/tsconfig.json alias must enter the architecture resolver",
  );
});
