import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * P2 验收测试：动态段注册表 + 组装管线升级。
 *
 * 覆盖 specs/system-prompt-section-registry.md 验收场景 1/2/4/5/6/7（场景 3/8/9 的
 * manifest 构建脚本与 parity 归 P3 专项，不在本文件）与方案 §4 P2 的验收：
 * - 场景 1：全旗标组合的段 id 序列快照（presentationSurface × 身份通道 ×
 *   disabledSections × 工具面）；
 * - 场景 2：cache breakpoint 断言（主路径 ≤3 block、全 ephemeral、stable 前缀跨
 *   cwd/日期逐字节稳定；子代理每段一条 system message 各带 breakpoint）；
 * - 场景 4：三选一互斥硬失败回归（错误消息逐字）+ custom 通道动态段整块缺席；
 * - 场景 5：双路径共享 descriptor 同一实例 + 共享段文本逐字节一致（R7）；
 * - 场景 6：旗标错误行为（未知 id 忽略+warn、非法 trace 值按 false+warn、无网络引用）；
 * - 场景 7：async 段失败 warn+skip、critical 身份段失败必抛（R3 例外）；
 * - Phase 1 保全：# Delegating work / 恢复的指导段 / memory、env 补齐全部有 id 且文本在场。
 *
 * 快照式断言 = 测试内冻结的 id 序列与关键文本（node:test + assert 既有约定）。
 */

const {
  MAIN_SECTION_REGISTRY,
  SUBAGENT_SECTION_REGISTRY,
  ALL_SECTION_IDS,
  createMainSectionContext,
  createSubagentSectionContext,
  resolveSectionEntries,
  resolveSectionEntriesSync,
  resolvePromptSectionFlags,
  createRegistrySection,
  PROMPT_SECTIONS_DISABLED_ENV,
  PROMPT_MANIFEST_TRACE_ENV,
} = await import("../packages/core/src/context/registry.ts");
const { createContextBuilder } = await import("../packages/core/src/context/builder.ts");
const { createSubagentContextBuilder } = await import(
  "../packages/core/src/subagent/context-builder.ts"
);
const { buildSubagentCommonNotes, buildSubagentEnvironmentContext } = await import(
  "../packages/core/src/subagent/system-prompt.ts"
);

const CLI_PREFIX_TEXT = "You are ACode, an interactive coding agent";

const ENV_INFO = {
  cwd: "C:/tmp/acode-p2-test",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26200 x64",
  nodeVersion: "v22.0.0",
};

const GIT_ENV_INFO = {
  ...ENV_INFO,
  isGitRepository: true,
  gitBranch: "dev/p2-test",
  gitMainBranch: "main",
  gitStatus: "clean",
};

const FULL_FACE = ["Agent", "SendMessage", "Skill", "AskUserQuestion", "Grep", "Glob", "Read", "Bash"];
const NO_SKILL_FACE = ["Agent", "Grep", "Glob", "Read"];
const READONLY_FACE = ["Read"];

const USER_INSTRUCTIONS = {
  scope: "workspace",
  filePath: "C:/tmp/acode-p2-test/AGENTS.md",
  fileName: "AGENTS.md",
  content: "# P2 test instructions",
  bytesRead: 22,
  sizeBytes: 22,
  truncated: false,
};

const SKILLS_OUTCOME = {
  skills: [
    {
      name: "p2-test-skill",
      description: "A fixture skill for registry tests.",
      path: ".agents/skills/p2-test-skill/SKILL.md",
    },
  ],
};

const NO_FLAGS = { disabledSections: [], manifestTrace: false };

function baseConfig(overrides = {}) {
  return {
    workingDirectory: ENV_INFO.cwd,
    envInfo: ENV_INFO,
    currentDate: "2026-09-29",
    guidanceToolNames: FULL_FACE,
    memoryRoot: "C:/tmp/acode-p2-memory",
    userInstructions: USER_INSTRUCTIONS,
    skills: SKILLS_OUTCOME,
    // 显式旗标：矩阵测试不吃宿主 env（env 接线单测除外）。
    prompt: NO_FLAGS,
    ...overrides,
  };
}

function createCapturingLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const logger = {
    calls,
    debug: (message, context) => calls.debug.push({ message, context }),
    info: (message, context) => calls.info.push({ message, context }),
    warn: (message, context) => calls.warn.push({ message, context }),
    error: (message, error, context) => calls.error.push({ message, error, context }),
    child: () => logger,
  };
  return logger;
}

function mainIds(config) {
  const ctx = createMainSectionContext(config);
  return resolveSectionEntriesSync(MAIN_SECTION_REGISTRY, ctx).map((entry) => entry.descriptor.id);
}

function subagentIds(subagentConfig) {
  const ctx = createSubagentSectionContext({
    config: {
      workingDirectory: subagentConfig.envInfo.cwd,
      envInfo: subagentConfig.envInfo,
      model: subagentConfig.model,
      currentDate: subagentConfig.currentDate,
      skillMetadataBudget: subagentConfig.skillMetadataBudget,
      skills: subagentConfig.skills,
      userInstructions: subagentConfig.userInstructions,
    },
    subagent: { agentPrompt: subagentConfig.agentPrompt },
    prompt: subagentConfig.prompt ?? NO_FLAGS,
    logger: subagentConfig.logger,
  });
  return resolveSectionEntriesSync(SUBAGENT_SECTION_REGISTRY, ctx).map(
    (entry) => entry.descriptor.id,
  );
}

// ============================================================
// 场景 1：全旗标组合的段 id 序列快照
// ============================================================

test("(场景1) default 通道全量组合：id 序列快照", () => {
  assert.deepEqual(mainIds(baseConfig()), [
    "prefix.cli",
    "identity.default",
    "behavior.dynamic",
    "guidance.session",
    "guidance.delegating_work",
    "memory.persistent",
    "env.info",
    "context.management",
    "skills.listing",
    "request.user_context",
    "date.current",
  ]);

  // acode_desktop 呈现面：surface.desktop 落 stable 组、紧随身份体（既有 push 顺序）。
  assert.deepEqual(mainIds(baseConfig({ presentationSurface: "acode_desktop" })), [
    "prefix.cli",
    "identity.default",
    "surface.desktop",
    "behavior.dynamic",
    "guidance.session",
    "guidance.delegating_work",
    "memory.persistent",
    "env.info",
    "context.management",
    "skills.listing",
    "request.user_context",
    "date.current",
  ]);

  // git 仓库在场：env.git_snapshot 出现在 context.management 之后。
  assert.deepEqual(mainIds(baseConfig({ envInfo: GIT_ENV_INFO })), [
    "prefix.cli",
    "identity.default",
    "behavior.dynamic",
    "guidance.session",
    "guidance.delegating_work",
    "memory.persistent",
    "env.info",
    "context.management",
    "env.git_snapshot",
    "skills.listing",
    "request.user_context",
    "date.current",
  ]);

  // output style 生效：style.output 在 env.info 之后。
  const styled = mainIds(baseConfig({ outputStyle: { name: "Terse", prompt: "Be terse." } }));
  assert.ok(styled.includes("style.output"));
  assert.ok(styled.indexOf("style.output") > styled.indexOf("env.info"));
  // 空白 prompt 的 style 视同缺席（既有 activeOutputStyle 判定）。
  assert.ok(!mainIds(baseConfig({ outputStyle: { name: "Blank", prompt: "   " } })).includes("style.output"));
});

test("(场景1) custom / workflow_actor 通道：id 序列快照", () => {
  // custom 通道：默认动态段体系整块缺席（R5），只剩前缀 + 自定义身份体 + any 通道段。
  assert.deepEqual(mainIds(baseConfig({ customSystemPrompt: "You are a review bot." })), [
    "prefix.cli",
    "identity.custom",
    "skills.listing",
    "request.user_context",
    "date.current",
  ]);

  // workflow_actor 通道：无 cli_prefix（错误身份不走前导），跳过面向用户对话的三段，
  // 保留 memory 与其后各段（既有语义）。
  assert.deepEqual(mainIds(baseConfig({ workflowActor: { name: "reviewer" } })), [
    "identity.workflow_actor",
    "memory.persistent",
    "env.info",
    "context.management",
    "skills.listing",
    "request.user_context",
    "date.current",
  ]);
});

