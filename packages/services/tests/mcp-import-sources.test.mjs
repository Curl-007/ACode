import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

/**
 * 阶段二 MCP 面验收（docs/specs/provider-config-import.md R7）：
 * - JSONC 解析契约（R7.5：注释/尾逗号、失败只给行号、错误消息不含原文片段）；
 * - 来源表扩展 cursor/gemini/vscode/opencode.jsonc/cc-switch（R7.1/R7.2）；
 * - 变量引用不展开 + 只带位置与键名的告警（R7.6/R7.7）；
 * - 写入收敛到 mcp-sync 唯一漏斗（Q2）：`~/.acode/cli/config.json` 的 mcp.servers 落盘、
 *   legacy `enable` → `enabled` 迁移、原子写无残留临时文件、其它顶层键保留。
 *
 * 夹具全部合成（合成 key 前缀 `sk-test-fake-`），cc-switch 库在临时目录现造。
 */

const { parseJsonc } = await import("../src/settings-sync/jsonc.ts");
const {
  collectExternalMcpSourceRoots,
  detectMcpVariableReferences,
  readMcpServersFromSourceFile,
  resolveVsCodeUserMcpFiles,
  SUPPORTED_MCP_AGENT_SOURCES,
} = await import("../src/settings-sync/mcpExternalSources.ts");
const { upsertAcodeMcpServers } = await import("../src/mcp-sync/mcpSyncService.ts");
const { createSettingsSyncService } = await import("../src/settings-sync/settingsSyncService.ts");

const FAKE_ENV_SECRET = "sk-test-fake-mcp-env-0001";

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "acode-mcp-import-home-"));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

async function withTempHomeAsync(fn) {
  const home = mkdtempSync(join(tmpdir(), "acode-mcp-import-home-"));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

// —— R7.5 JSONC ——

test("parseJsonc：去注释与尾逗号、保留结构；空文本视为无内容", () => {
  const parsed = parseJsonc(`{
    // 行注释
    "servers": {
      "demo": { "command": "npx", /* 块注释
        跨行 */ "args": ["-y", "pkg",], },
    },
  }`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { servers: { demo: { command: "npx", args: ["-y", "pkg"] } } });

  const empty = parseJsonc("   \n  ");
  assert.deepEqual(empty, { ok: true, value: undefined });

  // 字符串内的 // 与 /* 不能被当注释吃掉。
  const inString = parseJsonc('{ "url": "https://x.test/a//b", "note": "/* not a comment */" }');
  assert.equal(inString.ok, true);
  assert.equal(inString.value.url, "https://x.test/a//b");
  assert.equal(inString.value.note, "/* not a comment */");
});

test("N14 JSONC 解析失败只给行号，错误对象不含原文片段", () => {
  const unterminated = parseJsonc('{\n  "servers": {\n  /* 未闭合\n  "a": 1\n}\n');
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.line, 3);
  assert.deepEqual(Object.keys(unterminated), ["ok", "line"]);

  const secret = "sk-test-fake-jsonc-0002";
  // 该形态的 V8 错误带位置 → 可给出行号；失败对象自身只有 ok/line，绝不带原文片段。
  const broken = parseJsonc(`{\n  "servers": [1 2, "${secret}"]\n}`);
  assert.equal(broken.ok, false);
  assert.equal(broken.line, 2);
  assert.ok(Object.keys(broken).every((key) => key === "ok" || key === "line"));
  assert.ok(!JSON.stringify(broken).includes(secret), "失败对象不得含原文片段");
});

// —— R7.1/R7.2 来源表扩展 ——

test("来源表新增 cursor/gemini/vscode/opencode.jsonc/cc-switch 且格式与包装键正确", () => {
  const byKey = new Map(SUPPORTED_MCP_AGENT_SOURCES.map((source) => [`${source.agent}:${source.format}`, source]));
  assert.ok(byKey.has("cursor:mcpServersJson"));
  assert.ok(byKey.has("gemini:mcpServersJson"));
  const vscode = byKey.get("vscode:jsonc");
  assert.equal(vscode.wrapperKey, "servers");
  const openCodeJsonc = SUPPORTED_MCP_AGENT_SOURCES.find(
    (source) => source.agent === "openCode" && source.format === "jsonc",
  );
  assert.equal(openCodeJsonc.wrapperKey, "mcp");
  const ccSwitch = byKey.get("ccSwitch:ccSwitchSqlite");
  assert.deepEqual(ccSwitch.globalFiles, [[".cc-switch", "cc-switch.db"]]);
});

