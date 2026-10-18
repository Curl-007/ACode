import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * 市场安装事务化与管线硬化验收（specs/plugin-install-transactions.md）：
 *  - 装前 validate 门失败 → 拒装且零副作用（前后文件树对比）；
 *  - 安装事务：closure 中段失败 → 已激活目标回滚 + 注册表逐字节复原；
 *    回滚自身失败 → fail-loud 状态文件 + 聚合错误；
 *  - dry-run：全部校验 + 计划生成，storageRoot 零写盘；
 *  - 来源规格硬化：元字符黑名单、市场 git 源 host 白名单、URL 凭据剥离（持久化面无 token）。
 */

const marketplace = await import("../packages/adapters/src/plugins/marketplace.ts");
const transactionModule = await import("../packages/adapters/src/plugins/install-transaction.ts");
const hardening = await import("../packages/adapters/src/plugins/source-spec-hardening.ts");
const validation = await import("../packages/adapters/src/plugins/install-validation.ts");

async function newStorageRoot() {
  return mkdtemp(join(tmpdir(), "acode-install-tx-"));
}

/** 递归快照 storageRoot 相对路径（目录以 / 结尾），用作前后文件树对比。 */
async function treeSnapshot(root) {
  const entries = [];
  const walk = async (current) => {
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const child = join(current, dirent.name);
      const rel = relative(root, child).split(/[\\/]+/u).join("/");
      entries.push(dirent.isDirectory() ? `${rel}/` : rel);
      if (dirent.isDirectory()) await walk(child);
    }
  };
  await walk(root);
  return entries.sort();
}

async function assertTreeUnchanged(root, snapshot, label) {
  assert.deepEqual(await treeSnapshot(root), snapshot, label);
}

/** 向 root 写入一批相对路径文件（自动建父目录）。 */
function writePluginFixture(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * 本地目录市场 fixture：写入 marketDir 并 addMarketplace（这一步的落盘先于
 * 各测试的树快照，后续对比不受影响）。
 */
async function seedMarketplace(storageRoot, marketName, plugins) {
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-fixture-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: marketName,
      plugins,
    }),
  });
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  return marketDir;
}

const goodPluginA = {
  name: "plugin-a",
  source: "./plugin-a",
  version: "1.0.0",
};

/** 在 marketDir 里补一个最小可用插件目录（manifest + 一个 skill 文件）。 */
function writePluginDir(marketDir, pluginName, extraFiles = {}, manifest = undefined) {
  writePluginFixture(marketDir, {
    [join(pluginName, ".acode-plugin", "plugin.json")]: JSON.stringify(
      manifest ?? { name: pluginName, version: "1.0.0" },
    ),
    [join(pluginName, "skills", "demo", "SKILL.md")]:
      "---\nname: demo\ndescription: demo skill\n---\nbody\n",
    ...extraFiles,
  });
}

test("marketplace git spec host allowlist: omp host set allowed, others rejected", () => {
  const { describeMarketplaceGitSourceSpecViolation, MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS } = hardening;
  assert.deepEqual([...MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS].sort(), [
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
    "github.com",
    "gitlab.com",
    "www.github.com",
  ]);
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://gitlab.com/owner/repo.git",
    "https://bitbucket.org/owner/repo.git",
    "https://codeberg.org/owner/repo.git",
    "https://git.sr.ht/~owner/repo",
    "git@github.com:owner/repo.git",
    "ssh://git@gitlab.com/owner/repo.git",
  ]) {
    assert.equal(describeMarketplaceGitSourceSpecViolation({ url }), null, url);
  }
  for (const [url, reason] of [
    ["https://evil.example/owner/repo.git", /host is not allowed/u],
    ["http://github.com/owner/repo.git", /protocol is not allowed/u],
    ["ftp://github.com/owner/repo.git", /protocol is not allowed/u],
    // 空格本身就是元字符：门序为元字符优先，两种拒绝原因都算 fail-closed。
    ["not a url", /(protocol is not allowed|shell metacharacter)/u],
  ]) {
    assert.match(
      describeMarketplaceGitSourceSpecViolation({ url }) ?? "",
      reason,
      `expected violation for ${url}`,
    );
  }
});