test("(场景1) disabledSections 排除 dynamic 段与 stable 段", () => {
  const withoutDelegating = mainIds(
    baseConfig({ prompt: { disabledSections: ["guidance.delegating_work"], manifestTrace: false } }),
  );
  assert.ok(!withoutDelegating.includes("guidance.delegating_work"));
  assert.ok(withoutDelegating.includes("guidance.session"));

  const withoutDesktop = mainIds(
    baseConfig({
      presentationSurface: "acode_desktop",
      prompt: { disabledSections: ["surface.desktop"], manifestTrace: false },
    }),
  );
  assert.ok(!withoutDesktop.includes("surface.desktop"));

  // 稳定前缀段也可被诊断排除（block 1 缺席 → systemMessages 只剩 2 块）。
  const result = createContextBuilder(
    baseConfig({ prompt: { disabledSections: ["prefix.cli"], manifestTrace: false } }),
  ).build();
  assert.ok(!mainIds(baseConfig({ prompt: { disabledSections: ["prefix.cli"], manifestTrace: false } })).includes("prefix.cli"));
  assert.equal(result.systemMessages.length, 2);
  assert.equal(result.systemMessages[0].content.startsWith("\nYou are an interactive ACode agent"), true);
});

test("(场景1) 工具面组合：Skill 缺席 / 只读面 / 表缺席", () => {
  // 无 Skill 工具：skills.listing 缺席（不让模型相信它有没注册的工具），guidance 两段保留。
  const noSkill = mainIds(baseConfig({ guidanceToolNames: NO_SKILL_FACE }));
  assert.ok(!noSkill.includes("skills.listing"));
  assert.ok(noSkill.includes("guidance.session"));
  assert.ok(noSkill.includes("guidance.delegating_work"));

  // 只读面：无派发工具 → guidance 两段都缺席（严格方向）；无 Skill → skills.listing 缺席。
  const readonlyFace = mainIds(baseConfig({ guidanceToolNames: READONLY_FACE }));
  assert.ok(!readonlyFace.includes("guidance.session"));
  assert.ok(!readonlyFace.includes("guidance.delegating_work"));
  assert.ok(!readonlyFace.includes("skills.listing"));

  // 表缺席（undefined）：skills.listing 容错方向视为可用；guidance 严格方向缺席。
  const absentFace = mainIds(baseConfig({ guidanceToolNames: undefined }));
  assert.ok(absentFace.includes("skills.listing"));
  assert.ok(!absentFace.includes("guidance.session"));
  assert.ok(!absentFace.includes("guidance.delegating_work"));
});

test("(场景1) 数据缺席组合：memoryRoot / currentDate / userInstructions / skills", () => {
  const ids = mainIds(
    baseConfig({ memoryRoot: undefined, currentDate: undefined, userInstructions: undefined, skills: undefined }),
  );
  assert.deepEqual(ids, [
    "prefix.cli",
    "identity.default",
    "behavior.dynamic",
    "guidance.session",
    "guidance.delegating_work",
    "env.info",
    "context.management",
  ]);
});

