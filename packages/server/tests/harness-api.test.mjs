// Harness API v1 真实子进程端到端测试（spec 验收场景 1/2/3/4/5/9/10 的桥侧部分）。
// 子进程 = tests/harness-stub-services-entry.mjs（真实翻译桥/帧协议/stdio 传输，
// services 层在公开接口上脚本化打桩——真实 agent 需要真实模型凭据，无法进测试环境）。
// 仅用临时目录与 loopback 子进程；不触碰真实 ~/.acode 与任何真实凭据。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const stubEntry = fileURLToPath(new URL("./harness-stub-services-entry.mjs", import.meta.url));

/** 裸 NDJSON 客户端：直连子进程 stdio，逐帧收发（不经 SDK——SDK 对照在 parity 测试）。 */
class RawHarnessClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
    this.waiters = [];
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdout.on("data", (chunk) => this.onData(chunk));
    this.stderr = "";
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        const frame = JSON.parse(line);
        this.frames.push(frame);
        if (frame.kind === "response" && this.pending.has(frame.id)) {
          const { resolve } = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          resolve(frame);
        }
        for (const waiter of this.waiters.splice(0)) waiter(frame);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  send(frame) {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, { resolve }));
    this.send({ v: 1, kind: "request", id, method, ...(params !== undefined ? { params } : {}) });
    return promise;
  }

  /** 等待下一个满足谓词的帧（从未来帧流中）。M6：上限 8s→20s（tsx 冷启动 9s 实测会顶穿 8s）。 */
  waitFor(predicate, timeoutMs = 20_000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`frame wait timeout; got ${JSON.stringify(this.frames.slice(-5))}`)),
        timeoutMs,
      );
      const check = (frame) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  async close() {
    this.child.stdin.end();
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

async function launchStub(env = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", stubEntry], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RawHarnessClient(child);
  // 握手。
  client.send({
    v: 1,
    kind: "hello",
    client: "raw-test",
    capabilities: ["unknown-future-capability"],
  });
  const ack = await client.waitFor((frame) => frame.kind === "hello_ack", 15_000);
  return { client, ack };
}

const WORKSPACE = "C:\\workspace\\stub-test";

test("握手：未知 capabilities 被忽略，hello_ack 带版本信息", async () => {
  const { client, ack } = await launchStub();
  try {
    assert.equal(ack.kind, "hello_ack");
    assert.equal(ack.v, 1);
    assert.equal(typeof ack.protocolMinor, "number");
    assert.equal(ack.server, "acode-harness-stub");
    // 未知 capability 不导致拒绝（additive 兼容铁律）。
  } finally {
    await client.close();
  }
});

test("握手：主版本不符 → 可读拒绝 + 连接关闭", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", stubEntry], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RawHarnessClient(child);
  try {
    client.send({ v: 2, kind: "hello", client: "raw-test", capabilities: [] });
    const errorFrame = await client.waitFor((frame) => frame.kind === "error");
    assert.equal(errorFrame.code, "version_mismatch");
    // 可读错误 + 建议（人话，含两端版本）。
    assert.match(errorFrame.message, /2/);
    assert.match(errorFrame.message, /1/);
    assert.match(errorFrame.message, /upgrade/i);
    await client.exited;
  } finally {
    await client.close();
  }
});

test("非 hello 首帧 → invalid_handshake；非法 JSON 行 → error 帧但连接存活", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", stubEntry], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RawHarnessClient(child);
  try {
    client.child.stdin.write("this is not json\n");
    const errorFrame = await client.waitFor((frame) => frame.kind === "error");
    assert.equal(errorFrame.code, "invalid_json");
    // 非 hello 首帧 → 拒绝并退出。
    client.send({ v: 1, kind: "request", id: 1, method: "get_models" });
    const handshakeError = await client.waitFor(
      (frame) => frame.kind === "error" && frame.code === "invalid_handshake",
    );
    assert.ok(handshakeError);
  } finally {
    await client.close();
  }
});

