// ============================================================
// K8「ACP 宿主适配」测试（apps/acode-cli/specs/acp-host-adapter.md 验收 1-9）。
//
// 驱动方式（K7 测试先例的 in-process 变体）：ACP client 桩（内存 NDJSON 管道）
// ↔ AcpHostAdapter ↔ in-process harness 链路 ↔ createHarnessApiServer ↔
// 桩 ServiceCollection——协议、翻译桥、帧循环、映射、权限桥全部真实，
// 只有 services 层按 IACodeAgentService/IACodeTaskService/IModelSelectionService
// 公开签名提供确定性脚本化实现（与 packages/server/tests/
// harness-stub-services-entry.mjs 同款桩件哲学）。
//
// 验收 9（上游规范符合性）：ACP wire 形状按 spec 附录 A.2 快照手工断言
// （Agent Client Protocol v1 稳定版，schema 产物 1.24.1，2026-10-04 取自
// agentclientprotocol.com 与 zed-industries/agent-client-protocol）——
// NDJSON 分帧、jsonrpc:"2.0" 信封、session/update 的 sessionUpdate 判别、
// permission outcome 两形态。
// ============================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, "..", "..", "..");
const CLI_SRC = join(REPO_ROOT, "apps", "acode-cli", "packages", "cli", "src");

const { ServiceCollection, IACodeAgentService, IACodeTaskService, IModelSelectionService } =
  await import("../../../packages/services/src/index.ts");
const { AcpHostAdapter, ACP_TOOL_DENYLIST } = await import(
  "../packages/cli/src/acp/session-registry.ts"
);
const { createInProcessHarnessLink } = await import(
  "../packages/cli/src/acp/in-process-harness.ts"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ── ACP 内存管道（client 桩侧）──

function createMemoryAcpIo() {
  const inputLines = [];
  const inputWakeups = [];
  let inputEnded = false;
  return {
    input: {
      lines() {
        return {
          async *[Symbol.asyncIterator]() {
            while (true) {
              while (inputLines.length > 0) yield inputLines.shift();
              if (inputEnded) return;
              await new Promise((r) => inputWakeups.push(r));
            }
          },
        };
      },
    },
    output: {
      writeLine(line) {
        this.lines.push(line);
      },
      lines: [],
    },
    send(obj) {
      inputLines.push(JSON.stringify(obj));
      while (inputWakeups.length > 0) inputWakeups.shift()();
    },
    sendRaw(text) {
      inputLines.push(text);
      while (inputWakeups.length > 0) inputWakeups.shift()();
    },
    end() {
      inputEnded = true;
      while (inputWakeups.length > 0) inputWakeups.shift()();
    },
  };
}

/** ACP client 桩：请求关联 + 通知收集 + 权限请求应答。 */
class AcpTestClient {
  constructor(io) {
    this.io = io;
    this.nextId = 100;
    this.responses = new Map();
    this.updates = [];
    this.permissionRequests = [];
    this.frames = [];
    this.consumed = 0;
  }

  pump() {
    while (this.consumed < this.io.output.lines.length) {
      const line = this.io.output.lines[this.consumed];
      this.consumed += 1;
      const frame = JSON.parse(line);
      this.frames.push(frame);
      if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
        this.responses.set(frame.id, frame);
      } else if (frame.method === "session/update") {
        this.updates.push(frame.params);
      } else if (frame.method === "session/request_permission") {
        this.permissionRequests.push(frame);
      }
    }
  }

  async request(method, params) {
    const id = this.nextId++;
    this.io.send({ jsonrpc: "2.0", id, method, params });
    await waitFor(() => {
      this.pump();
      return this.responses.has(id);
    }, `response for ${method}(id=${id})`);
    return this.responses.get(id);
  }

  async notify(method, params) {
    this.io.send({ jsonrpc: "2.0", method, params });
    await sleep(10);
    this.pump();
  }

  async waitForUpdates(predicate, label, timeoutMs = 5000) {
    await waitFor(
      () => {
        this.pump();
        return predicate();
      },
      label,
      timeoutMs,
    );
  }

  respondPermission(requestId, outcome) {
    this.io.send({ jsonrpc: "2.0", id: requestId, result: { outcome } });
  }

  updatesFor(sessionId) {
    return this.updates.filter((params) => params.sessionId === sessionId);
  }
}

// ── 桩 services（K7 harness-stub-services-entry.mjs 的自包含精简版）──

