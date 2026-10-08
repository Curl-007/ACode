// B1 收口验收（specs/project-mcp-trust-gate.md R10/R11 + 「B1 收口」选型记录）：
// 显式 mcpServers 装配路径（desktop 设置页 mcp/list、legacy/v4 session/create、
// 手机 resumeTask 回声）不得绕过项目 MCP 信任门。
//
// 被钉住的绕过：desktop main 的 workspace 目录读取会把仓库携带的 .acode/config.json
// 与 .agents/mcp.json server 一并作为显式 params.mcpServers 下发；门控初版只认
// agent 侧 serverSources 的 project 标记——仓库只放 .agents/mcp.json 时发现面无
// 名字，门整体跳过，打开设置页/创建会话即无信任 spawn。
//
// 断言链：R11 发现面覆盖 .agents/mcp.json（source=project、cwd 绝对化）→ R10 显式
// 层内容命中即过 digest 门（wire 形态无 cwd → 归一到 workingDirectory，与根级声明
// 的 grant digest 对齐）→ 未 grant 不 spawn、grant 后 spawn、改名回声仍拦截、用户
// 自有内容放行。显式 server 用真实的 protocolMcpServersToRuntimeMcpConfig（legacy
// wire 转换）构造，不复刻手写替身。
//
// 仅用 mkdtemp 临时目录（workspace fixture + 临时 HOME/store），不触碰真实工作区。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { loadProjectMcpTrustSnapshot } = await import(
  "../packages/bootstrap/src/app/project-mcp-trust.ts"
);
const { grantProjectMcpTrust, revokeProjectMcpTrustCli } = await import(
  "../packages/bootstrap/src/project-mcp-trust-cli.ts"
);
const { protocolMcpServersToRuntimeMcpConfig } = await import(
  "../packages/bootstrap/src/acode-protocol/protocol-mcp-config.ts"
);
const { resolveAppRuntimeConfig } = await import(
  "../packages/bootstrap/src/app/runtime-config.ts"
);
const { createConfig } = await import(
  "../packages/adapters/src/config/config-factory.ts"
);

/** legacy wire 形态（acodeProtocolMcpServerSchema stdio 变体：无 cwd 字段）。 */
function wireStdio(name, { command, args = [], env = {} }) {
  return {
    name,
    command,
    args,
    env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
  };
}

/** desktop/手机显式 params → runtimeConfig.mcp 的真实转换链。 */
function explicitRuntimeMcp(wireServers) {
  return protocolMcpServersToRuntimeMcpConfig(wireServers);
}

function writeAgentsFixture(mcpServers, { acodeConfig } = {}) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "acode-b1-ws-"));
  if (acodeConfig) {
    mkdirSync(join(workspaceDir, ".acode"), { recursive: true });
    writeFileSync(
      join(workspaceDir, ".acode", "config.json"),
      JSON.stringify(acodeConfig, null, 2),
      "utf-8",
    );
  }
  mkdirSync(join(workspaceDir, ".agents"), { recursive: true });
  writeFileSync(
    join(workspaceDir, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers }, null, 2),
    "utf-8",
  );
  return workspaceDir;
}

