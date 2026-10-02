import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * P4 验收测试：提示词语言策略（specs/prompt-language-policy.md）。
 *
 * 覆盖该 spec 的验收场景：
 * - 场景 1「模型面无 locale 依赖」：`language` 取 zh-CN / en-US / 缺席时 systemMessages 与
 *   metaUserAttachments 逐字节相同；模型面源码不 import `@acode/i18n`、不调用
 *   resolveLocale/detectLocale/getACodeCopy、不读 `.language`（同时钉住 R6 第 2、3 条：
 *   locale 既不影响模型面文本，也不进 cache 前缀）。
 * - 场景 2「`language` 处置生效」（R4 选 (ii) 保留 + 注释）：`context/types.ts` 的声明上方
 *   有中文注释且含 R4 要求的三件事 + 类型不一致记录；透传链的命中文件集合被冻结
 *   （新出现的消费方会让本测试红）；设置 `language` 不改变组装结果。
 * - 场景 3「双面文本按模型面处理」：全部 `cancellation.userVisibleMessage` 恒英文（无 CJK）；
 *   经 `createErrorResult`（tool/executor/errors.ts）投影后 `error.message` 仍是英文且
 *   `error.type` 是结构化的 `tool_cancelled`；UI 侧 `formatEventError` 按 type 查 catalog
 *   取到本地化文案，表外类型回落展示原始英文（回落路径有断言），en-US 侧逐字不变。
 * - 场景 4「i18n 双 locale 同批」：两套 catalog 的键路径集合与每个键的 typeof 完全相同。
 * - 场景 6「无新增 env 面」：CLI 源码里出现的 `ACODE_*` 名称没有语言/本地化相关的新变量。
 *
 * 场景 5（cache 前缀不因语言分裂）由场景 1 的逐字节断言覆盖：stable 前缀两块在两个
 * `language` 取值下相同且各自带 ephemeral cacheControl。场景 7 是验证命令，不在测试内。
 */

const CLI_ROOT = new URL("../", import.meta.url);

const { createContextBuilder } = await import("../packages/core/src/context/builder.ts");
const { createErrorResult } = await import("../packages/core/src/tool/executor/errors.ts");
const { getACodeCopy } = await import("../packages/i18n/src/index.ts");
const { formatEventError } = await import("../packages/tui/src/app-event-data.ts");
// 源码路径导入（tests/ 下没有 node_modules，裸说明符解析不到）。core 内部按裸说明符
// 拿到的是 dist 副本，但 CoreErrorType 是字符串常量、isCoreError 是鸭子判定
// （`error instanceof Error && "type" in error && "code" in error`），跨副本不影响判定。
const { CoreErrorType, createCoreError } = await import(
  "../packages/contracts/src/errors/index.ts"
);

// ── 公共夹具 ──────────────────────────────────────────────────────────

const ENV_INFO = {
  cwd: "C:/tmp/acode-p4-test",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26200 x64",
  nodeVersion: "v22.0.0",
  isGitRepository: true,
  gitBranch: "dev/p4-test",
  gitMainBranch: "main",
  gitStatus: "clean",
};

const USER_INSTRUCTIONS = {
  scope: "workspace",
  filePath: "C:/tmp/acode-p4-test/AGENTS.md",
  fileName: "AGENTS.md",
  content: "# P4 test instructions",
  bytesRead: 22,
  sizeBytes: 22,
  truncated: false,
};

/**
 * 显式旗标：不吃宿主 env（ACODE_PROMPT_SECTIONS_DISABLED 在场会改变段序列，
 * 那样「逐字节相同」的断言就测不到语言维度了）。
 */
const NO_FLAGS = { disabledSections: [], manifestTrace: false };

function baseConfig(overrides = {}) {
  return {
    workingDirectory: ENV_INFO.cwd,
    envInfo: ENV_INFO,
    currentDate: "2026-09-29",
    guidanceToolNames: ["Agent", "Skill", "Grep", "Glob", "Read", "Bash"],
    userInstructions: USER_INSTRUCTIONS,
    prompt: NO_FLAGS,
    ...overrides,
  };
}

/** 递归收集目录下全部 `.ts` 源文件（跳过 dist / node_modules / generated）。 */
async function collectSources(relativeDir) {
  const absolute = new URL(relativeDir, CLI_ROOT);
  const out = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".ts")) out.push(child);
    }
  };
  await walk(absolute);
  assert.ok(out.length > 0, `no sources found under ${relativeDir}`);
  return out;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** URL → `packages/<包>/src/<文件>.ts`（断言失败时给出可读位置）。 */
