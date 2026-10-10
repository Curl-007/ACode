import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 编排方案 Phase 5 / P1 验收（apps/acode-cli/specs/agent-peer-messaging-cross-process.md
 * 场景 1-9）：SessionMailboxPort 写入方（原子落盘/排序/防护）、peer 窄面的跨进程
 * store-and-forward fallback（persisted_mailbox 语义、恒等式寻址、围栏单源、共享限速、
 * 镜像）、drain 空扫零副作用，以及双门控默认关的负向不变量守护。
 */

const { createNodeSessionMailboxAdapter } = await import(
  "../packages/adapters/src/mailbox/index.ts"
);
const { createPeerMessagingPort } = await import(
  "../packages/core/src/subagent/peer-messaging.ts"
);
const { formatPeerMessageEnvelope } = await import(
  "../packages/core/src/subagent/message-steering.ts"
);
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { SendMessageOutputSchema } = await import(
  "../packages/contracts/src/tools/send-message.ts"
);
const { createTraceId } = await import("../packages/contracts/src/interfaces/shared.ts");

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const tempRoots = [];
async function makeTempRoot(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { force: true, recursive: true })));
});

const trace = () => ({ traceId: createTraceId() });

const task = (id, overrides = {}) => ({
  agentId: id,
  agentType: "general-purpose",
  description: `probe ${id}`,
  startedAt: new Date(),
  status: "running",
  taskId: id,
  type: "local_agent",
  ...overrides,
});

/** 假 mailbox 接缝：known = agentId→sessionId 解析表；failDeliver 模拟 IO 失败。 */
function makeMailbox({ failDeliver = false, known = new Map() } = {}) {
  const delivered = [];
  const resolved = [];
  return {
    delivered,
    resolved,
    seam: {
      deliver: async (input) => {
        if (failDeliver) throw new Error("EACCES: simulated disk failure");
        delivered.push(input);
      },
      resolveTargetSession: async (agentId) => {
        resolved.push(agentId);
        return known.get(agentId);
      },
    },
  };
}

function makePort({ mailbox, mirror, registry, self = "agent_self", senderSessionId } = {}) {
  const reg = registry ?? new InMemoryRuntimeTaskRegistry();
  const mirrors = [];
  const port = createPeerMessagingPort({
    agentId: self,
    agentType: "general-purpose",
    parentSessionId: "sess_parent",
    registry: reg,
    ...(mailbox
      ? {
          mailbox: {
            senderSessionId: senderSessionId ?? "sess_subagent_agent_self",
            seam: mailbox.seam,
          },
        }
      : {}),
    ...(mirror === null
      ? {}
      : {
          mirror:
            mirror ??
            (async (input) => {
              mirrors.push(input);
            }),
        }),
  });
  return { mirrors, port, registry: reg };
}

const send = (port, to, overrides = {}) =>
  port.sendMessage({
    message: "hello sibling",
    summary: "greet",
    to,
    traceContext: trace(),
    ...overrides,
  });

