// 真子进程 → 真适配器 → 真 reducer 的端到端投影验证。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R12。
//
// 为什么需要这一条（它补的是别的测试补不到的那个缝）：
//   - script-workflow-sandbox.test.mjs 真的 spawn 子进程，但它只看子进程自己的返回值与
//     agent 请求，不看投影；
//   - script-workflow-progress-projection.test.mjs 真的过 reducer，但它喂的是**手写**载荷。
// 两者之间那段——「子进程实际发出的事件形状」是否等于「适配器以为的形状」——此前无人验证。
// 这段特别容易错，因为子进程的事件是由一份**字符串模板**（script-workflow-child-source.ts）
// 生成的：改了模板里的键名，手写夹具照样绿，投影却静默变空。
//
// 这里让真的子进程跑一段带 phase() / log() / parallel() / agent() 的脚本，把它发出的事件按
// runtime 的同一条规则（`script_${type}`）转给真适配器，再归约进真 reducer。
// agent 相关的 activity_* 事件由 handleRequest 桩按 runtime 的字段发，但 **callPath 取自子进程
// 送来的真值**（那是节点身份的来源，也是最不该被手写死的一个字段）。
//
// 只有 agent 的**执行**是桩（真跑要模型凭据），事件的形状与身份全是真的。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { runScriptWorkflowChild } = await import(
  "../packages/cli-workflow/src/script-workflow-process.ts"
);
const { createScriptWorkflowProgressAdapter } = await import(
  "../packages/cli-workflow/src/script-workflow-progress-adapter.ts"
);
const { reduceWorkflowRunsState } = await import(
  "../../../packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts"
);

const RUN_ID = "wf_e2e-projection";
const TOOL_CALL_ID = "tc_e2e";

/** 造一份最小合法的脚本文档；body 是**已剥掉 meta 头**的正文（与生产一致）。 */
function makeDocument(body, dir) {
  return {
    body,
    content: body,
    hash: "e2e-hash",
    meta: { description: "d", name: "n", phases: [] },
    path: join(dir, "script.workflow.js"),
  };
}

/**
 * 跑一段真脚本，把它的事件流灌进真适配器与真 reducer，返回最终的投影与上线的信封。
 */
async function projectScript(body, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "script-workflow-e2e-"));
  const envelopes = [];
  let state;

  const adapter = createScriptWorkflowProgressAdapter({
    emit: (progress) => {
      envelopes.push(progress);
      const next = reduceWorkflowRunsState(state, progress);
      if (next) state = next;
    },
  });
  adapter.registerRun({ parentSessionId: "sess_parent", runId: RUN_ID, toolCallId: TOOL_CALL_ID });

  /** runtime 的 handleChildEvent 就是这一行前缀变换；照抄，不另立规则。 */
  const forward = (type, payload) => adapter.onEvent({ payload, runId: RUN_ID, type });

  try {
    forward("workflow_started", { scriptPath: join(dir, "script.workflow.js") });
    let agentIndex = 0;
    const result = await runScriptWorkflowChild({
      document: makeDocument(body, dir),
      handleEvent: (event) => forward(`script_${event.type}`, event.payload),
      handleRequest: async (request) => {
        if (request.type !== "agent") return null;
        const { callPath, label, phase, prompt } = request.payload;
        const activityId = `act_${(agentIndex += 1)}`;
        // 按 runtime 的字段发，但 callPath / label / phase 全取子进程送来的真值。
        forward("activity_started", {
          activityId,
          callPath,
          childSessionId: `sess_child_${agentIndex}`,
          label: label ?? prompt,
          phase,
        });
        if (options.failAgent === true) {
          forward("activity_failed", {
            activityId,
            callPath,
            error: { message: "stubbed failure" },
            label: label ?? prompt,
            phase,
          });
          throw new Error("stubbed failure");
        }
        forward("activity_completed", {
          activityId,
          callPath,
          label: label ?? prompt,
          phase,
        });
        return { stats: { tokens: { total: 10 } }, value: `ok:${prompt}` };
      },
      runId: RUN_ID,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      workingDirectory: dir,
    });
    forward("workflow_completed", { result: result.value });
    return { dir: undefined, envelopes, run: state?.runs.find((entry) => entry.runId === RUN_ID), state, value: result.value };
  } catch (error) {
    forward(options.cancelled === true ? "workflow_cancelled" : "workflow_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { envelopes, error, run: state?.runs.find((entry) => entry.runId === RUN_ID), state };
  } finally {
    adapter.forgetRun(RUN_ID);
    await rm(dir, { force: true, recursive: true });
  }
}