test("方法面 E2E：list(空)→create→send+事件流(seq 单调)→run parity→fork→attach→detach→配置/文件面", async () => {
  const { client } = await launchStub();
  try {
    // list 空。
    const listEmpty = await client.request("list_sessions", { workspacePath: WORKSPACE });
    assert.equal(listEmpty.ok, true);
    assert.deepEqual(listEmpty.result.sessions, []);

    // create。
    const created = await client.request("create_session", {
      workspacePath: WORKSPACE,
      mode: "build",
    });
    assert.equal(created.ok, true);
    const sessionId = created.result.sessionId;
    assert.ok(sessionId);

    // subscribe → send → 事件流（text_delta / turn_done，seq 单调）。
    const subscribed = await client.request("subscribe_events", {
      workspacePath: WORKSPACE,
      sessionId,
    });
    assert.equal(subscribed.ok, true);
    const subscriptionId = subscribed.result.subscriptionId;

    const sent = await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "ping",
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.result.accepted, true);

    const delta = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "text_delta",
    );
    assert.equal(delta.event.delta, "Hello from stub: ping");
    const done = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "turn_done",
    );
    assert.equal(done.event.resultType, "success");
    assert.equal(done.event.response, "Hello from stub: ping");
    // seq 单调：事件帧 seq 递增无回退。
    const eventSeqs = client.frames.filter((f) => f.kind === "event").map((f) => f.seq);
    for (let i = 1; i < eventSeqs.length; i += 1) {
      assert.ok(eventSeqs[i] > eventSeqs[i - 1], `seq not monotonic: ${eventSeqs.join(",")}`);
    }

    // run（服务端 send+等待合并）与事件路径结果一致。
    const runResult = await client.request("run", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "ping",
    });
    assert.equal(runResult.ok, true);
    assert.equal(runResult.result.resultType, "success");
    assert.equal(runResult.result.response, "Hello from stub: ping");
    assert.equal(runResult.result.usage.totalTokens, 12);

    // token_usage 事件随终态附带。
    const usage = await client
      .waitFor((frame) => frame.kind === "event" && frame.event.kind === "token_usage", 1_000)
      .catch(() => undefined);
    assert.ok(usage, "token_usage event expected");

    // fork。
    const forked = await client.request("fork_session", { workspacePath: WORKSPACE, sessionId });
    assert.equal(forked.ok, true);
    assert.notEqual(forked.result.sessionId, sessionId);

    // attach（resume 投影）。
    const attached = await client.request("attach_session", {
      workspacePath: WORKSPACE,
      sessionId: forked.result.sessionId,
    });
    assert.equal(attached.ok, true);

    // set_model / get_models / compact。
    const modelSet = await client.request("set_model", {
      workspacePath: WORKSPACE,
      sessionId,
      model: { providerId: "stub-provider", modelId: "stub-model" },
    });
    assert.equal(modelSet.ok, true);
    const models = await client.request("get_models", {});
    assert.equal(models.ok, true);
    assert.equal(models.result.providers[0].providerId, "stub-provider");
    assert.equal(models.result.providers[0].models.length, 2);
    assert.equal(models.result.preferredSelection.modelId, "stub-model");
    const compacted = await client.request("compact", {
      workspacePath: WORKSPACE,
      sessionId,
      instructions: "summarize",
    });
    assert.equal(compacted.ok, true);

    // 文件面（read_file 读真实临时文件；find_files 走桩内文件名搜索）。
    const tempDir = await mkdtemp(join(tmpdir(), "harness-read-"));
    const filePath = join(tempDir, "note.txt");
    await writeFile(filePath, "hello harness file", "utf8");
    const readFileResult = await client.request("read_file", { path: filePath });
    assert.equal(readFileResult.ok, true);
    assert.equal(readFileResult.result.content, "hello harness file");
    assert.equal(readFileResult.result.isBinary, false);
    const findResult = await client.request("find_files", {
      rootPath: tempDir,
      query: "note",
      limit: 10,
    });
    assert.equal(findResult.ok, true);
    assert.equal(findResult.result.entries.length, 1);
    assert.equal(findResult.result.entries[0].name, "note.ts");

    // unsubscribe / detach。
    const unsubscribed = await client.request("unsubscribe_events", { subscriptionId });
    assert.equal(unsubscribed.ok, true);
    const detached = await client.request("detach_session", {
      workspacePath: WORKSPACE,
      sessionId,
    });
    assert.equal(detached.ok, true);
    assert.equal(detached.result.detached, true);

    // list 现在包含已建会话。
    const listAfter = await client.request("list_sessions", { workspacePath: WORKSPACE });
    assert.ok(listAfter.result.sessions.length >= 1);
  } finally {
    await client.close();
  }
});