function createStubServices() {
  const sessions = new Map();
  const calls = { createSession: [], sendPrompt: [], respondPermission: [], stopGeneration: [] };
  let idCounter = 0;

  const ensureSession = (sessionId) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        info: undefined,
        seq: 0,
        turnCounter: 0,
        listeners: new Set(),
        pendingPermission: null,
        cancelled: false,
        cancelWaiter: null,
      };
      sessions.set(sessionId, session);
    }
    return session;
  };

  const appendEvent = (session, type, payload, turnId) => {
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
    for (const listener of Array.from(session.listeners)) {
      listener({ type: "session.event", event: envelope });
    }
  };

  const driveTurn = async (session, content) => {
    session.turnCounter += 1;
    const turnId = `turn-${session.turnCounter}`;
    const complete = (payload) => appendEvent(session, "turn.completed", payload, turnId);
    appendEvent(session, "turn.started", { turnNumber: session.turnCounter, input: content }, turnId);

    // F7 测试用：永不终态且不占事件循环句柄（无 setTimeout）。
    if (content.includes("HANG")) {
      await new Promise(() => {});
      return;
    }

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
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "edit_once", kind: "edit_once", name: "Edit once" },
            { optionId: "deny", kind: "deny", name: "Deny" },
          ],
        },
        turnId,
      );
      const optionId = await new Promise((r) => {
        session.pendingPermission = r;
      });
      session.pendingPermission = null;
      if (session.cancelled || optionId === "deny") {
        complete({ response: "", tokenCount: 0, duration: 5, resultType: "cancelled" });
        return;
      }
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "allowed path" }, turnId);
      complete({ response: "allowed path", tokenCount: 8, duration: 5, resultType: "success" });
      return;
    }

    if (content.includes("SLOWDELTA")) {
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "A1" }, turnId);
      await sleep(30);
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "A2" }, turnId);
      complete({ response: "A1A2", tokenCount: 2, duration: 5, resultType: "success" });
      return;
    }

    if (content.includes("SLOW")) {
      await new Promise((r) => {
        const timer = setTimeout(r, 5_000);
        session.cancelWaiter = () => {
          clearTimeout(timer);
          r();
        };
      });
      complete({
        response: "",
        tokenCount: 0,
        duration: 5,
        resultType: session.cancelled ? "cancelled" : "success",
      });
      return;
    }

    if (content.includes("TOOLCALL")) {
      appendEvent(
        session,
        "tool.updated",
        { kind: "started", toolCallId: "tc-1", toolName: "Bash", description: "run tests" },
        turnId,
      );
      appendEvent(
        session,
        "tool.updated",
        { kind: "result", toolCallId: "tc-1", toolName: "Bash", duration: 12 },
        turnId,
      );
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "tool done" }, turnId);
      complete({ response: "tool done", tokenCount: 5, duration: 5, resultType: "success" });
      return;
    }

    if (content.includes("TURN_ERROR")) {
      appendEvent(
        session,
        "turn.failed",
        { error: { message: "provider rate limited", code: "rate_limited" } },
        turnId,
      );
      return;
    }

    if (content.includes("MULTI")) {
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "Hello " }, turnId);
      appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: "world" }, turnId);
      complete({ response: "Hello world", tokenCount: 2, duration: 5, resultType: "success" });
      return;
    }

    appendEvent(session, "part.delta", { messageId: "m-1", field: "text", delta: `Hello from stub: ${content}` }, turnId);
    complete({ response: `Hello from stub: ${content}`, tokenCount: 12, duration: 3, resultType: "success" });
  };

  const stubAgentService = {
    createSession(params) {
      calls.createSession.push(params);
      const sessionId = params.sessionId ?? `stub-session-${++idCounter}`;
      const session = ensureSession(sessionId);
      session.info = {
        sessionId,
        mode: params.mode ?? "build",
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return Promise.resolve({
        protocol: { name: "acode", version: 1 },
        session: { sessionId },
        settings: {},
        projection: {},
        runtime: {},
        messages: [],
      });
    },
    sendPrompt(params) {
      calls.sendPrompt.push(params);
      const session = ensureSession(params.sessionId);
      void driveTurn(session, params.content);
      return Promise.resolve({ sessionId: params.sessionId, accepted: true, stateRevision: 1 });
    },
    setModel(params) {
      const session = ensureSession(params.sessionId);
      if (session.info) session.info.model = params.model;
      return Promise.resolve({
        protocol: { name: "acode", version: 1 },
        session: { sessionId: params.sessionId },
        settings: {},
        projection: {},
        runtime: {},
        messages: [],
      });
    },
    onDynamicSessionEvent(params) {
      // F3 测试用：注入一次订阅失败（session/new 应直接失败并回收会话）。
      if (stub.failNextSubscribe) {
        stub.failNextSubscribe = false;
        throw new Error("stub subscribe failure (injected)");
      }
      return (listener) => {
        const session = ensureSession(params.sessionId);
        session.listeners.add(listener);
        return { dispose: () => session.listeners.delete(listener) };
      };
    },
  };

  const stubTaskService = {
    respondPermission(params) {
      calls.respondPermission.push(params);
      const session = sessions.get(params.taskId);
      if (session?.pendingPermission) session.pendingPermission(params.optionId);
      return Promise.resolve(true);
    },
    stopGeneration(params) {
      calls.stopGeneration.push(params);
      const session = sessions.get(params.taskId);
      if (session) {
        session.cancelled = true;
        session.cancelWaiter?.();
        session.pendingPermission?.("deny");
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

  const services = new ServiceCollection();
  services.register(IACodeAgentService, stubAgentService);
  services.register(IACodeTaskService, stubTaskService);
  services.register(IModelSelectionService, stubModelSelectionService);
  const stub = {
    services,
    calls,
    sessions,
    /** F3 测试注入：下一次 onDynamicSessionEvent（subscribe_events）抛错。 */
    failNextSubscribe: false,
    /** 直接向引擎侧会话注入事件（F2/F11 迟到终态、重复 turn_started 构造）。 */
    emit(sessionId, type, payload, turnId) {
      appendEvent(ensureSession(sessionId), type, payload, turnId);
    },
  };
  return stub;
}

// ── 适配器装配（每用例一套）──

async function startAdapter({ permissionTimeoutMs, promptTimeoutMs } = {}) {
  const io = createMemoryAcpIo();
  const stub = createStubServices();
  const allowedRoot = mkdtempSync(join(tmpdir(), "acode-acp-test-"));
  const link = await createInProcessHarnessLink({ services: stub.services });
  const adapter = new AcpHostAdapter({
    io,
    link,
    allowedRoot,
    agentVersion: "test",
    ...(permissionTimeoutMs ? { permissionTimeoutMs } : {}),
    ...(promptTimeoutMs ? { promptTimeoutMs } : {}),
  });
  const client = new AcpTestClient(io);
  const runPromise = adapter.run();
  return { io, stub, allowedRoot, link, adapter, client, runPromise };
}

async function stopAdapter(harness_) {
  harness_.io.end();
  await harness_.runPromise;
}

const initializeParams = (extra) => ({
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  clientInfo: { name: "test-client", version: "0.0.0" },
  ...(extra ?? {}),
});

async function newSession(client, cwd) {
  const response = await client.request("session/new", { cwd, mcpServers: [] });
  assert.equal(response.error, undefined, `session/new failed: ${JSON.stringify(response)}`);
  return response.result.sessionId;
}

// ============================================================
// 验收 1：握手能力声明（含/不含 fs 两形态钉住）+ 非 ACP 输入协议错误不崩
// ============================================================

test("验收1: initialize 能力声明（fs 两形态）且非 ACP 输入回协议错误不崩进程", async () => {
  const h = await startAdapter();
  try {
    // 非 ACP 输入在 initialize 之前/之后都不崩进程：先打一行垃圾。
    h.io.sendRaw("this is not json {{{");
    await h.client.waitForUpdates(() => h.client.frames.length > 0, "parse error frame");
    const parseError = h.client.frames[0];
    assert.equal(parseError.jsonrpc, "2.0");
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700, "非法行应回 -32700 Parse error");

    // 形态 A：client 声明 fs 能力。
    const withFs = await h.client.request("initialize", initializeParams());
    assert.equal(withFs.result.protocolVersion, 1);
    const caps = withFs.result.agentCapabilities;
    assert.equal(caps.loadSession, false);
    assert.deepEqual(caps.promptCapabilities, { image: false, audio: false, embeddedContext: false });
    assert.deepEqual(caps.mcpCapabilities, { http: false, sse: false });
    assert.deepEqual(caps.sessionCapabilities, {});
    assert.deepEqual(withFs.result.authMethods, []);
    assert.equal(withFs.result.agentInfo.name, "acode");
    assert.equal(withFs.result.agentInfo.version, "test");
    // agent 侧没有 fs 能力声明（fs 是 client 能力；适配层不发 fs/read_text_file）。
    assert.equal("fs" in caps, false);

    // 形态 B：不声明任何能力——握手结果一致。
    const bare = await h.client.request("initialize", { protocolVersion: 1 });
    assert.deepEqual(bare.result.agentCapabilities, caps);

    // initialize 之前的其他方法被拒（帧循环顺序约束）。
    const h2 = await startAdapter();
    try {
      const early = await h2.client.request("session/new", { cwd: h2.allowedRoot, mcpServers: [] });
      assert.equal(early.error.code, -32600);
      await h2.client.request("initialize", { protocolVersion: 1 });
      const ok = await h2.client.request("session/new", { cwd: h2.allowedRoot, mcpServers: [] });
      assert.equal(ok.error, undefined, "initialize 之后应可建会话");
    } finally {
      await stopAdapter(h2);
    }

    // 未实现方法 → -32601（能力未声明即不存在）。
    const unknown = await h.client.request("session/load", { sessionId: "x" });
    assert.equal(unknown.error.code, -32601);

    // 全程不得出现 agent→client 的 fs 请求（fs 不开，R2 表末行）。
    await sleep(50);
    h.client.pump();
    assert.equal(
      h.client.frames.some((frame) => typeof frame.method === "string" && frame.method.startsWith("fs/")),
      false,
      "适配层不得发送 fs/* 请求",
    );
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 2：会话生命周期与流 chunk 顺序（首块 reset、append 链）+ 多会话不串流
// ============================================================

test("验收2: 生命周期与流 chunk 顺序——首块新 messageId、append 同 messageId、turn 间 reset", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);

    const promptPromise = h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "MULTI" }],
    });
    await h.client.waitForUpdates(
      () => h.client.updatesFor(sessionId).length >= 2,
      "两个 agent_message_chunk",
    );
    const response = await promptPromise;
    assert.deepEqual(response.result, { stopReason: "end_turn" });

    const chunks = h.client.updatesFor(sessionId).map((params) => params.update);
    assert.equal(chunks.length, 2);
    // wire 形状（验收 9 快照）：sessionUpdate 判别 + text content。
    for (const chunk of chunks) {
      assert.equal(chunk.sessionUpdate, "agent_message_chunk");
      assert.equal(chunk.content.type, "text");
    }
    assert.equal(chunks[0].content.text, "Hello ");
    assert.equal(chunks[1].content.text, "world");
    // 同 turn 内 append：messageId 一致；reset 标记：acp-<turn>- 前缀。
    assert.equal(chunks[0].messageId, chunks[1].messageId);
    assert.match(chunks[0].messageId, /^acp-\d+-m-1$/);

    // 第二个 prompt：引擎重发同一 messageId（m-1）——turn 边界 reset 后 ACP
    // messageId 必须变化（客户端开新消息，不追加到旧消息）。
    await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "MULTI again" }],
    });
    await h.client.waitForUpdates(
      () => h.client.updatesFor(sessionId).length >= 4,
      "第二轮 chunk",
    );
    const secondRound = h.client.updatesFor(sessionId).slice(2).map((params) => params.update);
    assert.equal(secondRound.length, 2);
    const secondId = secondRound[0].messageId;
    assert.equal(secondId, secondRound[1].messageId);
    assert.notEqual(secondId, chunks[0].messageId, "turn 边界必须 reset messageId");
  } finally {
    await stopAdapter(h);
  }
});