test("(场景1) 子代理路径 id 序列快照（含旗标排除共享段）", () => {
  const subConfig = {
    agentPrompt: "Review the diff and report findings.",
    currentDate: "2026-09-29",
    envInfo: ENV_INFO,
    userInstructions: USER_INSTRUCTIONS,
    skills: SKILLS_OUTCOME,
  };
  assert.deepEqual(subagentIds(subConfig), [
    "prefix.cli",
    "subagent.agent_prompt",
    "subagent.notes",
    "subagent.environment",
    "request.user_context",
    "date.current",
    "skills.listing",
  ]);

  // 空 agentPrompt：整段缺席，左边界不得单独成为 system block。
  assert.deepEqual(subagentIds({ ...subConfig, agentPrompt: "   " }), [
    "prefix.cli",
    "subagent.notes",
    "subagent.environment",
    "request.user_context",
    "date.current",
    "skills.listing",
  ]);

  // 旗标对子代理路径同样生效（共享 descriptor 基础设施）。
  assert.deepEqual(subagentIds({ ...subConfig, prompt: { disabledSections: ["prefix.cli"], manifestTrace: false } }), [
    "subagent.agent_prompt",
    "subagent.notes",
    "subagent.environment",
    "request.user_context",
    "date.current",
    "skills.listing",
  ]);
});

// ============================================================
// 场景 2：cache breakpoint 断言
// ============================================================

test("(场景2) 主路径：≤3 个 system block、全 ephemeral、dynamic 自带左边界", () => {
  const result = createContextBuilder(baseConfig()).build();
  assert.equal(result.systemMessages.length, 3);
  for (const message of result.systemMessages) {
    assert.equal(message.role, "system");
    assert.deepEqual(message.cacheControl, { type: "ephemeral" });
  }
  assert.equal(result.systemMessages[0].content, CLI_PREFIX_TEXT);
  assert.ok(result.systemMessages[1].content.includes("You are an interactive ACode agent"));
  assert.ok(result.systemMessages[1].content.includes("# Harness"));
  assert.ok(result.systemMessages[2].content.startsWith("\n\n# Communicating with the user"));
  assert.equal(result.metaUserAttachments[0].source, "skills_listing");
  assert.equal(result.metaUserAttachments[1].source, "context_prefix");
  assert.ok(result.metaUserAttachments[1].content.includes("# agentsMd"));
  assert.ok(result.metaUserAttachments[1].content.includes("# currentDate"));
});

test("(场景2) stable 前缀稳定性：跨 cwd/日期/工具面逐字节相同", () => {
  const a = createContextBuilder(baseConfig()).build();
  const b = createContextBuilder(
    baseConfig({
      envInfo: { ...ENV_INFO, cwd: "D:/elsewhere/p2" },
      workingDirectory: "D:/elsewhere/p2",
      currentDate: "2027-01-01",
      guidanceToolNames: READONLY_FACE,
      memoryRoot: undefined,
    }),
  ).build();
  // block 1（cli_prefix）与 block 2（stable body）逐字节相同；dynamic block 必然不同。
  assert.equal(a.systemMessages[0].content, b.systemMessages[0].content);
  assert.equal(a.systemMessages[1].content, b.systemMessages[1].content);
  assert.notEqual(
    a.systemMessages[a.systemMessages.length - 1].content,
    b.systemMessages[b.systemMessages.length - 1].content,
  );
});

test("(场景2) 子代理路径：每段一条 system message、各带独立 breakpoint、boundary 由组装器施加", () => {
  const agentPrompt = "Review the diff and report findings.";
  const result = createSubagentContextBuilder({
    agentPrompt,
    currentDate: "2026-09-29",
    envInfo: ENV_INFO,
    userInstructions: USER_INSTRUCTIONS,
    prompt: NO_FLAGS,
  }).build();

  assert.equal(result.systemMessages.length, 4);
  for (const message of result.systemMessages) {
    assert.deepEqual(message.cacheControl, { type: "ephemeral" });
  }
  // cli_prefix 无左边界；agent_prompt 单换行；notes / environment 双换行（R7：组装器施加）。
  assert.equal(result.systemMessages[0].content, CLI_PREFIX_TEXT);
  assert.equal(result.systemMessages[1].content, `\n${agentPrompt}`);
  assert.equal(result.systemMessages[2].content, `\n\n${buildSubagentCommonNotes()}`);
  assert.equal(
    result.systemMessages[3].content,
    `\n\n${buildSubagentEnvironmentContext({ agentPrompt, envInfo: ENV_INFO })}`,
  );
  // descriptor 文本保持纯净：section 元数据里不含组装器施加的左边界。
  const notesSection = result.sections.find((section) => section.source === "subagent_notes");
  assert.equal(notesSection.content, buildSubagentCommonNotes());
});