test("(场景1) 适配器往返：deliver→drain 完整信封、createdAt 序、无 tmp 残留", async () => {
  const mailboxRoot = await makeTempRoot("acode-mailbox-rt-");
  const mailbox = createNodeSessionMailboxAdapter({ rootDir: mailboxRoot });
  await mailbox.deliver({
    content: "second",
    createdAt: "2026-10-10T00:00:02.000Z",
    fromSessionId: "sess_a",
    messageId: "msg_two",
    toSessionId: "sess_b",
  });
  await mailbox.deliver({
    content: "first",
    createdAt: "2026-10-10T00:00:01.000Z",
    fromSessionId: "sess_a",
    messageId: "msg_one",
    toSessionId: "sess_b",
  });

  const unreadBefore = await readdir(join(mailboxRoot, "sess_b", "unread"));
  assert.equal(unreadBefore.length, 2);
  assert.ok(
    unreadBefore.every((entry) => entry.endsWith(".json")),
    `unexpected non-json residue: ${unreadBefore.join(", ")}`,
  );

  const drained = await mailbox.drainUnread({ sessionId: "sess_b" });
  assert.deepEqual(
    drained.map((envelope) => envelope.messageId),
    ["msg_one", "msg_two"],
    "drain order must follow createdAt (sortable filename)",
  );
  assert.deepEqual(drained[0], {
    version: 1,
    messageId: "msg_one",
    fromSessionId: "sess_a",
    toSessionId: "sess_b",
    content: "first",
    createdAt: "2026-10-10T00:00:01.000Z",
  });

  assert.deepEqual(await readdir(join(mailboxRoot, "sess_b", "unread")), []);
  const readFiles = await readdir(join(mailboxRoot, "sess_b", "read"));
  assert.equal(readFiles.length, 2);
  // 归档后二次 drain 为空（rename = 单消费）。
  assert.deepEqual(await mailbox.drainUnread({ sessionId: "sess_b" }), []);

  // createdAt 缺省 = now（可解析的 ISO 时间戳）。
  await mailbox.deliver({
    content: "auto-time",
    fromSessionId: "sess_a",
    messageId: "msg_auto",
    toSessionId: "sess_b",
  });
  const auto = await mailbox.drainUnread({ sessionId: "sess_b" });
  assert.equal(auto.length, 1);
  assert.ok(Number.isFinite(Date.parse(auto[0].createdAt)));
});

test("(场景2) 写入防护：非法 sessionId / 非文件名安全 messageId / 非法 createdAt 全拒", async () => {
  const mailboxRoot = await makeTempRoot("acode-mailbox-guard-");
  const mailbox = createNodeSessionMailboxAdapter({ rootDir: mailboxRoot });
  await assert.rejects(
    mailbox.deliver({
      content: "x",
      fromSessionId: "sess_a",
      messageId: "msg_ok",
      toSessionId: "../evil",
    }),
    /Invalid session id/,
  );
  await assert.rejects(
    mailbox.deliver({
      content: "x",
      fromSessionId: "sess_a",
      messageId: "..\\..\\evil",
      toSessionId: "sess_b",
    }),
    /Invalid session mailbox message id/,
  );
  await assert.rejects(
    mailbox.deliver({
      content: "x",
      createdAt: "not-a-date",
      fromSessionId: "sess_a",
      messageId: "msg_ok",
      toSessionId: "sess_b",
    }),
    /Invalid session mailbox createdAt/,
  );
  // 全部拒绝 = 零落盘。
  await assert.rejects(stat(join(mailboxRoot, "sess_b")), /ENOENT/);
});

test("(场景3) drain 空扫零副作用：unread 目录不存在 → 返回空且不建任何目录", async () => {
  const mailboxRoot = await makeTempRoot("acode-mailbox-noop-");
  const mailbox = createNodeSessionMailboxAdapter({ rootDir: mailboxRoot });
  assert.deepEqual(await mailbox.drainUnread({ sessionId: "sess_ghost" }), []);
  await assert.rejects(stat(join(mailboxRoot, "sess_ghost")), /ENOENT/);
});

test("(场景4) 跨进程 fallback：registry 外目标 → persisted_mailbox，信封事实 + 围栏单源", async () => {
  const mailbox = makeMailbox({
    known: new Map([["agent_remote", "sess_subagent_agent_remote"]]),
  });
  const { mirrors, port } = makePort({ mailbox });
  const result = await send(port, "agent_remote", {
    message: "cross <process> hello",
    summary: "greet remote",
  });

  assert.equal(result.status, "success");
  assert.equal(result.delivery, "persisted_mailbox");
  assert.equal(result.agentId, "agent_remote");
  assert.equal(result.taskId, undefined);
  assert.match(result.message, /persisted to the session mailbox/);
  assert.match(result.message, /when that session next runs/);

  assert.equal(mailbox.delivered.length, 1);
  const envelope = mailbox.delivered[0];
  // fromSessionId = runner 铸造的发送方会话（模型不可伪造）；to = 恒等式解析结果。
  assert.equal(envelope.fromSessionId, "sess_subagent_agent_self");
  assert.equal(envelope.toSessionId, "sess_subagent_agent_remote");
  assert.match(envelope.messageId, /^msg_/);
  // R5：content 与 sink 注入共用同一构造器（单源），含声明行 + escapeXml。
  assert.equal(
    envelope.content,
    formatPeerMessageEnvelope({
      agentId: "agent_self",
      message: "cross <process> hello",
      summary: "greet remote",
    }),
  );
  assert.ok(envelope.content.includes("produced by a peer agent"));
  assert.ok(envelope.content.includes("cross &lt;process&gt; hello"));

  // R6：受理即镜像，metadata 记 delivery/toSessionId。
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].metadata.peerMessage.delivery, "persisted_mailbox");
  assert.equal(mirrors[0].metadata.peerMessage.toSessionId, "sess_subagent_agent_remote");
  assert.equal(mirrors[0].metadata.peerMessage.from, "agent_self");
});