test("验收2: 多会话并行互不串流（双 session 交错 delta 断言）+ 并发上限 8", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionA = await newSession(h.client, h.allowedRoot);
    const sessionB = await newSession(h.client, h.allowedRoot);

    // A 的 turn 中间有 30ms 间隙；间隙内 B 完成一整个 turn——输出流必须交错，
    // 且每个 sessionId 只收到自己的 chunk。
    const promptA = h.client.request("session/prompt", {
      sessionId: sessionA,
      prompt: [{ type: "text", text: "SLOWDELTA" }],
    });
    await sleep(10);
    const promptB = h.client.request("session/prompt", {
      sessionId: sessionB,
      prompt: [{ type: "text", text: "quick" }],
    });
    await promptA;
    await promptB;

    await h.client.waitForUpdates(() => h.client.updatesFor(sessionA).length >= 2, "A 两个 chunk");
    const aTexts = h.client.updatesFor(sessionA).map((p) => p.update.content.text);
    const bTexts = h.client.updatesFor(sessionB).map((p) => p.update.content.text);
    assert.deepEqual(aTexts, ["A1", "A2"]);
    assert.deepEqual(bTexts, ["Hello from stub: quick"]);
    // 交错断言：B 的 chunk 落在 A 的两个 chunk 之间。
    const ordered = h.client.updates.map((p) => p.sessionId);
    const a1 = ordered.indexOf(sessionA);
    const bIndex = ordered.indexOf(sessionB);
    const a2 = ordered.indexOf(sessionA, a1 + 1);
    assert.ok(a1 !== -1 && bIndex !== -1 && a2 !== -1, "应有三个 chunk 帧");
    assert.ok(a1 < bIndex && bIndex < a2, `chunk 应交错（实际顺序 ${ordered.join(",")}）`);

    // 并发上限（ACP_MAX_CONCURRENT_SESSIONS=8）：第 9 个会话拒绝。
    const more = [];
    for (let i = 0; i < 6; i += 1) more.push(await newSession(h.client, h.allowedRoot));
    assert.equal(more.length, 6);
    const ninth = await h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] });
    assert.equal(ninth.error.code, -32052, "超出 8 会话应拒绝（F9：自用段 -32052）");

    // 未知会话 → ACP 资源不存在保留段。
    const ghost = await h.client.request("session/prompt", {
      sessionId: "no-such-session",
      prompt: [{ type: "text", text: "hi" }],
    });
    assert.equal(ghost.error.code, -32002);
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 3：工具事件结构（ToolCallStarted/Finished → tool_call 更新组）
// ============================================================

