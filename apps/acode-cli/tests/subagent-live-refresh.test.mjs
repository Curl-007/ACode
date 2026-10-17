import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * GAP-A 闭环验收（specs/agent-teams-derived-config.md R7 / 场景 7）：
 * 派生边界（launch/run/start）在 loadCurrentProfiles 在场时必须消费**最新**快照，
 * loader 抛错必须 fail-closed 拒绝派生；loader 缺席时行为与现状一致（启动快照）。
 * 另钉住 R4 的 resolveSubagentSelection fail-closed guard（requireExplicitModelSelection）。
 *
 * harness 沿 subagent-background-tristate.test.mjs 的桩件模式：假 runExploreAgent
 * 自然收尾，output.status 即「走了哪条边界」的观测点。
 */

const { createExploreSubagentPort } = await import(
  "../packages/core/src/subagent/runner.ts"
);
const { resolveSubagentSelection } = await import(
  "../packages/core/src/runtime/helpers/subagent-selection.ts"
);
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

function makeProfile(overrides = {}) {
  return {
    description: "probe agent",
    name: "probe-agent",
    source: "user",
    systemPrompt: "probe",
    ...overrides,
  };
}

function makePort(dir, options) {
  const executed = [];
  const port = createExploreSubagentPort({
    outputRootDir: dir,
    runExploreAgent: async (request) => {
      executed.push(request.agentType);
      await request.onSessionReady?.();
      return {
        events: [],
        response: "probe finished",
        traceId: request.traceContext.traceId,
      };
    },
    emitParentEvent: async () => undefined,
    ...options,
  });
  return { port, executed };
}

function launchRequest(dir, agentType = "probe-agent", runInBackground) {
  return {
    agentType,
    description: "probe run",
    parentToolCallId: "toolu_probe",
    prompt: "probe",
    sessionId: createSessionId("sess_live_refresh"),
    trace: { traceId: createTraceId() },
    workingDirectory: dir,
    workspaceRoot: dir,
    ...(runInBackground === undefined ? {} : { runInBackground }),
  };
}

