// Harness API 测试桩入口：真实子进程 + 真实翻译桥/帧协议/传输，services 层在公开接口上打桩。
// 用途：packages/server/tests/harness-api.test.mjs 与 packages/harness-sdk/tests/parity.test.mjs。
// 真实 agent 需要真实模型凭据，无法在测试环境跑完整链路；协议/翻译/SDK 行为全部真实，
// services 层按 IACodeAgentService/IACodeTaskService/IModelSelectionService/IFileService 的
// 既有签名提供确定性脚本化实现（与 server-auth.test.mjs 的桩件哲学一致）。
//
// 脚本化行为（按消息内容分支，供两条测试链共用）：
// - 普通消息：turn.started → part.delta("Hello from stub: " + content) → turn.completed(success)
// - 含 "NEEDS_PERMISSION"：发 permission.requested（allow_once/deny 两选项），
//   挂起等待 permission_respond；deny → turn.completed(cancelled)，allow → success。
// - 含 "SLOW"：挂起 5s 或等 cancel_turn，完成 cancelled。
// - 含 "STRUCTURED"：首次回复非法 JSON，之后回复 {"answer": 42}（重试成功路径）。
// - 含 "STRUCTURED_ALWAYS_BAD"：始终回复非法 JSON（连续违例路径）。
// - 含 "HANG_TURN"：挂起直到同会话收到 "RELEASE_GATE" 或 cancel_turn（H1 归属回归用）。
// - 含 "RELEASE_GATE"：释放本会话 HANG_TURN 的挂起闸门，自身按普通消息完成。
// - 含 "NO_INPUT_ID_ECHO"：该 turn 的事件 payload 不回显 inputId（模拟不回显 inputId
//   的引擎，H1 退化归属路径回归用）。
// 事件形态对齐真实引擎（apps/acode-cli runtime/methods/turn.ts）：同一 turn 的全部
// 事件 envelope 携带同一 turnId；turn.started/turn.completed 的 payload 回显
// sendPrompt 下发的 inputId（未下发时不带）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ServiceCollection,
  IACodeAgentService,
  IACodeTaskService,
  IModelSelectionService,
  IFileService,
} from "@acode/services";
import { createHarnessApiServer } from "../src/harness/index.js";
import { createStdioTransport } from "../src/harness/transport.js";

const sessions = new Map();
let idCounter = 0;

function ensureSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      events: [],
      seq: 0,
      turnCounter: 0,
      listeners: new Set(),
      pendingPermission: null,
      cancelled: false,
      structuredCalls: 0,
      releaseGate: null,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function appendEvent(session, type, payload, turnId) {
  session.seq += 1;
  const envelope = {
    type,
    eventId: `ev-${++idCounter}`,
    sessionId: session.sessionId,
    turnId,
    seq: session.seq,
    timestamp: Date.now(),
    payload,
  };
  session.events.push(envelope);
  for (const listener of Array.from(session.listeners)) {
    listener({ type: "session.event", event: envelope });
  }
}

