import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 编排方案 R5/R6 验收（apps/acode-cli/specs/subagent-interaction-origin-lineage.md
 * 场景 1-5、7）：broker 包装链的谱系合并——depth 1 origin 与历史结构逐字节一致
 * （无新键）；depth≥2 时外层逐层 append ancestors 并覆写 rootSessionId（外层后写 =
 * 根锚定的机械保证）；发起者归属永不被外层覆盖；builder/mirror/徽章零波及。
 */

const { createSubagentInteractionBroker } = await import(
  "../packages/core/src/runtime/helpers/subagent-interaction-broker.ts"
);
const { buildSubagentInteractionOrigin } = await import(
  "../packages/core/src/subagent/interaction-origin.ts"
);

const cliRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (base, path) =>
  readFile(new URL(path, base), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const ctx = (name, session, parentSession, extra = {}) => ({
  agentId: `agent_${name}`,
  agentType: "general-purpose",
  childSessionId: session,
  description: `probe ${name}`,
  parentSessionId: parentSession,
  ...extra,
});

function makeRootBroker() {
  const captured = [];
  return {
    captured,
    port: {
      requestPermission: async (request) => {
        captured.push(request);
        return { decision: "allow", resolvedAt: new Date() };
      },
    },
  };
}

const baseRequest = (sessionId) => ({
  input: {},
  reason: "probe",
  requestId: "req_1",
  riskLevel: "low",
  sessionId,
  toolCallId: "tc_1",
  toolName: "Bash",
  turnId: "turn_child",
});

test("(场景1) depth1：origin 与 builder 直出逐字节一致，无 ancestors/rootSessionId 键", async () => {
  const rootBroker = makeRootBroker();
  const contextA = ctx("a", "sess_sa", "sess_root", {
    parentToolCallId: "tc_spawn_a",
    parentTurnId: "turn_root",
  });
  const broker = createSubagentInteractionBroker(rootBroker.port, contextA);
  await broker.requestPermission(baseRequest("sess_sa"));

  const sent = rootBroker.captured[0];
  assert.equal(sent.sessionId, "sess_root", "sessionId 外层后写 = 根会话（既有语义回归）");
  assert.deepStrictEqual(sent.origin, buildSubagentInteractionOrigin(contextA, "turn_child"));
  assert.ok(!("ancestors" in sent.origin), "depth1 不得出现 ancestors 键（R0）");
  assert.ok(!("rootSessionId" in sent.origin), "depth1 不得出现 rootSessionId 键（R0）");
});

test("(场景2) depth2：发起者扁平视角 + ancestors=[父层] + rootSessionId=根，不变量成立", async () => {
  const rootBroker = makeRootBroker();
  const brokerA = createSubagentInteractionBroker(
    rootBroker.port,
    ctx("a", "sess_sa", "sess_root", { parentToolCallId: "tc_spawn_a" }),
  );
  const brokerB = createSubagentInteractionBroker(brokerA, ctx("b", "sess_sb", "sess_sa"));
  await brokerB.requestPermission(baseRequest("sess_sb"));

  const sent = rootBroker.captured[0];
  assert.equal(sent.sessionId, "sess_root");
  const origin = sent.origin;
  assert.equal(origin.agentId, "agent_b", "归属 = 真正发起者，不被外层覆盖");
  assert.equal(origin.parentSessionId, "sess_sa");
  assert.equal(origin.ancestors.length, 1);
  assert.equal(origin.ancestors[0].agentId, "agent_a");
  assert.equal(origin.ancestors[0].sessionId, "sess_sa");
  assert.equal(origin.ancestors[0].parentSessionId, "sess_root");
  assert.equal(origin.ancestors[0].parentToolCallId, "tc_spawn_a");
  assert.equal(origin.rootSessionId, "sess_root");
  // R1 不变量：链首接发起者的父，链尾接根。
  assert.equal(origin.ancestors[0].sessionId, origin.parentSessionId);
  assert.equal(origin.ancestors.at(-1).parentSessionId, origin.rootSessionId);
});

test("(场景3) depth3：ancestors 内→外序、链路连续、rootSessionId = 最外层后写", async () => {
  const rootBroker = makeRootBroker();
  const brokerA = createSubagentInteractionBroker(rootBroker.port, ctx("a", "sess_sa", "sess_root"));
  const brokerB = createSubagentInteractionBroker(brokerA, ctx("b", "sess_sb", "sess_sa"));
  const brokerC = createSubagentInteractionBroker(brokerB, ctx("c", "sess_sc", "sess_sb"));
  await brokerC.requestPermission(baseRequest("sess_sc"));

  const sent = rootBroker.captured[0];
  assert.equal(sent.sessionId, "sess_root");
  const origin = sent.origin;
  assert.equal(origin.agentId, "agent_c");
  assert.deepEqual(
    origin.ancestors.map((layer) => layer.agentId),
    ["agent_b", "agent_a"],
    "ancestors 必须内→外排序",
  );
  assert.equal(origin.parentSessionId, origin.ancestors[0].sessionId);
  assert.equal(origin.ancestors[0].parentSessionId, origin.ancestors[1].sessionId);
  assert.equal(origin.ancestors.at(-1).parentSessionId, origin.rootSessionId);
  assert.equal(origin.rootSessionId, "sess_root");
});

test("(场景4) 调用方预置 origin：外层仍 append，发起者字段不被触碰", async () => {
  const rootBroker = makeRootBroker();
  const brokerA = createSubagentInteractionBroker(rootBroker.port, ctx("a", "sess_sa", "sess_root"));
  const preset = {
    kind: "subagent",
    agentId: "agent_preset",
    agentType: "Explore",
    childSessionId: "sess_preset",
    parentSessionId: "sess_sa",
  };
  await brokerA.requestPermission({ ...baseRequest("sess_sa"), origin: preset });

  const origin = rootBroker.captured[0].origin;
  assert.equal(origin.agentId, "agent_preset");
  assert.equal(origin.agentType, "Explore");
  assert.equal(origin.childSessionId, "sess_preset");
  assert.equal(origin.ancestors.length, 1);
  assert.equal(origin.ancestors[0].agentId, "agent_a");
  assert.equal(origin.rootSessionId, "sess_root");
});

test("(场景5) builder 零波及：buildSubagentInteractionOrigin 输出键集合不含新字段", () => {
  const origin = buildSubagentInteractionOrigin(
    ctx("a", "sess_sa", "sess_root"),
    "turn_child",
  );
  assert.deepEqual(Object.keys(origin).sort(), [
    "agentId",
    "agentType",
    "childSessionId",
    "childTurnId",
    "description",
    "kind",
    "parentSessionId",
  ]);
});

test("(场景7) 源文本守护：投影收集 ancestors；徽章谱系展示已随 P2b 收口", async () => {
  const projection = await read(
    cliRoot,
    "packages/bootstrap/src/acode-protocol-v4/product-projection.ts",
  );
  assert.ok(
    projection.includes(
      "for (const ancestor of origin.ancestors ?? []) waitingChildIds.add(ancestor.sessionId);",
    ),
    "waitingChildIds must collect ancestor sessions (R5)",
  );
  // R6 批次时此处断言徽章「未被触碰」（展示归 P2b）；P2b（db91911 批次）已收口：
  // 徽章 tooltip 在 ancestors 在场时显示谱系链——守护随之反转为正向断言。
  const badge = await read(repoRoot, "packages/ui/src/InteractionRequestOriginBadge.tsx");
  assert.ok(
    badge.includes("origin.ancestors") &&
      badge.includes("chat.interactionOrigin.subagent.nestedTitle"),
    "badge must render the ancestor chain tooltip (P2b closure of R5 display)",
  );
});
