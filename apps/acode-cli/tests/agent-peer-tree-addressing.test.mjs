import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";

/**
 * 编排方案 Phase 5 / P2 验收（apps/acode-cli/specs/agent-peer-tree-addressing.md
 * 场景 1-8）：整树寻址表原语与跨树隔离、同树跨层 live 投递（三语义单点复用）、
 * 终态拒绝与 stale 降级、本地优先的查询顺序、三路径共享限速窗、镜像逐级收口，
 * 以及登记/注销单点与 flag 透传的装配守护（源文本负向断言仿 P0/P1 模式）。
 */

const { createPeerMessagingPort } = await import(
  "../packages/core/src/subagent/peer-messaging.ts"
);
const {
  lookupTreeAddress,
  registerTreeAddress,
  resetTreeAddressingForTest,
  unregisterTreeAddress,
} = await import("../packages/core/src/subagent/tree-addressing.ts");
const { InMemoryRuntimeTaskRegistry } = await import(
  "../packages/core/src/runtime-task/registry.ts"
);
const { createTraceId } = await import("../packages/contracts/src/interfaces/shared.ts");

const cliRoot = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, cliRoot), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

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

function makePort({ mailbox, mirror, registry, self = "agent_self", treeRootKey } = {}) {
  const reg = registry ?? new InMemoryRuntimeTaskRegistry();
  const mirrors = [];
  const port = createPeerMessagingPort({
    agentId: self,
    agentType: "general-purpose",
    parentSessionId: "sess_parent",
    registry: reg,
    ...(mailbox
      ? { mailbox: { senderSessionId: "sess_subagent_agent_self", seam: mailbox.seam } }
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
    ...(treeRootKey === undefined ? {} : { treeAddressing: { rootKey: treeRootKey } }),
  });
  return { mirrors, port, registry: reg };
}

const send = (port, to, overrides = {}) =>
  port.sendMessage({
    message: "hello tree",
    summary: "greet",
    to,
    traceContext: trace(),
    ...overrides,
  });

const sinkRecording = (received) => ({
  send: async (message) => {
    received.push(message);
    return "steered";
  },
});

beforeEach(() => {
  resetTreeAddressingForTest();
});

test("(场景1) 表原语：register/lookup/unregister/覆盖写；跨树键结构性隔离", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerTreeAddress({
    entry: { agentId: "agent_b", childSessionId: "sess_sb", registry },
    rootKey: "sess_tree1",
  });
  assert.equal(lookupTreeAddress({ agentId: "agent_b", rootKey: "sess_tree1" })?.childSessionId, "sess_sb");
  // 跨树 miss（R1 域闸）。
  assert.equal(lookupTreeAddress({ agentId: "agent_b", rootKey: "sess_tree2" }), undefined);
  // 覆盖写 = resume 重臂自动刷新。
  const registry2 = new InMemoryRuntimeTaskRegistry();
  registerTreeAddress({
    entry: { agentId: "agent_b", childSessionId: "sess_sb2", registry: registry2 },
    rootKey: "sess_tree1",
  });
  assert.equal(lookupTreeAddress({ agentId: "agent_b", rootKey: "sess_tree1" }).childSessionId, "sess_sb2");
  unregisterTreeAddress({ agentId: "agent_b", rootKey: "sess_tree1" });
  assert.equal(lookupTreeAddress({ agentId: "agent_b", rootKey: "sess_tree1" }), undefined);
  // 幂等注销 + 未知根 no-op。
  unregisterTreeAddress({ agentId: "agent_b", rootKey: "sess_tree1" });
  unregisterTreeAddress({ agentId: "agent_x", rootKey: "sess_unknown_root" });
});

test("(场景2) 跨层投递：有 sink → steered（origin.kind=peer/hop=1）；无 sink → queued 进目标队列", async () => {
  const received = [];
  const uncleRegistry = new InMemoryRuntimeTaskRegistry();
  uncleRegistry.register(task("agent_uncle", { messageSink: sinkRecording(received) }));
  registerTreeAddress({
    entry: { agentId: "agent_uncle", childSessionId: "sess_su", registry: uncleRegistry },
    rootKey: "sess_tree1",
  });
  const { port } = makePort({ treeRootKey: "sess_tree1" });
  const steered = await send(port, "agent_uncle");
  assert.equal(steered.status, "success");
  assert.equal(steered.delivery, "steered");
  assert.equal(steered.agentId, "agent_uncle");
  assert.equal(received.length, 1);
  assert.equal(received[0].origin.kind, "peer");
  assert.equal(received[0].origin.agentId, "agent_self");
  assert.equal(received[0].origin.hop, 1);
  assert.equal(received[0].message, "hello tree");

  const cousinRegistry = new InMemoryRuntimeTaskRegistry();
  cousinRegistry.register(task("agent_cousin"));
  registerTreeAddress({
    entry: { agentId: "agent_cousin", childSessionId: "sess_sc", registry: cousinRegistry },
    rootKey: "sess_tree1",
  });
  const queued = await send(port, "agent_cousin");
  assert.equal(queued.status, "success");
  assert.equal(queued.delivery, "queued");
});