async function driveTurn(session, content, inputId) {
  // H1 回归形态：同一 turn 的全部事件共用同一 turnId；inputId 回显（NO_INPUT_ID_ECHO 除外）。
  session.turnCounter += 1;
  const turnId = `turn-${session.turnCounter}`;
  const echoInputId = inputId && !content.includes("NO_INPUT_ID_ECHO") ? inputId : undefined;
  const complete = (payload) =>
    appendEvent(
      session,
      "turn.completed",
      { ...payload, ...(echoInputId ? { inputId: echoInputId } : {}) },
      turnId,
    );
  appendEvent(
    session,
    "turn.started",
    {
      turnNumber: session.turnCounter,
      input: content,
      ...(echoInputId ? { inputId: echoInputId } : {}),
    },
    turnId,
  );
  if (content.includes("NEEDS_PERMISSION")) {
    const requestId = `perm-${++idCounter}`;
    appendEvent(
      session,
      "permission.requested",
      {
        requestId,
        toolCallId: `tc-${++idCounter}`,
        toolName: "Bash",
        riskLevel: "medium",
        reason: "stub permission gate",
        input: {},
        options: [
          {
            optionId: "allow_once",
            kind: "allow_once",
            name: "Allow once",
            description: "allow",
            response: { decision: "allow" },
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "Deny",
            description: "deny",
            response: { decision: "deny" },
          },
        ],
      },
      turnId,
    );
    const optionId = await new Promise((resolve) => {
      session.pendingPermission = resolve;
    });
    session.pendingPermission = null;
    if (session.cancelled || optionId === "deny") {
      complete({
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 5,
        resultType: "cancelled",
      });
      return;
    }
    appendEvent(
      session,
      "part.delta",
      {
        messageId: "m-1",
        partId: "p-1",
        field: "text",
        delta: "allowed path",
      },
      turnId,
    );
    complete({
      response: "allowed path",
      tokenCount: 8,
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      toolCallCount: 0,
      duration: 5,
      resultType: "success",
    });
    return;
  }
  if (content.includes("SLOW")) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      session.cancelWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    complete({
      response: "",
      tokenCount: 0,
      toolCallCount: 0,
      duration: 5,
      resultType: session.cancelled ? "cancelled" : "success",
    });
    return;
  }
  if (content.includes("STRUCTURED_ALWAYS_BAD")) {
    session.structuredCalls += 1;
    complete({
      response: "definitely not json",
      tokenCount: 1,
      toolCallCount: 0,
      duration: 1,
      resultType: "success",
    });
    return;
  }
  if (content.includes("STRUCTURED")) {
    session.structuredCalls += 1;
    complete({
      response: session.structuredCalls === 1 ? "oops not json" : '{"answer": 42}',
      tokenCount: 1,
      toolCallCount: 0,
      duration: 1,
      resultType: "success",
    });
    return;
  }
  if (content.includes("HANG_TURN")) {
    // H1 归属回归：本 turn 挂起，直到同会话 RELEASE_GATE 或 cancel_turn 释放。
    await new Promise((resolve) => {
      session.releaseGate = resolve;
    });
    session.releaseGate = null;
    complete({
      response: `hang released: ${content}`,
      tokenCount: 2,
      toolCallCount: 0,
      duration: 5,
      resultType: session.cancelled ? "cancelled" : "success",
    });
    return;
  }
  if (content.includes("RELEASE_GATE")) {
    session.releaseGate?.();
  }
  appendEvent(
    session,
    "part.delta",
    {
      messageId: "m-1",
      partId: "p-1",
      field: "text",
      delta: `Hello from stub: ${content}`,
    },
    turnId,
  );
  complete({
    response: `Hello from stub: ${content}`,
    tokenCount: 12,
    usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
    toolCallCount: 0,
    duration: 3,
    resultType: "success",
  });
}