function relName(file) {
  return `packages/${file.pathname.split("/packages/")[1]}`;
}

// ── 场景 1 / 5：模型面恒英文，无 locale 依赖 ────────────────────────────

test("(场景1) language 取 zh-CN / en-US / 缺席：systemMessages 逐字节相同", () => {
  const zh = createContextBuilder(baseConfig({ language: "zh-CN" })).build();
  const en = createContextBuilder(baseConfig({ language: "en-US" })).build();
  const none = createContextBuilder(baseConfig()).build();

  assert.ok(zh.systemMessages.length >= 2, "expected the stable prefix blocks to be present");
  assert.equal(JSON.stringify(zh.systemMessages), JSON.stringify(en.systemMessages));
  assert.equal(JSON.stringify(zh.systemMessages), JSON.stringify(none.systemMessages));
  assert.equal(JSON.stringify(zh.metaUserAttachments), JSON.stringify(en.metaUserAttachments));
  assert.equal(JSON.stringify(zh.metaUserAttachments), JSON.stringify(none.metaUserAttachments));
});

test("(场景5) stable 前缀不因语言分裂：两块逐字节相同且各带 ephemeral cacheControl", () => {
  const zh = createContextBuilder(baseConfig({ language: "zh-CN" })).build();
  const en = createContextBuilder(baseConfig({ language: "en-US" })).build();

  // 前两块是 stable 前缀（system-prompt-section-registry.md 场景 2 的同一断言口径）。
  assert.equal(zh.systemMessages[0].content, en.systemMessages[0].content);
  assert.equal(zh.systemMessages[1].content, en.systemMessages[1].content);
  for (const message of zh.systemMessages) {
    assert.equal(message.role, "system");
    assert.deepEqual(message.cacheControl, { type: "ephemeral" });
  }
});