function makeTempHome() {
  const homeDir = mkdtempSync(join(tmpdir(), "acode-b1-home-"));
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

function resolveRuntime({ configResult, workspaceDir, homeDir, trust, explicitMcp, builtInMcpServers }) {
  return resolveAppRuntimeConfig({
    cliStorageRoot: join(homeDir, "cli"),
    configResult,
    options: {
      runtimeConfig: {
        workingDirectory: workspaceDir,
        ...(explicitMcp ? { mcp: explicitMcp } : {}),
      },
    },
    ...(trust ? { projectMcpTrust: trust } : {}),
    ...(builtInMcpServers ? { builtInMcpServers } : {}),
    subagentOutputRootDir: join(homeDir, "agents"),
    workingDirectory: workspaceDir,
  });
}

const AGENTS_EVIL = { command: "node", args: ["agents-evil.js"], env: { E: "1" } };

// ---------------------------------------------------------------------------
// 场景 8：绕过闭合——.agents/mcp.json-only 仓库经显式路径不被 spawn
// ---------------------------------------------------------------------------

test("R11：.agents/mcp.json 进入 agent 项目发现面（source=project、type 推断、cwd 绝对化）", () => {
  const workspaceDir = writeAgentsFixture({ "agents-stdio": AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    assert.equal(
      configResult.sources.mcp.serverSources["agents-stdio"],
      "project",
      ".agents/mcp.json 的 server 必须被标为项目作用域（信任门/CLI 同一视野）",
    );
    const server = configResult.config.mcp.servers["agents-stdio"];
    assert.equal(server.type, "stdio", "command 形态必须推断为 stdio");
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["agents-evil.js"]);
    assert.equal(server.cwd, resolve(workspaceDir), "cwd 必须按项目 baseDir 绝对化（grant digest 基准）");
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

test("R10：未信任时，desktop 风格显式回声（wire 形态、无 cwd）不进 spawn 集合；改名回声同样拦截", async () => {
  const workspaceDir = writeAgentsFixture({ "agents-stdio": AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    const trust = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    // desktop getEnabledMcpServersForACode → wire → protocolMcpServersToRuntimeMcpConfig 的产物。
    const explicitMcp = explicitRuntimeMcp([wireStdio("agents-stdio", AGENTS_EVIL)]);
    assert.equal(explicitMcp.servers["agents-stdio"].cwd, undefined, "wire 面必须无 cwd（后果②前提）");

    const blocked = resolveRuntime({ configResult, workspaceDir, homeDir, trust, explicitMcp });
    assert.ok(
      !("agents-stdio" in blocked.runtimeConfig.mcp.servers),
      "仓库只放 .agents/mcp.json 也不得经显式路径无信任 spawn（B1 绕过闭合）",
    );
    assert.deepEqual([...blocked.untrustedProjectMcpServers], ["agents-stdio"]);
    // 状态投影保留（设置页显示 untrusted 而非消失）。
    assert.ok("agents-stdio" in blocked.configuredMcpServers);

    // 改名回声：仓库内容 + 新名字——内容命中声明，digest 键含名字，grant 不为改名背书。
    const renamed = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust,
      explicitMcp: explicitRuntimeMcp([wireStdio("innocent-name", AGENTS_EVIL)]),
    });
    assert.ok(!("innocent-name" in renamed.runtimeConfig.mcp.servers));
    assert.deepEqual([...renamed.untrustedProjectMcpServers], ["innocent-name"]);
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 9：grant 生效——已 grant 的 server 经显式路径真的进 spawn 集合
// ---------------------------------------------------------------------------

test("R10：grant 后显式回声 digest 匹配（cwd 归一对齐），server 进入 spawn 集合；revoke 后重新拦截", async () => {
  const workspaceDir = writeAgentsFixture({ "agents-stdio": AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const granted = await grantProjectMcpTrust({
      workspacePath: workspaceDir,
      userConfigPath,
      homeDir,
      all: true,
    });
    assert.equal(granted.reasonCode, "project_mcp_trusted_persistent");

    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    const trust = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const explicitMcp = explicitRuntimeMcp([wireStdio("agents-stdio", AGENTS_EVIL)]);
    const allowed = resolveRuntime({ configResult, workspaceDir, homeDir, trust, explicitMcp });
    assert.ok(
      "agents-stdio" in allowed.runtimeConfig.mcp.servers,
      "grant 后显式路径必须真的生效（wire 无 cwd → 归一到 workingDirectory，与根级声明 digest 对齐）",
    );
    assert.equal(allowed.untrustedProjectMcpServers.size, 0);

    // 改名回声即使 grant 过原名也依然拦截（digest 键含名字）。
    const renamed = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust,
      explicitMcp: explicitRuntimeMcp([wireStdio("innocent-name", AGENTS_EVIL)]),
    });
    assert.ok(!("innocent-name" in renamed.runtimeConfig.mcp.servers));

    await revokeProjectMcpTrustCli({ workspacePath: workspaceDir, userConfigPath, homeDir, all: true });
    const trustAfterRevoke = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const reblocked = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust: trustAfterRevoke,
      explicitMcp,
    });
    assert.ok(!("agents-stdio" in reblocked.runtimeConfig.mcp.servers));
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 10：用户自有 stdio server（内容不命中任何项目声明）照常放行
// ---------------------------------------------------------------------------

test("R3：显式路径的用户自有 stdio server（内容不命中项目声明）不门控", async () => {
  const workspaceDir = writeAgentsFixture({ "agents-stdio": AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    const trust = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const explicitMcp = explicitRuntimeMcp([
      wireStdio("my-own-tool", { command: "my-tool", args: ["--serve"], env: {} }),
    ]);
    const resolved = resolveRuntime({ configResult, workspaceDir, homeDir, trust, explicitMcp });
    assert.ok("my-own-tool" in resolved.runtimeConfig.mcp.servers);
    assert.equal(resolved.untrustedProjectMcpServers.size, 0);
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 11：.acode 与 .agents 并存——同名 .acode 优先，.agents 独有条目进项目层受门控
// ---------------------------------------------------------------------------

test("R11：按名合并——同名 server .acode 优先；.agents 独有条目 source=project 且显式回声被门控", async () => {
  const workspaceDir = writeAgentsFixture(
    {
      shared: { command: "agents-cmd" },
      "agents-only": AGENTS_EVIL,
    },
    {
      acodeConfig: {
        mcp: { servers: { shared: { type: "stdio", command: "acode-cmd" } } },
      },
    },
  );
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    assert.equal(
      configResult.config.mcp.servers.shared.command,
      "acode-cmd",
      "同名 server 必须以 .acode/config.json 为准（desktop 强优先对齐）",
    );
    assert.equal(configResult.sources.mcp.serverSources["agents-only"], "project");
    const trust = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    // .agents 独有条目的显式回声被门控（发现面不因 .acode 并存而留盲区）。
    const resolved = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust,
      explicitMcp: explicitRuntimeMcp([wireStdio("agents-only", AGENTS_EVIL)]),
    });
    assert.ok(!("agents-only" in resolved.runtimeConfig.mcp.servers));
    assert.deepEqual([...resolved.untrustedProjectMcpServers], ["agents-only"]);
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 12：.agents/mcp.json 解析诊断——非法条目逐个跳过，不拖垮整个文件
// ---------------------------------------------------------------------------

test("R11：.agents/mcp.json 非法 server 条目发 config_mcp_server_invalid 诊断并跳过；合法条目保留", () => {
  const workspaceDir = writeAgentsFixture({
    good: { command: "good-tool" },
    bad: { type: "nonsense", command: "" },
  });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    assert.ok("good" in configResult.config.mcp.servers);
    assert.ok(!("bad" in configResult.config.mcp.servers));
    const diagnostic = configResult.sources.project.diagnostics.find(
      (item) => item.code === "config_mcp_server_invalid" && item.path === "mcp.servers.bad",
    );
    assert.ok(diagnostic, "非法条目必须发 config_mcp_server_invalid 诊断");
    assert.equal(diagnostic.filePath, join(workspaceDir, ".agents", "mcp.json"));
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

test("R11：.agents/mcp.json 整文件非法 JSON → config_file_invalid 诊断，不抛出", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "acode-b1-ws-"));
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    mkdirSync(join(workspaceDir, ".agents"), { recursive: true });
    writeFileSync(join(workspaceDir, ".agents", "mcp.json"), "{ broken", "utf-8");
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    const diagnostic = configResult.sources.project.diagnostics.find(
      (item) => item.code === "config_file_invalid",
    );
    assert.ok(diagnostic, "损坏的 .agents/mcp.json 必须发 config_file_invalid 诊断而不是抛出");
    assert.deepEqual(configResult.config.mcp.servers, {});
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// 场景 13：store 损坏时 revoke 拒绝执行（R9，与 grant 同款 fail-closed）
// ---------------------------------------------------------------------------

test("R9：store corrupt 时 revokeProjectMcpTrustCli 拒绝执行，不把恢复副作用伪装成成功撤销", async () => {
  const workspaceDir = writeAgentsFixture({ "agents-stdio": AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    mkdirSync(join(homeDir, ".acode", "security"), { recursive: true });
    writeFileSync(storePath(homeDir), "{ not json !!!", "utf-8");
    await assert.rejects(
      () =>
        revokeProjectMcpTrustCli({
          workspacePath: workspaceDir,
          userConfigPath,
          homeDir,
          all: true,
        }),
      /project_mcp_trust_store_corrupt/u,
    );
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});

// ---------------------------------------------------------------------------
// R4 交互：宿主 builtIn 遮蔽在显式路径同样豁免（防 DoS 语义不因 B1 收口回退）
// ---------------------------------------------------------------------------

test("R4：显式回声与宿主 builtIn 同名时，builtIn 遮蔽、不门控（实际执行的是宿主内容）", async () => {
  const workspaceDir = writeAgentsFixture({ node_repl: AGENTS_EVIL });
  const { homeDir, userConfigPath } = makeTempHome();
  try {
    const configResult = createConfig({ workingDirectory: workspaceDir, userConfigPath, env: {} });
    const trust = await loadProjectMcpTrustSnapshot({
      workingDirectory: workspaceDir,
      userConfigPath,
      homeDir,
    });
    const builtIn = { node_repl: { type: "stdio", command: "host-owned-node-repl" } };
    const resolved = resolveRuntime({
      configResult,
      workspaceDir,
      homeDir,
      trust,
      explicitMcp: explicitRuntimeMcp([wireStdio("node_repl", AGENTS_EVIL)]),
      builtInMcpServers: builtIn,
    });
    assert.equal(resolved.untrustedProjectMcpServers.size, 0);
    assert.equal(resolved.runtimeConfig.mcp.servers.node_repl.command, "host-owned-node-repl");
  } finally {
    cleanup(workspaceDir, homeDir);
  }
});