test("权限面：PermissionRequested → 手动应答 deny → turn 以 cancelled 收口（不挂死）", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    await client.request("subscribe_events", { workspacePath: WORKSPACE, sessionId });
    await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "NEEDS_PERMISSION please",
    });
    const permission = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "permission_requested",
    );
    assert.equal(permission.event.options.length, 2);
    const denyOption = permission.event.options.find((o) => o.optionId === "deny");
    assert.ok(denyOption);
    const responded = await client.request("permission_respond", {
      workspacePath: WORKSPACE,
      sessionId,
      requestId: permission.event.requestId,
      optionId: denyOption.optionId,
    });
    assert.equal(responded.ok, true);
    assert.equal(responded.result.accepted, true);
    const done = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "turn_done",
    );
    assert.equal(done.event.resultType, "cancelled");
  } finally {
    await client.close();
  }
});

test("cancel_turn：SLOW turn 被取消后以 cancelled 收口", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    await client.request("subscribe_events", { workspacePath: WORKSPACE, sessionId });
    await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "SLOW operation",
    });
    await client.waitFor((frame) => frame.kind === "event" && frame.event.kind === "turn_started");
    const cancelled = await client.request("cancel_turn", { workspacePath: WORKSPACE, sessionId });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.result.cancelled, true);
    const done = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "turn_done",
      8_000,
    );
    assert.equal(done.event.resultType, "cancelled");
  } finally {
    await client.close();
  }
});

test("如实降级：rewind_session / search_text / configure_tools 返回 not_supported（结构化 details）", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    for (const [method, params] of [
      ["rewind_session", { workspacePath: WORKSPACE, sessionId }],
      ["search_text", { rootPath: WORKSPACE, query: "x" }],
      ["configure_tools", { workspacePath: WORKSPACE, sessionId, disable: ["Bash"] }],
    ]) {
      const response = await client.request(method, params);
      assert.equal(response.ok, false, `${method} should degrade`);
      assert.equal(response.error.code, "not_supported", `${method} error code`);
      assert.equal(response.error.details.method, method, `${method} details.method`);
      assert.ok(response.error.message.length > 0);
    }
    // create_session.systemPrompt 同样如实降级。
    const systemPrompt = await client.request("create_session", {
      workspacePath: WORKSPACE,
      systemPrompt: "custom",
    });
    assert.equal(systemPrompt.ok, false);
    assert.equal(systemPrompt.error.code, "not_supported");
    // 未知方法。
    const unknown = await client.request("future_method", {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "unknown_method");
  } finally {
    await client.close();
  }
});

test("seq 丢帧注入：桥测试钩子跳写指定 seq，消费方观察到缺口", async () => {
  const { client } = await launchStub({ ACODE_HARNESS_TEST_DROP_EVENT_SEQ: "2" });
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    await client.request("subscribe_events", { workspacePath: WORKSPACE, sessionId });
    await client.request("send_message", { workspacePath: WORKSPACE, sessionId, content: "ping" });
    await client.waitFor((frame) => frame.kind === "event" && frame.event.kind === "turn_done");
    const seqs = client.frames.filter((f) => f.kind === "event").map((f) => f.seq);
    // seq 2 被桥吞掉：观察到的序列存在 1→3 缺口。
    assert.ok(seqs.includes(1), `first seq present: ${seqs.join(",")}`);
    assert.ok(!seqs.includes(2), `seq 2 dropped: ${seqs.join(",")}`);
    assert.ok(seqs.includes(3), `seq 3 present: ${seqs.join(",")}`);
  } finally {
    await client.close();
  }
});