test("shell metacharacter denylist rejects injection payloads in url/ref", () => {
  const { describeShellMetacharViolation } = hardening;
  for (const payload of [
    "main;rm -rf /",
    "main|cat /etc/passwd",
    "main$(curl evil)",
    "main`id`",
    "main&whoami",
    "main\ncrlf",
  ]) {
    assert.match(
      describeShellMetacharViolation(payload, "git source ref") ?? "",
      /shell metacharacter/u,
      payload,
    );
  }
  assert.equal(describeShellMetacharViolation("main-v1.2.3", "git source ref"), null);
  assert.equal(describeShellMetacharViolation("https://github.com/o/r.git", "git source url"), null);
});

test("parseMarketplaceSourceInput enforces the gate and strips credentials", async () => {
  // 凭据剥离：user:token@host 不应出现在解析结果里。
  const withCreds = await marketplace.parseMarketplaceSourceInput(
    "https://ci-bot:ghp_secrettoken@github.com/owner/repo.git",
  );
  assert.equal(withCreds.source, "git");
  assert.equal(withCreds.url.includes("ghp_secrettoken"), false);
  assert.equal(withCreds.url.startsWith("https://github.com/"), true);

  // 白名单内新主机（omp 集合）放行。
  const gitlab = await marketplace.parseMarketplaceSourceInput("https://gitlab.com/o/r.git");
  assert.equal(gitlab.source, "git");
  assert.equal(gitlab.url, "https://gitlab.com/o/r.git");

  // 非白名单主机与元字符 ref 直接拒绝。
  await assert.rejects(
    marketplace.parseMarketplaceSourceInput("https://evil.example/o/r.git"),
    /host is not allowed/u,
  );
  await assert.rejects(
    marketplace.parseMarketplaceSourceInput("https://github.com/o/r.git#main;rm"),
    /shell metacharacter/u,
  );
  await assert.rejects(
    marketplace.parseMarketplaceSourceInput("http://github.com/o/r.git"),
    /protocol is not allowed/u,
  );

  // url 型（直指 JSON）源不进 spawn：不做 host 门，只剥离凭据。
  const catalog = await marketplace.parseMarketplaceSourceInput(
    "https://ci-bot:tok123@example.com/catalog.json",
  );
  assert.equal(catalog.source, "url");
  assert.equal(catalog.url.includes("tok123"), false);
});

test("stripPluginSourceCredentials: pure transform is deep, idempotent and keeps non-URL text", () => {
  const source = {
    source: "git",
    url: "https://user:ghp_secret@github.com/o/r.git",
    nested: [{ url: "https://u2:pw2@gitlab.com/g/r.git" }, "plain text with $ not a url"],
  };
  const outcome = hardening.stripPluginSourceCredentials(source);
  assert.deepEqual(outcome.redactedHosts.sort(), ["github.com", "gitlab.com"]);
  const serialized = JSON.stringify(outcome.value);
  assert.equal(serialized.includes("ghp_secret"), false);
  assert.equal(serialized.includes("pw2"), false);
  assert.equal(serialized.includes("plain text with $ not a url"), true);
  assert.deepEqual(hardening.stripPluginSourceCredentials(outcome.value).redactedHosts, []);

  // scp-like user:pass@host:path 保留用户段、剥掉口令段。
  const scp = hardening.stripUserInfoFromString("myuser:secrettoken@git.sr.ht:~/repo.git");
  assert.equal(scp.hadCredentials, true);
  assert.equal(scp.redacted.includes("secrettoken"), false);
  assert.equal(scp.redacted.startsWith("myuser@"), true);
});

