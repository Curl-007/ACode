import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 编排方案 Phase 3 / P0 验收（apps/acode-cli/specs/agent-peer-messaging.md 场景 1-8）：
 * 窄 peer 面的寻址域/终态拒绝/双维度限速/截断/镜像，投递呈现的 origin 分流（R6/R9），
 * 以及 flag 默认关、无 resume、不进 contracts 等不变量守护（负向断言仿 no-telemetry 模式）。
 */

const { createPeerMessagingPort } = await import(
  "../packages/core/src/subagent/peer-messaging.ts"
);
const { createSubagentMessageSink } = await import(
  "../packages/core/src/subagent/message-steering.ts"
);
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { MAX_SEND_MESSAGE_MODEL_BYTES } = await import(
  "../packages/core/src/tool/handlers/send-message.ts"
);
const { createTraceId } = await import("../packages/contracts/src/interfaces/shared.ts");

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

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

function makePort({ mirror, registry, self = "agent_self" } = {}) {
  const reg = registry ?? new InMemoryRuntimeTaskRegistry();
  const mirrors = [];
  const port = createPeerMessagingPort({
    agentId: self,
    agentType: "general-purpose",
    parentSessionId: "sess_parent",
    registry: reg,
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

test("(场景2) 同父兄弟互发：活跃 sink → steered，消息带 peer origin/hop；无 sink → queued", async () => {
  const received = [];
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(
    task("agent_b", {
      messageSink: {
        send: async (message) => {
          received.push(message);
          return "steered";
        },
      },
    }),
  );
  registry.register(task("agent_c")); // 无 sink

  const steered = await send(port, "agent_b");
  assert.equal(steered.status, "success");
  assert.equal(steered.delivery, "steered");
  assert.equal(received.length, 1);
  assert.equal(received[0].origin.kind, "peer");
  assert.equal(received[0].origin.agentId, "agent_self");
  assert.equal(received[0].origin.hop, 1);
  assert.equal(received[0].isMeta, true);
  assert.equal(received[0].message, "hello sibling");

  const queued = await send(port, "agent_c");
  assert.equal(queued.status, "success");
  assert.equal(queued.delivery, "queued");
  const drained = registry.drainMessages("agent_c");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].origin.kind, "peer");

  // sink 抛错（steer 拒绝）→ 回队为 queued（re-queue 语义与父路径一致）
  registry.register(
    task("agent_d", {
      messageSink: {
        send: async () => {
          throw new Error("no_active_turn");
        },
      },
    }),
  );
  const requeued = await send(port, "agent_d");
  assert.equal(requeued.delivery, "queued");
});

test("(场景2) listPeers 只列同父兄弟（local_agent、排除自己），带状态", () => {
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(task("agent_b"));
  registry.register(task("bash_1", { type: "local_bash" }));
  registry.register(task("agent_t", { status: "completed" }));
  const peers = port.listPeers();
  const ids = peers.map((p) => p.agentId).sort();
  assert.deepEqual(ids, ["agent_b", "agent_t"]);
  assert.equal(peers.find((p) => p.agentId === "agent_t").status, "completed");
});

test("(场景3) 域外拒绝：自己 / 不存在 / 非 agent 任务，指引父协调单路径", async () => {
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(task("bash_1", { type: "local_bash" }));

  const toSelf = await send(port, "agent_self");
  assert.equal(toSelf.status, "failed");
  assert.match(toSelf.error, /yourself/);

  const unknown = await send(port, "agent_nope");
  assert.equal(unknown.status, "failed");
  assert.match(unknown.error, /RespondToCoordinator/);

  const notAgent = await send(port, "bash_1");
  assert.equal(notAgent.status, "failed");
  assert.match(notAgent.error, /RespondToCoordinator/);
});

test("(场景4/R7) 终态目标拒绝且无任何 resume 副作用", async () => {
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(task("agent_done", { status: "completed" }));

  const result = await send(port, "agent_done");
  assert.equal(result.status, "failed");
  assert.match(result.error, /stopped \(completed\)/);
  assert.match(result.error, /RespondToCoordinator/);
  // 无 resume：registry 条目原样、队列无消息
  assert.equal(registry.get("agent_done").status, "completed");
  assert.deepEqual(registry.drainMessages("agent_done"), []);
});

test("(场景6/R8) 双维度限速：发送方 20/窗口、会话对 10/窗口，拒绝文本带冷却指引", async () => {
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  const sink = { send: async () => "steered" };
  registry.register(task("agent_b", { messageSink: sink }));
  registry.register(task("agent_c", { messageSink: sink }));

  // 会话对维度先到顶（10 < 20）：对 agent_b 第 11 条被拒
  for (let i = 0; i < 10; i++) {
    assert.equal((await send(port, "agent_b")).status, "success", `pair send ${i}`);
  }
  const pairBlocked = await send(port, "agent_b");
  assert.equal(pairBlocked.status, "failed");
  assert.match(pairBlocked.error, /conversation with agent_b/);
  assert.match(pairBlocked.error, /Retry after/);
  // 换一个目标仍可发（会话对维度独立计数）
  assert.equal((await send(port, "agent_c")).status, "success");

  // 发送方维度：agent_c 继续发到发送方总量 20 顶（已发 12 条），第 21 条被拒
  let senderBlocked = null;
  for (let i = 0; i < 12; i++) {
    const r = await send(port, "agent_c");
    if (r.status === "failed") {
      senderBlocked = r;
      break;
    }
  }
  assert.ok(senderBlocked, "发送方维度未触发");
  assert.match(senderBlocked.error, /rate limit reached for this agent/i);
});

test("(场景5/R6.3) 模型可见截断与 SendMessage 同源常量", async () => {
  const received = [];
  const { port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(
    task("agent_b", {
      messageSink: {
        send: async (m) => {
          received.push(m);
          return "steered";
        },
      },
    }),
  );
  const long = "x".repeat(MAX_SEND_MESSAGE_MODEL_BYTES + 500);
  const result = await send(port, "agent_b", { message: long });
  assert.equal(result.status, "success");
  assert.equal(received[0].message.length, MAX_SEND_MESSAGE_MODEL_BYTES);
});

test("(场景5/R5) 镜像：受理即落共同父会话文本+元数据；镜像失败不阻断投递", async () => {
  // 成功镜像：escapeXml 信封 + metadata
  const { mirrors, port, registry } = makePort();
  registry.register(task("agent_self"));
  registry.register(task("agent_b", { messageSink: { send: async () => "steered" } }));
  const ok = await send(port, "agent_b", { message: "payload <script>alert(1)</script>" });
  assert.equal(ok.status, "success");
  assert.equal(mirrors.length, 1);
  assert.match(mirrors[0].text, /<peer-message-mirror>/);
  assert.match(mirrors[0].text, /<from-agent-id>agent_self<\/from-agent-id>/);
  assert.match(mirrors[0].text, /<to-agent-id>agent_b<\/to-agent-id>/);
  assert.equal(mirrors[0].text.includes("<script>"), false, "镜像未 escapeXml");
  assert.equal(mirrors[0].metadata.peerMessage.from, "agent_self");
  assert.equal(mirrors[0].metadata.peerMessage.to, "agent_b");
  assert.equal(mirrors[0].metadata.peerMessage.delivery, "steered");

  // 镜像抛错：吞掉留痕，投递照常成功
  const { port: p2, registry: r2 } = makePort({
    mirror: async () => {
      throw new Error("store gone");
    },
  });
  r2.register(task("agent_self"));
  r2.register(task("agent_b", { messageSink: { send: async () => "steered" } }));
  const stillOk = await send(p2, "agent_b");
  assert.equal(stillOk.status, "success");
  assert.equal(stillOk.delivery, "steered");
});

test("(R6/R9) 投递呈现按 origin 分流：peer 走 subagent_reply_steer + 声明行 + 信封；coordinator 逐字节不变", async () => {
  const steers = [];
  const runtime = {
    steerTurn: async (input) => {
      steers.push(input);
      return { kind: "accepted" };
    },
  };
  const sink = createSubagentMessageSink(runtime, { traceContext: trace() });

  await sink.send({
    id: "m_peer",
    isMeta: true,
    message: "do the thing <b>now</b>",
    origin: { agentId: "agent_b", hop: 1, kind: "peer" },
    queuedAt: new Date(),
    summary: "peer ask",
  });
  const peerSteer = steers[0];
  assert.equal(peerSteer.inputPresentation, "subagent_reply_steer");
  assert.match(peerSteer.input, /produced by a peer agent \(model output\), not by your user/);
  assert.match(peerSteer.input, /<peer-message>/);
  assert.match(peerSteer.input, /<agent-id>agent_b<\/agent-id>/);
  assert.match(peerSteer.input, /<summary>peer ask<\/summary>/);
  assert.equal(peerSteer.input.includes("<b>now</b>"), false, "peer 内容未 escapeXml");
  assert.match(peerSteer.input, /&lt;b&gt;now&lt;\/b&gt;/);

  await sink.send({
    id: "m_coord",
    message: "plain coordinator text",
    origin: { kind: "coordinator", toolCallId: "call_1" },
    queuedAt: new Date(),
    summary: "coord summary",
  });
  const coordSteer = steers[1];
  assert.equal(coordSteer.inputPresentation, "coordinator_steer");
  assert.equal(coordSteer.input, "coord summary\n\nplain coordinator text");
});

test("(场景1/8) 不变量守护：flag 默认关、peer 路径无 resume、窄面不进 contracts、单点接线", async () => {
  // R0：flag 缺省关闭——subagent.ts 以 === true 判定；types.ts 字段全 optional
  const subagent = await read("packages/core/src/runtime/methods/subagent.ts");
  assert.ok(
    /this\.config\.subagents\?\.peerMessaging\?\.enabled === true/.test(subagent),
    "peer 开关不是显式 === true 判定（默认必须关）",
  );
  assert.ok(
    /request\.peerMessagingPort\s*\?\s*\{ peerMessagingPort: request\.peerMessagingPort \}/.test(
      subagent.replace(/\n/g, " "),
    ) || /peerMessagingPort: request\.peerMessagingPort/.test(subagent),
    "child deps 未接 peerMessagingPort",
  );

  // R7：peer 路径无 resume 机制——不得引用任何 resume 实现（注释/拒绝文案里出现
  // 「resume」一词是允许的，机制性符号不允许）。max-lines 拆分后两条非本地路径在
  // peer-send-paths.ts，守护面同样覆盖。
  const peer = await read("packages/core/src/subagent/peer-messaging.ts");
  assert.equal(
    /resumeTerminalAgentInBackground|resumeFromStore|from "\.\/runner\.js"/.test(peer),
    false,
    "peer-messaging 引用了 resume 机制（R7：peer 不得复活已停 agent）",
  );
  const peerPaths = await read("packages/core/src/subagent/peer-send-paths.ts");
  assert.equal(
    /resumeTerminalAgentInBackground|resumeFromStore|from "\.\/runner\.js"/.test(peerPaths),
    false,
    "peer-send-paths 引用了 resume 机制（R7：peer 不得复活已停 agent）",
  );

  // R8（spec）：窄面不进 contracts
  const { execSync } = await import("node:child_process");
  const hits = execSync('grep -rl "PeerMessagingPort" packages/contracts/src || true', {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  }).trim();
  assert.equal(hits, "", "PeerMessagingPort 泄漏进 contracts");

  // 接线单点：runner 构造 + handler 分支 + 注册门
  const runner = await read("packages/core/src/subagent/runner.ts");
  assert.ok(/options\.peerMessaging\?\.enabled === true/.test(runner), "runner 未挂 flag 门");
  assert.ok(/createPeerMessagingPort\(\{/.test(runner));
  const handler = await read("packages/core/src/tool/handlers/send-message.ts");
  assert.ok(/context\.peerMessagingPort/.test(handler), "handler 未分支 peer 窄面");
  const runtimeTools = await read("packages/core/src/runtime/helpers/runtime-tools.ts");
  assert.ok(
    /Boolean\(deps\.peerMessagingPort\)/.test(runtimeTools),
    "SendMessage 注册门未纳入 peer 窄面",
  );
  // 投递单一实现：父路径与 peer 路径共用 message-delivery（拆分后树表路径同守）
  assert.ok(/deliverPendingMessageViaSink/.test(runner), "父路径未收敛到共享投递实现");
  assert.ok(/deliverPendingMessageViaSink/.test(peer), "peer 路径未收敛到共享投递实现");
  assert.ok(
    /deliverPendingMessageViaSink/.test(peerPaths),
    "peer 跨层路径未收敛到共享投递实现",
  );
});