// ============================================================
// 场景 4：互斥硬失败回归
// ============================================================

const MUTEX_MESSAGE = "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive";

test("(场景4) workflowActor 与 customSystemPrompt 同在 → 抛错（消息逐字，sync/async 同语义）", () => {
  const config = baseConfig({ workflowActor: { name: "reviewer" }, customSystemPrompt: "You are a review bot." });
  assert.throws(() => createContextBuilder(config).build(), (error) => {
    assert.equal(error.message, MUTEX_MESSAGE);
    return true;
  });
  assert.throws(() => createMainSectionContext(config), (error) => error.message === MUTEX_MESSAGE);
  return createContextBuilder(config)
    .buildAsync()
    .then(
      () => assert.fail("buildAsync should have thrown"),
      (error) => assert.equal(error.message, MUTEX_MESSAGE),
    );
});

test("(场景4) custom 通道：默认动态段体系整块缺席、stable body 为自定义全文", () => {
  const result = createContextBuilder(baseConfig({ customSystemPrompt: "You are a review bot." })).build();
  const sources = result.sections.map((section) => section.source);
  for (const absent of [
    "dynamic_behavior",
    "session_guidance",
    "memory",
    "env_info",
    "output_style",
    "context_management",
    "system_context",
    "desktop_context",
    "identity",
  ]) {
    assert.equal(sources.includes(absent), false, `custom 通道不应含 ${absent}`);
  }
  assert.equal(result.systemMessages.length, 2);
  assert.equal(result.systemMessages[1].content, "\nYou are a review bot.");
});

// ============================================================
// 场景 5：双路径共享段一致性（R7）
// ============================================================

test("(场景5) 共享段 descriptor 是同一实例", () => {
  const byId = (registry) => new Map(registry.map((descriptor) => [descriptor.id, descriptor]));
  const main = byId(MAIN_SECTION_REGISTRY);
  const subagent = byId(SUBAGENT_SECTION_REGISTRY);
  for (const id of ["prefix.cli", "request.user_context", "date.current", "skills.listing"]) {
    assert.ok(main.has(id) && subagent.has(id), `${id} 应同时在两条注册表`);
    assert.equal(main.get(id), subagent.get(id), `${id} 必须是同一个 descriptor 对象`);
  }
});

test("(场景5) 共享段文本主/子代理路径逐字节相同", () => {
  const main = createContextBuilder(baseConfig({ memoryRoot: undefined })).build();
  const subagent = createSubagentContextBuilder({
    agentPrompt: "Review the diff.",
    currentDate: "2026-09-29",
    envInfo: ENV_INFO,
    userInstructions: USER_INSTRUCTIONS,
    skills: SKILLS_OUTCOME,
    prompt: NO_FLAGS,
  }).build();

  // cli_prefix：主路径 block 1 与子代理 message 1 逐字节相同。
  assert.equal(main.systemMessages[0].content, subagent.systemMessages[0].content);
  // context_prefix attachment（request_user_context + current_date 组合体）逐字节相同。
  const mainContext = main.metaUserAttachments.find((a) => a.source === "context_prefix");
  const subContext = subagent.metaUserAttachments.find((a) => a.source === "context_prefix");
  assert.equal(mainContext.content, subContext.content);
  // skills_listing attachment 逐字节相同。
  const mainSkills = main.metaUserAttachments.find((a) => a.source === "skills_listing");
  const subSkills = subagent.metaUserAttachments.find((a) => a.source === "skills_listing");
  assert.equal(mainSkills.content, subSkills.content);
});

// ============================================================
// 场景 6：旗标错误行为 + 无网络
// ============================================================

