import assert from "node:assert/strict";
import test from "node:test";

// handlers/index.ts → 各 handler → ../executor.js → 回本 index 的环：先初始化 index
// 即与生产加载序一致（M2-2 测试同款纪律，避免 index 的 spread 撞 TDZ）。
await import("../packages/bootstrap/src/acode-protocol-v4/commands/handlers/index.ts");
const { sessionMgmtHandlers } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/commands/handlers/session-mgmt.ts"
);
const {
  querySessionReadV4,
  querySessionResumeV4,
  querySessionsListV4,
  querySessionMessagesV4,
  querySessionEventsV4,
  subscribeSessionV4,
} = await import("../packages/bootstrap/src/acode-protocol-v4/session-readwrite.ts");
const {
  handleSessionRuntimePreferencesPushV4,
  readCachedSessionRuntimePreferences,
  resetCachedSessionRuntimePreferencesForTest,
} = await import("../packages/bootstrap/src/acode-protocol-v4/session-runtime-preferences.ts");
const { createSessionRecordForV4 } = await import(
  "../packages/bootstrap/src/acode-protocol/server-operations.ts"
);

/**
 * M2-3 session 读写面 handler 级测试（specs/m2-3-session-readwrite.md §5C）。
 * 钉住：
 * - resume 冷恢复：持久化记录缺席 → 协议错误（sessionUnavailable）；
 * - list：includeArchived/sessionIds/limit 语义 parity；
 * - messages：afterMessageId 严格其后 + limit 尾部切片（§6.1：不建 rowsRange 适配层，
 *   钉的是 legacy 语义本身）；
 * - events：afterSeq 重编号 parity；
 * - subscribe：eventSeq 与 events 同一水位、deliveryKind/legacyStreamSubscribed 副作用；
 * - runtime prefs：push→缓存→读取（缺失 → undefined；推送后 → 推送值；惰性 shell 读取）；
 * - createSession：parity 字段经 session-mgmt handler 直通 createSessionRecord 钩子；
 *   sessionId 无 importedHistory 的协议拒绝。
 *
 * 如实登记：钩子→rawParams 一跳在 v4-bridge.ts 的 createConversationV4Gateway 闭包内
 * （12 行逐字段 spread，persistence ?? "deferred"），无法脱离 gateway 构造单测；该跳
 * 由协议边界测试（persistence 字段 optional 钉住）+ 本文件钩子入参断言两端夹住。
 */

const SESSION_ID = "s1";

function makeContext({ sessions = [], sessionStore } = {}) {
  return {
    sessions: new Map(sessions),
    deps: { sessionStore, cwd: "/w" },
  };
}