test("(场景3) R7：树表命中但终态 → 拒绝零投递；stale 表项 → 降级 mailbox/拒绝链", async () => {
  const received = [];
  const terminalRegistry = new InMemoryRuntimeTaskRegistry();
  terminalRegistry.register(
    task("agent_done", { messageSink: sinkRecording(received), status: "completed" }),
  );
  registerTreeAddress({
    entry: { agentId: "agent_done", childSessionId: "sess_sd", registry: terminalRegistry },
    rootKey: "sess_tree1",
  });
  const { mirrors, port } = makePort({ treeRootKey: "sess_tree1" });
  const rejected = await send(port, "agent_done");
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error, /has stopped \(completed\)/);
  assert.match(rejected.error, /cannot resume stopped agents/);
  assert.equal(received.length, 0, "terminal target must receive nothing");
  assert.equal(mirrors.length, 0, "rejections must not mirror");

  // stale：表项在场但 registry 已无任务 → 无 mailbox 时落 P0 拒绝文案。
  const staleRegistry = new InMemoryRuntimeTaskRegistry();
  registerTreeAddress({
    entry: { agentId: "agent_gone", childSessionId: "sess_sg", registry: staleRegistry },
    rootKey: "sess_tree1",
  });
  const stale = await send(port, "agent_gone");
  assert.equal(stale.status, "failed");
  assert.equal(
    stale.error,
    "No sibling agent agent_gone is reachable from this session. Peer messages can only address agents spawned by the same coordinator; to reach anyone else, respond to your coordinator via RespondToCoordinator.",
  );

  // stale + mailbox 接缝在场 → 降级 P1 store-and-forward。
  const delivered = [];
  const mailbox = {
    delivered,
    seam: {
      deliver: async (input) => {
        delivered.push(input);
      },
      resolveTargetSession: async (agentId) =>
        agentId === "agent_gone" ? "sess_subagent_agent_gone" : undefined,
    },
  };
  const withMailbox = makePort({ mailbox, treeRootKey: "sess_tree1" });
  const downgraded = await send(withMailbox.port, "agent_gone");
  assert.equal(downgraded.status, "success");
  assert.equal(downgraded.delivery, "persisted_mailbox");
  assert.equal(delivered.length, 1);
});

test("(场景4) R2 顺序：本地 registry 命中优先于树表（P0 语义不被跨层路径截胡）", async () => {
  const treeReceived = [];
  const treeRegistry = new InMemoryRuntimeTaskRegistry();
  treeRegistry.register(task("agent_b", { messageSink: sinkRecording(treeReceived) }));
  registerTreeAddress({
    entry: { agentId: "agent_b", childSessionId: "sess_sb", registry: treeRegistry },
    rootKey: "sess_tree1",
  });
  // 本地 registry 也挂同名任务（无 sink → queued）：必须走本地路径。
  const { port, registry } = makePort({ treeRootKey: "sess_tree1" });
  registry.register(task("agent_b"));
  const result = await send(port, "agent_b");
  assert.equal(result.status, "success");
  assert.equal(result.delivery, "queued", "local registry path must win over tree entry");
  assert.equal(treeReceived.length, 0);
});