test("验收3: 工具事件映射 tool_call/tool_call_update 结构完整", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    const response = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "TOOLCALL" }],
    });
    assert.deepEqual(response.result, { stopReason: "end_turn" });

    const updates = h.client.updatesFor(sessionId).map((p) => p.update);
    const started = updates.find((u) => u.sessionUpdate === "tool_call");
    assert.ok(started, "应有 tool_call 更新");
    assert.equal(started.toolCallId, "tc-1");
    assert.equal(started.title, "run tests");
    assert.equal(started.name, "Bash");
    assert.equal(started.kind, "execute");
    assert.equal(started.status, "in_progress");

    const finished = updates.find((u) => u.sessionUpdate === "tool_call_update");
    assert.ok(finished, "应有 tool_call_update 更新");
    assert.equal(finished.toolCallId, "tc-1");
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.content, [{ type: "text", text: "completed" }]);

    // 更新顺序：tool_call 在 tool_call_update 之前，chunk 最后。
    const kinds = updates.map((u) => u.sessionUpdate);
    assert.ok(kinds.indexOf("tool_call") < kinds.indexOf("tool_call_update"));
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 4：权限桥三路——allow 继续 / reject 回执 / 无响应超时按拒绝
// ============================================================

test("验收4a: 权限桥 allow 路径——选项折叠正确、allow 后引擎继续", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    h.client.io.send({
      jsonrpc: "2.0",
      id: 500,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "NEEDS_PERMISSION" }] },
    });
    await h.client.waitForUpdates(() => h.client.permissionRequests.length > 0, "权限请求");
    const request = h.client.permissionRequests[0];
    assert.equal(request.params.sessionId, sessionId);
    assert.equal(request.params.toolCall.toolCallId.startsWith("tc-"), true);
    assert.equal(request.params.toolCall.status, "pending");
    // 档位折叠（附录 A.3）：allow_once 保留；edit_once（映射不到）→ allow_once（更严侧）；
    // deny（映射不到）→ reject_once。
    assert.deepEqual(
      request.params.options.map((o) => [o.optionId, o.kind]),
      [
        ["allow_once", "allow_once"],
        ["edit_once", "allow_once"],
        ["deny", "reject_once"],
      ],
    );

    h.client.respondPermission(request.id, { outcome: "selected", optionId: "allow_once" });
    await h.client.waitForUpdates(
      () => h.client.responses.has(500),
      "prompt 应答（allow 后 turn 完成）",
    );
    assert.deepEqual(h.client.responses.get(500).result, { stopReason: "end_turn" });
    // 引擎收到的是引擎侧 optionId（双向映射还原）。
    assert.equal(h.stub.calls.respondPermission.length, 1);
    assert.equal(h.stub.calls.respondPermission[0].optionId, "allow_once");
    const texts = h.client.updatesFor(sessionId).map((p) =>
      p.update.sessionUpdate === "agent_message_chunk" ? p.update.content.text : "",
    );
    assert.ok(texts.includes("allowed path"), "allow 后应有 delta");
  } finally {
    await stopAdapter(h);
  }
});

test("验收4b: 权限桥 reject 路径——回执拒绝、未知 optionId 折叠到拒绝", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    h.client.io.send({
      jsonrpc: "2.0",
      id: 501,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "NEEDS_PERMISSION" }] },
    });
    await h.client.waitForUpdates(() => h.client.permissionRequests.length > 0, "权限请求");
    const request = h.client.permissionRequests[0];
    // 未知 optionId：无法还原引擎档位 → 按 deny（更严侧）回执。
    h.client.respondPermission(request.id, { outcome: "selected", optionId: "bogus-option" });
    await h.client.waitForUpdates(() => h.client.responses.has(501), "prompt 应答（拒绝收口）");
    assert.deepEqual(h.client.responses.get(501).result, { stopReason: "cancelled" });
    assert.equal(h.stub.calls.respondPermission[0].optionId, "deny");
  } finally {
    await stopAdapter(h);
  }
});

test("验收4c: 权限桥无响应——超时按拒绝（fail-closed），绝不自动 allow", async () => {
  const h = await startAdapter({ permissionTimeoutMs: 120 });
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    h.client.io.send({
      jsonrpc: "2.0",
      id: 502,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "NEEDS_PERMISSION" }] },
    });
    // client 完全不应答（无人值守场景）。
    await h.client.waitForUpdates(
      () => h.client.responses.has(502),
      "超时后 prompt 以 cancelled 收口",
      3000,
    );
    assert.deepEqual(h.client.responses.get(502).result, { stopReason: "cancelled" });
    assert.equal(h.stub.calls.respondPermission.length, 1);
    assert.equal(h.stub.calls.respondPermission[0].optionId, "deny", "超时必须回执 deny，不得自动 allow");
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 5：cancel——进行中取消后可继续新 prompt
// ============================================================