test("(R7) loader 在场：派生用最新快照——新 agent 立即可派发，删除的立即失效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-live-refresh-"));
  try {
    let liveProfiles = [
      makeProfile(),
      makeProfile({ name: "live-added", description: "会话中新建" }),
    ];
    let loaderCalls = 0;
    const { port, executed } = makePort(dir, {
      profiles: [makeProfile()],
      loadCurrentProfiles: async () => {
        loaderCalls += 1;
        return { profiles: liveProfiles };
      },
    });

    // 启动快照里没有 live-added；live 快照有 → 派生成功（会话中新建即生效）。
    const output = await port.launch(launchRequest(dir, "live-added", false));
    assert.equal(output.status, "completed");
    assert.deepEqual(executed, ["live-added"]);
    assert.ok(loaderCalls > 0, "launch 边界必须消费 loader");

    // 用户删除 live-added 后：下一次派生立即拒绝（不等重启）。
    liveProfiles = [makeProfile()];
    await assert.rejects(
      port.launch(launchRequest(dir, "live-added", false)),
      (error) => {
        assert.match(error.message, /not found/u);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R7) run 与 start 边界同样消费 loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-live-refresh-"));
  try {
    const liveProfiles = [makeProfile({ name: "live-added" })];
    let loaderCalls = 0;
    const { port } = makePort(dir, {
      profiles: [],
      loadCurrentProfiles: async () => {
        loaderCalls += 1;
        return { profiles: liveProfiles };
      },
    });

    // run 边界：启动快照为空，只有 live 快照能解析出 live-added。
    const ran = await port.run(launchRequest(dir, "live-added"));
    assert.equal(ran.status, "completed");
    assert.ok(loaderCalls > 0);

    // start 边界（经 launch 的 background 分支）：同样从 live 快照解析。
    const before = loaderCalls;
    const started = await port.launch(launchRequest(dir, "live-added", true));
    assert.equal(started.status, "async_launched");
    assert.ok(loaderCalls > before, "start 边界必须消费 loader");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R7) live 快照的内置覆盖参与派发解析（bundled 成员语义由 bootstrap 侧测试钉住）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-live-refresh-"));
  try {
    // 快照携带 builtInModelSelectionOverrides 时，normalizeAgentProfiles 用它播种
    // 核心二内置——general-purpose 派发拿到的 modelSelection 来自最新覆盖。
    const selection = { providerId: "provider-live", modelId: "model-live" };
    let captured;
    const port = createExploreSubagentPort({
      outputRootDir: dir,
      profiles: [],
      loadCurrentProfiles: async () => ({
        builtInModelSelectionOverrides: { "general-purpose": selection },
        profiles: [],
      }),
      runExploreAgent: async (request) => {
        captured = request.profile;
        await request.onSessionReady?.();
        return { events: [], response: "ok", traceId: request.traceContext.traceId };
      },
      emitParentEvent: async () => undefined,
    });
    await port.launch(launchRequest(dir, "general-purpose", false));
    assert.deepEqual(captured?.modelSelection, selection);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R7) loader 抛错：派生被拒绝、错误原样上抛、不触达子运行时", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-live-refresh-"));
  try {
    const configError = new Error(
      "Subagent state field is malformed (disabledAgentIds): /state.json. Correct this entry in Subagents settings before starting a new agent.",
    );
    const { port, executed } = makePort(dir, {
      profiles: [makeProfile()],
      loadCurrentProfiles: async () => {
        throw configError;
      },
    });

    // fail-closed：不回退启动快照（启动快照里 probe-agent 明明可解析）。
    await assert.rejects(port.launch(launchRequest(dir, "probe-agent", false)), (error) => {
      assert.equal(error, configError, "错误必须原样上抛，不吞不换");
      return true;
    });
    await assert.rejects(port.run(launchRequest(dir, "probe-agent")), (error) => {
      assert.equal(error, configError);
      return true;
    });
    assert.deepEqual(executed, [], "loader 失败时不得触达子运行时");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R7) loader 缺席：行为与现状一致（启动快照，逐字节兼容旧宿主/测试替身）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-live-refresh-"));
  try {
    const { port, executed } = makePort(dir, { profiles: [makeProfile()] });
    const output = await port.launch(launchRequest(dir, "probe-agent", false));
    assert.equal(output.status, "completed");
    assert.deepEqual(executed, ["probe-agent"]);
    await assert.rejects(port.launch(launchRequest(dir, "ghost", false)), (error) => {
      assert.match(error.message, /not found/u);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(R4) requireExplicitModelSelection：无选择即拒绝，有 profile/override 选择放行", () => {
  const selection = { providerId: "provider", modelId: "model" };
  const parent = { providerId: "provider", modelId: "captain-model" };

  // 无 profileSelection、无 overrideSelection → fail-closed，消息带配置引导。
  assert.throws(
    () =>
      resolveSubagentSelection({
        requireExplicitModelSelection: true,
        parentSelection: parent,
      }),
    (error) => {
      assert.match(error.message, /Cannot start AgentTeams member/u);
      assert.match(error.message, /inheritCaptainModel/u);
      return true;
    },
  );

  // 有 profile 自身选择 → 放行。
  const withProfile = resolveSubagentSelection({
    requireExplicitModelSelection: true,
    profileSelection: selection,
    parentSelection: parent,
  });
  assert.deepEqual(withProfile.selection, selection);

  // 有 override（general-purpose 回退烘焙出的选择走 profileSelection，
  // 运行时 modelOverride 走 overrideSelection）→ 放行。
  const withOverride = resolveSubagentSelection({
    requireExplicitModelSelection: true,
    overrideSelection: selection,
    parentSelection: parent,
  });
  assert.deepEqual(withOverride.selection, selection);

  // 标记缺席 → 既有父继承语义不变（不受本批影响）。
  const inherited = resolveSubagentSelection({ parentSelection: parent });
  assert.deepEqual(inherited.selection, parent);
  assert.equal(inherited.hasConcreteModel, false);
});
