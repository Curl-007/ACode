import assert from "node:assert/strict";
// 全部临时文件 IO 走异步 API（AGENTS.md：使用异步文件和网络 IO），不用 mkdtempSync/rmSync/writeFileSync。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * CUA 启用单一权威测试（spec: packages/services/specs/cua-enablement-authority.md）。
 *
 * 被测对象：
 * - packages/acode-cua/broker-server.js isOfficialCuaPluginEnabledForWorkspace（R1 真读盘：
 *   user 配置 ~/.acode/cli/config.json + workspace 候选并入；占位曾恒 false）。
 * - packages/shared/src/runtimeEnv.ts isACodeCuaDevActivationRequested（R2 dev 覆盖旗标）。
 * - packages/services/src/node.ts 的 isCuaEnabledForContext 组合式（R1/R2/R3；该闭包不导出，
 *   按 cua-failclosed-gating.test.mjs 同款纪律用两个可导入谓词复算，并用 node.ts 源码文本
 *   切片钉住组合式防漂移）。
 *
 * 合并优先级实物结论（createConfig + mergeConfigs）：ConfigScopePriority Project(20) > User(10)，
 * enabledPlugins 按 id 展开、后写者胜——同一 id 冲突时 **workspace 覆盖 user**
 * （spec 验收 5 措辞已按实物修正）。workspace 候选发现序 = 根→cwd、每级 acode.json 先于
 * .acode/config.json（workspace-hook-config.ts 同步版），同级冲突后写者胜。
 *
 * 夹具纪律：temp HOME 经 options.env.HOME 注入（被测函数显式读注入 env 的 HOME，
 * 与 node.ts hasGlobalCliACodeCuaServer 同款解析），不碰 process.env；workspace 用
 * temp 目录 + 显式 .git 标记控制上溯边界，断言行不依赖宿主真实仓库布局。
 */

const { isOfficialCuaPluginEnabledForWorkspace } =
  await import("../../../packages/acode-cua/broker-server.js");
const { isACodeCuaDevActivationRequested } =
  await import("../../../packages/shared/src/runtimeEnv.ts");

// canonical / legacy id 字面量：单一事实源在 apps/acode-cli/packages/adapters/src/config/
// schema.ts:179-180（CANONICAL/LEGACY_CUA_PLUGIN_ID）；此处硬编码并锚定来源，防漂移靠
// 「alias 迁移」用例的行为断言（两处同错时 true/false 判定会翻转）。
const CANONICAL_ID = "computer-use@acode-plugins-official";
const LEGACY_ID = "acode-cua@acode-plugins-official";

/** 镜像 node.ts isCuaEnabledForContext 的组合式（R1 || R2；R3 = internal 不在其中）。 */
function isCuaEnabledForContextMirror(env, workingDirectory) {
  return (
    isACodeCuaDevActivationRequested(env) ||
    isOfficialCuaPluginEnabledForWorkspace({ env, workingDirectory })
  );
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "acode-cua-enablement-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(join(home, ".acode", "cli"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  return {
    root,
    home,
    workspace,
    env: { HOME: home },
    userConfigPath: join(home, ".acode", "cli", "config.json"),
    async writeUserConfig(value) {
      await writeFile(
        this.userConfigPath,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    },
    async writeWorkspaceConfig(relativePath, value) {
      const path = join(this.workspace, ...relativePath.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    async markGitDir(relativeDir = ".") {
      await mkdir(join(this.workspace, relativeDir, ".git"), { recursive: true });
    },
    async cleanup() {
      await rm(this.root, { recursive: true, force: true });
    },
  };
}

function enabledRecord(id, enabled) {
  return { plugins: { enabledPlugins: { [id]: enabled } } };
}

// ─────────────────────────────────────────────────────────────────────────────
// R1：单一权威读盘（user 层）
// ─────────────────────────────────────────────────────────────────────────────

test("R1 user 有记录 true → 启用（验收 1 的 host 侧读）", async () => {
  const fx = await createFixture();
  try {
    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, true));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      true,
    );
  } finally {
    await fx.cleanup();
  }
});

test("R1 user 无记录 → false（文件不存在 / 无 plugins 节 / 无该 id 三种形态）", async () => {
  const fx = await createFixture();
  try {
    // 文件不存在。
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    // 无 plugins 节。
    await fx.writeUserConfig({ model: "x" });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    // 有 plugins.enabledPlugins 但无该 id。
    await fx.writeUserConfig({ plugins: { enabledPlugins: { "other@market": true } } });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    // 显式 false（验收 2 的 host 侧读：开关 OFF → 新会话 fail-closed）。
    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, false));
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
  } finally {
    await fx.cleanup();
  }
});

