// 安全修复 H2（specs/project-mcp-trust-gate.md）的验收测试：项目作用域 stdio MCP
// server 的信任门。
//
// 被钉住的缺陷：untrustedProjectMcpServers 恒空集（「产品决定 workspace MCP 开箱
// 即用」），项目 .acode/config.json 声明的 stdio server 在 AgentRuntime 启动期即被
// spawn（adapters/mcp 直接用仓库文件的 command/args/env 执行子进程）——clone+打开
// 恶意仓库即 RCE，早于任何用户输入。
//
// 断言链：未信任 → 不进 runtimeConfig.mcp.servers（startMcpStartup 只 spawn 该集合，
// 即不 spawn）；grant 后 → 进入（即会 spawn）；配置内容变化 → digest 变化 → 重新拦截；
// store 损坏 → fail-closed；user 作用域与宿主 builtIn 遮蔽 → 不门控。
//
// 仅用 mkdtemp 临时目录（workspace fixture + 临时 HOME/store），绝不触碰真实工作区
// 或 ~/.acode。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const {
  computeProjectMcpServerDigest,
  loadProjectMcpTrustSnapshot,
  resolveUntrustedProjectMcpServers,
  resolveProjectMcpTrustIdentity,
} = await import("../packages/bootstrap/src/app/project-mcp-trust.ts");
const {
  inspectProjectMcpTrust,
  grantProjectMcpTrust,
  revokeProjectMcpTrustCli,
} = await import("../packages/bootstrap/src/project-mcp-trust-cli.ts");
const {
  createFileWorkspaceMcpTrustStore,
} = await import("../packages/adapters/src/storage/workspace-mcp-trust-store.ts");
const { resolveAppRuntimeConfig } = await import(
  "../packages/bootstrap/src/app/runtime-config.ts"
);
const { createConfig } = await import(
  "../packages/adapters/src/config/config-factory.ts"
);

const STDIO_SERVER = { type: "stdio", command: "node", args: ["mcp-evil.js"] };
const HTTP_SERVER = { type: "http", url: "https://example.com/mcp" };

/** 恶意仓库 fixture：.acode/config.json 声明项目作用域 MCP server。 */
function writeWorkspaceFixture(servers) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "acode-h2-ws-"));
  mkdirSync(join(workspaceDir, ".acode"), { recursive: true });
  const configPath = join(workspaceDir, ".acode", "config.json");
  writeFileSync(configPath, JSON.stringify({ mcp: { servers } }, null, 2), "utf-8");
  return { workspaceDir, configPath };
}

/** 临时 HOME（store 落 homeDir/.acode/security/）+ 空用户配置（隔离真实 ~/.acode）。 */
function makeTempHome() {
  const homeDir = mkdtempSync(join(tmpdir(), "acode-h2-home-"));
  const userConfigPath = join(homeDir, "user-config.json");
  writeFileSync(userConfigPath, JSON.stringify({}), "utf-8");
  return { homeDir, userConfigPath };
}