test("红线：翻译桥源码对 acode-protocol import 零命中（源码断言）", async () => {
  // 断言 import 语句零命中（静态/动态 import 的模块说明符里不得出现 acode-protocol）；
  // 注释允许提及该词（说明为什么不 import）。
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'][^"']*acode-protocol/;
  const dirPath = fileURLToPath(new URL("../src/harness/", import.meta.url));
  const entries = await readdir(dirPath);
  const sourceFiles = entries.filter((name) => name.endsWith(".ts"));
  assert.ok(sourceFiles.length >= 3, `expected harness sources, got ${sourceFiles.join(",")}`);
  for (const name of sourceFiles) {
    const source = await readFile(join(dirPath, name), "utf8");
    assert.equal(importPattern.test(source), false, `${name} must not import acode-protocol`);
  }
  const entry = await readFile(
    fileURLToPath(new URL("../src/entry-harness.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(importPattern.test(entry), false, "entry-harness.ts must not import acode-protocol");
});

test("H1 run 归属（inputId 回显路径）：挂起旧 turn 被 deny 不被 run 冒领，run 拿到自己的终态", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    await client.request("subscribe_events", { workspacePath: WORKSPACE, sessionId });

    // 旧 turn：send 的权限 gate（挂起等待应答）。
    await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "NEEDS_PERMISSION old turn",
    });
    const permission = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "permission_requested",
    );
    const denyOption = permission.event.options.find((o) => o.optionId === "deny");
    assert.ok(denyOption);

    // 新 turn：run（HANG_TURN 挂起，直到 RELEASE_GATE）。
    const runPromise = client.request("run", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "HANG_TURN run-owned",
    });
    // 等 run 自己的 turn_started（携带 run 预分配的 inputId）落地后再 deny 旧 turn。
    await client.waitFor(
      (frame) =>
        frame.kind === "event" &&
        frame.event.kind === "turn_started" &&
        frame.event.inputId?.startsWith("harness-run-"),
    );

    // 旧 turn 被 deny → cancelled 终态到达；旧实现（不匹配归属）会立即冒领该终态。
    await client.request("permission_respond", {
      workspacePath: WORKSPACE,
      sessionId,
      requestId: permission.event.requestId,
      optionId: denyOption.optionId,
    });
    await client.waitFor(
      (frame) =>
        frame.kind === "event" &&
        frame.event.kind === "turn_done" &&
        frame.event.resultType === "cancelled",
    );
    const early = await Promise.race([
      runPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 600)),
    ]);
    assert.equal(early, "pending", "run must not adopt the old turn's terminal state (H1)");

    // 释放 run 自己的 turn：RELEASE_GATE 是第三个 turn（其终态同样不得被冒领）。
    await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "RELEASE_GATE",
    });
    const runFrame = await runPromise;
    assert.equal(runFrame.ok, true);
    assert.equal(runFrame.result.resultType, "success");
    assert.equal(runFrame.result.response, "hang released: HANG_TURN run-owned");
    assert.match(runFrame.result.inputId ?? "", /^harness-run-/);
  } finally {
    await client.close();
  }
});

