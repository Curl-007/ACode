import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

/**
 * WI-10 验收测试（specs/stable-prefix-pause-gate.md R5）：提示词文件路由。
 *
 * 覆盖：
 * 1. loader（注入 fs，零真实盘）：project 裸文件 > project .acode > user；
 *    walk-up 近者胜；三类文件独立解析；全空白 = 缺席；非 ENOENT 读错 warn+跳过、
 *    ENOENT 静默；
 * 2. loader（真实 tmpdir 异步 IO）：project 命中压过 user；project 缺席落 user；
 * 3. builder 注入（APPEND_SYSTEM.md 注入单测）：identity.append 段渲染进
 *    stable body 末尾；custom 通道叠加；workflow_actor 通道排除；
 *    disabledSections 旗标可摘除；缺席时零渲染（既有面零回归）。
 *
 * 平台可移植性（CI run 39139112813 教训）：假路径常量必须是**运行平台原生**形态。
 * prompt-files.ts 的 projectCandidatePaths 首行 resolve(workingDirectory)——posix 上
 * "C:/work/..." 不是绝对路径，resolve 会拼上进程 cwd（/home/runner/.../C:/work/...），
 * 注入 fs 的键永不命中 → project 候选全 ENOENT → 误落 user 级。修法：两平台各取
 * 原生形态（win32 盘符、posix 根斜杠），即各自 resolve() 的不动点（有回归护栏用例）；
 * 所有 fake-fs 键与路径断言一律从常量经 join() 派生，不再写硬编码盘符字面量。
 */

const {
  APPEND_SYSTEM_PROMPT_FILE_NAME,
  SYSTEM_PROMPT_FILE_NAME,
  TITLE_SYSTEM_PROMPT_FILE_NAME,
  discoverPromptFile,
  loadPromptFileRouting,
} = await import("../packages/core/src/context/prompt-files.ts");
const { createContextBuilder } = await import("../packages/core/src/context/builder.ts");
const { clearStablePrefixCaches } = await import("../packages/core/src/context/stable-prefix.ts");

// ── 平台原生路径常量（唯一事实源；下游一律派生） ─────────────────

const IS_WIN = process.platform === "win32";
const PROJECT = IS_WIN ? "C:/work/wi10-project" : "/work/wi10-project";
// walk-up 终点，两平台对称（各 3 层到根：PROJECT → 父目录 → 根；
// win32 根形态 "C:/"、posix 根形态 "/"）。
const PROJECT_ROOT = dirname(dirname(PROJECT));
const NESTED = join(PROJECT, "apps", "nested");
const USER_DIR = join(PROJECT_ROOT, "home", "wi10", ".acode");

/** 归一路径键：win32 的 join 产物含反斜杠，注入 fs 键与断言统一正斜杠。 */
const K = (path) => path.replaceAll("\\", "/");

const NO_FLAGS = { disabledSections: [], manifestTrace: false };

/** 注入式假 fs：files 映射（键与查找统一经 K 归一，两平台一致）。 */
function createFakeFs(files, options = {}) {
  const warnings = [];
  // failWith 键同样归一：调用方可能直接传 join 产物（含平台分隔符）。
  const failWith = {};
  for (const [key, value] of Object.entries(options.failWith ?? {})) {
    failWith[K(key)] = value;
  }
  const readFileText = async (path) => {
    const normalized = K(path);
    if (failWith[normalized]) {
      throw failWith[normalized];
    }
    if (Object.prototype.hasOwnProperty.call(files, normalized)) {
      return files[normalized];
    }
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    error.code = "ENOENT";
    throw error;
  };
  const logger = {
    warn: (message, context) => warnings.push({ message, context }),
  };
  return { readFileText, logger, warnings };
}

function routingOptions(fake, overrides = {}) {
  return {
    workingDirectory: PROJECT,
    userConfigDir: USER_DIR,
    readFileText: fake.readFileText,
    logger: fake.logger,
    ...overrides,
  };
}

