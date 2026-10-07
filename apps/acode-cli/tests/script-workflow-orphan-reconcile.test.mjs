// 孤儿脚本工作流 run 的构造期收敛。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R16。
//
// 被钉住的问题：run 起跑后宿主进程被关掉，`workflow_run` 行就**永远停在 running**。
// 每个读面都照行回答——scriptWorkflowStatus 说「还在跑」、后台任务快照说「还在跑」、
// 冷回放把这条行原样投影出来于是卡片亮灯、Cancel 可点而后端无事可取消。永不自愈。
// 实测这个状态真实存在：开发库里就有一条 wf_a33b872a… 停在 running，是宿主被外部
// timeout 打死的遗物。
//
// 这些是行为级断言（假 store 记录每一次写），只有「构造期被调用」那一条是接线断言。

import assert from "node:assert/strict";
import test from "node:test";

const { reconcileOrphanScriptWorkflowRuns } = await import(
  "../packages/bootstrap/src/app/script-workflow-reconcile.ts"
);

const SESSION = "sess_owner-1";

function fakeStore({ rows = [], failList = false, failOn = undefined } = {}) {
  const updates = [];
  return {
    updates,
    store: {
      async listScriptWorkflowRuns(input) {
        if (failList) throw new Error("db locked");
        fakeStore.lastInput = input;
        return rows;
      },
      async updateScriptWorkflowRun(input) {
        if (failOn !== undefined && input.id === failOn) throw new Error("readonly db");
        updates.push(input);
        return input;
      },
    },
  };
}

const row = (id, status = "running") => ({ id, name: id, status, updatedAt: 0 });

test("非终态行收敛成物理 cancelled + 结构化 interrupted code", async () => {
  const { store, updates } = fakeStore({ rows: [row("wf_orphan-1", "running")] });
  await reconcileOrphanScriptWorkflowRuns({ parentSessionId: SESSION, store });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "wf_orphan-1");
  // 物理词只能是 CHECK 约束里那六个之一——`interrupted` 不在其中，写它会被真实库当场拒掉
  // （`CHECK constraint failed: status in`）。这条是**对着真实库跑**才炸出来的：假 store
  // 没有约束，类型也全绿。逻辑上的「宿主没了」由 failure 的结构化 code 承载。
  assert.equal(updates[0].status, "cancelled");
  assert.equal(updates[0].failure.code, "ScriptWorkflowInterrupted");
  assert.match(updates[0].failure.message, /owning process exited before the run settled/);
  assert.ok(updates[0].completedAt > 0, "终态行必须有 completedAt，否则时长读面算不出来");
});

test("用户取消与宿主死亡共用物理词，但靠 code 可分辨（不读 message 文本）", async () => {
  const { logicalScriptWorkflowStatus } = await import(
    "../packages/bootstrap/src/app/script-workflow-run-status.ts"
  );
  // dwf 对同一件事的裁决：「同码就只能靠 message 文本区分」是被明确拒绝的做法。
  assert.equal(
    logicalScriptWorkflowStatus({ status: "cancelled" }),
    "cancelled",
    "无 failure 的 cancelled 就是用户停的（runtime 刻意不给取消写 failure）",
  );
  assert.equal(
    logicalScriptWorkflowStatus({
      failure: { code: "ScriptWorkflowInterrupted", message: "…" },
      status: "cancelled",
    }),
    "interrupted",
  );
  // code 不命中就退回物理词：一个拼错的 code 不该把用户取消改判成进程死亡。
  assert.equal(
    logicalScriptWorkflowStatus({ failure: { code: "SomethingElse" }, status: "cancelled" }),
    "cancelled",
  );
  // message 文本改写成什么都不影响判定。
  assert.equal(
    logicalScriptWorkflowStatus({
      failure: { code: "ScriptWorkflowInterrupted", message: "user cancelled" },
      status: "cancelled",
    }),
    "interrupted",
  );
  // 其余物理词原样透传。
  for (const status of ["pending", "running", "paused", "completed", "failed"]) {
    assert.equal(logicalScriptWorkflowStatus({ status }), status);
  }
});

test("查询按会话作用域 + 只捞非终态 + 有上界", async () => {
  const { store } = fakeStore({ rows: [] });
  await reconcileOrphanScriptWorkflowRuns({ parentSessionId: SESSION, store });
  const input = fakeStore.lastInput;
  // 全局清扫会把同进程兄弟会话正在飞的 run 标死——作用域是这条规则的全部意义。
  assert.equal(input.parentSessionId, SESSION);
  assert.deepEqual([...input.statuses].sort(), ["paused", "pending", "running"]);
  assert.ok(input.limit > 0, "一次构造不该因为一张病态的历史表而无限写下去");
});

test("查询失败只记 warn，不抛（收敛是自愈动作，不是 app 构造的前提）", async () => {
  const warnings = [];
  const { store } = fakeStore({ failList: true });
  await reconcileOrphanScriptWorkflowRuns({
    logger: { warn: (message, context) => warnings.push([message, context?.event]) },
    parentSessionId: SESSION,
    store,
  });
  assert.deepEqual(warnings, [
    ["Script workflow orphan run query failed", "script_workflow.run.reconcile_query_failed"],
  ]);
});

test("单行写失败不牵连其余", async () => {
  const warnings = [];
  const { store, updates } = fakeStore({
    failOn: "wf_bad-1",
    rows: [row("wf_bad-1"), row("wf_ok-1"), row("wf_ok-2")],
  });
  await reconcileOrphanScriptWorkflowRuns({
    logger: { warn: (message, context) => warnings.push([message, context?.runId]) },
    parentSessionId: SESSION,
    store,
  });
  assert.deepEqual(updates.map((entry) => entry.id), ["wf_ok-1", "wf_ok-2"]);
  assert.deepEqual(warnings, [
    ["Script workflow orphan run reconciliation failed for one run", "wf_bad-1"],
  ]);
});

test("构造期真的接上了（桥一建就发射收敛，且 store 不支持时跳过）", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../packages/bootstrap/src/app/script-workflow-methods.ts", import.meta.url),
    "utf8",
  );
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.match(code, /if \(isScriptWorkflowStore\(deps\.sessionStore\)\) \{/);
  assert.match(code, /void reconcileOrphanScriptWorkflowRuns\(\{/);
  // 发射后不管的前提是那个函数永不 reject：它把查询失败与单行写失败都 catch 成 warn，
  // 否则这里会留下一个未处理的 promise 拒绝。
  assert.match(
    code,
    /parentSessionId: deps\.sessionId/,
    "作用域必须是本会话，不能是全局",
  );
});