function makeTitleEvent(sequenceNumber, title) {
  return {
    id: `evt_${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn_1",
    type: "session.title_updated",
    timestamp: new Date(1700000000000 + sequenceNumber),
    traceId: "trace_1",
    sequenceNumber,
    payload: { title },
  };
}

function makeRecord({ events = [], sessionId = SESSION_ID } = {}) {
  return {
    app: { sessionId },
    persistence: "immediate",
    taskType: "interactive",
    workspace: { workspacePath: "/w", workspaceKey: "/w" },
    eventStore: { getEvents: async () => events },
    protocolEventSequences: new Map(),
    deliveryKind: undefined,
    legacyStreamSubscribed: false,
  };
}

function makeMessage(id) {
  return { info: { id }, parts: [] };
}

// ── resume：冷恢复直通（spec §5C resume）──

test("resume: 持久化记录缺席 → 协议错误（Session not found），不静默建空会话", async () => {
  const context = makeContext({
    sessionStore: { getSession: async () => null },
  });
  await assert.rejects(
    () => querySessionResumeV4(context, { sessionId: "s-missing" }),
    /Session not found/,
  );
});

test("read: 活跃 record 缺席 → requireSession 协议错误（冷会话先 subscribe/resume）", async () => {
  const context = makeContext({ sessionStore: { getSession: async () => null } });
  await assert.rejects(
    () => querySessionReadV4(context, { sessionId: "s-missing" }),
    /not active/i,
  );
});

// ── list：includeArchived/sessionIds/limit parity（spec §5C list）──

function storedSession(id, { archived } = {}) {
  return {
    id,
    title: `title-${id}`,
    time: { created: 1, updated: 2, ...(archived ? { archived: 3 } : {}) },
    path: "/w",
    directory: "/w",
  };
}

test("list: 缺省过滤 archived、limit 缺省 50，显式 limit 直通 store", async () => {
  const captured = [];
  const context = makeContext({
    sessionStore: {
      listSessions: async (opts) => {
        captured.push(opts);
        return [storedSession("a"), storedSession("b", { archived: true })];
      },
    },
  });
  const result = await querySessionsListV4(context, { limit: 7 });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].limit, 7, "limit 必须直通 legacy store 查询");
  assert.equal(
    captured[0].includeArchived,
    false,
    "includeArchived 缺省由 params schema 落为 false（legacy parity）",
  );
  assert.deepEqual(
    result.sessions.map((s) => s.sessionId),
    ["a"],
    "缺省必须过滤 archived 会话",
  );
  assert.equal(result.sessions[0].title, "title-a");
  assert.equal(result.sessions[0].workspace.workspacePath, "/w");
});

test("list: includeArchived=true → archived 会话保留", async () => {
  const context = makeContext({
    sessionStore: {
      listSessions: async () => [storedSession("a"), storedSession("b", { archived: true })],
    },
  });
  const result = await querySessionsListV4(context, { includeArchived: true });
  assert.deepEqual(
    result.sessions.map((s) => s.sessionId),
    ["a", "b"],
  );
  assert.equal(result.sessions[1].archivedAt, 3);
});

test("list: sessionIds 显式查询走 getSession 单点，不触 listSessions", async () => {
  let listCalls = 0;
  const context = makeContext({
    sessionStore: {
      listSessions: async () => {
        listCalls += 1;
        return [];
      },
      getSession: async (id) => (id === "a" ? storedSession("a") : null),
    },
  });
  const result = await querySessionsListV4(context, { sessionIds: ["a", "gone"] });
  assert.equal(listCalls, 0, "显式 ID 查询不得走 listSessions");
  assert.deepEqual(
    result.sessions.map((s) => s.sessionId),
    ["a"],
    "不存在的 ID 必须被滤除",
  );
});

// ── messages：afterMessageId 严格其后 + limit 尾部切片（spec §5C messages）──

test("messages: afterMessageId 返回严格其后的消息，limit 取尾部切片", async () => {
  const record = makeRecord();
  const context = makeContext({
    sessions: [[SESSION_ID, record]],
    sessionStore: {
      messages: async () => [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")],
      getSession: async () => null,
    },
  });

  const all = await querySessionMessagesV4(context, { sessionId: SESSION_ID });
  assert.deepEqual(
    all.messages.map((m) => m.info.id),
    ["m1", "m2", "m3"],
  );

  const after = await querySessionMessagesV4(context, {
    sessionId: SESSION_ID,
    afterMessageId: "m1",
  });
  assert.deepEqual(
    after.messages.map((m) => m.info.id),
    ["m2", "m3"],
    "afterMessageId 必须严格排除自身",
  );

  const tail = await querySessionMessagesV4(context, {
    sessionId: SESSION_ID,
    afterMessageId: "m1",
    limit: 1,
  });
  assert.deepEqual(
    tail.messages.map((m) => m.info.id),
    ["m3"],
    "limit 必须取尾部切片（最新 N 条）",
  );

  const unknownAnchor = await querySessionMessagesV4(context, {
    sessionId: SESSION_ID,
    afterMessageId: "m-unknown",
  });
  assert.equal(unknownAnchor.messages.length, 3, "锚点缺席回落全量（legacy parity）");
});

// ── events：afterSeq 重编号 parity（spec §5C events）──

test("events: afterSeq 只返回协议可见且 seq 严格更大的事件（seq 按可见流重编号）", async () => {
  const record = makeRecord({
    events: [makeTitleEvent(1, "t1"), makeTitleEvent(2, "t2"), makeTitleEvent(3, "t3")],
  });
  const context = makeContext({ sessions: [[SESSION_ID, record]] });

  const all = await querySessionEventsV4(context, { sessionId: SESSION_ID });
  assert.deepEqual(
    all.events.map((e) => e.seq),
    [1, 2, 3],
    "协议 seq 按可见事件流连续重编号",
  );

  const after = await querySessionEventsV4(context, { sessionId: SESSION_ID, afterSeq: 1 });
  assert.deepEqual(
    after.events.map((e) => e.seq),
    [2, 3],
    "afterSeq 必须严格其后",
  );
});

// ── subscribe：水位原子性 + 副作用写入（spec §5C subscribe）──

test("subscribe: eventSeq 与 events 同一水位；deliveryKind/legacyStreamSubscribed 副作用写入", async () => {
  const record = makeRecord({
    events: [makeTitleEvent(1, "t1"), makeTitleEvent(2, "t2"), makeTitleEvent(3, "t3")],
  });
  const context = makeContext({ sessions: [[SESSION_ID, record]] });

  const result = await subscribeSessionV4(context, {
    sessionId: SESSION_ID,
    afterSeq: 1,
    deliveryKind: "desktop-continuous",
  });
  assert.equal(result.eventSeq, 3, "eventSeq 必须是可见流水位");
  assert.deepEqual(
    result.events.map((e) => e.seq),
    [2, 3],
    "events 与 eventSeq 同源同水位（原子读取）",
  );
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.snapshot, undefined, "includeSnapshot 缺席不携带快照");
  assert.equal(record.deliveryKind, "desktop-continuous", "deliveryKind 副作用写入 record");
  assert.equal(record.legacyStreamSubscribed, true, "legacyStreamSubscribed 副作用写入 record");

  const noAfter = await subscribeSessionV4(context, {
    sessionId: SESSION_ID,
    deliveryKind: "web-remote-replayable",
  });
  assert.deepEqual(noAfter.events, [], "afterSeq 缺席时 events 为空数组（不回放）");
  assert.equal(noAfter.eventSeq, 3);
});

// ── runtime prefs：push→缓存→读取（spec §5C runtime prefs）──

test("runtime prefs: 缓存缺失返回 undefined（物化读取方回落缺省值）", () => {
  resetCachedSessionRuntimePreferencesForTest();
  assert.equal(readCachedSessionRuntimePreferences(), undefined);
});

test("runtime prefs: push 后缓存持有推送值；再推送覆盖；惰性 shell 读取以最新缓存为准", async () => {
  resetCachedSessionRuntimePreferencesForTest();
  const context = makeContext();

  const ack1 = await handleSessionRuntimePreferencesPushV4(context, {
    preferences: {
      askUserQuestionAutoResolutionEnabled: false,
      memoryEnabled: true,
      nativeSearchEnhancementsEnabled: false,
      integratedTerminalShell: {
        mode: "shell",
        dialect: "git-bash",
        id: "git-bash",
        label: "Git Bash",
        path: "C:/git/bin/bash.exe",
      },
    },
  });
  assert.deepEqual(ack1, {}, "推送面是无返回值的承载");
  const cached1 = readCachedSessionRuntimePreferences();
  assert.equal(cached1.askUserQuestionAutoResolutionEnabled, false);
  assert.equal(cached1.memoryEnabled, true);
  assert.equal(cached1.nativeSearchEnhancementsEnabled, false);
  assert.deepEqual(cached1.integratedTerminalShell, {
    mode: "shell",
    dialect: "git-bash",
    id: "git-bash",
    label: "Git Bash",
    path: "C:/git/bin/bash.exe",
  });

  // 第二次推送覆盖（app-global 全量快照语义：host 侧已合并双 scope）。
  await handleSessionRuntimePreferencesPushV4(context, {
    preferences: {
      askUserQuestionAutoResolutionEnabled: true,
      memoryEnabled: false,
      nativeSearchEnhancementsEnabled: true,
      integratedTerminalShell: { mode: "auto" },
    },
  });
  const cached2 = readCachedSessionRuntimePreferences();
  assert.equal(cached2.memoryEnabled, false, "后推送覆盖先推送");
  // 惰性 shell 读取：读取以调用时刻的缓存为准（resolveSessionStartupPreferences
  // 的 resolveInitialBashShellSelection 同款语义，server-operations.ts:2815）。
  assert.deepEqual(cached2.integratedTerminalShell, { mode: "auto" });

  resetCachedSessionRuntimePreferencesForTest();
});

// ── createSession：parity 字段直通钩子 + sessionId 裁决（spec §5C createSession）──

test("createSession: parity 字段经 handler 直通 host.createSessionRecord 钩子", async () => {
  let captured;
  const host = {
    createSessionRecord: async (args) => {
      captured = args;
      return { sessionId: "s-created" };
    },
  };
  const envelope = {
    commandId: "cmd-create-1",
    clientId: "test-client",
    sessionId: null,
    type: "createSession",
    payload: {
      workspaceId: "/w",
      mcpServers: { fs: { command: "npx", args: ["mcp-fs"] } },
      offPeakToolEnabled: true,
      dynamicWorkflowEnabled: true,
      scriptWorkflowEnabled: false,
      toolSearchMode: "local",
      clientMode: "desktop-continuous",
      sessionId: "s-imported",
      persistence: "immediate",
      titleGenerationEnabled: false,
      toolAllowlist: ["Bash"],
      toolDenylist: ["Write"],
      importedHistory: { provider: "claude", messages: [] },
      mode: "plan",
      model: "anthropic/claude-opus-4",
      thoughtLevel: "high",
    },
    issuedAt: Date.now(),
  };
  const result = await sessionMgmtHandlers.createSession(host, envelope);
  assert.deepEqual(result, { type: "createSession", sessionId: "s-created" });
  // 九 parity 字段 + 既有 flag 全部逐字段透传（缺席纪律由字段本身的 conditional
  // spread 承载；本用例全量在场，断言恒等映射）。
  for (const key of [
    "sessionId",
    "persistence",
    "titleGenerationEnabled",
    "toolAllowlist",
    "toolDenylist",
    "importedHistory",
    "mode",
    "model",
    "thoughtLevel",
    "mcpServers",
    "offPeakToolEnabled",
    "dynamicWorkflowEnabled",
    "scriptWorkflowEnabled",
    "toolSearchMode",
    "clientMode",
    "workspaceId",
  ]) {
    assert.deepEqual(captured[key], envelope.payload[key], `字段 ${key} 必须直通`);
  }
});

test("createSession: sessionId 无 importedHistory → 协议拒绝（防接管活跃 record）", async () => {
  const context = makeContext();
  await assert.rejects(
    () =>
      createSessionRecordForV4(context, {
        workspace: { workspacePath: "/w", workspaceKey: "/w" },
        sessionId: "s-hijack",
      }),
    /sessionId is only supported for imported history/,
  );
});
