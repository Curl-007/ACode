import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * agent-teams 注册面 parity（specs/agent-teams-derived-config.md R1/R2，场景 3/9）。
 *
 * plugin-marketplaces.ts 的注释声称有「Settings 默认启用集合与 CLI 的官方插件声明
 * 一致」单测机械对照两处名单——本仓此前**并不存在**该测试（全仓 grep 零命中），
 * agent-teams 默认启用把两处名单漂移的后果放大到全量用户，这里补上。
 * 同时钉住发布暂存链的版本四处一致与 requiredSeedPaths 镜像：任何一处漏改，
 * 就是「市场可见但不可用」或「seed 拒绝写缓存」的生产事故形态。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repoRoot, "apps", "acode-cli");
const pluginRoot = join(cliRoot, "packages", "agent-teams-plugin");
const read = (path) => readFileSync(path, "utf8");

const {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: BOOTSTRAP_DEFAULT_ENABLED,
  OFFICIAL_PLUGIN_DEFINITIONS,
} = await import("../packages/bootstrap/src/app/official-plugin-definitions.ts");
const { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: SHARED_DEFAULT_ENABLED } = await import(
  "../../../packages/shared/src/plugin-marketplaces.ts"
);
const { officialSeaPlugins } = await import(
  "../packages/cli/scripts/sea-official-plugin-assets.mjs"
);
const {
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} = await import("../../../packages/server/src/remote/acodeAgentOfficialPluginAssets.ts");

const AGENT_TEAMS_ID = "agent-teams@acode-plugins-official";

function agentTeamsDefinition() {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "agent-teams");
  assert.ok(definition, "official-plugin-definitions.ts 必须有 agent-teams 条目");
  return definition;
}

test("默认启用两处名单机械一致，且 agent-teams 在场（spec R1）", () => {
  const fromDefinitions = [...BOOTSTRAP_DEFAULT_ENABLED].sort();
  const fromShared = [...SHARED_DEFAULT_ENABLED].sort();
  assert.deepEqual(
    fromDefinitions,
    fromShared,
    "bootstrap definitions 派生集合与 shared 镜像名单漂移（plugin-marketplaces.ts 注释宣称的对照即本测试）",
  );
  assert.ok(fromShared.includes(AGENT_TEAMS_ID), "agent-teams 必须默认启用（2026-10-15 拍板）");
  assert.equal(agentTeamsDefinition().defaultEnabled, true);
});

test("版本四处一致：package.json / plugin.json / definition / SEA 清单（spec R2）", () => {
  const pkg = JSON.parse(read(join(pluginRoot, "package.json")));
  const manifest = JSON.parse(read(join(pluginRoot, ".acode-plugin", "plugin.json")));
  const definition = agentTeamsDefinition();
  const sea = officialSeaPlugins.find((item) => item.name === "agent-teams");
  assert.ok(sea, "sea-official-plugin-assets.mjs 的 officialSeaPlugins 必须有 agent-teams 条目");

  assert.equal(pkg.version, definition.version, "package.json 与 definition 版本漂移");
  assert.equal(manifest.version, definition.version, "plugin.json 与 definition 版本漂移");
  assert.equal(sea.version, definition.version, "SEA 清单与 definition 版本漂移");
  assert.equal(pkg.name, "@acode/agent-teams-plugin");
  assert.equal(sea.packageName, "@acode/agent-teams-plugin");
});

test("SEA 清单 requiredSeedPaths 与 definition 镜像，runtime 校验在场（spec R2）", () => {
  const definition = agentTeamsDefinition();
  const sea = officialSeaPlugins.find((item) => item.name === "agent-teams");
  assert.deepEqual(
    [...sea.requiredSeedPaths].sort(),
    [...definition.requiredSeedPaths].sort(),
    "SEA requiredSeedPaths 必须镜像 definition（漂移即发布残缺插件）",
  );
  assert.equal(sea.requiresRuntime, true);
  assert.deepEqual(sea.requiredRuntimePaths, ["dist/mcp/server.js"]);
  assert.ok(definition.requiredSeedPaths.includes("dist/mcp/server.js"));
});

test("远端合同：agent-teams 在 PACKAGE_NAMES 且必需资产镜像 seed 清单（spec R2）", () => {
  assert.ok(REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.includes("agent-teams-plugin"));
  const definition = agentTeamsDefinition();
  for (const relativePath of definition.requiredSeedPaths) {
    assert.ok(
      REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.includes(
        `agent-teams-plugin/${relativePath}`,
      ),
      `远端合同缺少 agent-teams-plugin/${relativePath}`,
    );
  }
});

test("桌面生产/dev 与预构建三份暂存清单源码钉住（脚本导入即执行，用文本断言）", () => {
  const desktopProd = read(join(repoRoot, "packages/desktop/scripts/prepare-agent-node-bundle.mjs"));
  assert.match(desktopProd, /"@acode\/agent-teams-plugin"/u, "桌面生产清单缺 agent-teams");
  assert.match(
    desktopProd,
    /stagedPath: "packages\/agent-teams-plugin"/u,
    "桌面生产清单缺 stagedPath",
  );

  const desktopDev = read(join(repoRoot, "scripts/build-desktop-agent-cli.mjs"));
  assert.match(desktopDev, /"@acode\/agent-teams-plugin"/u, "桌面 dev 清单缺 agent-teams");
  assert.match(
    desktopDev,
    /agent-teams-plugin\/dist\/mcp\/server\.js/u,
    "桌面 dev 清单缺 dist 工件校验",
  );

  const prebuilds = read(join(repoRoot, "scripts/prepare-prebuilds.mjs"));
  assert.match(prebuilds, /"@acode\/agent-teams-plugin"/u, "预构建清单缺 agent-teams");
  assert.match(
    prebuilds,
    /packages\/agent-teams-plugin\/\.acode-plugin\/plugin\.json/u,
    "预构建必需路径缺 agent-teams manifest",
  );
});

test("knip 入口声明在场：dist bundle 不在 import 图（spec R2）", () => {
  const knip = read(join(repoRoot, "knip.jsonc"));
  assert.match(knip, /apps\/acode-cli\/packages\/agent-teams-plugin/u);
  assert.match(knip, /"entry": \["src\/server\.ts"\]/u);
});
