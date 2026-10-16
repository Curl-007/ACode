import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * guide 技能「Current Build」实时自知节验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/guide-live-build-section.md 的 R1-R6 与验收场景 1-6：
 * - 场景 1：无占位符零成本透传（skillPort 不被触碰）；
 * - 场景 2：全量渲染 + 秘密纪律（配置值绝不进快照，只列键名/服务器名）；
 * - 场景 3：子节级降级（version 缺席、discoverSkills 抛错）互不连坐；
 * - 场景 4：节级降级（采集整体抛错）占位符仍被替换，注入不抛；
 * - 场景 5：会话缓存（一次性生成、version 变化失效、降级不缓存）；
 * - 场景 6：静态件（SKILL.md 学说要素、recent-changes.md、skill.ts 接线、400 行上限）。
 */

const {
  LIVE_BUILD_PLACEHOLDER,
  clearLiveBuildSectionCache,
  collectLiveBuildSnapshot,
  injectLiveBuildSection,
  renderDegradedSection,
  renderLiveBuildSection,
} = await import("../packages/core/src/tool/handlers/skill-live-build.ts");

const FIXED_NOW = () => new Date("2026-10-15T08:00:00.000Z");
const SECRET = "super-secret-token-do-not-render";

/** 造假 skillPort：只实现 discoverSkills，形状对齐 contracts SkillLoadOutcome 的消费面。 */
function fakeSkillPort(skills, { failWith } = {}) {
  return {
    calls: 0,
    async discoverSkills() {
      this.calls += 1;
      if (failWith) throw failWith;
      return { skills, diagnostics: [], totalDiscovered: skills.length };
    },
  };
}