test("(场景4) 4096 同源截断后才进信封", async () => {
  const mailbox = makeMailbox({ known: new Map([["agent_remote", "sess_r"]]) });
  const { port } = makePort({ mailbox, mirror: null });
  const long = "x".repeat(5000);
  const result = await send(port, "agent_remote", { message: long });
  assert.equal(result.status, "success");
  const envelope = mailbox.delivered[0];
  assert.equal(
    envelope.content,
    formatPeerMessageEnvelope({
      agentId: "agent_self",
      message: "x".repeat(4096),
      summary: "greet",
    }),
  );
  assert.ok(!envelope.content.includes("x".repeat(4097)));
});

test("(场景4) resolver miss 零写拒绝；deliver IO 失败结构化 failed（拒绝不镜像）", async () => {
  const missBox = makeMailbox({ known: new Map() });
  const miss = makePort({ mailbox: missBox });
  const missResult = await send(miss.port, "agent_ghost");
  assert.equal(missResult.status, "failed");
  assert.match(missResult.error, /no session exists for that agent id/);
  assert.match(missResult.error, /RespondToCoordinator/);
  assert.equal(missBox.delivered.length, 0);
  assert.equal(miss.mirrors.length, 0);

  const failBox = makeMailbox({ failDeliver: true, known: new Map([["agent_remote", "sess_r"]]) });
  const failing = makePort({ mailbox: failBox });
  const failResult = await send(failing.port, "agent_remote");
  assert.equal(failResult.status, "failed");
  assert.match(failResult.error, /Mailbox delivery to agent agent_remote failed/);
  assert.match(failResult.error, /EACCES/);
  assert.equal(failing.mirrors.length, 0, "rejections must not mirror");
});

test("(场景5) 限速与 sink 路径共享窗口：sender 第 21 条拒、pair 第 11 条拒", async () => {
  const mailbox = makeMailbox({ known: new Map([["agent_remote", "sess_r"]]) });
  const { port, registry } = makePort({ mailbox, mirror: null });
  registry.register(task("agent_self"));
  registry.register(task("agent_b"));
  // 10 条 sink（queued）+ 10 条 mailbox = sender 窗口 20。
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(port, "agent_b")).status, "success");
  }
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(port, "agent_remote")).status, "success");
  }
  const overSender = await send(port, "agent_b");
  assert.equal(overSender.status, "failed");
  assert.match(overSender.error, /rate limit reached for this agent/);

  const mailbox2 = makeMailbox({ known: new Map([["agent_remote", "sess_r"]]) });
  const second = makePort({ mailbox: mailbox2, mirror: null });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(second.port, "agent_remote")).status, "success");
  }
  const overPair = await send(second.port, "agent_remote");
  assert.equal(overPair.status, "failed");
  assert.match(overPair.error, /rate limit reached for the conversation with agent_remote/);
});

test("(场景6) 镜像失败吞掉留痕，不阻断 persisted_mailbox 受理", async () => {
  const mailbox = makeMailbox({ known: new Map([["agent_remote", "sess_r"]]) });
  const { port } = makePort({
    mailbox,
    mirror: async () => {
      throw new Error("mirror store unavailable");
    },
  });
  const result = await send(port, "agent_remote");
  assert.equal(result.status, "success");
  assert.equal(result.delivery, "persisted_mailbox");
  assert.equal(mailbox.delivered.length, 1);
});