test("H1 run 归属（退化路径）：引擎不回显 inputId 时只认订阅后 TurnStarted→TurnDone 完整对", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    await client.request("subscribe_events", { workspacePath: WORKSPACE, sessionId });

    // 旧 turn：send 的权限 gate（挂起；其 turn.started 早于 run 的订阅建立）。
    await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "NEEDS_PERMISSION old turn",
    });
    const permission = await client.waitFor(
      (frame) => frame.kind === "event" && frame.event.kind === "permission_requested",
    );
    const denyOption = permission.event.options.find((o) => o.optionId === "deny");
    assert.ok(denyOption);

    // 新 turn：run（不回显 inputId + HANG_TURN 挂起——模拟不回显 inputId 的引擎）。
    const runPromise = client.request("run", {
      workspacePath: WORKSPACE,
      sessionId,
      content: "NO_INPUT_ID_ECHO HANG_TURN degraded",
    });
    await client.waitFor(
      (frame) =>
        frame.kind === "event" &&
        frame.event.kind === "turn_started" &&
        frame.event.inputPreview?.includes("degraded"),
    );

    // 旧 turn 被 deny：其终态的 turnId 不在 run 订阅窗口的 TurnStarted 集合内，必须跳过。
    await client.request("permission_respond", {
      workspacePath: WORKSPACE,
      sessionId,
      requestId: permission.event.requestId,
      optionId: denyOption.optionId,
    });
    await client.waitFor(
      (frame) =>
        frame.kind === "event" &&
        frame.event.kind === "turn_done" &&
        frame.event.resultType === "cancelled",
    );
    const early = await Promise.race([
      runPromise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 600)),
    ]);
    assert.equal(early, "pending", "degraded ownership must skip the pre-subscription turn (H1)");

    // cancel_turn 释放 run 自己的挂起 turn（cancelled + 可区分 response）。
    await client.request("cancel_turn", { workspacePath: WORKSPACE, sessionId });
    const runFrame = await runPromise;
    assert.equal(runFrame.ok, true);
    // 旧 turn 的 cancelled response 是 ""；run 自己的 turn 带 hang released 标记。
    assert.equal(runFrame.result.resultType, "cancelled");
    assert.equal(runFrame.result.response, "hang released: NO_INPUT_ID_ECHO HANG_TURN degraded");
  } finally {
    await client.close();
  }
});

test("H2 参数校验：send 缺 content / fork 缺 sessionId / list limit 越界 → invalid_params（字段路径稳定）", async () => {
  const { client } = await launchStub();
  try {
    const created = await client.request("create_session", { workspacePath: WORKSPACE });
    const sessionId = created.result.sessionId;
    // 旧实现：String(undefined) 把缺失 content 变形为 "undefined" 消息直发引擎。
    const noContent = await client.request("send_message", {
      workspacePath: WORKSPACE,
      sessionId,
    });
    assert.equal(noContent.ok, false);
    assert.equal(noContent.error.code, "invalid_params");
    assert.ok(
      noContent.error.details.issues.some((issue) => issue.path === "content"),
      `content path issue missing: ${JSON.stringify(noContent.error.details)}`,
    );
    // 旧实现：fork 缺 sessionId 时 String(undefined) 造出 parentSessionId:"undefined" 会话。
    const badFork = await client.request("fork_session", { workspacePath: WORKSPACE });
    assert.equal(badFork.ok, false);
    assert.equal(badFork.error.code, "invalid_params");
    assert.ok(
      badFork.error.details.issues.some((issue) => issue.path === "sessionId"),
      `sessionId path issue missing: ${JSON.stringify(badFork.error.details)}`,
    );
    // 旧实现：limit 1e9 经 typeof 检查直通（schema max 500 现在拦下）。
    const badLimit = await client.request("list_sessions", {
      workspacePath: WORKSPACE,
      limit: 1e9,
    });
    assert.equal(badLimit.ok, false);
    assert.equal(badLimit.error.code, "invalid_params");
    assert.ok(
      badLimit.error.details.issues.some((issue) => issue.path === "limit"),
      `limit path issue missing: ${JSON.stringify(badLimit.error.details)}`,
    );
    // 未知字段剥离（兼容铁律）：多余字段不炸请求，已声明字段仍校验。
    const tolerated = await client.request("list_sessions", {
      workspacePath: WORKSPACE,
      futureField: 1,
    });
    assert.equal(tolerated.ok, true);
  } finally {
    await client.close();
  }
});