test("dry-run install: full validation + plan with zero writes to storageRoot", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-dryrun-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "dryrun-market",
      plugins: [goodPluginA],
    }),
  });
  writePluginDir(marketDir, "plugin-a");
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  const before = await treeSnapshot(storageRoot);

  const dry = await marketplace.installMarketplacePlugin({
    marketplace: "dryrun-market",
    name: "plugin-a",
    storageRoot,
    dryRun: true,
  });

  assert.equal(dry.installed.length, 0);
  assert.equal(dry.plan?.dryRun, true);
  assert.deepEqual(dry.plan?.closure, ["plugin-a@dryrun-market"]);
  assert.equal(dry.plan?.entries.length, 1);
  assert.equal(dry.plan?.entries[0]?.action, "install");
  assert.equal(dry.plan?.entries[0]?.plannedVersion, "1.0.0");
  assert.match(dry.plan?.entries[0]?.plannedCacheDir ?? "", /[\\/]1\.0\.0$/u);
  await assertTreeUnchanged(storageRoot, before, "dry-run must not touch storageRoot");

  // 计划与真实安装一致：随后真实安装成功，版本来自同一条版本链。
  const real = await marketplace.installMarketplacePlugin({
    marketplace: "dryrun-market",
    name: "plugin-a",
    storageRoot,
  });
  assert.equal(real.installed[0]?.version, "1.0.0");
  assert.ok(existsSync(real.installed[0]?.installPath ?? ""));

  // 已安装后再次 dry-run：升级语义 replace + previousVersion。
  const upgradeDry = await marketplace.installMarketplacePlugin({
    marketplace: "dryrun-market",
    name: "plugin-a",
    storageRoot,
    dryRun: true,
  });
  assert.equal(upgradeDry.plan?.entries[0]?.action, "replace");
  assert.equal(upgradeDry.plan?.entries[0]?.previousVersion, "1.0.0");
  await rm(marketDir, { force: true, recursive: true });
});

test("validate gate rejects broken plugins with zero side effects", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-broken-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "broken-market",
      plugins: [
        { name: "declares-missing-path", source: "./declares-missing-path" },
        { name: "no-manifest", source: "./no-manifest" },
        {
          name: "missing-mcp-command",
          source: "./missing-mcp-command",
        },
      ],
    }),
  });
  // manifest 声明了不存在的 commands 目录。
  writePluginDir(marketDir, "declares-missing-path", {}, {
    name: "declares-missing-path",
    version: "1.0.0",
    commands: ["commands"],
  });
  // 空目录（strict 缺省 = true）→ manifest 缺失阻断。
  mkdirSync(join(marketDir, "no-manifest"), { recursive: true });
  // stdio command 指向插件内不存在的可执行文件。
  writePluginDir(marketDir, "missing-mcp-command", {
    [join("missing-mcp-command", ".mcp.json")]: JSON.stringify({
      mcpServers: {
        broken: { type: "stdio", command: "./bin/definitely-missing-tool-xyz" },
      },
    }),
  });
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });

  for (const pluginName of ["declares-missing-path", "no-manifest", "missing-mcp-command"]) {
    const before = await treeSnapshot(storageRoot);
    await assert.rejects(
      marketplace.installMarketplacePlugin({
        marketplace: "broken-market",
        name: pluginName,
        storageRoot,
      }),
      (error) => {
        assert.match(error?.message ?? "", /Plugin install validation failed/u);
        assert.match(error?.message ?? "", /plugin_(component_path_invalid|manifest_not_found)/u);
        return true;
      },
      pluginName,
    );
    await assertTreeUnchanged(storageRoot, before, `${pluginName} rejection must leave no trace`);
  }
  await rm(marketDir, { force: true, recursive: true });
});

test("validate gate tolerates runtime-variable MCP env and PATH commands (official-plugin shape)", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-official-shape-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "official-shape-market",
      plugins: [{ name: "stdio-plugin", source: "./stdio-plugin" }],
    }),
  });
  // 形态对齐官方 stdio 插件：command 为 PATH 裸命令，env 引用 user_config（安装进程不可解析）。
  writePluginDir(marketDir, "stdio-plugin", {
    [join("stdio-plugin", ".mcp.json")]: JSON.stringify({
      mcpServers: {
        team: {
          type: "stdio",
          command: "node",
          args: ["${ACODE_PLUGIN_ROOT}/dist/mcp/server.js"],
          env: { TEAM_TOKEN: "${user_config.missing_everywhere}" },
        },
      },
    }),
  }, { name: "stdio-plugin", version: "2.0.0" });
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });

  const result = await marketplace.installMarketplacePlugin({
    marketplace: "official-shape-market",
    name: "stdio-plugin",
    storageRoot,
  });
  assert.equal(result.installed.length, 1);
  // 变量缺失是运行期事实：降级为 warnings，不阻断安装。
  // 注意：mcp resolver 产出的 plugin_variable_missing 自带 severity "error"，
  // 阻断/容忍分诊规则是「error 且非 plugin_variable_missing」（spec R1）。
  assert.ok(
    (result.warnings ?? []).some(
      (diagnostic) => diagnostic.code === "plugin_variable_missing",
    ),
    "expected tolerated plugin_variable_missing warning",
  );
  assert.ok(
    !(result.warnings ?? []).some(
      (diagnostic) =>
        diagnostic.severity === "error" && diagnostic.code !== "plugin_variable_missing",
    ),
    JSON.stringify(result.warnings ?? []),
  );
  await rm(marketDir, { force: true, recursive: true });
});

