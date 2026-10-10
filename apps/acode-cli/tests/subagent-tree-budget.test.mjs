import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

/**
 * 编排方案 Phase 4 第二批验收（specs/subagent-nesting-budget.md R4/R5 + 场景 7/8）：
 * 树级预算三闸（总量/积压/token，键=树根、结构化拒绝、释放幂等）、§6.1 闲时轮 deny
 * 门的谱系继承、以及 §6.2 级联停止 / §6.3 双重镜像抑制的接线不变量。
 */

const {
  TREE_BUDGET_CAPS,
  claimTreeBudgetSlot,
  recordTreeBudgetTokens,
  releaseTreeBudgetSlot,
  resetTreeBudgetForTest,
} = await import("../packages/core/src/subagent/tree-budget.ts");
const { createExploreSubagentPort } = await import("../packages/core/src/subagent/runner.ts");
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

beforeEach(() => resetTreeBudgetForTest());

test("(R4) 三闸独立判定：积压闸拒绝第 17 个在飞，释放一个即恢复", () => {
  const rootKey = "sess_root_a";
  for (let i = 0; i < TREE_BUDGET_CAPS.maxLiveAgentsPerTree; i++) {
    const claim = claimTreeBudgetSlot({ agentId: `agent_${i}`, rootKey });
    assert.equal(claim.ok, true, `live claim ${i}`);
  }
  const overflow = claimTreeBudgetSlot({ agentId: "agent_over", rootKey });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, "live");
  assert.equal(overflow.cap, TREE_BUDGET_CAPS.maxLiveAgentsPerTree);

  releaseTreeBudgetSlot({ agentId: "agent_3", rootKey });
  assert.equal(claimTreeBudgetSlot({ agentId: "agent_next", rootKey }).ok, true);
  // 释放幂等 + 未知根 no-op
  releaseTreeBudgetSlot({ agentId: "agent_3", rootKey });
  releaseTreeBudgetSlot({ agentId: "ghost", rootKey: "sess_never_seen" });
});

test("(R4) 总量闸：累计派发（含重臂）越顶后结构化拒绝", () => {
  const rootKey = "sess_root_b";
  for (let i = 0; i < TREE_BUDGET_CAPS.maxAgentsPerTree; i++) {
    // claim+release 循环：绕开积压闸，专测总量口径（重臂 = 每次派发都计数）
    assert.equal(claimTreeBudgetSlot({ agentId: `agent_${i % 8}`, rootKey }).ok, true);
    releaseTreeBudgetSlot({ agentId: `agent_${i % 8}`, rootKey });
  }
  const overflow = claimTreeBudgetSlot({ agentId: "agent_final", rootKey });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, "agents");
  assert.equal(overflow.current, TREE_BUDGET_CAPS.maxAgentsPerTree);
});

test("(R4) token 事后闸：累计越顶后拒绝新派发；非正值忽略；键相互隔离", () => {
  const rootKey = "sess_root_c";
  recordTreeBudgetTokens({ rootKey, tokens: TREE_BUDGET_CAPS.maxTokensPerTree });
  const blocked = claimTreeBudgetSlot({ agentId: "agent_x", rootKey });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "tokens");
  // 非正值/非有限值忽略
  recordTreeBudgetTokens({ rootKey, tokens: 0 });
  recordTreeBudgetTokens({ rootKey, tokens: Number.NaN });
  // 键隔离：另一棵树不受影响
  assert.equal(claimTreeBudgetSlot({ agentId: "agent_y", rootKey: "sess_root_d" }).ok, true);
});