test("验收5: session/cancel 转发引擎 cancel_turn，取消后可续新 prompt", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    h.client.io.send({
      jsonrpc: "2.0",
      id: 600,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "SLOW" }] },
    });
    await sleep(30);
    await h.client.notify("session/cancel", { sessionId });
    await h.client.waitForUpdates(() => h.client.responses.has(600), "取消后 prompt 收口");
    assert.deepEqual(h.client.responses.get(600).result, { stopReason: "cancelled" });
    assert.equal(h.stub.calls.stopGeneration.length, 1);
    assert.equal(h.stub.calls.stopGeneration[0].taskId, sessionId);

    // 取消后会话可继续新 prompt。
    const next = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "after cancel" }],
    });
    assert.deepEqual(next.result, { stopReason: "end_turn" });
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 6：错误映射——引擎错误无内部栈泄漏 + cwd 越界拒绝
// ============================================================

test("验收6: 引擎错误映射 JSON-RPC internal + 人话 data 无栈泄漏；cwd 越界拒绝", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());

    // cwd 边界（R3）。
    const outside = resolve(h.allowedRoot, "..", "..", "..", "..");
    const rejected = await h.client.request("session/new", { cwd: outside, mcpServers: [] });
    assert.equal(rejected.error.code, -32602);
    assert.match(rejected.error.message, /outside the agent workspace/);

    const relative = await h.client.request("session/new", { cwd: "relative/path", mcpServers: [] });
    assert.equal(relative.error.code, -32602);
    assert.match(relative.error.message, /absolute/);

    // 引擎 turn 错误 → -32603 + data.engineMessage（人话），无内部栈。
    const sessionId = await newSession(h.client, h.allowedRoot);
    const failed = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "TURN_ERROR" }],
    });
    assert.equal(failed.error.code, -32603);
    assert.equal(failed.error.data.engineMessage, "provider rate limited");
    const serialized = JSON.stringify(failed);
    assert.equal(serialized.includes("stack"), false, "错误响应不得包含 stack");
    assert.equal(/\bat \S+\(\S+:\d+:\d+\)/.test(serialized), false, "错误响应不得包含栈帧");

    // prompt 块类型校验：未声明能力的内容块 → -32602。
    const badBlock = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "image", data: "..." }],
    });
    assert.equal(badBlock.error.code, -32602);

    // 同会话并发 prompt 冲突 → 协议保留段错误。
    h.client.io.send({
      jsonrpc: "2.0",
      id: 700,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "SLOW" }] },
    });
    await sleep(20);
    const concurrent = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "second" }],
    });
    assert.equal(concurrent.error.code, -32052);
    await h.client.notify("session/cancel", { sessionId });
    await h.client.waitForUpdates(() => h.client.responses.has(700), "挂起 prompt 收口");
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 7：工具裁剪——ACP 会话工具面不含 AskUserQuestion 类（创建时禁用）
// ============================================================

test("验收7: ACP 会话创建携带 UI 交互工具禁用清单（toolDenylist 替代路径）", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    assert.ok(sessionId, "会话应创建成功");
    assert.equal(h.stub.calls.createSession.length, 1);
    const params = h.stub.calls.createSession[0];
    assert.deepEqual(params.toolDenylist, [...ACP_TOOL_DENYLIST]);
    assert.ok(params.toolDenylist.includes("AskUserQuestion"), "必须禁用 AskUserQuestion");
    assert.ok(params.toolDenylist.includes("Open"), "必须禁用 Open（userInteraction 副作用面）");

    // 模型选择面（R2：get_models/set_model 经 config option）。
    const setModel = await h.client.request("session/set_config_option", {
      sessionId,
      configId: "acode.model",
      value: "stub-provider/stub-model-pro",
    });
    assert.equal(setModel.error, undefined);
    const modelCalls = h.stub.sessions.get(sessionId)?.info?.model;
    assert.deepEqual(modelCalls, { providerId: "stub-provider", modelId: "stub-model-pro" });
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 2 补充：session/new 返回 configOptions（模型下拉，源自 get_models）
// ============================================================

test("验收2/7: session/new 返回模型 configOptions（get_models 投影）", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const response = await h.client.request("session/new", {
      cwd: h.allowedRoot,
      mcpServers: [],
    });
    const options = response.result.configOptions;
    assert.equal(options.length, 1);
    assert.equal(options[0].id, "acode.model");
    assert.equal(options[0].type, "select");
    assert.equal(options[0].currentValue, "stub-provider/stub-model");
    assert.deepEqual(
      options[0].options.map((o) => o.id),
      ["stub-provider/stub-model", "stub-provider/stub-model-pro"],
    );
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// 验收 8：边界红线——适配层 import 面 + 零凭据引用 + acode-protocol v4 零 diff
// ============================================================

test("验收8: 适配层源码只 import harness-sdk/server 公开面，零 services/runtime 内部模块", async () => {
  const acpDir = join(CLI_SRC, "acp");
  const files = [
    ...readdirSync(acpDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => join(acpDir, name)),
    join(CLI_SRC, "acp-command.ts"),
  ];
  assert.ok(files.length >= 5, `应至少覆盖 5 个适配层源文件（实际 ${files.length}）`);

  // CLI 自身接线面（非引擎访问）与 K7 公开面。
  const allowed = new Set([
    "@acode/harness-sdk",
    "@acode/server/harness",
    "@acode/server/harness-inprocess",
    "@acode/shared/harness-api",
    "@acode/shared-types",
    "@acode/provider-node",
  ]);
  const importPattern = /(?:^|\n)import\s+[^;]*?from\s+["']([^"']+)["'];/g;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      assert.ok(
        allowed.has(specifier),
        `${file} 引用了非允许模块 '${specifier}'（只允许 harness-sdk/server 公开面与 CLI 接线面）`,
      );
    }
    // 动态 import 同样受限。
    for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      assert.ok(allowed.has(specifier), `${file} 动态引用了非允许模块 '${specifier}'`);
    }
  }

  // 引擎内部面零命中（services/runtime 等）。
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const forbidden = source.match(/@acode\/(services|core|bootstrap|adapters|contracts|rpc|client|tui)[/\s"']/);
    assert.equal(forbidden, null, `${file} 不得引用 services/runtime 内部模块`);
  }
});