test("(场景1/R6-2,3) 模型面源码不接 i18n、不读 locale、不读 .language", async () => {
  const dirs = ["packages/core/src/context/", "packages/core/src/subagent/"];
  for (const dir of dirs) {
    for (const file of await collectSources(dir)) {
      const source = await readFile(file, "utf8");
      const name = relName(file);
      // 精确匹配 import 语句与调用点：注释里出现「locale」「@acode/i18n」这类散文不算依赖
      // （context/types.ts 的 R4 注释就要写明 ui.locale 才是真实所有者）。
      assert.doesNotMatch(
        source,
        /^\s*import[^;]*?from\s*["']@acode\/i18n["']/mu,
        `${name} imports @acode/i18n`,
      );
      assert.doesNotMatch(
        source,
        /\b(resolveLocale|detectLocale|getACodeCopy)\s*\(/,
        `${name} resolves a locale`,
      );
      assert.doesNotMatch(source, /\.language\b/, `${name} reads .language`);
    }
  }
});

// ── 场景 2：language 是悬空配置（R4 选 (ii) 保留 + 注释） ─────────────────

test("(场景2) 透传链命中文件集合被冻结：core/bootstrap 里只有三处 .language", async () => {
  const allowed = [
    // 写入：config patch（本 spec 记录的写入点）
    "packages/core/src/runtime/methods/config.ts",
    // 透传：RuntimeConfig → ContextBuilderConfig
    "packages/core/src/runtime/methods/context.ts",
    // 装配：bootstrap 把 StartSessionOptions.runtimeConfig.language 搬进 RuntimeConfig
    "packages/bootstrap/src/app/runtime-config.ts",
  ].sort();
  const hits = [];
  for (const dir of ["packages/core/src/", "packages/bootstrap/src/"]) {
    for (const file of await collectSources(dir)) {
      const source = await readFile(file, "utf8");
      if (/\.language\b/.test(source)) hits.push(relName(file));
    }
  }
  // 集合相等 = 既没有漏掉已知链路，也没有新消费方偷偷接上（R4「不得接进任何 section builder」）。
  // 注：tui/src/app-shiki-highlighter.ts 也有 `.language`，那是语法高亮的语言标识，
  // 与 UI locale / 提示词语言无关，不在本扫描范围（只扫 core 与 bootstrap）。
  assert.deepEqual(hits.sort(), allowed);
});

test("(场景2) context/types.ts 的 language 声明带 R4 要求的中文注释", async () => {
  const source = await readFile(new URL("packages/core/src/context/types.ts", CLI_ROOT), "utf8");
  const at = source.indexOf("language?: string;");
  assert.ok(at > 0, "ContextBuilderConfig.language declaration not found");
  // 注释必须紧贴在声明上方（R4：「在 context/types.ts:124 上方加中文注释」）。
  const before = source.slice(Math.max(0, at - 1600), at);
  const commentStart = before.lastIndexOf("/**");
  assert.ok(commentStart >= 0, "no doc comment above the declaration");
  const comment = before.slice(commentStart);
  assert.ok(comment.includes("*/"), "doc comment is not closed before the declaration");

  // R4 要求的三件事 + 类型不一致记录。
  assert.match(comment, /无.*消费方|没有任何提示词消费方/, "must state there is no prompt consumer");
  assert.match(comment, /prompt-language-policy\.md/, "must cite the decision spec");
  assert.match(comment, /R1/, "must cite R1 (model-facing text stays English)");
  assert.match(comment, /RuntimeConfig\.ui\.locale|ui\.locale/, "must name the real locale owner");
  assert.match(comment, /不是\s*locale|不是它的别名/, "must state it is not a locale");
  assert.match(comment, /UiLocale|SupportedLocale/, "must record the type mismatch");
  assert.match(comment, CJK, "comment must be Chinese (repo convention / R7)");
});

// ── 场景 3：双面文本按模型面处理 ────────────────────────────────────────

test("(场景3) 全部 cancellation.userVisibleMessage 恒英文（无 CJK）", async () => {
  let seen = 0;
  for (const dir of ["packages/contracts/src/", "packages/core/src/"]) {
    for (const file of await collectSources(dir)) {
      const source = await readFile(file, "utf8");
      // 实例形态：`userVisibleMessage: "..."` / `userVisibleMessage:\n  "..."`。
      for (const match of source.matchAll(/userVisibleMessage:\s*\n?\s*(.+)/g)) {
        const literal = match[1];
        if (!/^["'`]/.test(literal.trim())) continue; // 声明或多行表达式的续行，跳过
        seen += 1;
        assert.ok(
          !CJK.test(literal),
          `${relName(file)} has a non-English userVisibleMessage`,
        );
      }
    }
  }
  // 数量下限 = 扫描本身没退化的哨兵（当前实际 42 处实例）。
  assert.ok(seen >= 35, `expected the known userVisibleMessage instances, saw ${seen}`);
});

test("(场景3) 取消工具 → tool result 的 error.message 是英文，type 是结构化码", () => {
  // 与 tool/executor/timeout.ts 的取消路径同形：CoreErrorType.ToolCancelled + userVisibleMessage。
  const message = "Bash was cancelled and the child process was asked to stop";
  const error = createCoreError(CoreErrorType.ToolCancelled, message, {
    context: { cancellation: "bestEffort", toolName: "Bash" },
    recoverable: true,
  });
  const result = createErrorResult({ id: "call_p4", name: "Bash", input: {} }, error);

  assert.equal(result.success, false);
  assert.equal(result.error.type, CoreErrorType.ToolCancelled);
  assert.equal(result.error.type, "tool_cancelled");
  assert.ok(result.error.message.includes("was cancelled"), result.error.message);
  assert.ok(!CJK.test(result.error.message), "model-facing message must stay English");
});

test("(场景3) UI 侧按 error.type 查 catalog；表外回落原始英文；en-US 逐字不变", () => {
  const cancelled = {
    type: CoreErrorType.ToolCancelled,
    message: "Bash was cancelled and the child process was asked to stop",
  };
  const zh = getACodeCopy("zh-CN").tui.errors;
  const en = getACodeCopy("en-US").tui.errors;

  // zh-CN：本地化类型标签 + 原样保留英文原文（R3：不翻译 message 本身）。
  const zhText = formatEventError({ error: cancelled }, zh);
  assert.equal(zhText, `工具取消：${cancelled.message}`);
  assert.ok(zhText.includes(cancelled.message), "the English detail must survive");

  // en-US：纯透传，既有显示逐字不变。
  assert.equal(formatEventError({ error: cancelled }, en), cancelled.message);

  // 回落是必须的：错误种类是开放集合，catalog 是封闭集合。
  const unknownType = { type: "storage_error", message: "Checkpoint store is unreadable" };
  assert.equal(formatEventError({ error: unknownType }, zh), unknownType.message);
  assert.equal(formatEventError({ error: unknownType }, en), unknownType.message);
  // 没有结构化 type 也回落（payload 直接给 message / reason 的既有形态）。
  assert.equal(formatEventError({ message: "Turn aborted" }, zh), "Turn aborted");
  assert.equal(formatEventError({ reason: "provider closed the stream" }, zh), "provider closed the stream");

  // 兜底行是纯 UI 文本（没有对应的模型面原文），走 catalog 而不是硬编码英文。
  assert.equal(formatEventError({}, zh), "未知错误");
  assert.equal(formatEventError({}, en), "Unknown error");
});

test("(场景3/R3) contracts 的 userVisibleMessage 记录了「模型面 + UI 走 type/code 映射」的裁决", async () => {
  const source = await readFile(
    new URL("packages/contracts/src/tools/contract.ts", CLI_ROOT),
    "utf8",
  );
  const at = source.indexOf("userVisibleMessage: string;");
  assert.ok(at > 0, "ToolCancellationPolicy.userVisibleMessage not found");
  const comment = source.slice(Math.max(0, at - 1600), at);
  assert.match(comment, /模型面/, "must state the text is model-facing");
  assert.match(comment, /恒英文/, "must state it stays English");
  assert.match(comment, /prompt-language-policy\.md/, "must cite the decision spec");
  assert.match(comment, /error\.type/, "must name the structured mapping key");
  assert.match(comment, /回落/, "must require the raw-English fallback");
});

// ── 场景 4：双 locale 同批 ──────────────────────────────────────────────

/** 递归收集「键路径 → typeof」；函数按叶子处理（不再展开其属性）。 */
function shapeOf(value, prefix = "") {
  if (value === null || typeof value !== "object") {
    return new Map([[prefix || "<root>", typeof value]]);
  }
  const out = new Map();
  for (const [key, child] of Object.entries(value)) {
    for (const [path, kind] of shapeOf(child, prefix === "" ? key : `${prefix}.${key}`)) {
      out.set(path, kind);
    }
  }
  return out;
}

test("(场景4) en-US 与 zh-CN 的 catalog 键路径集合与形状完全相同", () => {
  const en = shapeOf(getACodeCopy("en-US"));
  const zh = shapeOf(getACodeCopy("zh-CN"));

  const enPaths = [...en.keys()].sort();
  const zhPaths = [...zh.keys()].sort();
  assert.deepEqual(zhPaths, enPaths);
  for (const path of enPaths) {
    assert.equal(zh.get(path), en.get(path), `shape mismatch at ${path}`);
  }

  // 本项新增的键（同批补齐的最小集合）。
  assert.equal(en.get("tui.errors.toolCancelled"), "function");
  assert.equal(zh.get("tui.errors.toolCancelled"), "function");
  assert.equal(en.get("tui.errors.unknown"), "string");
  assert.equal(zh.get("tui.errors.unknown"), "string");
  assert.ok(CJK.test(getACodeCopy("zh-CN").tui.errors.unknown));
  assert.ok(!CJK.test(getACodeCopy("en-US").tui.errors.unknown));
});

test("(场景4) getACodeCopy 按 locale 选目录，结构形状一致", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const copy = getACodeCopy(locale);
    assert.equal(copy.locale, locale);
    assert.equal(typeof copy.cli.help, "function");
    assert.equal(typeof copy.cli.errors.localeUnsupported, "function");
    assert.equal(typeof copy.tui.status.toolFailed, "function");
    assert.equal(typeof copy.tui.errors.toolCancelled, "function");
  }
  // "auto" + 检测结果仍落在受支持目录内（resolveLocale 既有语义，不因本项改变）。
  assert.equal(getACodeCopy("auto", "zh-CN").locale, "zh-CN");
});

// ── 场景 6：无新增 ACODE_ 语言开关 ──────────────────────────────────────

test("(场景6/R6-5) CLI 源码里没有语言相关的 ACODE_ 环境变量", async () => {
  const names = new Set();
  for (const dir of ["packages/"]) {
    for (const file of await collectSources(dir)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\bACODE_[A-Z0-9_]+/g)) names.add(match[0]);
    }
  }
  assert.ok(names.size > 0, "expected the existing ACODE_* flags to be found");
  const linguistic = [...names].filter((name) => /LANG|LOCALE|I18N|TRANSLAT/i.test(name));
  assert.deepEqual(linguistic, [], `language-related env vars are forbidden by R6-5: ${linguistic}`);
});