test("(场景6) ACODE_PROMPT_SECTIONS_DISABLED：未知 id 忽略+warn，其余生效，重复去重", () => {
  const logger = createCapturingLogger();
  const flags = resolvePromptSectionFlags(
    { [PROMPT_SECTIONS_DISABLED_ENV]: "guidance.delegating_work, p2.fake.id ,guidance.delegating_work" },
    { logger, knownSectionIds: ALL_SECTION_IDS },
  );
  assert.deepEqual(flags.disabledSections, ["guidance.delegating_work"]);
  const warns = logger.calls.warn.filter((c) => c.context?.event === "prompt.flags.unknown_section_id");
  assert.equal(warns.length, 1);
  assert.equal(warns[0].context.sectionId, "p2.fake.id");

  // 空串 / 全空白 → 空数组（默认零行为变化）。
  assert.deepEqual(resolvePromptSectionFlags({ [PROMPT_SECTIONS_DISABLED_ENV]: "" }).disabledSections, []);
  assert.deepEqual(resolvePromptSectionFlags({ [PROMPT_SECTIONS_DISABLED_ENV]: "   " }).disabledSections, []);
  assert.deepEqual(resolvePromptSectionFlags({}).disabledSections, []);
});

test("(场景6) ACODE_PROMPT_MANIFEST_TRACE：1/true 为真，非法值按 false + warn", () => {
  assert.equal(resolvePromptSectionFlags({ [PROMPT_MANIFEST_TRACE_ENV]: "1" }).manifestTrace, true);
  assert.equal(resolvePromptSectionFlags({ [PROMPT_MANIFEST_TRACE_ENV]: "TRUE" }).manifestTrace, true);
  assert.equal(resolvePromptSectionFlags({ [PROMPT_MANIFEST_TRACE_ENV]: "0" }).manifestTrace, false);
  assert.equal(resolvePromptSectionFlags({ [PROMPT_MANIFEST_TRACE_ENV]: "false" }).manifestTrace, false);
  assert.equal(resolvePromptSectionFlags({}).manifestTrace, false);

  const logger = createCapturingLogger();
  const flags = resolvePromptSectionFlags({ [PROMPT_MANIFEST_TRACE_ENV]: "maybe-p2-invalid" }, { logger });
  assert.equal(flags.manifestTrace, false);
  assert.equal(
    logger.calls.warn.some((c) => c.context?.event === "prompt.flags.invalid_manifest_trace"),
    true,
  );
});

test("(场景6) env 接线：builder 在 config.prompt 缺席时解析 env，两个旗标都生效", (t) => {
  const logger = createCapturingLogger();
  process.env[PROMPT_SECTIONS_DISABLED_ENV] = "guidance.delegating_work, p2.env.unknown.id";
  process.env[PROMPT_MANIFEST_TRACE_ENV] = "1";
  t.after(() => {
    delete process.env[PROMPT_SECTIONS_DISABLED_ENV];
    delete process.env[PROMPT_MANIFEST_TRACE_ENV];
  });

  const result = createContextBuilder(baseConfig({ prompt: undefined, logger })).build();
  const contents = result.sections.map((section) => section.content).join("\n");
  assert.ok(contents.includes("# Session-specific guidance"));
  assert.ok(!contents.includes("# Delegating work"));

  // 未知 id：忽略 + warn，build 不失败（不 fail-closed）。
  assert.equal(
    logger.calls.warn.some(
      (c) => c.context?.event === "prompt.flags.unknown_section_id" && c.context.sectionId === "p2.env.unknown.id",
    ),
    true,
  );
  // manifest trace：debug 级、含段 id 清单 + hash，不外发。
  const trace = logger.calls.debug.find((c) => c.context?.event === "prompt.manifest_trace");
  assert.ok(trace);
  assert.ok(trace.context.sectionIds.includes("guidance.session"));
  assert.ok(!trace.context.sectionIds.includes("guidance.delegating_work"));
  assert.match(trace.context.sectionsHash, /^[0-9a-f]{64}$/);
});