test("验收8: 适配层零凭据引用", async () => {
  const acpDir = join(CLI_SRC, "acp");
  const files = [
    ...readdirSync(acpDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => join(acpDir, name)),
    join(CLI_SRC, "acp-command.ts"),
  ];
  const credentialPattern = /credential|api[-_]?key|password|passphrase|secret|bearer|access[-_]?token|refresh[-_]?token/i;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const hit = source.match(credentialPattern);
    assert.equal(hit, null, `${file} 出现凭据相关引用 '${hit?.[0]}'（适配层不处理凭据，R3）`);
  }
});

test("验收8: acode-protocol v4 与 Desktop/Web 零 diff；命令分发只一处注册", async () => {
  const git = (args) =>
    execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const protocolDiff = git(["diff", "--name-only", "--", "packages/shared/src/acode-protocol"]);
  assert.equal(protocolDiff, "", `acode-protocol v4 必须零 diff（实际：${protocolDiff}）`);
  const protocolStatus = git(["status", "--porcelain", "--", "packages/shared/src/acode-protocol"]);
  assert.equal(protocolStatus, "", `acode-protocol v4 不得有未跟踪变更（实际：${protocolStatus}）`);

  const runSource = readFileSync(join(CLI_SRC, "run.ts"), "utf8");
  assert.equal((runSource.match(/runAcpCommand/g) ?? []).length, 2, "run.ts 应恰好一处 import + 一处调用注册");
  assert.match(runSource, /case "acp":/);
});

// ============================================================
// 验收 9：上游规范符合性——wire 形状按附录 A.2 快照结构校验
// ============================================================

test("验收9: 全部出向帧符合 ACP v1 快照（jsonrpc 信封/方法名/update 判别）", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "TOOLCALL" }],
    });
    await h.client.waitForUpdates(
      () => h.client.updatesFor(sessionId).some((p) => p.update.sessionUpdate === "tool_call_update"),
      "工具事件",
    );
    h.client.pump();

    const knownAgentMethods = new Set([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
      "session/set_config_option",
      "session/load",
      "session/set_mode",
    ]);
    const knownClientMethods = new Set(["session/update", "session/request_permission"]);
    const knownUpdateVariants = new Set([
      "user_message_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
    ]);
    for (const line of h.client.io.output.lines) {
      const frame = JSON.parse(line);
      assert.equal(frame.jsonrpc, "2.0", "每帧必须带 jsonrpc 2.0 信封");
      assert.equal(line.includes("\n"), false, "NDJSON 单行铁律");
      if (frame.method !== undefined) {
        assert.ok(
          knownClientMethods.has(frame.method),
          `agent→client 方法 '${frame.method}' 必须在 ACP v1 client 方法面内`,
        );
        if (frame.method === "session/update") {
          assert.ok(typeof frame.params.sessionId === "string");
          assert.ok(knownUpdateVariants.has(frame.params.update.sessionUpdate));
        }
      } else {
        assert.ok("result" in frame || "error" in frame, "非通知帧必须是应答");
      }
      // 未越权发送 client→agent 方法（initialize 等不应由 agent 发出）。
      if (frame.method !== undefined) assert.ok(!knownAgentMethods.has(frame.method));
    }
  } finally {
    await stopAdapter(h);
  }
});

// ============================================================
// K8 对抗复核回归（F1-F8/F11）
// ============================================================

// ── F1：入口断裂——`acp` 子命令必须能物化 provider runtime env ──

test("F1: argv=[acp] 物化 provider runtime env；runAcpCommand 通过第一道检查", async () => {
  const { prepareCliProviderRuntimeEnv } = await import(
    "../packages/cli/src/provider-runtime-env.ts"
  );
  const { runAcpCommand } = await import("../packages/cli/src/acp-command.ts");

  // 最简启动测试形态（任务指定）：直接断言 prepareCliProviderRuntimeEnv
  // 对 argv:["acp"] 返回含 ACODE_BUILTIN_PROVIDER_CONFIG_FILE 的非空对象。
  // entrypoint 指向 CLI 源文件——第二候选路径恰解析到仓库随包配置。
  const dataBaseDir = mkdtempSync(join(tmpdir(), "acode-f1-data-"));
  const env = await prepareCliProviderRuntimeEnv({
    argv: ["acp"],
    env: {},
    dataBaseDir,
    entrypoint: join(CLI_SRC, "main.ts"),
    sea: undefined,
  });
  assert.equal(Object.keys(env).length > 0, true, "argv=[acp] 不得返回空 env（入口断裂根因）");
  assert.equal(
    typeof env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE === "string" &&
      env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE.length > 0,
    true,
    "必须物化 ACODE_BUILTIN_PROVIDER_CONFIG_FILE",
  );
  assert.equal(
    typeof env.ACODE_PERSONAL_PROVIDER_CONFIG_FILE === "string",
    true,
    "个人 provider 配置路径应一并就位",
  );

  // runAcpCommand 在该 env 下通过第一道检查（env gate）并完整走通装配：
  // stdin 立即结束 → 帧循环完结 → 返回 0（services 懒构造，不拉起完整服务面）。
  const stderrText = [];
  const stdin = new PassThrough();
  stdin.end(); // 真实流形态（createStreamLineSource 需要 .on），无输入即结束。
  const ctx = {
    argv: ["acp"],
    stderr: { write: (text) => stderrText.push(text) },
    stdin,
    stdout: { writeLine() {} },
  };
  const allowedRoot = mkdtempSync(join(tmpdir(), "acode-f1-root-"));
  const deps = { cwd: () => allowedRoot };
  const previous = process.env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE;
  process.env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE = env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE;
  try {
    const exitCode = await runAcpCommand(ctx, deps, "test");
    assert.equal(exitCode, 0, "env 就位时 runAcpCommand 应正常收口（返回 0）");
    assert.equal(
      stderrText.join("").includes("is not set"),
      false,
      "不得再命中第一道检查的失败分支",
    );
  } finally {
    if (previous === undefined) delete process.env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE;
    else process.env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE = previous;
  }

  // 负路径钉住 gate 文案：env 未物化 → 第一道检查失败（可读错误，返回 1）。
  delete process.env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE;
  stderrText.length = 0;
  const exitNegative = await runAcpCommand(ctx, deps, "test");
  assert.equal(exitNegative, 1);
  assert.match(stderrText.join(""), /ACODE_BUILTIN_PROVIDER_CONFIG_FILE is not set/);
});

