import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * K5「外部会话导入来源扩展」验收测试。
 * 覆盖 spec packages/services/specs/external-session-import-sources.md 的验收场景 1-7：
 * claude 零回归（快照逐字节一致）、四来源 happy path、对抗套件（R2 硬门槛）、
 * 幂等、编排失败隔离、Cursor cwd 解码/subagent、importSessions 缺省 source 兼容钉住。
 */

const { setDataBaseDir, getLegacyTaskSessionSnapshotPath } = await import("../src/paths.js");
const { TaskIndexRepo } = await import("../src/session/taskIndexRepo.js");
const { parseGuardedJsonText, IMPORT_FIELD_MAX_CHARS, IMPORT_JSON_MAX_DEPTH, IMPORT_LINE_MAX_BYTES, readGuardedJsonLinesFile } =
  await import("../src/session/external-import/importGuards.js");
const { isValidImportPathSegment } = await import("../src/session/external-import/pathSegmentGuard.js");
const { buildImportedExternalTaskFile, buildImportedExternalTaskId, IMPORTED_TASK_ID_PREFIXES } =
  await import("../src/session/external-import/importTaskFile.js");
const { discoverExternalSessions, importExternalSessions } = await import(
  "../src/session/external-import/importService.js"
);
const { claudeCodeExternalSessionAdapter } = await import(
  "../src/session/external-import/adapters/claudeCode.js"
);
const { codexExternalSessionAdapter, CODEX_SESSIONS_DIR_ENV } = await import(
  "../src/session/external-import/adapters/codex.js"
);
const { geminiCliExternalSessionAdapter, GEMINI_CLI_TMP_DIR_ENV } = await import(
  "../src/session/external-import/adapters/geminiCli.js"
);
const { opencodeExternalSessionAdapter, OPENCODE_STORAGE_DIR_ENV } = await import(
  "../src/session/external-import/adapters/opencode.js"
);
const {
  cursorExternalSessionAdapter,
  CURSOR_PROJECTS_DIR_ENV,
  decodeCursorProjectDirName,
} = await import("../src/session/external-import/adapters/cursor.js");
const {
  EXTERNAL_IMPORT_REPO_RANKING_ENABLED,
  rankExternalSessionSummaries,
  computeExternalRepoRankHint,
} = await import("../src/session/external-import/repoRanking.js");
const { importedHistoryRepairPolicies } = await import(
  "../src/session/external-import/importedHistoryRepairPolicy.js"
);
const { buildImportedClaudeTaskFile, buildImportedClaudeTaskId } = await import(
  "../src/session/claude-native/buildImportedClaudeTaskFile.js"
);
const { createACodeTaskServiceAdapter } = await import(
  "../src/acode-agent/acodeTaskServiceAdapter.js"
);

const T0 = "2026-01-02T03:04:05.000Z";
const T0_MS = Date.parse(T0);
const T1 = "2026-01-02T03:04:40.000Z";
const T1_MS = Date.parse(T1);

function makeFixtureRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJsonl(filePath, entries) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
}

function writeRawLines(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---- codex fixture 构造（形态取自本机 ~/.codex 真实 rollout 文件，见 spec 附录） ----

function codexMeta(sessionId, cwd) {
  return { timestamp: T0, type: "session_meta", payload: { session_id: sessionId, cwd } };
}
function codexUser(text, ts = T0) {
  return { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: text } };
}
function codexAgent(text, ts = T1) {
  return { timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: text, phase: "final" } };
}
function codexToolCall(name, ts = T0) {
  return { timestamp: ts, type: "response_item", payload: { type: "function_call", name, arguments: "{}", call_id: "call_1" } };
}

// ---- 测试组 1：R2 行级防护基础件 ----

test("guards: 深嵌套超 64 层被拒、字段超 1MiB 被截断", () => {
  const stats = { skippedLinesOverSize: 0, skippedLinesMalformed: 0, skippedLinesTooDeep: 0, skippedLinesNonObject: 0, truncatedFields: 0 };
  const ok60 = parseGuardedJsonText(`${"[".repeat(60)}1${"]".repeat(60)}`, stats);
  assert.equal(ok60.ok, true);
  const tooDeep = parseGuardedJsonText(`${"[".repeat(IMPORT_JSON_MAX_DEPTH + 6)}1${"]".repeat(IMPORT_JSON_MAX_DEPTH + 6)}`, stats);
  assert.equal(tooDeep.ok, false);
  assert.equal(tooDeep.reason, "too_deep");
  const truncated = parseGuardedJsonText(`{"text":"${"a".repeat(IMPORT_FIELD_MAX_CHARS + 10)}"}`, stats);
  assert.equal(truncated.ok, true);
  assert.equal(truncated.value.text.length, IMPORT_FIELD_MAX_CHARS);
  assert.equal(stats.truncatedFields, 1);
  assert.equal(parseGuardedJsonText("{broken", stats).ok, false);
});