const stubAgentService = {
  createSession(params) {
    const sessionId = params.sessionId ?? `stub-session-${++idCounter}`;
    const session = ensureSession(sessionId);
    session.info = {
      sessionId,
      parentSessionId: params.parentSessionId,
      title: `stub ${sessionId}`,
      mode: params.mode ?? "build",
      status: "idle",
      model: params.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return Promise.resolve({
      protocol: { name: "acode", version: 1 },
      session: { ...session.info },
      settings: {},
      projection: {},
      runtime: {},
      messages: [],
    });
  },
  resumeSession(params) {
    const session = ensureSession(params.sessionId);
    return Promise.resolve({
      protocol: { name: "acode", version: 1 },
      session: {
        ...(session.info ?? { sessionId: params.sessionId, status: "idle", mode: "build" }),
      },
      settings: {},
      projection: {},
      runtime: {},
      messages: [],
    });
  },
  listSessions() {
    return Promise.resolve([...sessions.values()].map((s) => s.info).filter(Boolean));
  },
  sendPrompt(params) {
    const session = ensureSession(params.sessionId);
    // 驱动 turn 异步进行：sendPrompt 立即返回 accepted，事件经订阅/轮询面流出。
    // inputId 透传给 driveTurn 并在 turn 事件 payload 回显（对齐真实引擎，H1 归属依据）。
    void driveTurn(session, params.content, params.inputId);
    return Promise.resolve({ sessionId: params.sessionId, accepted: true, stateRevision: 1 });
  },
  readSessionEvents(params) {
    const session = ensureSession(params.sessionId);
    const afterSeq = params.afterSeq ?? 0;
    return Promise.resolve(session.events.filter((event) => event.seq > afterSeq));
  },
  setModel(params) {
    const session = ensureSession(params.sessionId);
    if (session.info) session.info.model = params.model;
    return Promise.resolve({
      protocol: { name: "acode", version: 1 },
      session: {
        ...(session.info ?? { sessionId: params.sessionId, status: "idle", mode: "build" }),
      },
      settings: {},
      projection: {},
      runtime: {},
      messages: [],
    });
  },
  compactSession() {
    return Promise.resolve({
      response: "compacted",
      snapshot: null,
      compact: { state: "accepted", inputId: `in-${++idCounter}` },
    });
  },
  onDynamicSessionEvent(params) {
    return (listener) => {
      const session = ensureSession(params.sessionId);
      session.listeners.add(listener);
      return { dispose: () => session.listeners.delete(listener) };
    };
  },
};

const stubTaskService = {
  respondPermission(params) {
    const session = sessions.get(params.taskId);
    if (session?.pendingPermission) session.pendingPermission(params.optionId);
    return Promise.resolve(true);
  },
  stopGeneration(params) {
    const session = sessions.get(params.taskId);
    if (session) {
      session.cancelled = true;
      session.cancelWaiter?.();
      session.pendingPermission?.("deny");
      // HANG_TURN 挂起闸门同样由 cancel 释放（H1 退化路径回归）。
      session.releaseGate?.();
    }
    return Promise.resolve();
  },
  releaseWorkspacePreparation() {
    return Promise.resolve();
  },
};

const stubModelSelectionService = {
  getView() {
    return Promise.resolve({
      revision: 1,
      providers: [
        {
          providerId: "stub-provider",
          providerName: "Stub Provider",
          models: [{ modelId: "stub-model" }, { modelId: "stub-model-pro" }],
        },
      ],
      preferredSelection: { providerId: "stub-provider", modelId: "stub-model" },
    });
  },
  onDidChange: () => ({ dispose: () => undefined }),
};

const stubFileService = {
  async readTextFile(params) {
    const content = await readFile(params.path, "utf8");
    const offset = params.offset ?? 0;
    const sliced = params.length
      ? content.slice(offset, offset + params.length)
      : content.slice(offset);
    return {
      path: params.path,
      content: sliced,
      offset,
      bytesRead: Buffer.byteLength(sliced, "utf8"),
      totalBytes: Buffer.byteLength(content, "utf8"),
      truncated: params.length !== undefined && offset + params.length < content.length,
      isBinary: false,
    };
  },
  async searchWorkspaceFiles(params) {
    const name = `${params.query}.ts`;
    return [
      {
        name,
        path: join(params.rootPath, name),
        relativePath: name,
        type: "file",
      },
    ];
  },
};

const services = new ServiceCollection();
services.register(IACodeAgentService, stubAgentService);
services.register(IACodeTaskService, stubTaskService);
services.register(IModelSelectionService, stubModelSelectionService);
services.register(IFileService, stubFileService);

createHarnessApiServer({
  transport: createStdioTransport(process.stdin, process.stdout),
  services,
  serverName: "acode-harness-stub",
  // 与生产 entry-harness 同一测试钩子：命中 seq 的事件帧跳写（SDK gap 检测验证）。
  ...(process.env.ACODE_HARNESS_TEST_DROP_EVENT_SEQ
    ? { testDropEventSeq: Number.parseInt(process.env.ACODE_HARNESS_TEST_DROP_EVENT_SEQ, 10) }
    : {}),
  log: (message) => console.error(`[stub] ${message}`),
});