// ── F2：settlePrompt 归属过滤（迟到旧终态不误释放 busy 锁）──

test("F2: 旧 turn 迟到终态 + 未知 turn 终态不误结算新 prompt（K7 H1 同款纪律）", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    // 第一轮 prompt 正常完成（turn-1 已终态）。
    await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "first" }],
    });

    // 第二轮 prompt 挂起（SLOW：5s 后才终态；turn-2 已进入 live 窗口）。
    h.client.io.send({
      jsonrpc: "2.0",
      id: 800,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "SLOW" }] },
    });
    await sleep(50);

    // 迟到重复终态（turn-1，prompt 之前已在途的旧 turn）与未知 turn 终态
    // （turn-999，从未 TurnStarted）都必须被归属过滤丢弃。
    h.stub.emit(
      sessionId,
      "turn.completed",
      { response: "late", tokenCount: 1, duration: 1, resultType: "success" },
      "turn-1",
    );
    h.stub.emit(
      sessionId,
      "turn.completed",
      { response: "ghost", tokenCount: 1, duration: 1, resultType: "success" },
      "turn-999",
    );
    await sleep(50);
    h.client.pump();
    assert.equal(
      h.client.responses.has(800),
      false,
      "迟到/未知终态不得结算 prompt 800（busy 锁不得误释放）",
    );

    // cancel 收口（F3 即时结算）——prompt 800 以 cancelled 应答。
    await h.client.notify("session/cancel", { sessionId });
    await h.client.waitForUpdates(() => h.client.responses.has(800), "cancel 后收口");
    assert.deepEqual(h.client.responses.get(800).result, { stopReason: "cancelled" });

    // busy 锁确已释放：新 prompt 立即可用。
    const next = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "after" }],
    });
    assert.deepEqual(next.result, { stopReason: "end_turn" });
  } finally {
    await stopAdapter(h);
  }
});

// ── F3：无超时挂死——prompt 终态超时 + subscribe_events 失败即失败 ──

test("F3: prompt 无终态超时——-32603 错误回执 + busy 锁释放", async () => {
  const h = await startAdapter({ promptTimeoutMs: 80 });
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    const response = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW" }],
    });
    assert.equal(response.error.code, -32603, "超时应回 internal 错误");
    assert.match(response.error.message, /timed out after 80ms/);
    // 锁已释放：同会话可立即发新 prompt。
    const next = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "quick" }],
    });
    assert.deepEqual(next.result, { stopReason: "end_turn" });
    // 清掉桩侧 5s 等待器，避免测试进程拖尾。
    await h.client.notify("session/cancel", { sessionId });
  } finally {
    await stopAdapter(h);
  }
});

test("F3: subscribe_events 失败 → session/new 直接失败（不返回哑会话）且名额不泄漏", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    h.stub.failNextSubscribe = true;
    const failed = await h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] });
    assert.equal(failed.error.code, -32603);
    assert.match(failed.error.message, /event subscription failed/);
    // 失败会话已回收：仍可开满 8 个会话（注册表无泄漏）。
    for (let i = 0; i < 8; i += 1) {
      const ok = await h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] });
      assert.equal(ok.error, undefined, `第 ${i + 1} 个会话应成功`);
    }
    const ninth = await h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] });
    assert.equal(ninth.error.code, -32052);
  } finally {
    await stopAdapter(h);
  }
});

// ── F4：ACP stdin 行长上限（单一出处 HARNESS_MAX_LINE_LENGTH）──

test("F4: 超长行断链——onOversize 回调后行源完结，常规行不受影响", async () => {
  const { createStreamLineSource, ACP_LINE_TOO_LONG } = await import(
    "../packages/cli/src/acp/protocol.ts"
  );
  const { HARNESS_MAX_LINE_LENGTH } = await import(
    "../../../packages/shared/src/harness-api/index.ts"
  );
  assert.equal(ACP_LINE_TOO_LONG, -32053, "F9：line_too_long 占自用段 -32053");

  const stream = new PassThrough();
  const oversize = [];
  const source = createStreamLineSource(stream, {
    onOversize: (info) => oversize.push(info),
  });
  const lines = [];
  const drained = (async () => {
    for await (const line of source.lines()) lines.push(line);
  })();
  stream.write('{"jsonrpc":"2.0","id":1,"method":"x"}\n');
  stream.write(`${"x".repeat(HARNESS_MAX_LINE_LENGTH + 1)}\n`);
  stream.write('{"jsonrpc":"2.0","id":2,"method":"y"}\n');
  stream.end();
  await drained;
  assert.equal(lines.length, 1, "超限前的常规行应正常产出");
  assert.equal(oversize.length, 1, "超限恰好触发一次回调");
  assert.ok(oversize[0].lineLength > HARNESS_MAX_LINE_LENGTH);
});

// ── F5：console 边界时机——main.ts 的 acp 分支在 import run 之前 ──

test("F5: main.ts 为 acp 形态在加载 run.js 前安装 console 边界（源码钉子）", async () => {
  const mainSource = readFileSync(join(CLI_SRC, "main.ts"), "utf8");
  const boundaryIndex = mainSource.indexOf("installStderrConsoleBoundary(process.stderr)");
  // 钉真实加载语句（不能用裸子串——注释里也会提到 import("./run.js")）。
  const importRunIndex = mainSource.indexOf('const { run } = await import("./run.js")');
  assert.ok(boundaryIndex > 0, "main.ts 应安装 stderr console 边界");
  assert.ok(
    importRunIndex > boundaryIndex,
    "边界安装必须先于 run.js 动态加载（三方依赖求值期即受保护）",
  );
  assert.match(mainSource, /isAcpInvocation\(argv\)/, "acp 形态识别应进入边界条件");
  assert.match(mainSource, /isProtocol \|\| isTui \|\| isAcp/, "边界条件应含 acp");
  // acp-command.ts 内的安装保留为幂等兜底。
  const commandSource = readFileSync(join(CLI_SRC, "acp-command.ts"), "utf8");
  assert.match(commandSource, /installStderrConsoleBoundary\(ctx\.stderr\)/);
});

