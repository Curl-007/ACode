import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * 内置子智能体目录（bundled 官方预置层）bootstrap + bundled 包基建验收。
 *
 * 覆盖 specs/builtin-subagent-catalog.md：
 * - R1：BUNDLED_SKILL_PACK_REQUIRED_PATHS 追加三个 agents/*.md（all-or-nothing 完整性门）；
 * - R5：合并序（核心内置 < bundled < user < project）、保留名单动态化（插件 bare-name
 *   撞 bundled 名 → 仅命名空间名 + agent_ambiguous_name）、禁用扩展至 bundled（核心二内置
 *   无 path 维持不可禁用）、模型覆盖键集遍历 BUILT_IN_SUBAGENT_NAMES（未知键忽略）、
 *   GUI 内置覆盖装配期烘焙到 bundled 成员（场景 6 派发生效面；user/project 同名整体
 *   替换后 override 不迁移）；
 * - R8：bundled 包/agents 目录缺席 → warn + 空 profiles + 不抛错，diagnostic 不静默。
 *
 * 测试不依赖 agents/Plan.md 等真实包文件内容（由并行批次产出）：解析路径全部用
 * fixture 目录构造；仅文件名常量断言引用真实路径，真实包在场性断言放在容忍缺席的
 * 独立用例里（skip-if-missing 姿态，注明原因）。
 */

const {
  loadACodeAgentProfiles,
  loadPluginAgentProfiles,
} = await import("../packages/bootstrap/src/subagents.ts");
const {
  BUNDLED_AGENTS_DIRECTORY,
  CORE_RESERVED_AGENT_NAMES,
  createReservedAgentNames,
  loadBundledAgentProfilesFromRoot,
  resolveBundledAgentProfiles,
} = await import("../packages/bootstrap/src/app/bundled-agents.ts");
const { BUILT_IN_SUBAGENT_NAMES } = await import(
  "../../../packages/shared/src/subagents-types.ts"
);
const {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  resolveBundledContentPackRoot,
} = await import("../packages/bootstrap/src/app/bundled-skills.ts");
const { normalizeAgentProfiles } = await import(
  "../packages/core/src/subagent/profile.ts"
);
const { createAgentStateId } = await import(
  "../../../packages/shared/src/subagents-types.ts"
);

const BUNDLED_AGENT_FILE_NAMES = ["Plan", "Verify", "Review"];

function makeLogger() {
  const warnings = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn(message, context) {
      warnings.push({ message, context });
    },
    error() {},
  };
}

async function makeTempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 构造 bundled 层 profile：source "built-in" 且 path 指向包内实际文件（可禁用判据）。 */
function makeBundledProfile(name, packRoot = join("fake", "pack")) {
  return {
    name,
    description: `bundled ${name} description`,
    source: "built-in",
    systemPrompt: `bundled ${name} prompt`,
    path: join(packRoot, BUNDLED_AGENTS_DIRECTORY, `${name}.md`),
  };
}

function makeCoreBuiltInProfile(name) {
  // 核心 TS 内置二名：无 path，维持不可禁用（与 core createBuiltIn*AgentProfile 同形）。
  return {
    name,
    description: `core ${name} description`,
    source: "built-in",
    systemPrompt: `core ${name} prompt`,
  };
}

async function writeAgentMarkdown(root, fileName, { name, body, description }) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, fileName),
    `---\nname: ${name}\ndescription: ${description ?? `${name} description`}\n---\n\n${body}\n`,
    "utf8",
  );
}

async function writeAgentState(storageRoot, state) {
  const stateDir = join(storageRoot, "v2");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "agents-state.json"), JSON.stringify(state, null, 2), "utf8");
}