test("transaction rolls back activated targets and registry on mid-closure failure", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-rollback-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "rollback-market",
      plugins: [
        // 依赖先装并激活；根插件在下载/解析阶段失败（不可支持的 source kind），
        // 注入「第二阶段失败」→ 前一插件的激活必须整体回滚。
        { name: "root-plugin", source: { source: "definitely-not-a-kind" }, dependencies: ["plugin-dep"] },
        { name: "plugin-dep", source: "./plugin-dep", version: "0.1.0" },
      ],
    }),
  });
  writePluginDir(marketDir, "plugin-dep", {}, { name: "plugin-dep", version: "0.1.0" });
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  // 安装前注册表尚不存在（nothing installed）：快照语义 = 缺失，回滚后必须仍缺失。
  const registryBefore = existsSync(join(storageRoot, "installed_plugins.json"))
    ? readFileSync(join(storageRoot, "installed_plugins.json"), "utf8")
    : null;
  const before = await treeSnapshot(storageRoot);

  await assert.rejects(
    marketplace.installMarketplacePlugin({
      marketplace: "rollback-market",
      name: "root-plugin",
      storageRoot,
    }),
    /rolled back to the pre-install snapshot/u,
  );
  await assertTreeUnchanged(storageRoot, before, "mid-closure failure must restore the whole tree");
  const registryAfter = existsSync(join(storageRoot, "installed_plugins.json"))
    ? readFileSync(join(storageRoot, "installed_plugins.json"), "utf8")
    : null;
  assert.equal(registryAfter, registryBefore, "registry must be byte-identical after rollback");
  // 回滚完全成功时不留 fail-loud 状态文件。
  assert.ok(!existsSync(join(storageRoot, ".install-transactions")));
  await rm(marketDir, { force: true, recursive: true });
});

test("validate-stage failure after a prior activation also rolls back", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-rollback2-"));
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "rollback-market-2",
      plugins: [
        {
          name: "root-plugin",
          source: "./root-plugin",
          dependencies: ["plugin-dep"],
        },
        { name: "plugin-dep", source: "./plugin-dep", version: "0.1.0" },
      ],
    }),
  });
  writePluginDir(marketDir, "plugin-dep", {}, { name: "plugin-dep", version: "0.1.0" });
  // 根插件自身 manifest 声明了缺失路径 → validate 门在 dep 激活之后阻断。
  writePluginDir(marketDir, "root-plugin", {}, {
    name: "root-plugin",
    version: "1.0.0",
    commands: ["missing-commands-dir"],
  });
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  const registryBefore = existsSync(join(storageRoot, "installed_plugins.json"))
    ? readFileSync(join(storageRoot, "installed_plugins.json"), "utf8")
    : null;
  const before = await treeSnapshot(storageRoot);
  await assert.rejects(
    marketplace.installMarketplacePlugin({
      marketplace: "rollback-market-2",
      name: "root-plugin",
      storageRoot,
    }),
    /Plugin install validation failed/u,
  );
  await assertTreeUnchanged(storageRoot, before, "validate-stage failure must restore the tree");
  const registryAfter = existsSync(join(storageRoot, "installed_plugins.json"))
    ? readFileSync(join(storageRoot, "installed_plugins.json"), "utf8")
    : null;
  assert.equal(registryAfter, registryBefore);
  await rm(marketDir, { force: true, recursive: true });
});

test("transaction unit: registry snapshot restore on rollback", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const registryPath = join(storageRoot, "installed_plugins.json");
  await writeFile(registryPath, '{"version":1,"plugins":[{"id":"x@a"}]}\n', "utf8");
  const tx = await transactionModule.beginMarketplaceInstallTransaction({ storageRoot });
  await writeFile(registryPath, '{"version":1,"plugins":[{"id":"y@b"},{"id":"z@c"}]}\n', "utf8");
  await assert.rejects(
    tx.rollback({ error: new Error("boom"), stage: "unit" }),
    /boom; install rolled back to the pre-install snapshot/u,
  );
  assert.equal(
    await readFile(registryPath, "utf8"),
    '{"version":1,"plugins":[{"id":"x@a"}]}\n',
    "registry must be restored to the snapshot",
  );
});