test("(R5-1/§6.1) offPeakInherited：无显式 modelOverride 也拒绝 background 派发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-offpeak-"));
  try {
    const makePort = (overrides = {}) =>
      createExploreSubagentPort({
        emitParentEvent: async () => undefined,
        outputRootDir: dir,
        profiles: [{ description: "p", name: "probe", source: "user", systemPrompt: "p" }],
        runExploreAgent: async (request) => {
          await request.onSessionReady?.();
          return { events: [], response: "done", traceId: request.traceContext.traceId };
        },
        ...overrides,
      });
    const launchRequest = {
      agentType: "probe",
      description: "d",
      parentToolCallId: "call_1",
      prompt: "p",
      runInBackground: true,
      sessionId: createSessionId("sess_offpeak"),
      trace: { traceId: createTraceId() },
      workingDirectory: dir,
      workspaceRoot: dir,
    };

    // 继承标志在场：无显式 override 也拒绝（孙层泄漏封堵）
    const inherited = makePort({ offPeakInherited: true });
    await assert.rejects(
      inherited.launch(launchRequest),
      /Idle-time tasks do not support background agents/,
    );

    // 显式 deny（既有 depth-1 门）回归不变
    const explicit = makePort();
    await assert.rejects(
      explicit.launch(launchRequest, {
        modelOverride: { background: "deny", selection: { modelId: "m", providerId: "p" } },
      }),
      /Idle-time tasks do not support background agents/,
    );

    // 两者都缺席：background 派发照常（现状零回归）
    const normal = makePort();
    const output = await normal.launch(launchRequest);
    assert.equal(output.status, "async_launched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R4) 端口级准入：树级预算耗尽时 run 被结构化拒绝（TREE_BUDGET_EXCEEDED）", async () => {
  resetTreeBudgetForTest();
  const dir = mkdtempSync(join(tmpdir(), "acode-treebudget-"));
  try {
    const rootKey = "sess_root_port";
    for (let i = 0; i < TREE_BUDGET_CAPS.maxLiveAgentsPerTree; i++) {
      claimTreeBudgetSlot({ agentId: `prefill_${i}`, rootKey });
    }
    const port = createExploreSubagentPort({
      emitParentEvent: async () => undefined,
      outputRootDir: dir,
      profiles: [{ description: "p", name: "probe", source: "user", systemPrompt: "p" }],
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return { events: [], response: "done", traceId: request.traceContext.traceId };
      },
      treeBudgetRootKey: rootKey,
    });
    const result = await port
      .run({
        agentType: "probe",
        description: "d",
        parentToolCallId: "call_1",
        prompt: "p",
        sessionId: createSessionId("sess_budget_parent"),
        trace: { traceId: createTraceId() },
        workingDirectory: dir,
        workspaceRoot: dir,
      })
      .then((output) => ({ output }))
      .catch((error) => ({ error }));
    const text = result.error
      ? String(result.error.message ?? result.error)
      : JSON.stringify(result.output);
    assert.match(text, /tree budget exceeded/i, `未结构化拒绝：${text.slice(0, 200)}`);
  } finally {
    resetTreeBudgetForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R4/R5) 接线不变量：单点准入、settle 单点释放、deny 谱系、镜像抑制、级联停止", async () => {
  const runner = await read("packages/core/src/subagent/runner.ts");
  // 单一准入点在执行原语顶部（三路全经）
  const admissionIdx = runner.indexOf("claimTreeBudgetSlot({");
  const primitiveIdx = runner.indexOf("async function runAgentToCompletion(");
  assert.ok(admissionIdx > primitiveIdx, "准入不在 runAgentToCompletion 内");
  assert.ok(/AgentErrorCode\.TREE_BUDGET_EXCEEDED/.test(runner), "缺结构化错误码");
  // settle 单点释放 + token 记账（emitSubagentEvent 内）
  const emitIdx = runner.indexOf("async function emitSubagentEvent(");
  const releaseIdx = runner.indexOf("releaseTreeBudgetSlot(");
  assert.ok(releaseIdx > emitIdx, "释放不在 emitSubagentEvent 单点");
  assert.ok(/recordTreeBudgetTokens\(/.test(runner.slice(emitIdx)));
  // deny 门按「有效 override」判定
  assert.ok(
    /launchOptions\?\.modelOverride\?\.background === "deny" \|\| options\.offPeakInherited === true/.test(
      runner,
    ),
    "deny 门未纳入继承事实",
  );

  const subagent = await read("packages/core/src/runtime/methods/subagent.ts");
  // 预算键 = 树根（rootSessionId ?? 自身）
  assert.ok(
    /treeBudgetRootKey: String\(this\.config\.rootSessionId \?\? this\.sessionId\)/.test(subagent),
    "预算键不是树根",
  );
  // §6.1 事实置位与继承
  assert.ok(/offPeakSubagentExecution: true/.test(subagent));
  assert.ok(/offPeakInherited: true/.test(subagent));
  // §6.3 双重镜像抑制：直接子会话判定 + 镜像产物判定，两者同时成立才镜像
  assert.ok(/const isDirectChildEvent = String\(event\.sessionId\) === String\(request\.sessionId\);/.test(subagent));
  assert.ok(/\?\.source === "subagent"/.test(subagent));
  assert.ok(/isDirectChildEvent && !isAlreadyMirrored/.test(subagent));
  // §6.2 级联停止挂在 child turn 的 finally
  assert.ok(/childRuntime\.stopInFlightSubagentTasks\(\{/.test(subagent));

  const background = await read("packages/core/src/runtime/methods/background.ts");
  assert.ok(/export async function stopInFlightSubagentTasks\(/.test(background));
  assert.ok(/task\.type === "local_agent" && task\.status === "running"/.test(background));

  const methodsIndex = await read("packages/core/src/runtime/methods/index.ts");
  assert.ok(/proto\.stopInFlightSubagentTasks = stopInFlightSubagentTasks;/.test(methodsIndex));

  const contractsAgent = await read("packages/contracts/src/tools/agent.ts");
  assert.ok(/TREE_BUDGET_EXCEEDED: "agent_tree_budget_exceeded"/.test(contractsAgent));
});