function storePath(homeDir) {
  return join(homeDir, ".acode", "security", "workspace-mcp-trust-v1.json");
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function resolveRuntime(input) {
  const { configResult, workspaceDir, homeDir, trust, builtInMcpServers } = input;
  return resolveAppRuntimeConfig({
    cliStorageRoot: join(homeDir, "cli"),
    configResult,
    options: { runtimeConfig: { workingDirectory: workspaceDir } },
    ...(trust ? { projectMcpTrust: trust } : {}),
    ...(builtInMcpServers ? { builtInMcpServers } : {}),
    subagentOutputRootDir: join(homeDir, "agents"),
    workingDirectory: workspaceDir,
  });
}

// ---------------------------------------------------------------------------
// 场景 1+2+3：未信任不 spawn → grant 后 spawn → digest 变化重新拦截（全链）
// ---------------------------------------------------------------------------

test("项目 stdio server：未信任不进自动连接集合；grant 后进入；内容变化重新拦截", async () => {
  const { workspaceDir, configPath } = writeWorkspaceFixture({
    "proj-stdio": STDIO_SERVER,
    "proj-http": HTTP_SERVER,
  });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({
      workingDirectory: workspaceDir,
      userConfigPath,
      env: {},
    });
    assert.equal(
      configResult.sources.mcp.serverSources["proj-stdio"],
      "project",
      "serverSources 必须把 fixture server 标为项目作用域（单一事实源）",
    );

    // 未信任：fail-closed，stdio 被拦、http 不受门控（spec R1/R2）。
    const untrustedSnapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    assert.equal(untrustedSnapshot.status, "missing");
    assert.equal(untrustedSnapshot.workspaceIdentity, resolve(workspaceDir));
    const blocked = resolveRuntime({ configResult, workspaceDir, homeDir, trust: untrustedSnapshot });
    assert.ok(
      !("proj-stdio" in blocked.runtimeConfig.mcp.servers),
      "未信任的项目 stdio server 不得进入 runtimeConfig.mcp.servers（startMcpStartup 只 spawn 该集合）",
    );
    assert.ok(
      "proj-http" in blocked.runtimeConfig.mcp.servers,
      "项目 http server 不 spawn 本地进程，维持自动连接（R2）",
    );
    assert.deepEqual([...blocked.untrustedProjectMcpServers], ["proj-stdio"]);
    assert.equal(blocked.pendingProjectMcpServers.length, 1);
    assert.equal(blocked.pendingProjectMcpServers[0].name, "proj-stdio");
    assert.match(blocked.pendingProjectMcpServers[0].digest, /^[a-f0-9]{64}$/u);
    // 状态投影不消失：configuredMcpServers 保留全量（facade 标 untrusted 而非静默丢弃）。
    assert.ok("proj-stdio" in blocked.configuredMcpServers);

    // 快照缺省（调用方未注入）同样 fail-closed。
    const defaulted = resolveRuntime({ configResult, workspaceDir, homeDir });
    assert.ok(!("proj-stdio" in defaulted.runtimeConfig.mcp.servers));

    // grant --all：按当前配置内容钉 digest 持久化，之后进入自动连接集合（即会 spawn）。
    const granted = await grantProjectMcpTrust({
      workspacePath: workspaceDir,
      userConfigPath,
      homeDir,
      all: true,
      appVersion: "test",
    });
    assert.equal(granted.reasonCode, "project_mcp_trusted_persistent");
    const stdioItem = granted.items.find((item) => item.serverName === "proj-stdio");
    assert.equal(stdioItem.trustState, "trusted_persistent");
    assert.equal(stdioItem.displayCommand, "node mcp-evil.js");

    const trustedSnapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    assert.equal(trustedSnapshot.status, "ok");
    const allowed = resolveRuntime({ configResult, workspaceDir, homeDir, trust: trustedSnapshot });
    assert.ok(
      "proj-stdio" in allowed.runtimeConfig.mcp.servers,
      "信任后项目 stdio server 必须进入自动连接集合（spawn 恢复）",
    );
    assert.equal(allowed.untrustedProjectMcpServers.size, 0);

    // 配置内容变化（args 换了 payload）→ digest 变化 → 旧信任失效，重新拦截（spec R5）。
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcp: {
            servers: {
              "proj-stdio": { type: "stdio", command: "node", args: ["mcp-payload-2.js"] },
              "proj-http": HTTP_SERVER,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    const changedResult = createConfig({
      workingDirectory: workspaceDir,
      userConfigPath,
      env: {},
    });
    const changedSnapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const reblocked = resolveRuntime({
      configResult: changedResult,
      workspaceDir,
      homeDir,
      trust: changedSnapshot,
    });
    assert.ok(
      !("proj-stdio" in reblocked.runtimeConfig.mcp.servers),
      "digest 变化后必须重新拦截（信任按内容钉死，配置变更即失效）",
    );

    // revoke --all 后回到未信任态。
    await revokeProjectMcpTrustCli({ workspacePath: workspaceDir, userConfigPath, homeDir, all: true });
    const afterRevoke = await inspectProjectMcpTrust({
      workspacePath: workspaceDir,
      userConfigPath,
      homeDir,
    });
    assert.equal(afterRevoke.reasonCode, "project_mcp_pending_trust");
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 4：store 损坏 → fail-closed + 改名留证
// ---------------------------------------------------------------------------

test("store 损坏：fail-closed（全部项目 stdio untrusted）且损坏文件改名留证", async () => {
  const { workspaceDir } = writeWorkspaceFixture({ "proj-stdio": STDIO_SERVER });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    mkdirSync(join(homeDir, ".acode", "security"), { recursive: true });
    // grant 是第一个读者：corrupt 下拒绝执行（不得把恢复副作用伪装成成功授权），
    // load 的恢复逻辑已把损坏文件改名留证。
    writeFileSync(storePath(homeDir), "{ not json !!!", "utf-8");
    await assert.rejects(
      () =>
        grantProjectMcpTrust({
          workspacePath: workspaceDir,
          userConfigPath,
          homeDir,
          all: true,
        }),
      /project_mcp_trust_store_corrupt/u,
    );
    const securityDir = readdirSync(join(homeDir, ".acode", "security"));
    assert.ok(
      securityDir.some((name) => name.startsWith("workspace-mcp-trust-v1.json.corrupt-")),
      "损坏文件必须按 hooks 同款语义改名留证",
    );
    // 快照加载是第一个读者时：status=corrupt、空信任集（fail-closed），门控照常拦截。
    writeFileSync(storePath(homeDir), "{ not json !!!", "utf-8");
    const snapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    assert.equal(snapshot.status, "corrupt");
    assert.equal(snapshot.trustedKeys.size, 0);
    const inspect = await inspectProjectMcpTrust({
      workspacePath: workspaceDir,
      userConfigPath,
      homeDir,
    });
    // inspect 时损坏文件已被快照 load 改名恢复——CLI 报 pending 而不是伪装 corrupt。
    assert.ok(
      inspect.reasonCode === "project_mcp_pending_trust" ||
        inspect.reasonCode === "project_mcp_trust_store_corrupt",
    );
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 5+6：作用域与宿主 authority 边界
// ---------------------------------------------------------------------------

test("user 作用域 stdio server 不门控；项目同名被 user 覆盖后也不门控（R3）", async () => {
  const { workspaceDir } = writeWorkspaceFixture({ "proj-stdio": STDIO_SERVER });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcp: {
          servers: {
            "user-stdio": { type: "stdio", command: "user-tool" },
            // 与项目声明同名：user 覆盖 project（serverSources 记 user）。
            "proj-stdio": { type: "stdio", command: "user-override" },
          },
        },
      }),
      "utf-8",
    );
    const configResult = createConfig({
      workingDirectory: workspaceDir,
      userConfigPath,
      env: {},
    });
    assert.equal(configResult.sources.mcp.serverSources["user-stdio"], "user");
    assert.equal(configResult.sources.mcp.serverSources["proj-stdio"], "user");
    const snapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const resolved = resolveRuntime({ configResult, workspaceDir, homeDir, trust: snapshot });
    assert.ok("user-stdio" in resolved.runtimeConfig.mcp.servers);
    assert.ok("proj-stdio" in resolved.runtimeConfig.mcp.servers);
    assert.equal(resolved.runtimeConfig.mcp.servers["proj-stdio"].command, "user-override");
    assert.equal(resolved.untrustedProjectMcpServers.size, 0);
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

test("宿主 builtIn 遮蔽项目同名声明：不门控（R4，防「声明同名 node_repl」DoS 宿主工具）", async () => {
  const { workspaceDir } = writeWorkspaceFixture({ node_repl: STDIO_SERVER });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({
      workingDirectory: workspaceDir,
      userConfigPath,
      env: {},
    });
    const builtIn = { node_repl: { type: "stdio", command: "host-owned-node-repl" } };
    const snapshot = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const resolved = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust: snapshot,
      builtInMcpServers: builtIn,
    });
    assert.equal(resolved.untrustedProjectMcpServers.size, 0);
    assert.equal(
      resolved.runtimeConfig.mcp.servers.node_repl.command,
      "host-owned-node-repl",
      "实际生效的必须是宿主对象（引用相等判定豁免门控）",
    );
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

test("serverSources 缺席（旧形态/测试替身）：门控不触发，保持既有装配行为", () => {
  const servers = { "proj-stdio": STDIO_SERVER };
  const gate = resolveUntrustedProjectMcpServers({
    configuredMcpServers: servers,
    configLayerServers: servers,
    serverSources: undefined,
  });
  assert.equal(gate.untrustedServerNames.size, 0);
});

// ---------------------------------------------------------------------------
// 场景 7：digest 稳定性与规范化
// ---------------------------------------------------------------------------

test("digest：同配置稳定、env 键序无关、内容变化即变化", () => {
  const a = computeProjectMcpServerDigest("srv", {
    type: "stdio",
    command: "node",
    args: ["a.js"],
    env: { A: "1", B: "2" },
  });
  const b = computeProjectMcpServerDigest("srv", {
    type: "stdio",
    command: "node",
    args: ["a.js"],
    env: { B: "2", A: "1" },
  });
  assert.equal(a, b, "env 键序不得影响 digest");
  assert.match(a, /^[a-f0-9]{64}$/u);
  const renamed = computeProjectMcpServerDigest("srv2", {
    type: "stdio",
    command: "node",
    args: ["a.js"],
    env: { A: "1", B: "2" },
  });
  assert.notEqual(a, renamed, "server 名参与 digest（改名即失效）");
  const changedArgs = computeProjectMcpServerDigest("srv", {
    type: "stdio",
    command: "node",
    args: ["b.js"],
    env: { A: "1", B: "2" },
  });
  assert.notEqual(a, changedArgs);
  const changedEnv = computeProjectMcpServerDigest("srv", {
    type: "stdio",
    command: "node",
    args: ["a.js"],
    env: { A: "1", B: "3" },
  });
  assert.notEqual(a, changedEnv);
});

// ---------------------------------------------------------------------------
// store 层：三态 revoke 与身份隔离
// ---------------------------------------------------------------------------

test("store：revoke 三态（undefined=全部、非空=精确、空数组拒绝）与身份隔离", async () => {
  const { homeDir } = makeTempHome();
  try {
    const filePath = storePath(homeDir);
    const store = createFileWorkspaceMcpTrustStore({ filePath });
    const base = {
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: new Date().toISOString(),
      displayCommandAtGrant: "node a.js",
    };
    const digest = computeProjectMcpServerDigest("srv", { type: "stdio", command: "node", args: ["a.js"] });
    await store.grant([
      { workspaceIdentity: "ws-a", serverName: "srv", mcpServerDigest: digest, ...base },
      { workspaceIdentity: "ws-b", serverName: "srv", mcpServerDigest: digest, ...base },
    ]);
    await assert.rejects(
      () => store.revoke({ workspaceIdentity: "ws-a", serverNames: [] }),
      /non-empty/u,
      "空数组必须在任何 IO 前拒绝（三态与 hooks 同款）",
    );
    await store.revoke({ workspaceIdentity: "ws-a", serverNames: ["srv"] });
    const loaded = await store.load();
    assert.equal(loaded.status, "ok");
    assert.deepEqual(
      loaded.records.map((record) => record.workspaceIdentity),
      ["ws-b"],
      "精确 revoke 只删目标身份的记录",
    );
    await store.revoke({ workspaceIdentity: "ws-b" });
    const emptied = await store.load();
    assert.deepEqual(emptied.records, []);
  } finally {
    cleanup(homeDir);
  }
});

test("身份解析：identity 优先、缺省回落绝对路径（AGENTS 全局约定）", () => {
  assert.equal(
    resolveProjectMcpTrustIdentity({ workspaceIdentity: " remote:ws-1 ", workingDirectory: "C:\\w" }),
    "remote:ws-1",
  );
  assert.equal(
    resolveProjectMcpTrustIdentity({ workspaceIdentity: "   ", workingDirectory: "C:\\w" }),
    resolve("C:\\w"),
  );
});

test("inspect：无项目 stdio server 时 reasonCode 为 not_applicable", async () => {
  const { workspaceDir } = writeWorkspaceFixture({ "proj-http": HTTP_SERVER });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const status = await inspectProjectMcpTrust({ workspacePath: workspaceDir, userConfigPath, homeDir });
    assert.equal(status.reasonCode, "project_mcp_not_applicable");
    assert.deepEqual(status.items, []);
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});