test("transaction unit: registry absence snapshot removes the file on rollback", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const registryPath = join(storageRoot, "installed_plugins.json");
  const tx = await transactionModule.beginMarketplaceInstallTransaction({ storageRoot });
  await writeFile(registryPath, "{}\n", "utf8");
  await assert.rejects(tx.rollback({ error: new Error("boom"), stage: "unit" }), /boom/u);
  assert.ok(!existsSync(registryPath), "registry file created during install must be removed");
});

test("rollback failure is fail-loud with a diagnosable state file", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const target = join(storageRoot, "cache", "m", "p", "1.0.0");
  await mkdir(join(target, "content"), { recursive: true });
  await writeFile(join(target, "content", "file.txt"), "v1", "utf8");
  const tx = await transactionModule.beginMarketplaceInstallTransaction({ storageRoot });
  await tx.snapshotTarget(target);
  // 注入「内容不可恢复」：目标与其 activation backup 一并消失，快照无法复原。
  await rm(target, { force: true, recursive: true });
  await assert.rejects(
    tx.rollback({ error: new Error("stage failed"), stage: "place", pluginId: "p@m" }),
    (error) => {
      assert.equal(error?.name, "MarketplaceInstallRollbackError");
      assert.match(error?.message ?? "", /stage failed/u);
      assert.match(error?.message ?? "", /install rollback FAILED/u);
      assert.match(error?.message ?? "", /failed-[\w-]+\.json/u);
      return true;
    },
  );
  const reportDir = join(storageRoot, ".install-transactions");
  const reports = await readdir(reportDir);
  assert.equal(reports.length, 1);
  const report = JSON.parse(await readFile(join(reportDir, reports[0] ?? ""), "utf8"));
  assert.equal(report.originalError, "stage failed");
  assert.equal(report.pluginId, "p@m");
  assert.equal(report.stage, "place");
  assert.equal(report.registry.hadContent, false);
  assert.equal(report.targets[0]?.snapshotExisted, true);
  assert.equal(report.targets[0]?.outcome, "mismatch");
});

test("version resolution chain: plugin.json → package.json → catalog → sha[:7] → default", () => {
  const { resolvePluginInstallVersionChain } = validation;
  const makeRoot = async () => mkdtemp(join(tmpdir(), "acode-version-chain-"));

  return (async () => {
    // 1. plugin.json 优先。
    const withManifest = await makeRoot();
    writePluginFixture(withManifest, {
      [join(".acode-plugin", "plugin.json")]: JSON.stringify({ name: "p", version: "1.2.3" }),
      "package.json": JSON.stringify({ name: "p", version: "9.9.9" }),
    });
    assert.deepEqual(resolvePluginInstallVersionChain({ entry: { name: "p", raw: {} }, rootPath: withManifest }), {
      version: "1.2.3",
      provenance: "plugin.json",
      manifestVersion: "1.2.3",
    });

    // 2. 无 manifest 版本时回退 package.json。
    const withPackage = await makeRoot();
    writePluginFixture(withPackage, {
      [join(".acode-plugin", "plugin.json")]: JSON.stringify({ name: "p" }),
      "package.json": JSON.stringify({ name: "p", version: "4.5.6" }),
    });
    assert.equal(
      resolvePluginInstallVersionChain({ entry: { name: "p", raw: {} }, rootPath: withPackage }).version,
      "4.5.6",
    );
    assert.equal(
      resolvePluginInstallVersionChain({ entry: { name: "p", raw: {} }, rootPath: withPackage }).provenance,
      "package.json",
    );

    // 3. catalog 条目版本。
    const bare = await makeRoot();
    assert.deepEqual(
      resolvePluginInstallVersionChain({
        entry: { name: "p", version: "7.7.7", raw: {} },
        rootPath: bare,
      }),
      { version: "7.7.7", provenance: "catalog", catalogVersion: "7.7.7" },
    );

    // 4. 源锚点前 7 位。
    const sha = "abcdef1234567890".repeat(4);
    assert.equal(
      resolvePluginInstallVersionChain({
        entry: { name: "p", raw: {}, source: { source: "git", url: "https://github.com/o/r.git", sha } },
        rootPath: bare,
      }).version,
      sha.slice(0, 7),
    );

    // 5. 兜底 0.0.0。
    assert.equal(
      resolvePluginInstallVersionChain({ entry: { name: "p", raw: {} }, rootPath: bare }).version,
      "0.0.0",
    );

    for (const dir of [withManifest, withPackage, bare]) {
      await rm(dir, { force: true, recursive: true });
    }
  })();
});