async function makeTree() {
  const home = await mkdtemp(join(tmpdir(), "live-build-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "live-build-ws-"));
  await mkdir(join(home, ".acode", "cli"), { recursive: true });
  await writeFile(
    join(home, ".acode", "cli", "config.json"),
    JSON.stringify({
      hooks: { enabled: true },
      mcp: { servers: { "my-server": { command: "npx", args: ["-y", SECRET], env: { KEY: SECRET } } } },
      plugins: {},
    }),
  );
  await mkdir(join(home, ".agents", "commands"), { recursive: true });
  await writeFile(join(home, ".agents", "commands", "foo.md"), "# foo\n");
  await mkdir(join(home, ".acode", "cli", "agents"), { recursive: true });
  await writeFile(join(home, ".acode", "cli", "agents", "reviewer.md"), "# reviewer\n");
  await mkdir(join(workspace, ".acode", "commands", "review"), { recursive: true });
  await writeFile(join(workspace, ".acode", "commands", "review", "code.md"), "# review\n");
  await mkdir(join(workspace, ".acode", "agents"), { recursive: true });
  await writeFile(join(workspace, ".acode", "agents", "writer.md"), "# writer\n");
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await writeFile(
    join(workspace, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers: { "ws-server": { url: "https://example.invalid/mcp" } } }),
  );
  return { home, workspace };
}

function baseInput(tree, extra = {}) {
  return {
    workingDirectory: tree.workspace,
    workspaceRoot: tree.workspace,
    homeDirectory: tree.home,
    now: FIXED_NOW,
    toolNames: ["Bash", "Read", "Skill"],
    ...extra,
  };
}

test("场景 1：无占位符零成本透传，skillPort 不被调用（R1）", async () => {
  clearLiveBuildSectionCache();
  const tree = await makeTree();
  const port = fakeSkillPort([{ name: "x", scope: "user", source: "acode" }]);
  const content = "# plain skill\nno placeholder here\n";
  const out = await injectLiveBuildSection(content, baseInput(tree, { skillPort: port }));
  assert.equal(out, content);
  assert.equal(port.calls, 0);
});

test("场景 2：全量渲染——工具/技能/命令/agents/MCP/设置键在场，秘密值绝不出现（R2/R3）", async () => {
  clearLiveBuildSectionCache();
  const tree = await makeTree();
  const port = fakeSkillPort([
    { name: "zcode-configuration-guide", qualifiedName: "acode-guide:zcode-configuration-guide", scope: "user", source: "plugin" },
  ]);
  const out = await injectLiveBuildSection(
    `before\n${LIVE_BUILD_PLACEHOLDER}\nafter\n${LIVE_BUILD_PLACEHOLDER}`,
    baseInput(tree, { skillPort: port, sessionId: "sess-full" }),
  );
  assert.ok(out.startsWith("before\n"));
  assert.ok(out.includes("## Current Build (live snapshot)"));
  assert.ok(out.includes("2026-10-15T08:00:00.000Z"));
  // 占位符出现多次 → 全部替换（R1）。
  assert.equal(out.split("## Current Build (live snapshot)").length - 1, 2);
  assert.ok(!out.includes(LIVE_BUILD_PLACEHOLDER));
  // runtime truth 子节
  assert.ok(out.includes("`Bash`") && out.includes("`Skill`"));
  assert.ok(out.includes("- acode-guide:zcode-configuration-guide (scope: user, source: plugin)"));
  // 磁盘 best-effort 子节
  assert.ok(out.includes("- /foo (user)"), "user 命令根扫描缺失");
  assert.ok(out.includes("- /review:code (workspace)"), "嵌套命令应以冒号连接");
  assert.ok(out.includes("- reviewer (user)") && out.includes("- writer (workspace)"));
  assert.ok(out.includes("- my-server (user, stdio)"));
  assert.ok(out.includes("- ws-server (workspace (.agents fallback), http)"));
  assert.ok(out.includes("hooks, mcp, plugins"), "设置子节应只列顶层键名（排序后）");
  // 未接线的子节显式降级而非缺失（R3）
  assert.ok(out.includes("unavailable this time"));
  assert.ok(out.includes("Built-in slash command table: unavailable this time"));
  // R3 秘密纪律：配置值（args/env 里的 token）绝不出现在输出任何位置
  assert.ok(!out.includes(SECRET));
  assert.ok(!out.includes("npx"));
});

test("场景 3：子节降级互不连坐——discoverSkills 抛错只降级技能子节（R3）", async () => {
  clearLiveBuildSectionCache();
  const tree = await makeTree();
  const port = fakeSkillPort([], { failWith: new Error("scan exploded") });
  const snapshot = await collectLiveBuildSnapshot(baseInput(tree, { skillPort: port }));
  assert.equal(snapshot.skills.available, false);
  assert.match(snapshot.skills.reason, /scan exploded/);
  const section = renderLiveBuildSection(snapshot);
  assert.ok(section.includes("unavailable this time — skill discovery failed (scan exploded)"));
  // 其余子节照常渲染
  assert.ok(section.includes("- my-server (user, stdio)"));
  assert.ok(section.includes("`Bash`"));
  // version 缺席 → 子节降级但节存在
  assert.match(section, /Version: unavailable this time/);
});

test("场景 4：采集整体抛错 → 节级降级，占位符仍被替换，注入不抛（R3/R5）", async () => {
  clearLiveBuildSectionCache();
  const input = {
    sessionId: "sess-degraded",
    workingDirectory: "/nonexistent",
    workspaceRoot: "/nonexistent",
    now: FIXED_NOW,
  };
  // homeDirectory 读取即抛：模拟采集面整体不可用。
  Object.defineProperty(input, "homeDirectory", {
    get() {
      throw new Error("home unreachable");
    },
  });
  const out = await injectLiveBuildSection(`x ${LIVE_BUILD_PLACEHOLDER} y`, input);
  assert.ok(!out.includes(LIVE_BUILD_PLACEHOLDER));
  assert.ok(out.includes("## Current Build — unavailable this time"));
  assert.ok(out.includes("home unreachable"));
  assert.ok(out.includes("references/recent-changes.md"), "降级节必须指引回退 references");
  // 渲染函数自身是纯函数，可直接断言
  assert.ok(renderDegradedSection("boom").includes("boom"));
});

test("场景 5：会话缓存——一次性生成、version 变化失效、降级不缓存（R4）", async () => {
  clearLiveBuildSectionCache();
  const tree = await makeTree();
  const content = `# guide\n${LIVE_BUILD_PLACEHOLDER}`;
  const first = await injectLiveBuildSection(
    content,
    baseInput(tree, { sessionId: "sess-cache", version: "1.0.0" }),
  );
  assert.ok(first.includes("- my-server"));
  // 首采后改盘上配置：同会话同版本二次调用应命中缓存，输出不变。
  await writeFile(
    join(tree.home, ".acode", "cli", "config.json"),
    JSON.stringify({ mcp: { servers: { "second-server": { command: "node" } } } }),
  );
  const second = await injectLiveBuildSection(
    content,
    baseInput(tree, { sessionId: "sess-cache", version: "1.0.0" }),
  );
  assert.equal(second, first);
  // version 变化 → 失效重采，输出反映新事实。
  const third = await injectLiveBuildSection(
    content,
    baseInput(tree, { sessionId: "sess-cache", version: "1.0.1" }),
  );
  assert.ok(third.includes("- second-server"));
  assert.ok(!third.includes("- my-server"));
  // 降级结果不进缓存：失败会话后续调用可自愈。
  const failing = { sessionId: "sess-retry", workingDirectory: tree.workspace, workspaceRoot: tree.workspace, now: FIXED_NOW };
  Object.defineProperty(failing, "homeDirectory", {
    get() {
      throw new Error("transient");
    },
    configurable: true,
  });
  const degraded = await injectLiveBuildSection(content, failing);
  assert.ok(degraded.includes("## Current Build — unavailable this time"));
  const healed = await injectLiveBuildSection(
    content,
    baseInput(tree, { sessionId: "sess-retry" }),
  );
  assert.ok(healed.includes("## Current Build (live snapshot)"));
});

test("场景 6：静态件——SKILL.md 学说要素 / recent-changes / 装配点接线 / 行数上限（R5/R6）", async () => {
  const skillDir = new URL(
    "../packages/acode-guide-plugin/skills/zcode-configuration-guide/",
    import.meta.url,
  );
  const skillMd = await readFile(new URL("SKILL.md", skillDir), "utf8");
  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, "SKILL.md 缺少 frontmatter");
  const fmKeys = [...frontmatter[1].matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(fmKeys, ["name", "description"], "frontmatter 只允许安全键（safeToAutoLoad）");
  assert.ok(skillMd.includes("name: zcode-configuration-guide"));
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)[1];
  assert.ok(description.length <= 1024, "description 超过适配器 1024 上限");
  // R1：占位符在场
  assert.ok(skillMd.includes(LIVE_BUILD_PLACEHOLDER));
  // R5：反陈旧学说四要素
  assert.match(skillMd, /stale by default/i);
  assert.match(skillMd, /ground truth/i);
  assert.match(skillMd, /references\/recent-changes\.md/);
  assert.match(skillMd, /Training data comes last/);
  assert.match(skillMd, /unavailable this time/);
  // R5：答案风格纪律（可粘贴 JSON + 落点文件与键路径）
  assert.match(skillMd, /no comments, no trailing commas/);
  assert.match(skillMd, /exact key path/);
  // R6：recent-changes.md 首版三条 + 本轮新增说明
  const changes = await readFile(new URL("references/recent-changes.md", skillDir), "utf8");
  assert.match(changes, /\.zcode/);
  assert.match(changes, /workspace overwrites user/);
  assert.match(changes, /SessionStart/);
  assert.match(changes, /dynamic-workflows/);
  assert.match(changes, /ACODE_CURRENT_BUILD/);
  // 装配点接线：skill.ts 在返回前调用注入（且未改 handlers barrel）
  const handler = await readFile(
    new URL("../packages/core/src/tool/handlers/skill.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    handler,
    /import \{ injectLiveBuildSection, LIVE_BUILD_PLACEHOLDER \} from "\.\/skill-live-build\.js"/,
  );
  assert.match(handler, /await injectLiveBuildSection\(/);
  // 仓库纪律：单文件 ≤400 行（apps/acode-cli/AGENTS.md），注入/渲染与采集两个模块都钉住
  for (const file of ["skill-live-build.ts", "skill-live-build-collect.ts"]) {
    const source = await readFile(
      new URL(`../packages/core/src/tool/handlers/${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(source.split("\n").length <= 400, `${file} 超过 400 行上限`);
    // 秘密纪律钉桩：模块源码不得整体序列化配置值
    assert.ok(!source.includes("JSON.stringify(parsed.value)"));
  }
  const handlerLines = handler.split("\n").length;
  assert.ok(handlerLines <= 400, "skill.ts 超过 400 行上限");
  // fileURLToPath 仅用于保持 import 一致性（避免未使用告警）
  assert.ok(fileURLToPath(skillDir).length > 0);
});
