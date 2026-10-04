import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * K9（工具微增补）验收测试：invalid 反馈护栏 + open 工具。
 *
 * 规格 apps/acode-cli/specs/tooling-micro-additions.md 验收场景 1–9：
 * - invalid：unknown 就近建议 / 无近似列全集 / schema 逐字段截断 / 零副作用 /
 *   主动调 invalid 的处理 / 错误分类零变化（判定逻辑只有载体变化）；
 * - open：URL 白名单 / file:// 拒绝 / 权限档断言 / 平台缺失不注册 / reveal 降级 /
 *   日志不含 URL/路径本体。
 */

const { formatInvalidSchemaViolationReceipt, formatInvalidUnknownToolReceipt, invalidToolEntry, suggestToolNames } =
  await import("../packages/core/src/tool/handlers/invalid.ts");
const { createOpenToolEntry } = await import("../packages/core/src/tool/handlers/open.ts");
const { createToolRegistry } = await import("../packages/core/src/tool/registry.ts");
const { executeToolCall } = await import("../packages/core/src/tool/executor/call-runner.ts");
const { BackgroundTaskTracker } = await import(
  "../packages/core/src/tool/executor/background-tasks.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { CoreErrorType } = await import("../packages/contracts/src/errors/index.ts");
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");

const WORKSPACE = mkdtempSync(join(tmpdir(), "acode-k9-open-"));
const OUTSIDE_DIR = join(tmpdir(), "acode-k9-outside-ref");
mkdirSync(OUTSIDE_DIR, { recursive: true });
after(() => {
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(OUTSIDE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// -----------------------------------------------
// fixtures
// -----------------------------------------------

function makeEntry(name, { schema, handler } = {}) {
  return {
    capability: `probe capability for ${name}`,
    metadata: {
      name,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler:
      handler ??
      (async () => {
        return { ok: true };
      }),
    inputSchema: schema ?? { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {},
    permission: {
      permission: `probe.${name.toLowerCase()}`,
      reason: "test probe tool",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 4000,
      maxModelBytes: 4000,
      strategy: "truncate",
    },
    timeout: { defaultMs: 5000, maxMs: 5000, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "cancelled" },
    trace: { required: true, propagateToAdapters: false, recordInput: "none", recordOutput: "summary" },
  };
}

function makeExecutorDeps(registry) {
  const deps = {
    registry,
    permissionService: new PermissionService(),
    emitEvent: async () => undefined,
    sessionId: "session-k9-test",
    turnId: "turn-k9-test",
    defaultTimeoutMs: 5000,
    getMode: () => "build",
    getWorkingDirectory: () => WORKSPACE,
    getWorkspaceRoot: () => WORKSPACE,
    runtimeScope: "main",
  };
  return { deps, tracker: new BackgroundTaskTracker(deps) };
}

async function runToolCall(registry, toolCall) {
  const { deps, tracker } = makeExecutorDeps(registry);
  return executeToolCall(deps, tracker, toolCall);
}

function makeOpenContext(overrides = {}) {
  return {
    toolCallId: "tc-open-k9",
    traceId: "trace-open-k9",
    abortSignal: new AbortController().signal,
    fileSystemPort: createNodeFileSystemAdapter(),
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

function makePlatform({ withOpenExternalFile = true, opened = true } = {}) {
  const calls = { openExternal: [], openExternalFile: [] };
  const platform = {
    openExternal(url) {
      calls.openExternal.push(url);
    },
    ...(withOpenExternalFile
      ? {
          openExternalFile: async (path) => {
            calls.openExternalFile.push(path);
            return opened ? { success: true } : { success: false, error: "no association" };
          },
        }
      : {}),
  };
  return { platform, calls };
}

function makeLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      debug() {},
      info(message, context) {
        entries.push({ message, context });
      },
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
  };
}

// ── 场景 1：unknown name 就近建议 / 无近似列注册表全集 ─────────────────

test("invalid: unknown tool name suggests the closest registered name (edit distance 1)", async () => {
  const registry = createToolRegistry();
  registry.register(makeEntry("Write"));
  registry.register(makeEntry("Read"));
  registry.register(makeEntry("Grep"));

  const result = await runToolCall(registry, { id: "call-k9-1", name: "Writee", input: {} });

  assert.equal(result.success, false, "unknown-name 调用仍是失败回执（判定语义照旧）");
  assert.equal(result.error.type, CoreErrorType.ToolNotFound, "错误分类不变：tool_not_found");
  assert.match(result.modelContent, /No such tool available: `Writee`/, "回执保留原始工具名");
  assert.match(result.modelContent, /Did you mean: `Write`\?/, "就近建议给出编辑距离 1 的 Write");
  assert.doesNotMatch(result.modelContent, /Did you mean[^`]*`Read`/, "不把距离过远的名字混进建议");
});

test("invalid: unknown tool name without near match lists the full registry snapshot", async () => {
  const registry = createToolRegistry();
  registry.register(makeEntry("Write"));
  registry.register(makeEntry("Read"));
  registry.register(makeEntry("Grep"));

  const result = await runToolCall(registry, { id: "call-k9-2", name: "zzz", input: {} });

  assert.equal(result.success, false);
  assert.match(result.modelContent, /No similar tool name found/);
  for (const name of ["Write", "Read", "Grep"]) {
    assert.ok(
      result.modelContent.includes(`\`${name}\``),
      `全集包含注册表工具名 ${name}`,
    );
  }
  // 全集来自注册表快照：新注册的工具自动进入回执，不是硬编码清单。
  registry.register(makeEntry("BrandNewTool"));
  const refreshed = formatInvalidUnknownToolReceipt("zzz", registry);
  assert.match(refreshed, /`BrandNewTool`/, "后注册的工具名进入全集（快照而非硬编码）");
});

test("invalid: suggestToolNames honors distance bound and cap", () => {
  assert.deepEqual(suggestToolNames("Writee", ["Write", "Read", "Grep"]), ["Write"]);
  assert.deepEqual(suggestToolNames("read", ["Read"]), ["Read"], "大小写差异编辑距离 ≤2 仍可建议");
  assert.deepEqual(suggestToolNames("zzz", ["Write", "Read"]), []);
  assert.deepEqual(
    suggestToolNames("Rea", ["Read", "Reap", "Reat", "Real", "Road"]),
    ["Read", "Real", "Reap"],
    "按（距离, 字典序）排序后最多 3 个建议",
  );
});

// ── 场景 2：schema 违例逐字段（路径 + 期望 + 截断实际值） ────────────────

test("invalid: schema violation receipt lists per-field path/expected/truncated actual", async () => {
  const longValue = "x".repeat(201);
  const registry = createToolRegistry();
  registry.register(
    makeEntry("Write", {
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          // content 期望 number：发送超长字符串会同时触发类型违例与 200 字符截断展示
          content: { type: "number" },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
    }),
  );

  const result = await runToolCall(registry, {
    id: "call-k9-3",
    name: "Write",
    input: { file_path: 5, content: longValue, extra: true },
  });

  assert.equal(result.success, false, "schema 违例仍是失败回执（判定语义照旧）");
  assert.equal(
    result.error.type,
    CoreErrorType.ToolExecutionFailed,
    "错误分类不变：tool_execution_failed",
  );
  const receipt = result.modelContent;
  // 逐字段：file_path 类型错（number 而非 string）
  assert.match(receipt, /`file_path`: expected `string`, actual type `number`/);
  // 超长实际值截断到 200 字符 + 省略标记（防投毒面）
  assert.match(receipt, /`content`: expected `number`, actual type `string`; actual value: /);
  assert.ok(receipt.includes("x".repeat(200)), "截断后保留前 200 字符");
  assert.ok(!receipt.includes("x".repeat(201)), "第 201 字符不出现");
  assert.match(receipt, /…\(truncated\)/, "截断带省略标记");
  // 未声明字段逐 key 拆行
  assert.match(receipt, /`extra`: expected `absent/);
});

test("invalid: direct formatter truncates 201-char value to 200 with marker", () => {
  const receipt = formatInvalidSchemaViolationReceipt(
    "Probe",
    { value: "y".repeat(201) },
    { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  );
  assert.ok(receipt.includes("y".repeat(200)));
  assert.ok(!receipt.includes("y".repeat(201)));
  assert.match(receipt, /…\(truncated\)/);
  assert.match(receipt, /`value`: expected `number`, actual type `string`/);
});

// ── 场景 3：畸形调用零工具执行 ─────────────────────────────────────────

test("invalid: malformed call executes zero tools (execution counter stays 0)", async () => {
  let executions = 0;
  const registry = createToolRegistry();
  registry.register(
    makeEntry("Write", {
      handler: async () => {
        executions += 1;
        return { ok: true };
      },
    }),
  );

  const unknown = await runToolCall(registry, { id: "call-k9-4a", name: "Writee", input: {} });
  assert.equal(unknown.success, false);
  assert.equal(executions, 0, "unknown-name 分支不执行任何 handler");

  const violating = await runToolCall(registry, {
    id: "call-k9-4b",
    name: "Write",
    input: { not_a_known_field: true },
  });
  assert.equal(violating.success, false);
  assert.equal(executions, 0, "schema 违例分支不执行任何 handler");
});

// ── 场景 4：模型主动调 invalid → 按 unknown-name 口径处理 ────────────────

test("invalid: proactive call to `invalid` is answered as a non-callable surface", async () => {
  const registry = createToolRegistry();
  registry.register(makeEntry("Write"));
  // invalid 不在模型可主动调用的注册表里（providerVisible=false 的引擎载体），
  // 因此模型主动调它落在引擎 unknown-name 分支——与真实运行时形态一致。
  const result = await runToolCall(registry, { id: "call-k9-5", name: "invalid", input: {} });

  assert.equal(result.success, false);
  assert.equal(result.error.type, CoreErrorType.ToolNotFound);
  assert.match(
    result.modelContent,
    /not a tool you can call/,
    "回执说明 invalid 非主动调用面",
  );
  assert.match(result.modelContent, /`Write`/, "仍列出可用工具面帮助模型回到正轨");

  // 若整合方把 entry 注册进注册表（providerVisible=false），handler 侧同样按
  // unknown-name 口径回执——两条路径呈现一致。
  const proactiveOutput = await invalidToolEntry.handler(
    {},
    {
      toolCallId: "tc-invalid-k9",
      traceId: "trace-invalid-k9",
      abortSignal: new AbortController().signal,
      workingDirectory: WORKSPACE,
      workspaceRoot: WORKSPACE,
      providerVisibleToolNames: ["Write", "Read"],
    },
  );
  assert.match(proactiveOutput, /not a tool you can call/);
  assert.match(proactiveOutput, /`Write`/);
  assert.equal(invalidToolEntry.metadata.providerVisible, false, "entry 不进模型可见注册面");
});

// ── 场景 5：错误分类零变化（判定逻辑只有载体变化） ──────────────────────

test("invalid: classification stays intact — carrier change only", async () => {
  const registry = createToolRegistry();
  registry.register(
    makeEntry("Write", {
      schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    }),
  );

  const unknown = await runToolCall(registry, { id: "call-k9-6a", name: "Nope", input: {} });
  assert.equal(unknown.error.type, CoreErrorType.ToolNotFound, "unknown 分类照旧");
  assert.equal(unknown.error.message, "Tool not found: Nope", "错误 message（UI/日志面）照旧");

  const violating = await runToolCall(registry, {
    id: "call-k9-6b",
    name: "Write",
    input: {},
  });
  assert.equal(
    violating.error.type,
    CoreErrorType.ToolExecutionFailed,
    "schema 违例分类照旧（不是新的错误类型）",
  );
  assert.equal(
    violating.error.message,
    "Tool input failed inputSchema validation",
    "错误 message（UI/日志面）照旧",
  );
  // 载体是 modelContent（provider 可见面），error 结构本身未被改写
  assert.match(violating.modelContent, /`Write` failed input schema validation/);
});

// ── 场景 6：URL 白名单与平台面调用 ─────────────────────────────────────

test("open: https URL opens through the platform port openExternal", async () => {
  const { platform, calls } = makePlatform();
  const entry = createOpenToolEntry({ platform });
  assert.ok(entry, "有平台面时 entry 构造成功");

  const result = await entry.handler({ target: "https://example.com/docs" }, makeOpenContext());

  assert.deepEqual(result, { opened: true, kind: "url" });
  assert.deepEqual(calls.openExternal, ["https://example.com/docs"], "URL 经 port openExternal 开箱");
  assert.deepEqual(calls.openExternalFile, [], "URL 不走文件开箱通道");
});

test("open: non-http(s) protocols are rejected by the whitelist", async () => {
  const { platform, calls } = makePlatform();
  const entry = createOpenToolEntry({ platform });

  for (const target of ["file:///etc/passwd", "ftp://files.example.com/x", "javascript:alert(1)"]) {
    await assert.rejects(
      entry.handler({ target }, makeOpenContext()),
      (error) => {
        assert.match(error.message, /only http and https URLs are allowed/);
        return true;
      },
      `${target} 必须被协议白名单拒绝`,
    );
  }
  assert.deepEqual(calls.openExternal, [], "被拒目标不触达平台面");
  assert.deepEqual(calls.openExternalFile, []);
});

// ── 场景 7：权限档断言 ─────────────────────────────────────────────────

test("open: workspace-internal directory is low tier; URL and outside paths confirm", async () => {
  const { platform } = makePlatform();
  const entry = createOpenToolEntry({ platform });
  const logsDir = join(WORKSPACE, "logs");
  mkdirSync(logsDir, { recursive: true });

  const capabilityContext = { workingDirectory: WORKSPACE, workspaceRoot: WORKSPACE };

  const inWorkspaceDirectory = entry.resolvePermissionCapability(
    { target: logsDir },
    capabilityContext,
  );
  assert.equal(inWorkspaceDirectory.needsApproval, false, "workspace 内目录低档放行");
  assert.equal(inWorkspaceDirectory.riskLevel, "low");

  // URL：capability 收窄钩子不介入（返回 undefined），维持 entry 默认 confirm 档
  assert.equal(
    entry.resolvePermissionCapability({ target: "https://example.com" }, capabilityContext),
    undefined,
    "URL 不享受低档收窄",
  );
  assert.equal(entry.metadata.needsApproval, true, "entry 默认 confirm（needsApproval）");

  // workspace 外路径：同样维持 confirm 档
  assert.equal(
    entry.resolvePermissionCapability({ target: OUTSIDE_DIR }, capabilityContext),
    undefined,
    "workspace 外路径维持 confirm 档",
  );

  // workspace 内普通文件（非目录）：文件开箱默认走 confirm
  assert.equal(
    entry.resolvePermissionCapability(
      { target: join(WORKSPACE, "notes.txt") },
      capabilityContext,
    ),
    undefined,
    "workspace 内文件维持 confirm 档（只有目录低档）",
  );
});

// ── 场景 8：平台面缺失不注册 / reveal 降级 ─────────────────────────────

test("open: missing platform surface means the tool is not registered (CLI form)", () => {
  assert.equal(createOpenToolEntry({}), undefined, "无 platform → 不产出 entry（不注册）");
  assert.equal(
    createOpenToolEntry({ platform: undefined }),
    undefined,
    "platform 显式缺席同样不注册",
  );
});

test("open: reveal without openExternalFile degrades to opened:false + detail (no fail)", async () => {
  const { platform } = makePlatform({ withOpenExternalFile: false });
  const entry = createOpenToolEntry({ platform });
  const logsDir = join(WORKSPACE, "logs");
  mkdirSync(logsDir, { recursive: true });

  const result = await entry.handler({ target: logsDir, action: "reveal" }, makeOpenContext());

  assert.equal(result.opened, false, "能力缺席 → opened:false");
  assert.equal(result.kind, "directory");
  assert.ok(typeof result.detail === "string" && result.detail.length > 0, "降级附 detail 说明");
});

test("open: file/directory open goes through openExternalFile with resolved workspace path", async () => {
  const { platform, calls } = makePlatform();
  const entry = createOpenToolEntry({ platform });
  const logsDir = join(WORKSPACE, "logs");
  mkdirSync(logsDir, { recursive: true });

  const absolute = await entry.handler({ target: logsDir }, makeOpenContext());
  assert.deepEqual(absolute, { opened: true, kind: "directory" });
  assert.deepEqual(calls.openExternalFile, [logsDir], "绝对路径直达平台面");

  const relative = await entry.handler({ target: "logs" }, makeOpenContext());
  assert.equal(relative.opened, true);
  assert.deepEqual(
    calls.openExternalFile,
    [logsDir, logsDir],
    "相对路径经 workspace 路径治理解析成同一绝对路径",
  );
});

test("open: platform open failure is surfaced as opened:false + detail", async () => {
  const { platform } = makePlatform({ opened: false });
  const entry = createOpenToolEntry({ platform });
  const result = await entry.handler({ target: join(WORKSPACE, "logs") }, makeOpenContext());
  assert.equal(result.opened, false);
  assert.equal(result.detail, "no association");
});

// ── 场景 9：日志纪律（不记 URL/路径本体） ──────────────────────────────

test("open: info log records kind/opened only — never the URL or path body", async () => {
  const { platform } = makePlatform();
  const { entries, logger } = makeLogger();
  const entry = createOpenToolEntry({ platform, logger });

  const secretUrl = "https://secret.example.com/tenant-42/invoice";
  await entry.handler({ target: secretUrl }, makeOpenContext());

  mkdirSync(join(WORKSPACE, "logs"), { recursive: true });
  await entry.handler({ target: join(WORKSPACE, "logs") }, makeOpenContext());

  const openLogs = entries.filter((entry_) => entry_.context?.event === "tool.open");
  assert.equal(openLogs.length, 2, "每次调用记一条 info 级 tool.open");
  assert.deepEqual(
    openLogs.map((entry_) => entry_.context.kind).sort(),
    ["directory", "url"],
    "记录 kind",
  );
  assert.deepEqual(
    openLogs.map((entry_) => entry_.context.opened),
    [true, true],
    "记录 opened",
  );
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("secret.example.com"), "日志不含 URL 本体");
  assert.ok(!serialized.includes(join(WORKSPACE, "logs").replace(/\\/g, "\\\\")), "日志不含路径本体");
  assert.ok(!serialized.includes("logs"), "日志不含路径片段");
});

// ── 对抗复核 H1 回归：URL 元字符不得到达宿主 opener（cmd 时代曾可执行任意命令） ──

test("open: URL with embedded quotes/&/^ reaches the platform percent-encoded (H1)", async () => {
  const { platform, calls } = makePlatform();
  const entry = createOpenToolEntry({ platform });
  assert.ok(entry, "platform 在场必须注册");

  // H1 原始 payload：内嵌双引号曾在 `cmd /c start "" target` 下击穿转义执行附加命令。
  const payload = 'https://example.com/" & calc.exe & "^%PATH%';
  await entry.handler({ target: payload }, makeOpenContext());

  assert.equal(calls.openExternal.length, 1, "URL 走 openExternal 一次");
  const delivered = calls.openExternal[0];
  assert.ok(!delivered.includes('"'), `执行面不得含原始双引号（实际收到 ${delivered}）`);
  assert.ok(!delivered.includes(" "), `执行面不得含未编码空格（实际收到 ${delivered}）`);
  // %VAR% 展开只在 cmd 时代是威胁（explorer.exe 非 shell、argv 直传不展开环境变量，
  // 且 `%PA` 是合法 percent-escape 会被 URL 序列化原样保留）——不做字面断言。
  assert.ok(delivered.startsWith("https://"), "规范形仍为 https");
});

test("open: host opener implementation never routes through cmd.exe (H1 source assertion)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const implPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../packages/bootstrap/src/app/platform-open-port.ts",
  );
  const source = readFileSync(implPath, "utf8");
  // 防线形态断言：execFile 目标恒为非 shell opener；cmd 形态一经出现即测试失败。
  assert.ok(!/"cmd"|'cmd'/.test(source), "不得出现 cmd 作为 execFile 目标");
  assert.ok(source.includes("explorer.exe"), "Windows 形态用 explorer.exe 直传");
});