// ── F6：会话零回收 + check-then-set 竞态——原子登记恰一过 + closeSession 复用 ──

test("F6: 并发 session/new 恰一过（原子登记）+ closeSession 后可再开", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    // 先占 7 个名额（软预检对两并发都放行）。
    for (let i = 0; i < 7; i += 1) await newSession(h.client, h.allowedRoot);
    const [a, b] = await Promise.all([
      h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] }),
      h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] }),
    ]);
    const rejected = [a, b].filter((r) => r.error);
    const accepted = [a, b].filter((r) => !r.error);
    assert.equal(rejected.length, 1, `并发两请求应恰一过（实际 ${JSON.stringify([a.error?.code, b.error?.code])}）`);
    assert.equal(accepted.length, 1);
    assert.equal(rejected[0].error.code, -32052);
    assert.match(
      rejected[0].error.message,
      /reuse an existing session or restart the adapter process/,
      "超限文案必须可行动（ACP v1 无 destroy，上游缺口 F6）",
    );

    // closeSession 回收：名额可复用，被回收会话从事实源移除。
    const keptSessionId = accepted[0].result.sessionId;
    await h.adapter.closeSession(keptSessionId);
    const reopened = await h.client.request("session/new", { cwd: h.allowedRoot, mcpServers: [] });
    assert.equal(reopened.error, undefined, "closeSession 后应可再开会话");
    const ghost = await h.client.request("session/prompt", {
      sessionId: keptSessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    assert.equal(ghost.error.code, -32002, "回收后的会话应资源不存在");
  } finally {
    await stopAdapter(h);
  }
});

// ── F7：loopback 单侧死亡——server stop 后 request 立即拒绝 + 适配层 failPending ──

test("F7: server 侧 stop 后 request 立即拒绝；在途 prompt 经适配层 failPending 收口", async () => {
  const stub = createStubServices();
  let serverRef = null;
  const link = await createInProcessHarnessLink({
    services: stub.services,
    onServer: (server) => {
      serverRef = server;
    },
  });
  const io = createMemoryAcpIo();
  const allowedRoot = mkdtempSync(join(tmpdir(), "acode-acp-f7-"));
  const adapter = new AcpHostAdapter({ io, link, allowedRoot, agentVersion: "test" });
  const client = new AcpTestClient(io);
  const runPromise = adapter.run();
  try {
    await client.request("initialize", initializeParams());
    const sessionId = await newSession(client, allowedRoot);
    client.io.send({
      jsonrpc: "2.0",
      id: 820,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "HANG" }] },
    });
    await sleep(30);

    // server 侧死亡（transport dispose → onClose 回调面 → 适配层 failPending）。
    await serverRef.stop();
    await client.waitForUpdates(
      () => client.responses.has(820),
      "链路死亡后在途 prompt 应立即失败回执",
      3000,
    );
    assert.equal(client.responses.get(820).error.code, -32603);
    assert.match(client.responses.get(820).error.message, /harness link closed unexpectedly/);

    // 死亡后的新 request 立即拒绝（可读错误），不静默入队挂起。
    await assert.rejects(
      () => link.request("list_sessions", { workspacePath: allowedRoot }),
      /server stopped/,
    );
  } finally {
    io.end();
    await runPromise;
  }
});

// ── F8：两份 node-forge.d.ts 的 declare 块一致性（漂移即红）──

test("F8: cli 与 services 两份 node-forge.d.ts 的 declare 块逐字一致", async () => {
  const cliDeclare = readFileSync(join(CLI_SRC, "types", "node-forge.d.ts"), "utf8");
  const servicesDeclare = readFileSync(
    join(REPO_ROOT, "packages", "services", "src", "runtime-tools", "node-forge.d.ts"),
    "utf8",
  );
  const blockOf = (source) => source.slice(source.indexOf('declare module "node-forge"'));
  assert.ok(blockOf(cliDeclare).length > 0, "cli 副本应含 declare 块");
  assert.equal(
    blockOf(cliDeclare),
    blockOf(servicesDeclare),
    "两份声明块漂移（升级 node-forge 或安装 @types 时须两处同步修改/删除）",
  );
});

// ── F11：turn_started 二次递增防御（同 turnId 重复帧幂等）──

test("F11: 同 turnId 的重复 turn_started 不再推进 messageId 命名空间", async () => {
  const h = await startAdapter();
  try {
    await h.client.request("initialize", initializeParams());
    const sessionId = await newSession(h.client, h.allowedRoot);
    // 第一轮：prompt 预递增 + turn_started(turn-1) 递增 → 命名空间 acp-2。
    const first = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "MULTI" }],
    });
    assert.deepEqual(first.result, { stopReason: "end_turn" });
    assert.equal(h.client.updatesFor(sessionId)[0].update.messageId, "acp-2-m-1");

    // 迟到的重复 turn_started(turn-1)：不得再递增（修复前会把计数多推一格）。
    h.stub.emit(sessionId, "turn.started", { turnNumber: 1, input: "MULTI" }, "turn-1");

    // 第二轮：预递增（3）+ turn_started(turn-2)（4）→ acp-4；若重复帧多推一格
    // 则会落到 acp-5，断言即红。
    const second = await h.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "MULTI again" }],
    });
    assert.deepEqual(second.result, { stopReason: "end_turn" });
    const secondChunks = h.client
      .updatesFor(sessionId)
      .slice(2)
      .map((p) => p.update.messageId);
    assert.equal(
      secondChunks[0],
      "acp-4-m-1",
      `重复 turn_started 不得推进命名空间（实际 ${secondChunks[0]}）`,
    );
  } finally {
    await stopAdapter(h);
  }
});