test("R1 畸形输入 fail-closed：非法 JSON / 顶层非对象 / enabledPlugins 非 record / 值非 boolean", async () => {
  const fx = await createFixture();
  try {
    await fx.writeUserConfig("{ not json");
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    await fx.writeUserConfig([1, 2, 3]);
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    await fx.writeUserConfig({ plugins: { enabledPlugins: [CANONICAL_ID] } });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    // 值类型不符（镜像 schema.ts:171 z.record(z.string(), z.boolean())：任一值非 boolean
    // 即整文件 schema 失败、该层视同未加载）。
    await fx.writeUserConfig({ plugins: { enabledPlugins: { [CANONICAL_ID]: "yes" } } });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    // 无关 id 的非法值同样使整文件失效（zod 整文件拒绝，不是单键忽略）。
    await fx.writeUserConfig({
      plugins: { enabledPlugins: { [CANONICAL_ID]: true, "other@market": 1 } },
    });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R1：workspace 并入与合并优先级（实物 = workspace 覆盖 user，验收 5）
// ─────────────────────────────────────────────────────────────────────────────

test("R1 合并优先级：workspace false 覆盖 user true；workspace true 覆盖 user false（验收 5 实物）", async () => {
  const fx = await createFixture();
  try {
    await fx.markGitDir();
    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, true));
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, false));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      false,
      "ConfigScopePriority Project(20) > User(10)：workspace 记录覆盖 user 记录",
    );

    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, false));
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, true));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      true,
    );

    // 仅 workspace 有记录（user 无记录）同样生效（「并入」语义）。
    await fx.writeUserConfig({});
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      true,
    );
  } finally {
    await fx.cleanup();
  }
});

test("R1 同目录双候选：acode.json 先于 .acode/config.json，后写者胜", async () => {
  const fx = await createFixture();
  try {
    await fx.markGitDir();
    await fx.writeWorkspaceConfig("acode.json", enabledRecord(CANONICAL_ID, true));
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, false));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      false,
      "buildWorkspaceHookCandidatePaths：每级目录 acode.json 在前、.acode/config.json 在后",
    );
  } finally {
    await fx.cleanup();
  }
});

test("R1 发现序根→cwd：根声明 true、cwd 声明 false 时 cwd 胜（同优先级后写者胜）", async () => {
  const fx = await createFixture();
  try {
    await fx.markGitDir(); // workspace 是 worktree 根
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, true));
    const sub = "sub";
    await fx.writeWorkspaceConfig(`${sub}/.acode/config.json`, enabledRecord(CANONICAL_ID, false));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: fx.env,
        workingDirectory: join(fx.workspace, sub),
      }),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

test("R1 .git 边界：worktree 根之外的祖先配置不并入（根→cwd 上溯在 .git 处截止）", async () => {
  const fx = await createFixture();
  try {
    // fx.workspace 无 .git（外层祖先声明不得生效）；repo 有 .git；cwd 在 repo 内更深层。
    await fx.writeWorkspaceConfig("acode.json", enabledRecord(CANONICAL_ID, true)); // 边界外祖先
    await fx.markGitDir("repo");
    const cwd = join(fx.workspace, "repo", "sub");
    await mkdir(cwd, { recursive: true });
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: cwd }),
      false,
      "getProjectConfigDirectories 在首个含 .git 的目录处截止，边界外祖先配置不得并入",
    );
    // 边界内（repo 级）声明则正常并入。
    await fx.writeWorkspaceConfig("repo/.acode/config.json", enabledRecord(CANONICAL_ID, true));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: cwd }),
      true,
    );
  } finally {
    await fx.cleanup();
  }
});

test("R1 无 workingDirectory → 只读 user 层（workspace 记录不影响）", async () => {
  const fx = await createFixture();
  try {
    await fx.markGitDir();
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, true));
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: "" }),
      false,
      "空串 workingDirectory 视同未提供",
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R1：canonical id 别名迁移（schema.ts:454-458 / file-config.adapter.ts:118-161）
// ─────────────────────────────────────────────────────────────────────────────

test("R1 别名迁移：仅 legacy 键时按其值判定（true→启用，false→不启用），旧键不误判", async () => {
  const fx = await createFixture();
  try {
    await fx.writeUserConfig(enabledRecord(LEGACY_ID, true));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }),
      true,
      "canonical 缺席时 legacy 值补位（装载态迁移语义）",
    );
    await fx.writeUserConfig(enabledRecord(LEGACY_ID, false));
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), false);
  } finally {
    await fx.cleanup();
  }
});

test("R1 别名迁移：canonical 与 legacy 同文件并存时 canonical 恒胜", async () => {
  const fx = await createFixture();
  try {
    await fx.writeUserConfig({
      plugins: { enabledPlugins: { [CANONICAL_ID]: false, [LEGACY_ID]: true } },
    });
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }),
      false,
      "schema.ts:455：canonical 在席时 legacy 不补位",
    );
    await fx.writeUserConfig({
      plugins: { enabledPlugins: { [CANONICAL_ID]: true, [LEGACY_ID]: false } },
    });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: fx.env }), true);
  } finally {
    await fx.cleanup();
  }
});