test("真子进程的 phase() 与 log() 事件形状与适配器一致，投影里真的长出阶段与日志", async () => {
  const { run, envelopes } = await projectScript(`
    phase("Collect");
    log("collecting items");
    const a = await agent("one", { label: "finder:1" });
    phase("Verify");
    log("verifying");
    const b = await agent("two", { label: "verifier:1" });
    return { a, b };
  `);

  // 子进程发的是 {title} 与 {message}——这两个键名住在一份字符串模板里，
  // 手写夹具永远不会发现自己抄错了，只有真跑一遍才知道。
  const types = envelopes.map((entry) => entry.eventType);
  assert.ok(types.includes("phase-entered"), `阶段事件缺席，实际收到：${types.join(", ")}`);
  assert.ok(types.includes("log"), `日志事件缺席，实际收到：${types.join(", ")}`);

  const phases = envelopes
    .filter((entry) => entry.eventType === "phase-entered")
    .map((entry) => entry.payload.name);
  assert.deepEqual(phases, ["Collect", "Verify"], "phase() 的标题必须原样到达投影");

  const logs = envelopes
    .filter((entry) => entry.eventType === "log")
    .map((entry) => entry.payload.message);
  assert.deepEqual(logs, ["collecting items", "verifying"]);

  assert.equal(run.status, "completed");
  assert.equal(run.dialect, "script");
  assert.equal(run.toolCallId, TOOL_CALL_ID, "卡片靠它联接到发起它的那一行工具调用");
});

test("真子进程的 parallel() 给出唯一 callPath，投影里每个子代理各有身份与会话", async () => {
  const { run } = await projectScript(`
    const results = await parallel([
      async () => await agent("a", { label: "finder:a" }),
      async () => await agent("b", { label: "finder:b" }),
      async () => await agent("c", { label: "finder:c" }),
    ]);
    return results;
  `);

  assert.equal(run.status, "completed");
  assert.equal(run.actors.length, 3, "三个并发 agent 必须各自坐上名册");
  // siteId 就是子进程送来的 callPath：它同时是 resume 缓存键的一部分，
  // 所以「缓存认得、投影认不得」的裂缝只能靠真跑一遍才排得掉。
  const siteIds = run.actors.map((actor) => actor.siteId).sort();
  assert.deepEqual(siteIds, [
    "root/parallel0/item0/agent0",
    "root/parallel0/item1/agent0",
    "root/parallel0/item2/agent0",
  ]);
  // 子代理会话 id 走信封顶层才落得进投影（本轮修的缺陷 1）。
  assert.equal(
    run.actors.filter((actor) => typeof actor.sessionId === "string").length,
    3,
    "每个子代理都要能点开自己的转写",
  );
  assert.equal(run.nodes.length, 3);
});

test("真子进程里 agent 失败 → 投影是 errored，而不是停在 running", async () => {
  const { run } = await projectScript(`await agent("boom");`, { failAgent: true });
  // 终态词错了的话，闭集校验会把整帧丢掉，UI 永远停在 running——那是静默失败。
  assert.equal(run.status, "errored");
  assert.equal(run.nodes.length, 1, "失败的那一步也要坐上表，否则看不出是哪里断的");
});