// ── 1. loader：注入 fs ────────────────────────────────────────────

test("(R5) 假路径常量是本平台 resolve 不动点（CI posix 拼接根因回归护栏）", () => {
  // projectCandidatePaths 首行 resolve(workingDirectory)：若常量不是原生形态，
  // posix 会拼上进程 cwd，注入 fs 的键全部失配。本护栏在两平台各自断言
  // resolve() 不改变常量（按 K 归一后逐字节相等）。
  for (const candidate of [PROJECT, NESTED, USER_DIR]) {
    assert.equal(
      K(resolve(candidate)),
      K(candidate),
      `假路径必须与运行平台同构（resolve 不动点）：${candidate}`,
    );
  }
  // 根形态也按平台对称：walk-up 终点两端都是 3 层。
  assert.equal(K(PROJECT_ROOT), IS_WIN ? "C:/" : "/");
});

test("(R5) project 裸文件 > project .acode > user", async () => {
  const fake = createFakeFs({
    [K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "bare project",
    [K(join(PROJECT, ".acode", APPEND_SYSTEM_PROMPT_FILE_NAME))]: "acode project",
    [K(join(USER_DIR, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "user level",
  });
  const routing = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(routing.appendSystem.content, "bare project");
  assert.equal(routing.appendSystem.scope, "project");
  assert.equal(
    K(routing.appendSystem.path),
    K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME)),
  );
});

test("(R5) project 裸文件缺席 → .acode 子目录命中", async () => {
  const fake = createFakeFs({
    [K(join(PROJECT, ".acode", APPEND_SYSTEM_PROMPT_FILE_NAME))]: "acode project",
    [K(join(USER_DIR, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "user level",
  });
  const routing = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(routing.appendSystem.content, "acode project");
});

test("(R5) project 全缺席 → user 兜底；walk-up 近者胜", async () => {
  const fake = createFakeFs({
    [K(join(USER_DIR, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "user level",
    [K(join(PROJECT, SYSTEM_PROMPT_FILE_NAME))]: "repo root system",
    [K(join(NESTED, SYSTEM_PROMPT_FILE_NAME))]: "nested system",
  });
  const fromProject = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(fromProject.appendSystem.content, "user level");
  assert.equal(fromProject.appendSystem.scope, "user");
  assert.equal(fromProject.systemOverride.content, "repo root system");

  // 从 nested cwd 出发：近层祖先的文件压过远层。
  const fromNested = await loadPromptFileRouting(
    routingOptions(fake, { workingDirectory: NESTED }),
  );
  assert.equal(fromNested.systemOverride.content, "nested system");
});

test("(R5) 三类文件独立解析：TITLE_SYSTEM/SYSTEM 与 APPEND_SYSTEM 互不干扰", async () => {
  const fake = createFakeFs({
    [K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "append body",
    [K(join(PROJECT, SYSTEM_PROMPT_FILE_NAME))]: "system body",
    [K(join(USER_DIR, TITLE_SYSTEM_PROMPT_FILE_NAME))]: "title body",
  });
  const routing = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(routing.appendSystem.content, "append body");
  assert.equal(routing.systemOverride.content, "system body");
  assert.equal(routing.titleSystem.content, "title body");
  assert.equal(routing.titleSystem.scope, "user");
});

test("(R5) 全空白文件 = 缺席：不命中、继续下一优先级", async () => {
  const fake = createFakeFs({
    [K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "   \n\t\n",
    [K(join(USER_DIR, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "user fallback",
  });
  const routing = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(routing.appendSystem.content, "user fallback");

  const onlyBlank = await loadPromptFileRouting(
    routingOptions(
      createFakeFs({ [K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "  " }),
    ),
  );
  assert.equal(onlyBlank.appendSystem, undefined);
});

test("(R5) 读取故障：非 ENOENT warn+跳过候选；ENOENT 静默", async () => {
  const target = K(join(PROJECT, APPEND_SYSTEM_PROMPT_FILE_NAME));
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const fake = createFakeFs(
    { [K(join(USER_DIR, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "user fallback" },
    { failWith: { [target]: eacces } },
  );
  const routing = await loadPromptFileRouting(routingOptions(fake));
  assert.equal(routing.appendSystem.content, "user fallback", "故障候选跳过、user 兜底");
  assert.equal(fake.warnings.length, 1);
  assert.equal(fake.warnings[0].context.event, "prompt_file.read_failed");

  const silent = createFakeFs({});
  await loadPromptFileRouting(routingOptions(silent));
  assert.equal(silent.warnings.length, 0, "ENOENT 不产生 warn");
});

test("(R5) discoverPromptFile 单文件面 + walk-up 上限", async () => {
  const fake = createFakeFs({ [K(join(PROJECT_ROOT, APPEND_SYSTEM_PROMPT_FILE_NAME))]: "far ancestor" });
  // 默认上限 8 层：PROJECT → 父目录 → 根 共 3 层（两平台对称），能命中。
  const hit = await discoverPromptFile(APPEND_SYSTEM_PROMPT_FILE_NAME, routingOptions(fake));
  assert.equal(hit.content, "far ancestor");
  // 上限 1：只看 workingDirectory 本层。
  const missed = await discoverPromptFile(
    APPEND_SYSTEM_PROMPT_FILE_NAME,
    routingOptions(fake, { projectWalkUpLimit: 1 }),
  );
  assert.equal(missed, undefined);
});

// ── 2. loader：真实 tmpdir 异步 IO ───────────────────────────────

test("(R5) 真实盘：project 命中压过 user；project 移除后落 user", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-wi10-prompt-"));
  try {
    const projectDir = join(root, "project");
    const userDir = join(root, "user", ".acode");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, APPEND_SYSTEM_PROMPT_FILE_NAME), "from user dir", "utf8");

    const userOnly = await loadPromptFileRouting({
      workingDirectory: projectDir,
      userConfigDir: userDir,
    });
    assert.equal(userOnly.appendSystem.content, "from user dir");
    assert.equal(userOnly.appendSystem.scope, "user");

    await writeFile(join(projectDir, APPEND_SYSTEM_PROMPT_FILE_NAME), "from project", "utf8");
    const projectWins = await loadPromptFileRouting({
      workingDirectory: projectDir,
      userConfigDir: userDir,
    });
    assert.equal(projectWins.appendSystem.content, "from project");
    assert.equal(projectWins.appendSystem.scope, "project");
    // 内容逐字（不 trim、不加工）。
    assert.equal(projectWins.appendSystem.content, "from project");
    assert.equal(projectWins.systemOverride, undefined);
    assert.equal(projectWins.titleSystem, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. builder 注入（APPEND_SYSTEM.md 注入单测） ─────────────────

function baseConfig(overrides = {}) {
  return {
    workingDirectory: PROJECT,
    envInfo: {
      cwd: PROJECT,
      platform: process.platform,
      shell: "bash",
      osVersion: "test os",
      nodeVersion: process.version,
    },
    currentDate: "2026-10-18",
    guidanceToolNames: ["Read", "Bash", "Skill"],
    prompt: NO_FLAGS,
    ...overrides,
  };
}

function stableBodyOf(result) {
  // 3-block 布局：cli_prefix / stable body / dynamic（R4 硬约束，registry spec）。
  const stableBlocks = result.systemMessages.filter(
    (message) => message.role === "system" && !message.content.startsWith("You are ACode"),
  );
  return stableBlocks;
}

test("(R5) appendSystemPrompt 渲染 identity.append 段并进 stable body 末尾", () => {
  clearStablePrefixCaches();
  const result = createContextBuilder(
    baseConfig({ appendSystemPrompt: "ALWAYS ANSWER IN PIRATE SPEAK" }),
  ).build();

  const section = result.sections.find((s) => s.source === "append_system_prompt");
  assert.ok(section, "identity.append 段必须在场");
  assert.equal(section.name, "Append System Prompt");
  assert.equal(section.injectionTarget, "system");
  assert.equal(section.cacheHint, "stable");
  assert.equal(section.content, "\nALWAYS ANSWER IN PIRATE SPEAK");

  // stable body 是 cli_prefix 之外的第一个 system block；追加文本必须落其末尾
  // （stable 组声明序最后），且不进 dynamic block / meta_user。
  const body = stableBodyOf(result)[0].content;
  assert.ok(body.endsWith("ALWAYS ANSWER IN PIRATE SPEAK"), "追加文本在 stable body 末尾");
  const dynamic = result.systemMessages[result.systemMessages.length - 1].content;
  assert.ok(!dynamic.includes("PIRATE"), "dynamic block 不含追加文本");
  for (const attachment of result.metaUserAttachments) {
    assert.ok(!attachment.content.includes("PIRATE"));
  }
  clearStablePrefixCaches();
});

test("(R5) custom 通道叠加：customSystemPrompt + appendSystemPrompt 共存", () => {
  clearStablePrefixCaches();
  const result = createContextBuilder(
    baseConfig({
      customSystemPrompt: "YOU ARE A TRANSLATOR",
      appendSystemPrompt: "EXTRA RULES",
    }),
  ).build();
  const body = stableBodyOf(result)[0].content;
  assert.ok(body.includes("YOU ARE A TRANSLATOR"));
  assert.ok(body.endsWith("EXTRA RULES"));
  // custom 通道身份体替换默认身份：default identity 不在 stable body。
  assert.ok(!body.includes("You are an agent for ACode"));
  clearStablePrefixCaches();
});

test("(R5) workflow_actor 通道排除追加段（actor 身份自足）", () => {
  clearStablePrefixCaches();
  const result = createContextBuilder(
    baseConfig({
      workflowActor: { name: "worker", persona: "PERSONA TEXT" },
      appendSystemPrompt: "EXTRA RULES",
    }),
  ).build();
  assert.equal(
    result.sections.some((s) => s.source === "append_system_prompt"),
    false,
    "workflow_actor 通道不得渲染 identity.append",
  );
  const allText = JSON.stringify(result.systemMessages);
  assert.ok(!allText.includes("EXTRA RULES"));
  clearStablePrefixCaches();
});

test("(R5) 缺席/全空白 → 零渲染（既有面零回归）；旗标可单独摘除", () => {
  clearStablePrefixCaches();
  const absent = createContextBuilder(baseConfig()).build();
  assert.equal(
    absent.sections.some((s) => s.source === "append_system_prompt"),
    false,
  );
  const blank = createContextBuilder(baseConfig({ appendSystemPrompt: "   \n " })).build();
  assert.equal(blank.sections.some((s) => s.source === "append_system_prompt"), false);

  const disabled = createContextBuilder(
    baseConfig({
      appendSystemPrompt: "EXTRA RULES",
      prompt: { disabledSections: ["identity.append"], manifestTrace: false },
    }),
  ).build();
  assert.equal(
    disabled.sections.some((s) => s.source === "append_system_prompt"),
    false,
    "ACODE_PROMPT_SECTIONS_DISABLED=identity.append 可单独摘除",
  );
  clearStablePrefixCaches();
});

test("(R5) 文件名常量与 omp 路由面一致", () => {
  assert.equal(APPEND_SYSTEM_PROMPT_FILE_NAME, "APPEND_SYSTEM.md");
  assert.equal(SYSTEM_PROMPT_FILE_NAME, "SYSTEM.md");
  assert.equal(TITLE_SYSTEM_PROMPT_FILE_NAME, "TITLE_SYSTEM.md");
});