test("guards: 单行超过 4 MiB 被跳过计数，不崩", async () => {
  const root = makeFixtureRoot("acode-k5-guard-line-");
  try {
    const filePath = join(root, "big.jsonl");
    const bigLine = JSON.stringify({ type: "x", payload: { message: "a".repeat(IMPORT_LINE_MAX_BYTES + 512) } });
    writeRawLines(filePath, ['{"type":"ok1"}', bigLine, '{"type":"ok2"}']);
    const { records, stats } = await readGuardedJsonLinesFile(filePath);
    assert.equal(records.length, 2);
    assert.equal(stats.skippedLinesOverSize, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pathSegmentGuard: 路径穿越型 id 被拒", () => {
  assert.equal(isValidImportPathSegment("../../x"), false);
  assert.equal(isValidImportPathSegment(".."), false);
  assert.equal(isValidImportPathSegment("a/b"), false);
  assert.equal(isValidImportPathSegment("a\\b"), false);
  assert.equal(isValidImportPathSegment("sess-123_abc"), true);
});

// ---- 测试组 2：四来源 happy path ----

test("codex happy path: 事件流 → ExternalSessionRecord（含工具摘要与 cwd）", async () => {
  const root = makeFixtureRoot("acode-k5-codex-happy-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      // 真实 rollout 文件名形如 rollout-2026-08-07T12-09-47-<uuid>.jsonl（时间分隔符已折叠，Windows 安全）。
      writeJsonl(join(root, "sessions", "2026", "01", "02", `rollout-2026-01-02T03-04-05-019faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl`), [
        codexMeta("codex-ses-001", ws),
        codexUser("帮我看下分支状态"),
        codexToolCall("shell"),
        codexAgent("当前在 main 分支，工作区干净。"),
        { timestamp: T1, type: "token_count", payload: { total: 10 } },
      ]);
      const summaries = await codexExternalSessionAdapter.discoverSessions({});
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].sourceSessionId, "codex-ses-001");
      assert.equal(summaries[0].cwd, ws);

      const record = await codexExternalSessionAdapter.parseSession({ sourceSessionId: "codex-ses-001" });
      assert.equal(record.source, "openai-codex");
      assert.equal(record.importedTaskIdPrefix, IMPORTED_TASK_ID_PREFIXES["openai-codex"]);
      assert.deepEqual(
        record.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.equal(record.messages[0].content, "帮我看下分支状态");
      assert.equal(record.messages[0].ts, T0_MS);
      assert.equal(record.messages[1].toolCallSummaries?.[0]?.toolName, "shell");
      assert.equal(record.cwd, ws);
      assert.equal(record.parseStats.knownNonMessageEventCount >= 1, true);

      const taskId = buildImportedExternalTaskId(record);
      assert.equal(taskId.startsWith("imported-codex-"), true);
      const taskFile = buildImportedExternalTaskFile(record, taskId);
      assert.equal(taskFile.meta.workspacePath, ws);
      assert.deepEqual(
        taskFile.messages.map((message) => message.role),
        ["user", "assistant"],
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gemini-cli happy path: chats json → 消息对 + functionCall 摘要", async () => {
  const root = makeFixtureRoot("acode-k5-gemini-happy-");
  try {
    await withEnv({ [GEMINI_CLI_TMP_DIR_ENV]: join(root, "tmp") }, async () => {
      writeJson(join(root, "tmp", "hash1", "chats", "chat-001.json"), {
        messages: [
          { role: "user", timestamp: T0, message: { parts: [{ text: "帮我总结这个仓库" }] } },
          {
            role: { model: "gemini-2.5-pro" },
            timestamp: T1,
            message: { parts: [{ text: "这是一个 CLI 工具仓库。" }, { functionCall: { name: "read_file" } }] },
          },
        ],
      });
      const summaries = await geminiCliExternalSessionAdapter.discoverSessions({});
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].sourceSessionId, "chat-001");

      const record = await geminiCliExternalSessionAdapter.parseSession({ sourceSessionId: "chat-001" });
      assert.equal(record.source, "gemini-cli");
      assert.deepEqual(
        record.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.equal(record.messages[1].toolCallSummaries?.[0]?.toolName, "read_file");
      assert.equal(record.model, "gemini-2.5-pro");
      assert.equal(buildImportedExternalTaskId(record).startsWith("imported-gemini-"), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode happy path: session/message/part 三级文件 → 消息与工具摘要", async () => {
  const root = makeFixtureRoot("acode-k5-opencode-happy-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [OPENCODE_STORAGE_DIR_ENV]: join(root, "storage") }, async () => {
      const owner = join(root, "storage", "local");
      writeJson(join(owner, "session", "ses-001.json"), {
        id: "ses-001",
        cwd: ws,
        title: "opencode demo",
        time: { start: T0_MS, end: T1_MS },
      });
      writeJson(join(owner, "message", "ses-001", "msg-001.json"), {
        id: "msg-001",
        sessionID: "ses-001",
        role: "user",
        time: { start: T0_MS },
        parts: ["part-001"],
      });
      writeJson(join(owner, "part", "msg-001", "part-001.json"), {
        id: "part-001",
        type: "text",
        text: "列出这个项目的模块",
      });
      writeJson(join(owner, "message", "ses-001", "msg-002.json"), {
        id: "msg-002",
        role: "assistant",
        time: { start: T1_MS },
        parts: [{ type: "text", text: "共 3 个模块。" }, { type: "tool", tool: "read" }],
      });
      const summaries = await opencodeExternalSessionAdapter.discoverSessions({});
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].sourceSessionId, "ses-001");
      assert.equal(summaries[0].cwd, ws);

      const record = await opencodeExternalSessionAdapter.parseSession({ sourceSessionId: "ses-001" });
      assert.deepEqual(
        record.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.equal(record.messages[0].content, "列出这个项目的模块");
      assert.equal(record.messages[1].toolCallSummaries?.[0]?.toolName, "read");
      assert.equal(record.title, "opencode demo");
      assert.equal(buildImportedExternalTaskId(record).startsWith("imported-opencode-"), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor happy path: cwd 解码成功 + subagent 拍平 + 工具摘要", async () => {
  const root = makeFixtureRoot("acode-k5-cursor-happy-");
  try {
    await withEnv({ [CURSOR_PROJECTS_DIR_ENV]: join(root, "projects") }, async () => {
      // URL 编码的绝对路径目录名（Cursor 新版编码）。
      const encoded = Buffer.from("c:\\Users\\demo\\proj", "utf-8").toString("hex").replace(/(..)/g, "%$1");
      const transcriptDir = join(root, "projects", encoded, "agent-transcripts");
      writeJsonl(join(transcriptDir, "tr-001.jsonl"), [
        { type: "user", content: "修一下登录跳转", timestamp: T0 },
        { type: "assistant", content: "我先复现问题。", timestamp: T1, toolName: "grep_search" },
        { type: "assistant", agentId: "agent-7", content: "定位到路由守卫漏洞", timestamp: T1 },
        { type: "summary", content: "会话摘要" },
        { type: "quantum_fluctuation", content: "?" },
      ]);
      const summaries = await cursorExternalSessionAdapter.discoverSessions({});
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].cwd?.toLowerCase(), "c:\\users\\demo\\proj");
      assert.equal(summaries[0].projectHint, summaries[0].cwd);

      const record = await cursorExternalSessionAdapter.parseSession({ sourceSessionId: "tr-001" });
      assert.deepEqual(
        record.messages.map((message) => message.role),
        ["user", "assistant", "assistant"],
      );
      assert.equal(record.messages[0].content, "修一下登录跳转");
      assert.equal(record.messages[1].toolCallSummaries?.[0]?.toolName, "grep_search");
      // subagent 段拍平为带 [subagent] 前缀的 assistant 消息（R5）。
      assert.equal(record.messages[2].content.startsWith("[subagent] "), true);
      assert.equal(record.messages[2].segmentLabel, "[subagent]");
      // 已知非消息类型 + 未知类型分别计数，不抛错。
      assert.equal(record.parseStats.knownNonMessageEventCount >= 1, true);
      assert.equal(record.parseStats.unknownEventTypeCount >= 1, true);
      assert.equal(buildImportedExternalTaskId(record).startsWith("imported-cursor-"), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor cwd 解码失败: projectHint = 原始目录名（不猜）", async () => {
  const root = makeFixtureRoot("acode-k5-cursor-decode-");
  try {
    await withEnv({ [CURSOR_PROJECTS_DIR_ENV]: join(root, "projects") }, async () => {
      const transcriptDir = join(root, "projects", "some-random-name", "agent-transcripts");
      writeJsonl(join(transcriptDir, "tr-002.jsonl"), [
        { type: "user", content: "hello", timestamp: T0 },
      ]);
      const summaries = await cursorExternalSessionAdapter.discoverSessions({});
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].cwd, undefined);
      assert.equal(summaries[0].projectHint, "some-random-name");
      const record = await cursorExternalSessionAdapter.parseSession({ sourceSessionId: "tr-002" });
      assert.equal(record.cwd, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decodeCursorProjectDirName: base64 旧编码也可解码", () => {
  const encoded = Buffer.from("/home/demo/proj", "utf-8").toString("base64url");
  const decoded = decodeCursorProjectDirName(encoded);
  assert.equal(decoded.decoded, true);
  assert.equal(decoded.cwd, "/home/demo/proj");
  assert.equal(decodeCursorProjectDirName("zzzz-not-a-path").decoded, false);
});

test("四来源: 来源目录缺失 → 空结果不报错", async () => {
  const root = makeFixtureRoot("acode-k5-missing-");
  try {
    await withEnv(
      {
        [CODEX_SESSIONS_DIR_ENV]: join(root, "nope-codex"),
        [GEMINI_CLI_TMP_DIR_ENV]: join(root, "nope-gemini"),
        [OPENCODE_STORAGE_DIR_ENV]: join(root, "nope-opencode"),
        [CURSOR_PROJECTS_DIR_ENV]: join(root, "nope-cursor"),
      },
      async () => {
        assert.deepEqual(await codexExternalSessionAdapter.discoverSessions({}), []);
        assert.deepEqual(await geminiCliExternalSessionAdapter.discoverSessions({}), []);
        assert.deepEqual(await opencodeExternalSessionAdapter.discoverSessions({}), []);
        assert.deepEqual(await cursorExternalSessionAdapter.discoverSessions({}), []);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 测试组 3：对抗套件（R2 硬门槛，每来源同跑） ----

const adversarialAdapters = [
  { name: "codex", adapter: codexExternalSessionAdapter, env: CODEX_SESSIONS_DIR_ENV },
  { name: "cursor", adapter: cursorExternalSessionAdapter, env: CURSOR_PROJECTS_DIR_ENV },
];

for (const { name, adapter, env } of adversarialAdapters) {
  test(`对抗套件(${name}): 超长行/深嵌套/伪 role/未知事件/损坏 JSONL/路径穿越`, async () => {
    const root = makeFixtureRoot(`acode-k5-adv-${name}-`);
    try {
      await withEnv({ [env]: join(root, "root") }, async () => {
        const dir = name === "codex" ? join(root, "root", "2026") : join(root, "root", "proj", "agent-transcripts");
        const fileName = name === "codex" ? "rollout-x-adv.jsonl" : "adv.jsonl";
        const filePath = join(dir, fileName);
        mkdirSync(dir, { recursive: true });
        const deepLine = `{"p":${"[".repeat(IMPORT_JSON_MAX_DEPTH + 10)}1${"]".repeat(IMPORT_JSON_MAX_DEPTH + 10)}}`;
        const oversized = JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "a".repeat(IMPORT_LINE_MAX_BYTES + 256) },
        });
        const lines = [];
        if (name === "codex") {
          lines.push(JSON.stringify(codexMeta("adv-1", "/definitely/not/here")));
          lines.push(JSON.stringify(codexUser("正常消息 A")));
          lines.push(deepLine);
          lines.push(oversized);
          lines.push('{"timestamp":"2026-01-02T03:04:05.000Z","type":"response_item","payload":{"type":"message","role":"fake_role","content":[]}}');
          lines.push('{"timestamp":"2026-01-02T03:04:05.000Z","type":"quantum_unknown","payload":{}}');
          lines.push("{broken-json");
          lines.push(JSON.stringify(codexAgent("正常消息 B")));
        } else {
          lines.push(JSON.stringify({ type: "user", content: "正常消息 A", timestamp: T0 }));
          lines.push(deepLine);
          lines.push(oversized);
          lines.push(JSON.stringify({ type: "system", content: "伪 role", timestamp: T0 }));
          lines.push(JSON.stringify({ type: "quantum_unknown", content: "?" }));
          lines.push("{broken-json");
          lines.push(JSON.stringify({ type: "assistant", content: "正常消息 B", timestamp: T1 }));
        }
        writeRawLines(filePath, lines);

        const summaries = await adapter.discoverSessions({});
        const sessionId = summaries[0]?.sourceSessionId;
        assert.ok(sessionId, "发现阶段应找到会话");
        const record = await adapter.parseSession({ sourceSessionId: sessionId });
        // 部分导入：坏行前后的好消息保留。
        assert.deepEqual(
          record.messages.filter((message) => message.content.startsWith("正常消息")).map((message) => message.content),
          ["正常消息 A", "正常消息 B"],
        );
        assert.equal(record.parseStats.skippedLinesOverSize, 1);
        assert.equal(record.parseStats.skippedLinesTooDeep >= 1, true);
        assert.equal(record.parseStats.skippedLinesMalformed >= 1, true);
        assert.equal(record.parseStats.droppedMessagesInvalidRole, 1);
        assert.equal(record.parseStats.unknownEventTypeCount >= 1, true);

        // 路径穿越型 sourceSessionId 被拒。
      await assert.rejects(
        () => adapter.parseSession({ sourceSessionId: "../../x" }),
        /非法路径段|路径非法/,
      );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("对抗套件(gemini/opencode 整文件形态): 伪 role/未知结构/损坏文件/路径穿越", async () => {
  const root = makeFixtureRoot("acode-k5-adv-file-");
  try {
    await withEnv(
      { [GEMINI_CLI_TMP_DIR_ENV]: join(root, "gemini"), [OPENCODE_STORAGE_DIR_ENV]: join(root, "opencode") },
      async () => {
        writeJson(join(root, "gemini", "hash", "chats", "g-adv.json"), {
          messages: [
            { role: "user", timestamp: T0, message: { parts: [{ text: "正常消息 A" }] } },
            { role: "fake-speaker", timestamp: T0, message: { parts: [{ text: "伪 role" }] } },
            { role: { model: "m" }, timestamp: T1, message: { parts: [{ text: "正常消息 B" }] } },
          ],
        });
        const owner = join(root, "opencode", "local");
        writeJson(join(owner, "session", "o-adv.json"), { id: "o-adv", time: { start: T0_MS } });
        writeJson(join(owner, "message", "o-adv", "m1.json"), {
          id: "m1",
          role: "tool",
          time: { start: T0_MS },
          parts: [{ type: "text", text: "伪 role" }],
        });
        writeJson(join(owner, "message", "o-adv", "m2.json"), {
          id: "m2",
          role: "assistant",
          time: { start: T1_MS },
          parts: [{ type: "text", text: "正常消息 B" }],
        });

        const geminiRecord = await geminiCliExternalSessionAdapter.parseSession({ sourceSessionId: "g-adv" });
        assert.equal(geminiRecord.parseStats.droppedMessagesInvalidRole, 1);
        assert.equal(geminiRecord.messages.length, 2);
        const opencodeRecord = await opencodeExternalSessionAdapter.parseSession({ sourceSessionId: "o-adv" });
        assert.equal(opencodeRecord.parseStats.droppedMessagesInvalidRole, 1);
        assert.equal(opencodeRecord.messages.length, 1);

        // 损坏整文件：解析失败抛错（编排层记 failed，不拖垮其它会话）。
        writeFileSync(join(root, "gemini", "hash", "chats", "g-broken.json"), "{broken", "utf-8");
        await assert.rejects(
          () => geminiCliExternalSessionAdapter.parseSession({ sourceSessionId: "g-broken" }),
          /不可解析/,
        );
        await assert.rejects(
          () => geminiCliExternalSessionAdapter.parseSession({ sourceSessionId: "../../x" }),
          /非法路径段/,
        );
        await assert.rejects(
          () => opencodeExternalSessionAdapter.parseSession({ sourceSessionId: "..\\..\\x" }),
          /非法路径段/,
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 测试组 4：claude-code adapter 零回归（验收场景 1） ----

function writeClaudeFixture(root, sessionId) {
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const filePath = join(root, ".claude", "projects", "enc-proj", `${sessionId}.jsonl`);
  writeJsonl(filePath, [
    {
      type: "user",
      message: { role: "user", content: "导入测试问题" },
      cwd: ws,
      timestamp: T0,
      sessionId,
      uuid: "u1",
    },
    {
      type: "assistant",
      message: { role: "assistant", model: "glm-4.7", content: [{ type: "text", text: "导入测试回答" }] },
      cwd: ws,
      timestamp: T1,
      uuid: "u2",
    },
  ]);
  return { ws, filePath };
}

test("claude-code adapter: 发现/解析 + 产出与既有 claude 链路逐字节一致", async () => {
  const root = makeFixtureRoot("acode-k5-claude-compat-");
  try {
    const { ws } = writeClaudeFixture(root, "sess-abc");
    setDataBaseDir(root);
    try {
      const summaries = await claudeCodeExternalSessionAdapter.discoverSessions({ workspacePath: ws });
      const target = summaries.find((item) => item.sourceSessionId === "sess-abc");
      assert.ok(target, "应发现 fixture 会话");
      assert.equal(target.cwd, ws);

      const record = await claudeCodeExternalSessionAdapter.parseSession({ sourceSessionId: "sess-abc" });
      assert.equal(record.source, "claude-code");
      assert.ok(record.native, "必须透传 native 解析产物");
      // 验收场景 1：泛化 builder 与既有 builder 输出逐字节一致。
      // generateTraceId 每次调用都随机（既有链路自身两次构建也不同），因此比较前
      // 把两侧 traceId 对齐到 legacy 产物，其余字段必须零差异。
      const legacyFile = buildImportedClaudeTaskFile(record.native);
      const externalFile = buildImportedExternalTaskFile(record);
      externalFile.meta.traceId = legacyFile.meta.traceId;
      assert.equal(JSON.stringify(externalFile), JSON.stringify(legacyFile));
      // 既有 taskId 前缀 claude-import- 保持不变。
      assert.equal(buildImportedExternalTaskId(record), buildImportedClaudeTaskId(ws, "sess-abc"));
      assert.equal(record.cwd, ws);
      assert.deepEqual(
        record.messages.map((message) => message.content),
        ["导入测试问题", "导入测试回答"],
      );
      // 路径穿越拒绝同样生效。
      await assert.rejects(
        () => claudeCodeExternalSessionAdapter.parseSession({ sourceSessionId: "../../x" }),
        /非法路径段/,
      );
    } finally {
      setDataBaseDir(null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 测试组 5：幂等与编排（验收场景 4/5） ----

test("importExternalSessions: 落库 + 幂等跳过（同 sourceSessionId 二次导入不双份）", async () => {
  const root = makeFixtureRoot("acode-k5-idem-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      writeJsonl(join(root, "sessions", "2026", `rollout-x-idem.jsonl`), [
        codexMeta("codex-idem-1", ws),
        codexUser("幂等测试问题"),
        codexAgent("幂等测试回答"),
      ]);
      setDataBaseDir(root);
      const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
      try {
        const first = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-idem-1"],
        });
        assert.equal(first.imported.length, 1);
        assert.equal(first.failed.length, 0);
        const taskId = first.imported[0].taskId;
        assert.equal(taskId.startsWith("imported-codex-"), true);
        // snapshot 已写入 legacy 位置。
        const snapshotPath = getLegacyTaskSessionSnapshotPath(ws, taskId, undefined);
        assert.equal(Boolean(snapshotPath), true);

        const second = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-idem-1"],
        });
        assert.equal(second.imported.length, 0);
        assert.equal(second.skipped.length, 1);
        assert.equal(second.skipped[0].reason, "already_imported");
        assert.deepEqual(second.skippedReasons, [{ reason: "already_imported", count: 1 }]);

        const metas = await taskIndexRepo.listTaskMetas({});
        assert.equal(metas.length, 1);
      } finally {
        taskIndexRepo.close();
        setDataBaseDir(null);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importExternalSessions: 损坏会话逐条隔离，好会话照常导入", async () => {
  const root = makeFixtureRoot("acode-k5-failiso-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      writeJsonl(join(root, "sessions", "rollout-good.jsonl"), [
        codexMeta("codex-good", ws),
        codexUser("好会话问题"),
        codexAgent("好会话回答"),
      ]);
      // 损坏 rollout：sourceSessionId 不存在 → failed。
      setDataBaseDir(root);
      const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
      try {
        const result = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-good", "codex-missing"],
        });
        assert.equal(result.imported.length, 1);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].sourceSessionId, "codex-missing");
      } finally {
        taskIndexRepo.close();
        setDataBaseDir(null);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverExternalSessions: 一来源失败不拖垮整轮（allSettled）", async () => {
  const root = makeFixtureRoot("acode-k5-orch-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      writeJsonl(join(root, "sessions", "rollout-orch.jsonl"), [
        codexMeta("codex-orch", ws),
        codexUser("编排测试"),
      ]);
      const throwingAdapter = {
        source: "gemini-cli",
        importedTaskIdPrefix: "imported-gemini-",
        async discoverSessions() {
          throw new Error("stub boom");
        },
        async parseSession() {
          throw new Error("stub boom");
        },
      };
      const { summaries, failedSources } = await discoverExternalSessions({
        adapters: [throwingAdapter, codexExternalSessionAdapter],
      });
      assert.equal(failedSources.length, 1);
      assert.equal(failedSources[0].source, "gemini-cli");
      assert.match(failedSources[0].error, /stub boom/);
      assert.equal(summaries.some((item) => item.sourceSessionId === "codex-orch"), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 测试组 6：importSessions 缺省 source 兼容钉住（验收场景 7） ----

function buildFakeAgentService() {
  const created = [];
  const service = {
    async resumeSession() {
      throw new Error("not used");
    },
    async createSession(input) {
      created.push(input);
      // snapshotToMeta 消费的是协议 snapshot 形态（session/settings/projection/runtime），
      // 与 importedClaudeRecovery.test.ts 的最小快照同构。
      return {
        protocol: { name: "acode", version: 1 },
        session: {
          sessionId: input.sessionId,
          traceId: input.sessionTraceId,
          workspace: {
            workspacePath: input.workspacePath,
            workspaceIdentity: input.workspaceIdentity,
            workspaceKey: input.workspaceIdentity ?? input.workspacePath,
          },
          sessionKind: "interactive",
          title: input.importedHistory?.title,
          mode: "build",
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
        },
        settings: {
          model: { available: [] },
          thoughtLevel: { enabled: false, available: [] },
          mode: { current: "build" },
        },
        projection: {
          sessionId: input.sessionId,
          status: "idle",
          mode: "build",
          turnCount: 0,
          totalTokenCount: 0,
          contextUsed: 0,
          contextWindow: 200000,
          pendingPermissions: [],
          activeToolCalls: [],
          backgroundJobs: [],
        },
        runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
        messages: [],
      };
    },
    disposeAll() {},
  };
  return { service, created };
}

test("importClaudeSessions: 缺省与显式 claude-code 行为一致，新来源路由 external-import", async () => {
  const root = makeFixtureRoot("acode-k5-service-route-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const fake = buildFakeAgentService();
  setDataBaseDir(root);
  const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const disposable = () => ({ dispose() {} });
  const service = createACodeTaskServiceAdapter({
    taskIndexRepo,
    acodeAgentService: fake.service,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      emitWorkspaceTaskListChanged() {},
      disposeAll() {},
    },
  });
  try {
    writeClaudeFixture(root, "sess-route");
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "codex-sessions") }, async () => {
      writeJsonl(join(root, "codex-sessions", "rollout-route.jsonl"), [
        codexMeta("codex-route-1", ws),
        codexUser("codex 路由测试"),
        codexAgent("codex 路由回答"),
      ]);

      // 缺省 source → 既有 Claude 链路。
      const withoutSource = await service.importClaudeSessions({ sessionIds: ["sess-route"] });
      assert.equal(withoutSource.imported.length, 1);
      assert.equal(withoutSource.imported[0].provider, "claude");
      const claudeTaskId = withoutSource.imported[0].taskId;
      assert.equal(claudeTaskId, buildImportedClaudeTaskId(ws, "sess-route"));

      // 显式 claude-code → 同一条链路、同一个 taskId（兼容性钉住）。
      const withClaudeSource = await service.importClaudeSessions({
        sessionIds: ["sess-route"],
        source: "claude-code",
      });
      assert.equal(withClaudeSource.imported[0].taskId, claudeTaskId);
      assert.equal(fake.created.length >= 2, true);

      // 新来源 → external-import 框架（ExternalImportResult 形态）。
      const codexResult = await service.importClaudeSessions({
        sessionIds: ["codex-route-1"],
        source: "openai-codex",
      });
      assert.equal(codexResult.imported.length, 1);
      assert.equal(codexResult.imported[0].source, "openai-codex");
      assert.equal(codexResult.imported[0].taskId.startsWith("imported-codex-"), true);
    });
  } finally {
    service.disposeAll();
    taskIndexRepo.close();
    setDataBaseDir(null);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 测试组 7：R7 repo_ranking 纯函数与修复器登记 ----

test("repoRanking: 纯函数排序 key + feature flag 缺省关闭", () => {
  assert.equal(EXTERNAL_IMPORT_REPO_RANKING_ENABLED, false);
  const active = computeExternalRepoRankHint({ lastCommitTs: 1_700_000_000_000, gitDirMtimeMs: 1_700_000_100_000 });
  const stale = computeExternalRepoRankHint({ lastCommitTs: 1_600_000_000_000, gitDirMtimeMs: 1_600_000_000_000 });
  assert.ok(active > stale);
  assert.equal(computeExternalRepoRankHint(null), 0);

  const summaries = [
    { source: "cursor", sourceSessionId: "a", lastActivityTs: 5, messageCountEstimate: 0, sourcePath: "p1", cwd: "/repo-stale" },
    { source: "cursor", sourceSessionId: "b", lastActivityTs: 4, messageCountEstimate: 0, sourcePath: "p2", cwd: "/repo-active" },
    { source: "cursor", sourceSessionId: "c", lastActivityTs: 3, messageCountEstimate: 0, sourcePath: "p3" },
  ];
  const ranked = rankExternalSessionSummaries(summaries, new Map([
    ["/repo-stale", { lastCommitTs: 1_600_000_000_000 }],
    ["/repo-active", { lastCommitTs: 1_700_000_000_000 }],
  ]));
  assert.equal(ranked[0].sourceSessionId, "b");
  assert.equal(ranked[0].rankHint > 0, true);
  assert.equal(ranked[2].sourceSessionId, "c");
  assert.equal(ranked[2].rankHint, undefined);
});

test("修复器策略: claude 走原生修复，新来源登记为 no-op", () => {
  assert.deepEqual(importedHistoryRepairPolicies["claude-code"], { kind: "claude-native" });
  for (const source of ["openai-codex", "gemini-cli", "opencode", "cursor"]) {
    assert.equal(importedHistoryRepairPolicies[source].kind, "noop");
  }
});

// ---- 测试组 8：批次 C 对抗复核回归（finding F1/F4/F5/F6） ----

test("F1 opencode: parts 路径穿越 entry 被拒（entry 级丢弃计数，不整会话失败），合法 part 照常读", async () => {
  const root = makeFixtureRoot("acode-k5c-f1-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [OPENCODE_STORAGE_DIR_ENV]: join(root, "storage") }, async () => {
      const owner = join(root, "storage", "owner-a");
      writeJson(join(owner, "session", "ses-f1.json"), {
        id: "ses-f1",
        cwd: ws,
        time: { start: T0_MS, end: T1_MS },
      });
      // 恶意 parts 混排："../../../secret"（逃出 ownerDir）、posix 绝对路径、
      // Windows "..\" 形态、纯 ".."，与一条合法 part 并存。
      writeJson(join(owner, "message", "ses-f1", "m1.json"), {
        id: "m1",
        role: "user",
        time: { start: T0_MS },
        parts: ["../../../secret", "/etc/passwd", "..\\..\\win", "..", "good-part"],
      });
      writeJson(join(owner, "part", "m1", "good-part.json"), { type: "text", text: "合法 part 内容" });
      // POC 目标：ownerDir/part/m1/../../../secret.json = storage/secret.json，
      // 无守卫时会被读出并落库展示。
      writeJson(join(root, "storage", "secret.json"), { type: "text", text: "TOP-SECRET-LEAKED" });

      const record = await opencodeExternalSessionAdapter.parseSession({ sourceSessionId: "ses-f1" });
      // 不整会话失败：合法 part 照常读入。
      assert.equal(record.messages.length, 1);
      assert.equal(record.messages[0].content, "合法 part 内容");
      // 越界 entry 全部被拒并计数（4 条恶意 entry → entry 级丢弃）。
      assert.equal(record.parseStats.skippedLinesMalformed, 4);
      // ownerDir 之外的秘密内容绝不进入解析产物。
      assert.equal(JSON.stringify(record).includes("TOP-SECRET-LEAKED"), false);

      // messageId（外部 value.id）穿越形态：会话级拒绝（importService 记 failed，不崩进程）。
      writeJson(join(owner, "message", "ses-f1", "m2.json"), {
        id: "../../evil",
        role: "assistant",
        time: { start: T1_MS },
        parts: [{ type: "text", text: "恶意消息 id" }],
      });
      await assert.rejects(
        () => opencodeExternalSessionAdapter.parseSession({ sourceSessionId: "ses-f1" }),
        /非法路径段/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4: cwd 与过滤 workspacePath 不一致 → skip(workspace-mismatch)；匹配/回退时 identity 正确绑定", async () => {
  const root = makeFixtureRoot("acode-k5c-f4-");
  const wsA = join(root, "wsA");
  const wsB = join(root, "wsB");
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  try {
    await withEnv(
      { [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions"), [GEMINI_CLI_TMP_DIR_ENV]: join(root, "gemini") },
      async () => {
        // 会话真实 cwd 是 wsB；过滤 wsA 时不得导入、不得绑定 identity-A。
        writeJsonl(join(root, "sessions", "rollout-f4.jsonl"), [
          codexMeta("codex-f4-1", wsB),
          codexUser("F4 测试问题"),
          codexAgent("F4 测试回答"),
        ]);
        // gemini 无 cwd：回退到过滤 workspace 导入（合法路径，identity 应绑定）。
        writeJson(join(root, "gemini", "hash", "chats", "g-f4.json"), {
          messages: [{ role: "user", timestamp: T0, message: { parts: [{ text: "F4 gemini 回退" }] } }],
        });
        setDataBaseDir(root);
        const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
        try {
          const mismatch = await importExternalSessions({
            source: "openai-codex",
            taskIndexRepo,
            workspacePath: wsA,
            workspaceIdentity: "identity-A",
            sessionIds: ["codex-f4-1"],
          });
          assert.equal(mismatch.imported.length, 0);
          assert.equal(mismatch.skipped.length, 1);
          assert.equal(mismatch.skipped[0].reason, "workspace-mismatch");
          assert.equal(mismatch.skipped[0].workspacePath, wsB);
          assert.deepEqual(mismatch.skippedReasons, [{ reason: "workspace-mismatch", count: 1 }]);
          assert.equal((await taskIndexRepo.listTaskMetas({})).length, 0);

          // 过滤 wsB（= 真实 cwd）：导入成功且 identity-B 绑定到该 workspace。
          const match = await importExternalSessions({
            source: "openai-codex",
            taskIndexRepo,
            workspacePath: wsB,
            workspaceIdentity: "identity-B",
            sessionIds: ["codex-f4-1"],
          });
          assert.equal(match.imported.length, 1);
          const codexMetaRow = (await taskIndexRepo.listTaskMetas({})).find(
            (meta) => meta.taskId === match.imported[0].taskId,
          );
          assert.equal(codexMetaRow?.workspacePath, wsB);
          assert.equal(codexMetaRow?.workspaceIdentity, "identity-B");

          // cwd 缺失（gemini）：回退到过滤 workspace，identity 照常绑定。
          const fallback = await importExternalSessions({
            source: "gemini-cli",
            taskIndexRepo,
            workspacePath: wsA,
            workspaceIdentity: "identity-A",
            sessionIds: ["g-f4"],
          });
          assert.equal(fallback.imported.length, 1);
          const geminiMetaRow = (await taskIndexRepo.listTaskMetas({})).find(
            (meta) => meta.taskId === fallback.imported[0].taskId,
          );
          assert.equal(geminiMetaRow?.workspacePath, wsA);
          assert.equal(geminiMetaRow?.workspaceIdentity, "identity-A");
        } finally {
          taskIndexRepo.close();
          setDataBaseDir(null);
        }
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5: 幂等键不含 cwd——同 session 跨 cwd 只导入一份", async () => {
  const root = makeFixtureRoot("acode-k5c-f5-");
  const wsA = join(root, "wsA");
  const wsB = join(root, "wsB");
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      const rollout = join(root, "sessions", "rollout-f5.jsonl");
      writeJsonl(rollout, [
        codexMeta("codex-f5-1", wsA),
        codexUser("跨 cwd 幂等测试"),
        codexAgent("跨 cwd 幂等回答"),
      ]);
      // 单元层：同 source+sourceSessionId、不同 cwd → 同一 taskId（origin 不含 cwd）。
      const recordA = await codexExternalSessionAdapter.parseSession({ sourceSessionId: "codex-f5-1" });
      assert.equal(
        buildImportedExternalTaskId(recordA),
        buildImportedExternalTaskId({ ...recordA, cwd: wsB }),
      );

      setDataBaseDir(root);
      const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
      try {
        const first = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-f5-1"],
        });
        assert.equal(first.imported.length, 1);

        // codex resume rollout 形态：同 session 换 cwd 续跑后重写文件，再次导入
        // 必须命中同一 taskId → already_imported，而不是第二份任务。
        writeJsonl(rollout, [
          codexMeta("codex-f5-1", wsB),
          codexUser("跨 cwd 幂等测试"),
          codexAgent("跨 cwd 幂等回答"),
        ]);
        const second = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-f5-1"],
        });
        assert.equal(second.imported.length, 0);
        assert.equal(second.skipped.length, 1);
        assert.equal(second.skipped[0].reason, "already_imported");
        assert.equal((await taskIndexRepo.listTaskMetas({})).length, 1);
      } finally {
        taskIndexRepo.close();
        setDataBaseDir(null);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F6: 已删除任务重导入 → 恢复（重新可见），不是 skip", async () => {
  const root = makeFixtureRoot("acode-k5c-f6-");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    await withEnv({ [CODEX_SESSIONS_DIR_ENV]: join(root, "sessions") }, async () => {
      writeJsonl(join(root, "sessions", "rollout-f6.jsonl"), [
        codexMeta("codex-f6-1", ws),
        codexUser("F6 恢复语义测试"),
        codexAgent("F6 恢复语义回答"),
      ]);
      setDataBaseDir(root);
      const taskIndexRepo = new TaskIndexRepo(join(root, "tasks.sqlite"));
      try {
        const first = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-f6-1"],
        });
        assert.equal(first.imported.length, 1);
        const taskId = first.imported[0].taskId;

        // 用户删除导入任务 → 活任务列表不可见。
        await taskIndexRepo.updateTaskState({ workspacePath: ws, taskId, patch: { deleted: true } });
        assert.equal((await taskIndexRepo.listTaskMetas({})).length, 0);

        // 重导入 = 恢复：imported（不是 skipped(already_imported)），任务重新可见。
        const again = await importExternalSessions({
          source: "openai-codex",
          taskIndexRepo,
          sessionIds: ["codex-f6-1"],
        });
        assert.equal(again.imported.length, 1);
        assert.equal(again.skipped.length, 0);
        // listTaskMetas 缺省排除已删除任务：重导入后该 taskId 重新出现在活任务列表
        // 即“恢复可见”（ACodeTaskMeta 本身不投影 deleted 标志位）。
        const metas = await taskIndexRepo.listTaskMetas({});
        assert.equal(metas.length, 1);
        assert.equal(metas[0].taskId, taskId);
      } finally {
        taskIndexRepo.close();
        setDataBaseDir(null);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