test("validate gate blocks cache-unsafe versions", () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "acode-version-unsafe-"));
  try {
    writePluginFixture(storageRoot, {
      [join(".acode-plugin", "plugin.json")]: JSON.stringify({ name: "p", version: "../../evil" }),
    });
    const gate = validation.validatePluginForInstall({
      entry: { name: "p", raw: {} },
      marketplace: "m",
      rootPath: storageRoot,
      storageRoot,
    });
    assert.equal(gate.blocking.length, 1);
    assert.match(gate.blocking[0]?.message ?? "", /not safe for cache paths/u);
  } finally {
    rmSync(storageRoot, { force: true, recursive: true });
  }
});

test("catalog credential stripping: persisted marketplace copy contains no token", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-creds-"));
  const secret = "ghp_LIVE_TOKEN_123";
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "creds-market",
      plugins: [
        {
          name: "git-plugin",
          source: {
            source: "git",
            url: `https://ci-bot:${secret}@github.com/owner/repo.git`,
            sha: "c".repeat(40),
          },
        },
      ],
    }),
  });
  const diagnostics = await marketplace.validateMarketplaceSource({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  // 校验面披露剥离告警（normalize 层收集）。
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "warning" && /stripped before persistence/u.test(diagnostic.message),
    ),
    JSON.stringify(diagnostics),
  );

  // addMarketplace 持久化目录副本后，任何持久化文件都不得含 token。
  await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  const persistedDir = join(storageRoot, "marketplaces", "creds-market");
  // 根副本与 cp 进来的 .claude-plugin 副本都要干净。
  for (const manifestCopy of [
    join(persistedDir, "marketplace.json"),
    join(persistedDir, ".claude-plugin", "marketplace.json"),
  ]) {
    const catalogCopy = await readFile(manifestCopy, "utf8");
    assert.equal(
      catalogCopy.includes(secret),
      false,
      `token must not land in the persisted catalog copy: ${manifestCopy}`,
    );
    assert.equal(catalogCopy.includes("ci-bot@"), false);
    assert.ok(catalogCopy.includes("https://github.com/owner/repo.git"));
  }

  const knownRaw = await readFile(join(storageRoot, "known_marketplaces.json"), "utf8");
  assert.equal(knownRaw.includes(secret), false);
  await rm(marketDir, { force: true, recursive: true });
});

test("addMarketplace records credentialRedaction when the marketplace source itself carries credentials", async (t) => {
  const storageRoot = await newStorageRoot();
  t.after(() => rm(storageRoot, { force: true, recursive: true }));
  const marketDir = await mkdtemp(join(tmpdir(), "acode-market-own-creds-"));
  const secret = "ghp_SOURCE_TOKEN_9";
  writePluginFixture(marketDir, {
    [join(".claude-plugin", "marketplace.json")]: JSON.stringify({
      name: "own-creds-market",
      plugins: [{ name: "local", source: "./local" }],
    }),
  });
  writePluginDir(marketDir, "local");
  // 本地目录市场不带凭据；known record 的 redaction 走 parse 层单测覆盖，
  // 这里用 directory 源验证「无凭据时不产生告警事实」。
  const record = await marketplace.addMarketplace({
    source: { source: "directory", path: marketDir },
    storageRoot,
  });
  assert.equal(record.credentialRedaction, undefined);

  // git URL 源的剥离事实由 parseMarketplaceSourceInput 单测 + 本函数的输入剥离覆盖。
  const stripped = hardening.stripPluginSourceCredentials({
    source: "git",
    url: `https://u:${secret}@github.com/o/r.git`,
  });
  assert.deepEqual(stripped.redactedHosts, ["github.com"]);
  assert.equal(JSON.stringify(stripped.value).includes(secret), false);
  await rm(marketDir, { force: true, recursive: true });
});