test("(场景5) R3：限速三路径共享窗口——本地+跨层混发 sender 第 21 条拒；跨层 pair 第 11 条拒", async () => {
  const cousinRegistry = new InMemoryRuntimeTaskRegistry();
  cousinRegistry.register(task("agent_cousin"));
  registerTreeAddress({
    entry: { agentId: "agent_cousin", childSessionId: "sess_sc", registry: cousinRegistry },
    rootKey: "sess_tree1",
  });
  const { port, registry } = makePort({ mirror: null, treeRootKey: "sess_tree1" });
  registry.register(task("agent_self"));
  registry.register(task("agent_b"));
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(port, "agent_b")).status, "success");
  }
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(port, "agent_cousin")).status, "success");
  }
  const overSender = await send(port, "agent_cousin");
  assert.equal(overSender.status, "failed");
  assert.match(overSender.error, /rate limit reached for this agent/);

  const second = makePort({ mirror: null, treeRootKey: "sess_tree1" });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await send(second.port, "agent_cousin")).status, "success");
  }
  const overPair = await send(second.port, "agent_cousin");
  assert.equal(overPair.status, "failed");
  assert.match(overPair.error, /rate limit reached for the conversation with agent_cousin/);
});

test("(场景6) R4：跨层镜像落发送方父回调，metadata 含 toAgentSessionId；镜像失败不阻断", async () => {
  const cousinRegistry = new InMemoryRuntimeTaskRegistry();
  cousinRegistry.register(task("agent_cousin"));
  registerTreeAddress({
    entry: { agentId: "agent_cousin", childSessionId: "sess_sc", registry: cousinRegistry },
    rootKey: "sess_tree1",
  });
  const { mirrors, port } = makePort({ treeRootKey: "sess_tree1" });
  const result = await send(port, "agent_cousin");
  assert.equal(result.status, "success");
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].metadata.peerMessage.delivery, "queued");
  assert.equal(mirrors[0].metadata.peerMessage.to, "agent_cousin");
  assert.equal(mirrors[0].metadata.peerMessage.toAgentSessionId, "sess_sc");
  assert.equal(mirrors[0].metadata.peerMessage.parentSessionId, "sess_parent");

  const failing = makePort({
    mirror: async () => {
      throw new Error("mirror store unavailable");
    },
    treeRootKey: "sess_tree1",
  });
  const still = await send(failing.port, "agent_cousin");
  assert.equal(still.status, "success");
});

test("(场景8) 缺省负向：port 无 treeAddressing option 时不查树表（P0/P1 行为不变）", async () => {
  const received = [];
  const uncleRegistry = new InMemoryRuntimeTaskRegistry();
  uncleRegistry.register(task("agent_uncle", { messageSink: sinkRecording(received) }));
  registerTreeAddress({
    entry: { agentId: "agent_uncle", childSessionId: "sess_su", registry: uncleRegistry },
    rootKey: "sess_tree1",
  });
  const { port } = makePort({});
  const result = await send(port, "agent_uncle");
  assert.equal(result.status, "failed");
  assert.match(result.error, /No sibling agent agent_uncle is reachable/);
  assert.equal(received.length, 0);
});

test("(场景7) 装配守护：登记在预算 claim 之后、注销在 settle 单点、rootKey 在 flag 条件块内且无深度条件、child config 透传、listPeers 未扩", async () => {
  const runnerSource = await read("packages/core/src/subagent/runner.ts");
  const claimIdx = runnerSource.indexOf("const claim = claimTreeBudgetSlot({");
  const registerIdx = runnerSource.indexOf("registerTreeAddress({");
  assert.ok(claimIdx !== -1 && registerIdx > claimIdx, "register must sit after budget claim");
  assert.ok(
    runnerSource.includes(
      'if (edgeCommand?.kind === "settle" && options.treeAddressingRootKey !== undefined) {\n    unregisterTreeAddress({',
    ),
    "unregister must sit in the settle single-exit branch",
  );

  const subagentSource = await read("packages/core/src/runtime/methods/subagent.ts");
  const flagIdx = subagentSource.indexOf("this.config.subagents?.peerMessaging?.enabled === true");
  const keyIdx = subagentSource.indexOf("treeAddressingRootKey: String(this.config.rootSessionId ?? this.sessionId)");
  assert.ok(flagIdx !== -1 && keyIdx > flagIdx, "rootKey must live inside the peerMessaging conditional");
  assert.equal(
    subagentSource.split("treeAddressingRootKey").length - 1,
    1,
    "exactly one wiring point, no depth-conditional duplicate",
  );
  assert.ok(
    subagentSource.includes("{ peerMessaging: this.config.subagents.peerMessaging }"),
    "child config must propagate the peerMessaging flag (R6)",
  );

  const peerSource = await read("packages/core/src/subagent/peer-messaging.ts");
  assert.ok(
    peerSource.includes("return siblingTasks().map((task) => ({"),
    "listPeers must stay a same-parent sibling projection (no tree enumeration)",
  );
});