test("(R1) REQUIRED_PATHS 含三个 agents/*.md 路径，技能条目保留", () => {
  const required = [...BUNDLED_SKILL_PACK_REQUIRED_PATHS];
  for (const name of BUNDLED_AGENT_FILE_NAMES) {
    assert.ok(
      required.includes(`agents/${name}.md`),
      `BUNDLED_SKILL_PACK_REQUIRED_PATHS 缺 agents/${name}.md`,
    );
  }
  assert.ok(
    required.some((path) => path.startsWith("skills/")),
    "技能必需路径不得因 agents 追加而丢失",
  );
});

test("(R5) bundled profiles 置于数组最前，user/project 同名整体覆盖", async () => {
  const storageRoot = await makeTempRoot("acode-subagent-catalog-");
  const workingDirectory = await makeTempRoot("acode-subagent-catalog-wd-");
  try {
    const bundled = [makeBundledProfile("Plan"), makeBundledProfile("Verify")];
    await writeAgentMarkdown(join(storageRoot, "agents"), "Plan.md", {
      name: "Plan",
      body: "user plan body",
    });
    await writeAgentMarkdown(join(workingDirectory, ".acode", "agents"), "Plan.md", {
      name: "Plan",
      body: "project plan body",
    });

    const outcome = await loadACodeAgentProfiles({
      bundledProfiles: bundled,
      storageRoot,
      workingDirectory,
    });

    // 数组序即合并序输入：bundled 最前，其后 user、project（normalizeAgentProfiles 后者覆盖）。
    const names = outcome.profiles.map((profile) => `${profile.source}:${profile.name}`);
    assert.deepEqual(names, [
      "built-in:Plan",
      "built-in:Verify",
      "user:Plan",
      "project:Plan",
    ]);

    const normalized = normalizeAgentProfiles(outcome.profiles);
    const plan = normalized.find((profile) => profile.name === "Plan");
    // project 同名整体替换（含 prompt/source，非字段级合并）。
    assert.equal(plan.source, "project");
    assert.equal(plan.systemPrompt, "project plan body");
    const verify = normalized.find((profile) => profile.name === "Verify");
    assert.equal(verify.source, "built-in");
    assert.equal(verify.systemPrompt, "bundled Verify prompt");
    // 核心二内置照常播种。
    assert.ok(normalized.some((profile) => profile.name === "general-purpose"));
    assert.ok(normalized.some((profile) => profile.name === "Explore"));

    // user 同名（无 project 文件）覆盖 bundled：
    const userOnlyStorage = await makeTempRoot("acode-subagent-catalog-user-");
    const userOnlyWorkdir = await makeTempRoot("acode-subagent-catalog-userwd-");
    try {
      await writeAgentMarkdown(join(userOnlyStorage, "agents"), "Verify.md", {
        name: "Verify",
        body: "user verify body",
      });
      const userOutcome = await loadACodeAgentProfiles({
        bundledProfiles: bundled,
        storageRoot: userOnlyStorage,
        workingDirectory: userOnlyWorkdir,
      });
      const userNormalized = normalizeAgentProfiles(userOutcome.profiles);
      const userVerify = userNormalized.find((profile) => profile.name === "Verify");
      assert.equal(userVerify.source, "user");
      assert.equal(userVerify.systemPrompt, "user verify body");
    } finally {
      await rm(userOnlyStorage, { force: true, recursive: true });
      await rm(userOnlyWorkdir, { force: true, recursive: true });
    }
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

test("(R5) 保留名单动态化：核心二名固定基座 + bundled 名派生", () => {
  const reserved = createReservedAgentNames([{ name: "Verify" }]);
  // 核心二名是固定基座；bundled 名从传入 profiles 派生。
  for (const name of ["general-purpose", "Explore", "Verify"]) {
    assert.ok(reserved.has(name), `保留名单缺 ${name}`);
  }
  assert.ok(!reserved.has("Plan"), "未传入的 bundled 名不得凭空保留");
  // 无 bundled（包缺席降级）时回落到核心二名（现状语义）。
  const coreOnly = createReservedAgentNames();
  assert.deepEqual([...coreOnly].sort(), ["Explore", "general-purpose"]);
});

test("(R5) 插件 bare-name 撞 bundled 名：命名空间名 + agent_ambiguous_name 诊断", async () => {
  const pluginRoot = await makeTempRoot("acode-subagent-catalog-plugin-");
  try {
    await writeAgentMarkdown(join(pluginRoot, "agents"), "Verify.md", {
      name: "Verify",
      body: "plugin verify body",
    });
    await writeAgentMarkdown(join(pluginRoot, "agents"), "Helper.md", {
      name: "Helper",
      body: "plugin helper body",
    });
    const outcome = loadPluginAgentProfiles({
      plugins: [
        {
          id: "test-plugin@local",
          name: "test-plugin",
          enabled: true,
          rootPath: pluginRoot,
          components: [
            { kind: "agent", items: [{ name: "Verify" }, { name: "Helper" }] },
          ],
        },
      ],
      reservedProfileNames: createReservedAgentNames([makeBundledProfile("Verify")]),
    });
    const names = outcome.profiles.map((profile) => profile.name).sort();
    // 撞名仅命名空间名；不撞名保留 bare-name 别名（既有行为不变）。
    assert.deepEqual(names, ["test-plugin:Helper", "Helper", "test-plugin:Verify"].sort());
    const ambiguous = outcome.diagnostics.filter(
      (diagnostic) => diagnostic.code === "agent_ambiguous_name",
    );
    assert.equal(ambiguous.length, 1);
    assert.match(ambiguous[0].message, /test-plugin:Verify/);
  } finally {
    await rm(pluginRoot, { force: true, recursive: true });
  }
});

test("(R5) 禁用 bundled profile 生效；核心内置（无 path）不受禁用影响", async () => {
  const storageRoot = await makeTempRoot("acode-subagent-catalog-disable-");
  const workingDirectory = await makeTempRoot("acode-subagent-catalog-disable-wd-");
  try {
    const verifyStateId = createAgentStateId({
      name: "Verify",
      scope: "built-in",
      source: "built-in",
    });
    const exploreStateId = createAgentStateId({
      name: "Explore",
      scope: "built-in",
      source: "built-in",
    });
    await writeAgentState(storageRoot, {
      disabledAgentIds: [verifyStateId, exploreStateId],
    });

    const outcome = await loadACodeAgentProfiles({
      bundledProfiles: [
        makeBundledProfile("Verify"),
        makeBundledProfile("Plan"),
        makeCoreBuiltInProfile("Explore"),
      ],
      storageRoot,
      workingDirectory,
    });
    const names = outcome.profiles.map((profile) => profile.name);
    // bundled Verify 被 disabledAgentIds 过滤；Plan 未禁用保留。
    assert.ok(!names.includes("Verify"), "禁用的 bundled Verify 不应装配");
    assert.ok(names.includes("Plan"), "未禁用的 bundled Plan 应装配");
    // 核心二内置无 path：即使 state 里出现同形 id 也维持不可禁用现状。
    assert.ok(names.includes("Explore"), "核心内置 Explore 不受禁用影响");
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

test("(R5) 模型覆盖键集接受 Plan/Verify/Review，未知键忽略", async () => {
  const storageRoot = await makeTempRoot("acode-subagent-catalog-model-");
  const workingDirectory = await makeTempRoot("acode-subagent-catalog-model-wd-");
  try {
    await writeAgentState(storageRoot, {
      builtInModelSelectionOverrides: {
        Plan: { providerId: "provider-a", modelId: "model-plan" },
        Verify: { providerId: "provider-b", modelId: "model-verify" },
        Review: { providerId: "provider-c", modelId: "model-review" },
        Unknown: { providerId: "provider-x", modelId: "model-x" },
      },
    });
    const outcome = await loadACodeAgentProfiles({ storageRoot, workingDirectory });
    const overrides = outcome.builtInModelSelectionOverrides;
    assert.deepEqual(overrides.Plan, { providerId: "provider-a", modelId: "model-plan" });
    assert.deepEqual(overrides.Verify, { providerId: "provider-b", modelId: "model-verify" });
    assert.deepEqual(overrides.Review, { providerId: "provider-c", modelId: "model-review" });
    assert.ok(!("Unknown" in overrides), "未知键应忽略不报错");
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

test("(R8) loadBundledAgentProfilesFromRoot 解析 fixture pack：source built-in、path 指实际文件", async () => {
  const packRoot = await makeTempRoot("acode-bundled-agents-pack-");
  try {
    const agentsRoot = join(packRoot, BUNDLED_AGENTS_DIRECTORY);
    await writeAgentMarkdown(agentsRoot, "Plan.md", {
      name: "Plan",
      body: "plan prompt body",
      description: "Plan description",
    });
    await writeAgentMarkdown(agentsRoot, "Review.md", {
      name: "Review",
      body: "review prompt body",
    });
    // 非 markdown 与子目录不参与解析：
    await writeFile(join(agentsRoot, "notes.txt"), "ignored", "utf8");
    await mkdir(join(agentsRoot, "nested"), { recursive: true });

    const logger = makeLogger();
    const outcome = await loadBundledAgentProfilesFromRoot(packRoot, logger);
    assert.equal(outcome.profiles.length, 2);
    // 目录枚举按文件名排序（localeCompare），Plan 在 Review 前。
    assert.deepEqual(
      outcome.profiles.map((profile) => profile.name),
      ["Plan", "Review"],
    );
    for (const profile of outcome.profiles) {
      assert.equal(profile.source, "built-in");
      assert.ok(profile.path, "bundled profile 必须带 path（禁用机制判据）");
      assert.equal(dirname(profile.path), agentsRoot);
    }
    assert.equal(outcome.profiles[0].systemPrompt, "plan prompt body");
    assert.equal(outcome.diagnostics.length, 0);
  } finally {
    await rm(packRoot, { force: true, recursive: true });
  }
});

test("(R8) bundled markdown 解析 diagnostic 不静默：缺 frontmatter 文件不装配且上报", async () => {
  const packRoot = await makeTempRoot("acode-bundled-agents-broken-");
  try {
    const agentsRoot = join(packRoot, BUNDLED_AGENTS_DIRECTORY);
    await mkdir(agentsRoot, { recursive: true });
    await writeFile(join(agentsRoot, "Broken.md"), "no frontmatter here\n", "utf8");
    await writeAgentMarkdown(agentsRoot, "Plan.md", { name: "Plan", body: "plan body" });

    const logger = makeLogger();
    const outcome = await loadBundledAgentProfilesFromRoot(packRoot, logger);
    assert.deepEqual(
      outcome.profiles.map((profile) => profile.name),
      ["Plan"],
    );
    assert.equal(outcome.diagnostics.length, 1);
    assert.equal(outcome.diagnostics[0].code, "agent_missing_frontmatter");
    assert.ok(
      logger.warnings.some((entry) => entry.message === "Bundled agent profile diagnostic"),
      "diagnostic 应经 warn 日志上报",
    );
  } finally {
    await rm(packRoot, { force: true, recursive: true });
  }
});

test("(R8) agents 目录缺失：warn + 空 profiles + 不抛错", async () => {
  const packRoot = await makeTempRoot("acode-bundled-agents-missing-");
  try {
    const logger = makeLogger();
    const outcome = await loadBundledAgentProfilesFromRoot(packRoot, logger);
    assert.deepEqual(outcome.profiles, []);
    assert.deepEqual(outcome.diagnostics, []);
    assert.ok(
      logger.warnings.some((entry) => entry.message === "Bundled agents directory unavailable"),
      "目录缺失应 warn",
    );
  } finally {
    await rm(packRoot, { force: true, recursive: true });
  }
});

test("(R8) resolveBundledAgentProfiles：真实包缺席降级为空，在场则解析三成员（容忍并行批次未完成）", async () => {
  const cliStorageRoot = await makeTempRoot("acode-bundled-agents-cli-");
  try {
    const logger = makeLogger();
    // 不断言真实包一定在场：agents/*.md 由并行批次写入，缺失时完整性门拒绝整包，
    // 此处验证的正是 R8 降级姿态（空 profiles + warn + 不抛错）。
    const outcome = await resolveBundledAgentProfiles({ cliStorageRoot, logger });
    assert.ok(Array.isArray(outcome.profiles));
    assert.ok(Array.isArray(outcome.diagnostics));

    const packRoot = await resolveBundledContentPackRoot({ cliStorageRoot });
    if (!packRoot) {
      assert.deepEqual(outcome.profiles, [], "包缺席时应降级为空 profiles");
      assert.ok(
        logger.warnings.some((entry) => entry.message === "Bundled agent pack unavailable"),
        "包缺席应 warn",
      );
      return;
    }
    // 包在场（三个 agents 文件齐备，否则完整性门不会放行）：解析出全部三成员。
    const names = outcome.profiles.map((profile) => profile.name).sort();
    for (const name of BUNDLED_AGENT_FILE_NAMES) {
      assert.ok(names.includes(name), `在场包应解析出 ${name}`);
    }
    for (const profile of outcome.profiles) {
      assert.equal(profile.source, "built-in");
      assert.ok(profile.path?.startsWith(packRoot), "path 应指向包内实际文件");
      // 不校验 prompt 内容（所有权归并行批次的 markdown 文件）。
      assert.ok((await readFile(profile.path, "utf8")).length > 0);
    }
  } finally {
    await rm(cliStorageRoot, { force: true, recursive: true });
  }
});

test("(R5/场景6) GUI 内置覆盖在装配期烘焙到 bundled 成员 modelSelection；核心二内置仍走播种通道", async () => {
  const storageRoot = await makeTempRoot("acode-subagent-catalog-bake-");
  const workingDirectory = await makeTempRoot("acode-subagent-catalog-bake-wd-");
  try {
    await writeAgentState(storageRoot, {
      builtInModelSelectionOverrides: {
        Review: { providerId: "provider-c", modelId: "model-review" },
        Explore: { providerId: "provider-e", modelId: "model-explore" },
      },
    });
    const outcome = await loadACodeAgentProfiles({
      bundledProfiles: [makeBundledProfile("Review"), makeBundledProfile("Plan")],
      storageRoot,
      workingDirectory,
    });

    // 烘焙面：bundled Review（source "built-in" 且带 path）拿到 state 里的覆盖；
    // 无覆盖的 bundled Plan 不被烘焙（v1 预置不钉模型档位，继承父模型）。
    const review = outcome.profiles.find((profile) => profile.name === "Review");
    assert.equal(review.source, "built-in");
    assert.deepEqual(review.modelSelection, {
      providerId: "provider-c",
      modelId: "model-review",
    });
    const plan = outcome.profiles.find((profile) => profile.name === "Plan");
    assert.equal(plan.modelSelection, undefined);

    // 派发生效面：normalizeAgentProfiles 后 bundled Review 仍携带覆盖（profile 显式
    // 选择 → resolveSubagentSelection 的 override > profile > 父继承链由此接通）；
    // 核心二内置不被本层烘焙，Explore 的覆盖继续由播种通道应用（既有语义不变）。
    const normalized = normalizeAgentProfiles(outcome.profiles, {
      builtInModelSelectionOverrides: outcome.builtInModelSelectionOverrides,
    });
    assert.deepEqual(normalized.find((entry) => entry.name === "Review").modelSelection, {
      providerId: "provider-c",
      modelId: "model-review",
    });
    assert.deepEqual(normalized.find((entry) => entry.name === "Explore").modelSelection, {
      providerId: "provider-e",
      modelId: "model-explore",
    });
    assert.equal(
      normalized.find((entry) => entry.name === "general-purpose").modelSelection,
      undefined,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

test("(R5/场景6) user 同名 markdown 整体替换 bundled：override 不落到 user profile", async () => {
  const storageRoot = await makeTempRoot("acode-subagent-catalog-bake-user-");
  const workingDirectory = await makeTempRoot("acode-subagent-catalog-bake-user-wd-");
  try {
    await writeAgentState(storageRoot, {
      builtInModelSelectionOverrides: {
        Plan: { providerId: "provider-a", modelId: "model-plan" },
      },
    });
    await writeAgentMarkdown(join(storageRoot, "agents"), "Plan.md", {
      name: "Plan",
      body: "user plan body",
    });
    const outcome = await loadACodeAgentProfiles({
      bundledProfiles: [makeBundledProfile("Plan")],
      storageRoot,
      workingDirectory,
    });

    // bundled 条目本身仍被烘焙（随后在数组序里被 user 条目整体替换）；
    // user 条目不带 override——替换后走用户 markdown 自己的模型选择语义。
    const bakedBundled = outcome.profiles.find(
      (profile) => profile.name === "Plan" && profile.source === "built-in",
    );
    assert.deepEqual(bakedBundled.modelSelection, {
      providerId: "provider-a",
      modelId: "model-plan",
    });
    const userPlan = outcome.profiles.find(
      (profile) => profile.name === "Plan" && profile.source === "user",
    );
    assert.equal(userPlan.modelSelection, undefined);

    // 装配结果：同名覆盖后生效的是 user profile，且不携带内置覆盖。
    const normalized = normalizeAgentProfiles(outcome.profiles, {
      builtInModelSelectionOverrides: outcome.builtInModelSelectionOverrides,
    });
    const activePlan = normalized.find((profile) => profile.name === "Plan");
    assert.equal(activePlan.source, "user");
    assert.equal(activePlan.systemPrompt, "user plan body");
    assert.equal(activePlan.modelSelection, undefined);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
});

test("(R6/Review-F2) 静态名单与 bundled 包目录同集合：核心二名 ∪ agents/*.md == BUILT_IN_SUBAGENT_NAMES", async () => {
  // BUILT_IN_SUBAGENT_NAMES 是 shared 侧静态名单，包目录是目录内容的事实源（spec R1/R6）。
  // 目录扩容/改名而名单未同步时，静态名单消费面会静默降级（覆盖烘焙、GUI 内置控件、
  // 启动迁移键集）——本断言与 sea-bundled-skill-assets.test.mjs 的三处清单同集合
  // 断言同一防漂移方向（Review 子代理 E2E 首跑 finding F2 的修复用例）。
  const cliStorageRoot = await makeTempRoot("acode-catalog-coupling-");
  try {
    const packRoot = await resolveBundledContentPackRoot({ cliStorageRoot });
    assert.ok(packRoot, "仓库 dev 形态下 bundled 包必须在场（本测试随仓库分发）");
    const entries = await readdir(join(packRoot, BUNDLED_AGENTS_DIRECTORY));
    const bundledNames = entries
      .filter((name) => /\.(md|markdown)$/iu.test(name))
      .map((name) => name.replace(/\.(md|markdown)$/iu, ""));
    const derived = [...new Set([...CORE_RESERVED_AGENT_NAMES, ...bundledNames])].sort();
    assert.deepEqual(derived, [...BUILT_IN_SUBAGENT_NAMES].sort());
    // 双保险：测试内文件名常量与包目录同步（R1 REQUIRED_PATHS 用例已钉路径拼写）。
    assert.deepEqual([...bundledNames].sort(), [...BUNDLED_AGENT_FILE_NAMES].sort());
  } finally {
    await rm(cliStorageRoot, { force: true, recursive: true });
  }
});