test("(场景7) R0 负向：self 先于 resolver 拒绝；seam 缺席时拒绝文案与 P0 逐字节一致", async () => {
  const mailbox = makeMailbox({ known: new Map([["agent_self", "sess_should_not_resolve"]]) });
  const { port } = makePort({ mailbox });
  const selfResult = await send(port, "agent_self");
  assert.equal(selfResult.status, "failed");
  assert.equal(selfResult.error, "Cannot send a peer message to yourself.");
  assert.equal(mailbox.resolved.length, 0, "self check must short-circuit before resolution");
  assert.equal(mailbox.delivered.length, 0);

  const bare = makePort({});
  const bareResult = await send(bare.port, "agent_ghost");
  assert.equal(bareResult.status, "failed");
  assert.equal(
    bareResult.error,
    "No sibling agent agent_ghost is reachable from this session. Peer messages can only address agents spawned by the same coordinator; to reach anyone else, respond to your coordinator via RespondToCoordinator.",
  );
});

test("(场景8) SendMessageOutputSchema 接受 persisted_mailbox（strict 往返）", () => {
  const parsed = SendMessageOutputSchema.parse({
    status: "success",
    messageId: "msg_x",
    delivery: "persisted_mailbox",
    agentId: "agent_remote",
    message: "persisted",
  });
  assert.equal(parsed.delivery, "persisted_mailbox");
});

test("(场景9) 不变量守护：mailbox 路径无即时投递面、转发是条件 spread、父路径文案未扩", async () => {
  // max-lines 拆分后 mailbox 路径在 peer-send-paths.ts；切片收在 sendPeerViaMailbox
  // 自己的函数体（树表路径合法使用 registry/sink，守护边界必须停在它之前）。
  const pathsSource = await read("packages/core/src/subagent/peer-send-paths.ts");
  const mailboxStart = pathsSource.indexOf("export async function sendPeerViaMailbox");
  const mailboxEnd = pathsSource.indexOf("export async function sendPeerViaTreeAddress");
  assert.ok(
    mailboxStart !== -1 && mailboxEnd > mailboxStart,
    "sendPeerViaMailbox block not found",
  );
  const mailboxFn = pathsSource.slice(mailboxStart, mailboxEnd);
  // R3（peer-1 跨进程形态）：写入方只触文件系统——无 registry 句柄、无 sink 投递、
  // 无 steer/resume 调用。
  assert.ok(!mailboxFn.includes("registry"), "mailbox path must not touch registry");
  assert.ok(
    !mailboxFn.includes("deliverPendingMessageViaSink"),
    "mailbox path must not deliver via sink",
  );
  assert.ok(!mailboxFn.includes("steerTurn"), "mailbox path must not steer");
  assert.ok(!mailboxFn.includes("resume"), "mailbox path must not resume");

  const subagentSource = await read("packages/core/src/runtime/methods/subagent.ts");
  // R0/R7：child deps 转发与 peerMailbox 下发都必须是条件 spread（门关闭 = 字段缺席）。
  assert.ok(
    subagentSource.includes(
      "...(deps.sessionMailboxPort ? { sessionMailboxPort: deps.sessionMailboxPort } : {})",
    ),
    "child deps mailbox forwarding must stay a conditional spread",
  );
  assert.ok(
    subagentSource.includes("...(peerMailbox ? { peerMailbox } : {})"),
    "peerMailbox must stay inside the peerMessaging flag conditional",
  );

  const runnerSource = await read("packages/core/src/subagent/runner.ts");
  const successStart = runnerSource.indexOf("function createSendMessageSuccess");
  const successEnd = runnerSource.indexOf("function createSendMessageFailure");
  assert.ok(successStart !== -1 && successEnd > successStart);
  // R8：persisted_mailbox 文案单源在 peer port——父 registry 路径的文案分支不扩。
  assert.ok(
    !runnerSource.slice(successStart, successEnd).includes("persisted_mailbox"),
    "createSendMessageSuccess must not grow a persisted_mailbox branch",
  );
});