test("VS Code 平台候选路径（win/mac/linux）与来源根展开", () => {
  // node:path 的 join 按平台分隔符输出；期望值同样用 join 构造，避免平台耦合断言。
  const win = resolveVsCodeUserMcpFiles("/home/u", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
  assert.ok(win.includes(join("C:\\Users\\u\\AppData\\Roaming", "Code", "User", "mcp.json")));
  assert.ok(
    win.includes(join("C:\\Users\\u\\AppData\\Roaming", "Code - Insiders", "User", "mcp.json")),
  );

  const mac = resolveVsCodeUserMcpFiles("/Users/u", {});
  assert.ok(mac.includes(join("/Users/u", "Library", "Application Support", "Code", "User", "mcp.json")));

  const linux = resolveVsCodeUserMcpFiles("/home/u", { XDG_CONFIG_HOME: "/home/u/.config" });
  assert.ok(linux.includes(join("/home/u/.config", "Code", "User", "mcp.json")));

  const roots = collectExternalMcpSourceRoots("/home/u", "/ws", { XDG_CONFIG_HOME: "/home/u/.config" });
  const keys = roots.map((root) => `${root.agent}:${root.scope}`);
  assert.ok(keys.includes("cursor:user"));
  assert.ok(keys.includes("gemini:user"));
  assert.ok(keys.includes("vscode:user"));
  assert.ok(keys.includes("ccSwitch:user"));
  assert.ok(roots.some((root) => root.agent === "vscode" && root.rootPath.endsWith("mcp.json")));
  assert.ok(roots.some((root) => root.agent === "openCode" && root.rootPath.endsWith("opencode.jsonc")));
});

test("readMcpServersFromSourceFile：jsonc（VS Code `servers` 与 OpenCode `mcp`）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-jsonc-"));
  try {
    const vscodePath = join(dir, "mcp.json");
    writeFileSync(
      vscodePath,
      '{\n  // VS Code 允许注释\n  "servers": {\n    "demo": { "command": "npx", "args": ["-y", "pkg",], },\n  },\n}\n',
      "utf8",
    );
    const vscodeServers = await readMcpServersFromSourceFile(vscodePath, "jsonc", "servers");
    assert.deepEqual(Object.keys(vscodeServers), ["demo"]);
    assert.deepEqual(vscodeServers.demo.args, ["-y", "pkg"]);

    const opencodePath = join(dir, "opencode.jsonc");
    writeFileSync(
      opencodePath,
      '{\n  "mcp": {\n    "local-one": { "type": "local", "command": ["node", "server.js"], "environment": { "TOKEN": "${MY_TOKEN}" } },\n  },\n}\n',
      "utf8",
    );
    const opencodeServers = await readMcpServersFromSourceFile(opencodePath, "jsonc", "mcp");
    assert.equal(opencodeServers["local-one"].type, "stdio");
    assert.equal(opencodeServers["local-one"].command, "node");
    assert.deepEqual(opencodeServers["local-one"].args, ["server.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMcpServersFromSourceFile：cc-switch mcp_servers（只读副本 + 关闭态）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-ccswitch-"));
  try {
    const dbPath = join(dir, "cc-switch.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT, server_config TEXT, enabled INTEGER)",
    );
    const insert = db.prepare("INSERT INTO mcp_servers (id, name, server_config, enabled) VALUES (?,?,?,?)");
    insert.run("m1", "demo", JSON.stringify({ command: "npx", args: ["-y", "pkg"] }), 1);
    insert.run("m2", "off", JSON.stringify({ command: "node", args: ["s.js"] }), 0);
    db.close();
    const before = readFileSync(dbPath);

    const servers = await readMcpServersFromSourceFile(dbPath, "ccSwitchSqlite");
    assert.equal(servers.demo.command, "npx");
    assert.equal(servers.off.enabled, false, "显式关闭的行落 enabled:false");
    assert.deepEqual(readFileSync(dbPath), before, "源库只读：字节不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— R7.6/R7.7 变量引用 ——

test("N13 变量引用告警只含位置与键名，不含值", () => {
  const warnings = detectMcpVariableReferences({
    command: "npx",
    args: ["-y", "${PKG_NAME}", "plain"],
    env: { API_TOKEN: `${FAKE_ENV_SECRET}`, PLAIN: "x", REF: "${SOME_VAR}" },
    headers: { Authorization: "Bearer ${TOKEN}", "X-Static": "static" },
    url: "https://example.test/mcp/${TENANT}",
  });
  assert.deepEqual(warnings, [
    { kind: "variable-reference", location: "env", keys: ["REF"] },
    { kind: "variable-reference", location: "headers", keys: ["Authorization"] },
    { kind: "variable-reference", location: "args", keys: ["1"] },
    { kind: "variable-reference", location: "url", keys: [] },
  ]);
  const serialized = JSON.stringify(warnings);
  assert.ok(!serialized.includes(FAKE_ENV_SECRET), "告警不得含 env 值");
  assert.ok(!serialized.includes("${SOME_VAR}"), "告警不得含变量表达式原文");
  assert.ok(!serialized.includes("plain"), "告警不得含无引用的值");

  // 无引用时零告警。
  assert.deepEqual(detectMcpVariableReferences({ command: "npx", env: { A: "1" } }), []);
});

// —— Q2 写入收敛 ——

test("upsertAcodeMcpServers：写入 ACODE_MCP_DESCRIPTOR 路径 + legacy enable 迁移 + 保留其它键", async () => {
  await withTempHomeAsync(async (home) => {
    const configPath = join(home, ".acode", "cli", "config.json");
    mkdirSync(join(home, ".acode", "cli"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          otherTopLevel: { keep: true },
          mcp: {
            keepMe: 1,
            servers: { existing: { command: "node", args: ["a.js"], enable: false } },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await upsertAcodeMcpServers({
      scope: "user",
      servers: { imported: { command: "npx", args: ["-y", "pkg"] } },
    });

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(written.otherTopLevel, { keep: true }, "其它顶层键保留");
    assert.equal(written.mcp.keepMe, 1, "mcp 的兄弟键保留");
    assert.deepEqual(written.mcp.servers.imported, { command: "npx", args: ["-y", "pkg"] });
    assert.equal(written.mcp.servers.existing.enable, undefined, "legacy enable 已折叠");
    assert.equal(written.mcp.servers.existing.enabled, false, "legacy enable:false → enabled:false");
    assert.deepEqual(readdirSync(join(home, ".acode", "cli")), ["config.json"], "无残留临时文件");
  });
});

test("场景10 集成：settings-sync 导入 MCP 经唯一漏斗落盘 + 变量引用告警 + 无明文", async () => {
  await withTempHomeAsync(async (home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const cursorPath = join(home, ".cursor", "mcp.json");
    writeFileSync(
      cursorPath,
      JSON.stringify(
        {
          mcpServers: {
            demo: {
              command: "npx",
              args: ["-y", "pkg"],
              env: { API_TOKEN: FAKE_ENV_SECRET, REF: `${FAKE_ENV_SECRET}-${"${SOME_VAR}"}` },
              headers: { Authorization: "Bearer ${TOKEN}" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = createSettingsSyncService({
      settingService: { get: async () => ({}), update: async () => {} },
    });
    const result = await service.importSelected({
      selections: [
        {
          agent: "cursor",
          category: "mcpServers",
          targetScope: "global",
          importMode: "copy",
          mcpServerPaths: [`${cursorPath}#demo`],
        },
      ],
    });

    const taskResult = result.taskResults[0];
    const item = taskResult.mcpServerResults[0];
    assert.equal(item.status, "imported");
    assert.equal(taskResult.importedCount, 1);
    // R7.6：变量引用告警只带位置与键名。
    const locations = new Set(item.warnings.map((warning) => warning.location));
    assert.ok(locations.has("env"));
    assert.ok(locations.has("headers"));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(FAKE_ENV_SECRET), "结果载荷不得含 env 值");
    assert.ok(!serialized.includes("${SOME_VAR}"), "结果载荷不得含变量表达式原文");

    // Q2：落盘走 mcp-sync 漏斗（~/.acode/cli/config.json 的 mcp.servers）。
    const written = JSON.parse(readFileSync(join(home, ".acode", "cli", "config.json"), "utf8"));
    assert.deepEqual(written.mcp.servers.demo.command, "npx");
    assert.deepEqual(written.mcp.servers.demo.args, ["-y", "pkg"]);
    // 变量引用原样保留（不展开）。
    assert.equal(written.mcp.servers.demo.env.REF.startsWith(FAKE_ENV_SECRET), true);
    assert.ok(!existsSync(join(home, ".cursor", "mcp.json.tmp")));
  });
});

test("场景10b：openCode.jsonc 与 gemini 来源可被发现（detect）", async () => {
  await withTempHomeAsync(async (home) => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.jsonc"),
      '{\n  // jsonc 变体\n  "mcp": { "oc": { "command": ["node", "s.js"], } },\n}\n',
      "utf8",
    );
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { gem: { command: "node", args: ["g.js"] } } }),
      "utf8",
    );

    const service = createSettingsSyncService({
      settingService: { get: async () => ({}), update: async () => {} },
    });
    const discovery = await service.detect({ intent: "manualImport", categories: ["mcpServers"] });
    const agents = discovery.agents.map((agent) => agent.agent);
    assert.ok(agents.includes("openCode"));
    assert.ok(agents.includes("gemini"));
    const openCodeAgent = discovery.agents.find((agent) => agent.agent === "openCode");
    const mcpCategory = openCodeAgent.categories.find((item) => item.category === "mcpServers");
    assert.ok(mcpCategory.discoveredCount >= 1);
  });
});