test("R1 跨层优先级在别名迁移后成立：user legacy true 被 workspace canonical false 覆盖", async () => {
  const fx = await createFixture();
  try {
    await fx.markGitDir();
    await fx.writeUserConfig(enabledRecord(LEGACY_ID, true));
    await fx.writeWorkspaceConfig(".acode/config.json", enabledRecord(CANONICAL_ID, false));
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env: fx.env, workingDirectory: fx.workspace }),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R2：dev 覆盖旗标独立于开关（OR 支；验收 3）
// ─────────────────────────────────────────────────────────────────────────────

test("R2 仅 dev 旗标（开关 OFF/无记录）→ 启用；dev 旗标不读盘", async () => {
  const fx = await createFixture();
  try {
    // 无任何记录 + DEV_MODE=1 → true（验收 3：dev 链可用）。
    assert.equal(
      isCuaEnabledForContextMirror({ ...fx.env, ACODE_CUA_DEV_MODE: "1" }, fx.workspace),
      true,
    );
    // 显式 OFF 记录 + PRODUCT_HELPER=1 → 仍 true（覆盖独立于开关记录）。
    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, false));
    assert.equal(
      isCuaEnabledForContextMirror({ ...fx.env, ACODE_CUA_PRODUCT_HELPER: "1" }, fx.workspace),
      true,
    );
    // dev 旗标不是磁盘谓词的输入：只给磁盘谓词传 dev env 仍判 false（无记录）。
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: { ...fx.env, ACODE_CUA_DEV_MODE: "1" },
        workingDirectory: fx.workspace,
      }),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R3：internal flag 退出启用判定
// ─────────────────────────────────────────────────────────────────────────────

test("R3 缺省（internal feature ON）+ 无记录 → 不启用；internal ON 不再撑起启用判定", async () => {
  const fx = await createFixture();
  try {
    // isACodeCuaInternalFeatureEnabled 缺省 ON（runtimeEnv.ts:41-48）；R3 前该 OR 支使
    // 缺省恒启用。R3 后缺省 + 无记录必须 false（「电脑控制默认关闭」产品决策）。
    assert.equal(isCuaEnabledForContextMirror({ ...fx.env }, fx.workspace), false);
  } finally {
    await fx.cleanup();
  }
});

test("R3 internal flag OFF（PRODUCT_HELPER=0）+ 记录 true → 启用（任务书钉定形态）", async () => {
  const fx = await createFixture();
  try {
    await fx.writeUserConfig(enabledRecord(CANONICAL_ID, true));
    assert.equal(
      isCuaEnabledForContextMirror({ ...fx.env, ACODE_CUA_PRODUCT_HELPER: "0" }, fx.workspace),
      true,
      "internal flag 不再参与启用判定：开关记录是唯一权威（R1），0/off/false 压不住它",
    );
    // 对照：同一 flag OFF + 无记录 → false（dev 支也不认显式 0）。
    const fx2 = await createFixture();
    try {
      assert.equal(
        isCuaEnabledForContextMirror({ ...fx2.env, ACODE_CUA_PRODUCT_HELPER: "0" }, fx2.workspace),
        false,
      );
    } finally {
      await fx2.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组合式防漂移：node.ts 的 isCuaEnabledForContext 必须保持「dev 旗标 || 磁盘记录」、
// 不再含 internal 支（R3 结构钉；闭包不导出，用源码切片锁定）
// ─────────────────────────────────────────────────────────────────────────────

test("R3 结构钉：node.ts isCuaEnabledForContext 闭包不含 isACodeCuaInternalFeatureEnabled", async () => {
  const nodeSource = await readFile(join(import.meta.dirname, "..", "src", "node.ts"), "utf8");
  const marker = "const isCuaEnabledForContext";
  const start = nodeSource.indexOf(marker);
  assert.notEqual(start, -1, "node.ts 缺少 isCuaEnabledForContext 闭包");
  // 只断言代码本体：剥离注释行，避免注释里引用谓词名（说明文字）被误判为 OR 支。
  const closure = nodeSource
    .slice(start, nodeSource.indexOf(";", start))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(
    closure.includes("isACodeCuaDevActivationRequested(process.env)"),
    "R2：启用判定必须含 dev 覆盖旗标支",
  );
  assert.ok(
    closure.includes("isOfficialCuaPluginEnabledForWorkspace({"),
    "R1：启用判定必须含设置页开关落盘记录支",
  );
  assert.ok(
    !closure.includes("isACodeCuaInternalFeatureEnabled"),
    "R3：internal flag 必须退出启用判定（其 infra 语义留在 shouldEnableDefaultCuaProductHelper）",
  );
});
