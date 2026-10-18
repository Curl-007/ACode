// specs/skills-bundled-visibility-and-official-cache-authority.md §四 R3/M1-3（三条管线收敛）：
// commands 管线（commandsService → #src/plugins/officialPluginCacheRoots.scanOfficialPluginCacheRoots）
// 的分片权威 + 回退组内择优行为。commandsService 没有 scan 注入面（pluginStorageRoot 由真实
// HOME 的 CLI config 推导），测试把 process.env.HOME/USERPROFILE 重定向到 tmp fixture 后经
// list() 端到端断言；node --test 每个测试文件独立进程，HOME 重定向不外溢到其它测试文件，
// 且用例内 try/finally 恢复环境。表驱动风格对齐 skillsBundledScopeAndCacheAuthority.test.ts
// （S5-S7），commands 面钉住：分片只列 p1 → p2 不贡献命令；分片缺失 → 回退全扫且每插件仅
// semver 最高版本出根（旧版插件命令不再泄漏）；分片空数组 → 权威无插件、不回退。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createCommandsService } from "../src/commands/commandsService.js";

const OFFICIAL_MARKETPLACE_DIR = "acode-plugins-official";

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

after(() => {
  // 恢复进程级环境（node --test 同文件用例串行执行，恢复只为本文件后续钩子兜底）。
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

function commandMarkdown(name: string): string {
  return `---
name: ${name}
description: fixture command ${name}
---

${name} fixture prompt.
`;
}

async function writePluginRoot(params: {
  pluginRoot: string;
  pluginName: string;
  commands: readonly string[];
}): Promise<void> {
  await mkdir(join(params.pluginRoot, ".acode-plugin"), { recursive: true });
  await writeFile(
    join(params.pluginRoot, ".acode-plugin", "plugin.json"),
    JSON.stringify({ name: params.pluginName, commands: "commands" }),
    "utf-8",
  );
  for (const command of params.commands) {
    await mkdir(join(params.pluginRoot, "commands"), { recursive: true });
    await writeFile(
      join(params.pluginRoot, "commands", `${command}.md`),
      commandMarkdown(command),
      "utf-8",
    );
  }
}

interface Fixture {
  home: string;
  /** <home>/storage/cli/plugins/cache/acode-plugins-official */
  cacheRoot: string;
}

async function withHome(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "acode-commands-cache-"));
  // resolveUserHomeDir 依次读 HOME / USERPROFILE，两个都指向 fixture，避免宿主机环境差异。
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await mkdir(join(home, ".acode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".acode", "cli", "config.json"),
      JSON.stringify({
        storage: { dir: join(home, "storage") },
        plugins: {
          enabled: true,
          enabledPlugins: {
            "p1-fixture@acode-plugins-official": true,
            "p2-fixture@acode-plugins-official": true,
          },
        },
      }),
      "utf-8",
    );
    const cacheRoot = join(home, "storage", "cli", "plugins", "cache", OFFICIAL_MARKETPLACE_DIR);
    await run({ home, cacheRoot });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeOfficialCachePlugin(params: {
  cacheRoot: string;
  pluginName: string;
  version: string;
  commands: readonly string[];
}): Promise<void> {
  await writePluginRoot({
    pluginRoot: join(params.cacheRoot, params.pluginName, params.version),
    pluginName: params.pluginName,
    commands: params.commands,
  });
}

async function writePartition(home: string, content: string): Promise<void> {
  const partitionDir = join(
    home,
    "storage",
    "cli",
    "plugins",
    "marketplaces",
    OFFICIAL_MARKETPLACE_DIR,
  );
  await mkdir(partitionDir, { recursive: true });
  await writeFile(join(partitionDir, "bundled-marketplace.json"), content, "utf-8");
}

async function listPluginCommandNames(): Promise<string[]> {
  const service = createCommandsService();
  const { pluginCommands } = await service.list({});
  return pluginCommands.map((command) => command.name).sort();
}

describe("commandsService 官方 cache 分片权威消费（三管线收敛）", () => {
  it("分片只列 p1-fixture 时，cache 下的 p2-fixture 不贡献命令（分片权威）", async () => {
    await withHome(async ({ home, cacheRoot }) => {
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p1-fixture",
        version: "0.1.0",
        commands: ["alpha-only-in-p1"],
      });
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p2-fixture",
        version: "0.2.0",
        commands: ["beta-only-in-p2"],
      });
      await writePartition(
        home,
        JSON.stringify({
          version: 1,
          manifest: {
            name: OFFICIAL_MARKETPLACE_DIR,
            plugins: [{ name: "p1-fixture", cachePath: join(cacheRoot, "p1-fixture", "0.1.0") }],
          },
        }),
      );
      assert.deepEqual(await listPluginCommandNames(), ["/alpha-only-in-p1"]);
    });
  });

  it("分片缺失 → 回退全扫 + 组内择优：仅 semver 最高版本贡献命令，旧版命令不泄漏", async () => {
    await withHome(async ({ cacheRoot }) => {
      // 同一插件两个版本各自带不同命令：修复前全版本目录都进候选，0.1.0 的 stale 命令
      // 会与 0.2.0 的并存（字典序先到先得只挡同名）；收敛后组内仅最高版本出根。
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p1-fixture",
        version: "0.1.0",
        commands: ["stale-from-010"],
      });
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p1-fixture",
        version: "0.2.0",
        commands: ["fresh-from-020"],
      });
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p2-fixture",
        version: "0.9.0",
        commands: ["p2-nine"],
      });
      const names = await listPluginCommandNames();
      assert.ok(
        names.includes("/fresh-from-020"),
        `expected fresh command, got ${names.join(",")}`,
      );
      assert.ok(names.includes("/p2-nine"), `expected p2 command, got ${names.join(",")}`);
      assert.ok(
        !names.includes("/stale-from-010"),
        `stale version command must not leak, got ${names.join(",")}`,
      );
    });
  });

  it("分片有效但 plugins 为空数组 → 权威声明无内置插件，commands 管线不回退全扫", async () => {
    await withHome(async ({ home, cacheRoot }) => {
      await writeOfficialCachePlugin({
        cacheRoot,
        pluginName: "p1-fixture",
        version: "0.1.0",
        commands: ["alpha-only-in-p1"],
      });
      await writePartition(
        home,
        JSON.stringify({
          version: 1,
          manifest: { name: OFFICIAL_MARKETPLACE_DIR, plugins: [] },
        }),
      );
      assert.deepEqual(await listPluginCommandNames(), []);
    });
  });
});