test("M1 UTF-8 跨 chunk：中文路径在多字节字符内切开仍完整解码", async () => {
  const { client } = await launchStub();
  try {
    // 临时目录 + 中文文件名/内容（read_file 路径为自由字符串，不经枚举校验）。
    const tempDir = await mkdtemp(join(tmpdir(), "harness-utf8-"));
    const filePath = join(tempDir, "笔记.txt");
    await writeFile(filePath, "你好，世界", "utf8");
    // 构造含「笔」的 read_file 帧，并把「笔」的 3 字节 UTF-8 序列从中间切开写入：
    // 旧实现 chunk.toString("utf8") 会在切点产生 U+FFFD（路径损坏 → 文件找不到）。
    const frame = `${JSON.stringify({
      v: 1,
      kind: "request",
      id: 4900,
      method: "read_file",
      params: { path: filePath },
    })}\n`;
    const bytes = Buffer.from(frame, "utf8");
    const charStart = Buffer.byteLength(frame.slice(0, frame.indexOf("笔")), "utf8");
    assert.ok(charStart > 0 && charStart + 1 < bytes.length, "split point must be mid-character");
    client.child.stdin.write(bytes.subarray(0, charStart + 1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.child.stdin.write(bytes.subarray(charStart + 1));
    const response = await client.waitFor((f) => f.kind === "response" && f.id === 4900);
    assert.equal(response.ok, true, `split frame must decode: ${JSON.stringify(response)}`);
    // 内容回读同样不含替换符（路径解码损坏时 read 会失败或读错文件）。
    assert.equal(response.result.content, "你好，世界");
    assert.ok(!response.result.content.includes("\uFFFD"));
  } finally {
    await client.close();
  }
});

test("M4 行长上限：超 4 MiB 单行 → line_too_long error 帧 + 连接断开", async () => {
  const { client } = await launchStub();
  try {
    const huge = `${JSON.stringify({
      v: 1,
      kind: "request",
      id: 4901,
      method: "get_models",
      params: { pad: "x".repeat(4 * 1024 * 1024 + 256) },
    })}\n`;
    client.child.stdin.write(huge);
    const errorFrame = await client.waitFor(
      (frame) => frame.kind === "error" && frame.code === "line_too_long",
    );
    assert.ok(errorFrame, "line_too_long error frame expected");
    assert.ok(errorFrame.message.includes("closing connection"));
    // 断连：后续请求不再有响应。
    const probeId = client.nextId;
    client.send({ v: 1, kind: "request", id: probeId, method: "get_models", params: {} });
    const answered = await client
      .waitFor((frame) => frame.kind === "response" && frame.id === probeId, 1_500)
      .then(
        () => true,
        () => false,
      );
    assert.equal(answered, false, "connection must be closed after line_too_long");
  } finally {
    await client.close();
  }
});

test("M4 写背压：write() 返回 false 暂停输入泵，drain 后恢复（桩流断言）", async () => {
  const { EventEmitter } = await import("node:events");
  const { createStdioTransport } = await import("../src/harness/transport.ts");
  const input = new EventEmitter();
  const output = new EventEmitter();
  const paused = [];
  const resumed = [];
  input.pause = () => paused.push(paused.length);
  input.resume = () => resumed.push(resumed.length);
  output.write = () => false; // 永远背压
  const transport = createStdioTransport(input, output);
  try {
    transport.writeLine("frame-1");
    transport.writeLine("frame-2");
    // 一次背压期只暂停一次（dedup，不堆 drain 监听）。
    assert.equal(paused.length, 1, `pause once while backpressured, got ${paused.length}`);
    output.emit("drain");
    assert.equal(resumed.length, 1, "resume on drain");
    transport.writeLine("frame-3");
    // drain 后新一轮背压重新暂停。
    assert.equal(paused.length, 2, "re-pause on next backpressure episode");
  } finally {
    transport.dispose();
  }
});

test("红线：server harness 只允许已登记的 protocol capability/schema 改动", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "packages/shared/src/acode-protocol",
      "packages/shared/src/acode-protocol-v4",
    ],
    { cwd: repoRoot },
  );
  const allowedChanges = new Set([
    "M  packages/shared/src/acode-protocol-v4/index.ts",
    " M packages/shared/src/acode-protocol-v4/index.ts",
    "M  packages/shared/src/acode-protocol-v4/transport.ts",
    " M packages/shared/src/acode-protocol-v4/transport.ts",
    "M  packages/shared/src/acode-protocol-v4/command.ts",
    " M packages/shared/src/acode-protocol-v4/command.ts",
    "M  packages/shared/src/acode-protocol/index.ts",
    " M packages/shared/src/acode-protocol/index.ts",
    "?? packages/shared/src/acode-protocol-v4/capabilities.ts",
  ]);
  const unexpected = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !allowedChanges.has(line));
  assert.deepEqual(
    unexpected,
    [],
    `acode-protocol changed outside the capability slice: ${stdout}`,
  );
});
