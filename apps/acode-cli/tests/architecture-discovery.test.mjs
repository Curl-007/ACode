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
  // cua-producer 与真包 packages/foo 撞名（同名 @acme/foo），复现 U14 角色 A 骨架的
  // name-collision 危险面：discoverWorkspacePackages 用 packages[manifest.name]=root 建表、
  // 同名后写覆盖前者，胜出方取决于 readdir 原始顺序（未排序，非确定）。
  await mkdir(join(cwd, "cua-producer"), { recursive: true });
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
  // cua-producer 声明与 packages/foo 相同的包名，用于验证它在 SKIP_DIRECTORIES 内被排除、
  // 不劫持 @acme/foo 的映射。
  await writeFile(join(cwd, "cua-producer", "package.json"), JSON.stringify({ name: "@acme/foo" }));
  // 另放一个唯一名包在 cua-producer 子树内：它不与任何真包撞名，故「是否出现在映射里」
  // 只取决于 cua-producer 是否被 SKIP 排除——与 readdir 顺序无关。这是下面回归测试的确定性锚点。
  await mkdir(join(cwd, "cua-producer", "nested-probe"), { recursive: true });
  await writeFile(
    join(cwd, "cua-producer", "nested-probe", "package.json"),
    JSON.stringify({ name: "@acme/cua-producer-must-be-skipped" }),
  );
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

test("architecture discovery skips cua-producer so it cannot hijack a colliding package name", async (t) => {
  const cwd = await fixture(t);
  const policy = await loadPolicy(cwd);
  const packages = await discoverWorkspacePackages(policy);
  // 确定性锚点：cua-producer/nested-probe 声明唯一名 @acme/cua-producer-must-be-skipped，
  // 不与任何真包撞名，故它是否出现在映射里只取决于 cua-producer 是否被 SKIP 排除——与
  // readdir 顺序无关。若把 cua-producer 移出 SKIP_DIRECTORIES，此断言确定性失败（不是间歇）。
  assert.equal(
    packages["@acme/cua-producer-must-be-skipped"],
    undefined,
    "cua-producer subtree must be excluded from workspace package discovery",
  );
  // 撞名面：cua-producer/package.json 也声明 @acme/foo。它被排除后，@acme/foo 唯一解析到真包。
  // 注意此断言本身在 readdir 侥幸让真包后写时也会通过，真正的回归锁是上面的唯一名锚点；
  // 这里一并断言是为表达「撞名不劫持」的完整意图（U14 §7.8：建目录与改 SKIP 必须原子同批）。
  assert.equal(packages["@acme/foo"], join(cwd, "packages", "foo"));
  assert.ok(
    !Object.values(packages).some((root) => String(root).includes("cua-producer")),
    "no workspace package may resolve into the skipped cua-producer directory",
  );
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