test("(场景6) 注册表与旗标源码无任何网络/遥测引用", async () => {
  // 源文件路径必须锚定测试文件自身位置而非 process.cwd()：cwd 相对路径在从
  // apps/acode-cli 目录运行套件时会把 apps/acode-cli 拼接两次导致 ENOENT
  // （同目录 auth-login-vault-wiring 等源码审读测试的既有纪律）。
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    "context/registry.ts",
    "context/registry-main.ts",
    "context/registry-subagent.ts",
    "context/registry-shared.ts",
    "context/section-descriptors.ts",
    "context/section-flags.ts",
    "context/builder.ts",
    "subagent/context-builder.ts",
  ];
  // 断言的是**代码级**网络/遥测引用：注释里引用 spec 名（no-telemetry.md）不算。
  const forbidden = /fetch\(|XMLHttpRequest|otlp|new\s+\w*Exporter|from\s+["'][^"']*telemetry|https?:\/\//i;
  for (const file of files) {
    const content = await readFile(
      join(here, "..", "packages", "core", "src", ...file.split("/")),
      "utf8",
    );
    assert.equal(forbidden.test(content), false, `${file} 不得含网络/遥测引用`);
  }
});

test("(场景6/R6) manifest trace hash 只覆盖 persistable 段且跨运行期数据稳定", () => {
  const loggerA = createCapturingLogger();
  const loggerB = createCapturingLogger();
  createContextBuilder(baseConfig({ logger: loggerA, prompt: { disabledSections: [], manifestTrace: true } })).build();
  createContextBuilder(
    baseConfig({
      logger: loggerB,
      prompt: { disabledSections: [], manifestTrace: true },
      envInfo: { ...ENV_INFO, cwd: "D:/elsewhere/p2" },
      currentDate: "2027-01-01",
      memoryRoot: "D:/other-memory",
    }),
  ).build();
  const traceA = loggerA.calls.debug.find((c) => c.context?.event === "prompt.manifest_trace");
  const traceB = loggerB.calls.debug.find((c) => c.context?.event === "prompt.manifest_trace");
  assert.ok(traceA && traceB);
  // persistable 段（prefix.cli / identity.default / behavior.dynamic / context.management）
  // 不含运行期数据 → 两次构建 hash 相同。
  assert.equal(traceA.context.sectionsHash, traceB.context.sectionsHash);
});

// ============================================================
// 场景 7：async 段解析失败不致命；critical 例外
// ============================================================

function fixtureDescriptor(overrides) {
  return {
    id: "test.fixture",
    source: "context_management",
    group: "system-dynamic",
    channel: "any",
    persistable: false,
    owner: "apps/acode-cli/tests/system-prompt-section-registry.test.mjs",
    enabled: () => true,
    build: () =>
      createRegistrySection({
        name: "Fixture",
        source: "context_management",
        group: "system-dynamic",
        content: "fixture",
      }),
    ...overrides,
  };
}

test("(场景7) async 段 reject：warn + 跳过，其余段照常；critical 段 reject 必抛", async () => {
  const logger = createCapturingLogger();
  const ctx = createMainSectionContext(baseConfig({ logger }));
  const failing = fixtureDescriptor({
    id: "test.failing_async",
    build: async () => {
      throw new Error("p2 fixture boom");
    },
  });
  const ok = fixtureDescriptor({ id: "test.ok" });

  const entries = await resolveSectionEntries([ok, failing, ok], ctx);
  assert.deepEqual(entries.map((e) => e.descriptor.id), ["test.ok", "test.ok"]);
  const warn = logger.calls.warn.find((c) => c.context?.event === "prompt.section.build_failed");
  assert.ok(warn);
  assert.equal(warn.context.sectionId, "test.failing_async");

  const critical = fixtureDescriptor({
    id: "identity.fixture",
    critical: true,
    build: async () => {
      throw new Error("p2 identity boom");
    },
  });
  await assert.rejects(() => resolveSectionEntries([critical], ctx), /p2 identity boom/);
});

test("(场景7) 同步管线遇到 async 段：非 critical warn+skip，critical 抛", () => {
  const logger = createCapturingLogger();
  const ctx = createMainSectionContext(baseConfig({ logger }));
  const asyncOk = fixtureDescriptor({
    id: "test.async_in_sync",
    build: async () =>
      createRegistrySection({
        name: "Fixture",
        source: "context_management",
        group: "system-dynamic",
        content: "fixture",
      }),
  });
  const entries = resolveSectionEntriesSync([asyncOk], ctx);
  assert.deepEqual(entries, []);
  assert.equal(
    logger.calls.warn.some((c) => c.context?.event === "prompt.section.build_failed"),
    true,
  );

  const criticalAsync = fixtureDescriptor({
    id: "identity.async_in_sync",
    critical: true,
    build: () => Promise.resolve(null),
  });
  assert.throws(() => resolveSectionEntriesSync([criticalAsync], ctx), /returned a promise/);
});

test("(场景7) build 与 buildAsync 产物一致（当前注册表全同步）", async () => {
  const sync = createContextBuilder(baseConfig()).build();
  const async_ = await createContextBuilder(baseConfig()).buildAsync();
  assert.deepEqual(async_.sections, sync.sections);
  assert.deepEqual(async_.systemMessages, sync.systemMessages);
  assert.deepEqual(async_.metaUserAttachments, sync.metaUserAttachments);
});

// ============================================================
// Phase 1 保全 + 注册表清单
// ============================================================

test("(Phase1 保全) 注册表段 id 清单：19 个 id 全量、含 P1/P6 落地段", () => {
  assert.deepEqual([...ALL_SECTION_IDS], [
    "prefix.cli",
    "identity.custom",
    "identity.workflow_actor",
    "identity.default",
    "surface.desktop",
    "behavior.dynamic",
    "guidance.session",
    "guidance.delegating_work",
    "memory.persistent",
    "env.info",
    "style.output",
    "context.management",
    "env.git_snapshot",
    "skills.listing",
    "request.user_context",
    "date.current",
    "subagent.agent_prompt",
    "subagent.notes",
    "subagent.environment",
  ]);
});

test("(Phase1 保全) 纪律节/指导段/memory/env 补齐文本全部在场且可单独开关", () => {
  const result = createContextBuilder(baseConfig()).build();
  const dynamicBlock = result.systemMessages[result.systemMessages.length - 1].content;
  // D1 纪律节 + P1 恢复的指导 bullet：
  assert.ok(dynamicBlock.includes("# Delegating work"));
  assert.ok(dynamicBlock.includes("Dispatch subagents in the background by default"));
  assert.ok(dynamicBlock.includes("- For broad codebase exploration or research"));
  assert.ok(dynamicBlock.includes("- AskUserQuestion is the channel for a bounded clarification"));
  // P6 memory 补齐（好记忆三特征 + 待核实快照定性）：
  const memory = result.sections.find((section) => section.source === "memory");
  assert.ok(memory.content.includes("**Applicable**"));
  assert.ok(memory.content.includes("snapshot awaiting verification"));
  // P6 env 补齐（Operating system 明细行 + not-a-git 指令段）：
  const envInfo = result.sections.find((section) => section.source === "env_info");
  assert.ok(envInfo.content.includes("- Operating system: Windows (10.0.26200 x64)"));
  assert.ok(envInfo.content.includes("The working directory is not a git repository"));

  // 单独开关：只摘纪律节，其余段逐字节不受影响（dynamic block 恰少「\n\n + 纪律节全文」）。
  const delegatingContent = result.sections.find((section) =>
    section.content.startsWith("# Delegating work"),
  ).content;
  const withoutDelegating = createContextBuilder(
    baseConfig({ prompt: { disabledSections: ["guidance.delegating_work"], manifestTrace: false } }),
  ).build();
  const withoutBlock = withoutDelegating.systemMessages[withoutDelegating.systemMessages.length - 1].content;
  assert.ok(!withoutBlock.includes("# Delegating work"));
  assert.ok(withoutBlock.includes("# Session-specific guidance"));
  assert.equal(withoutBlock, dynamicBlock.replace(`\n\n${delegatingContent}`, ""));
});
