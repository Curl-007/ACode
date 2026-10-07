import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * 子代理 background 三态语义与一次性会话前台策略验收。
 * specs/subagent-background-tristate.md 场景 1/2/3/5。
 *
 * harness 沿 subagent-maxturns-dangling.test.mjs (8) 的桩件模式：假 runExploreAgent
 * 自然收尾，前台路径产出 completed、后台路径产出 async_launched——
 * output.status 即「走了 port.run 还是 port.start」的观测点（场景 4 的 honor
 * 缺省不回退由既有 subagent-* 套件全绿承担，不在此重复）。
 */

const { createExploreSubagentPort } = await import(
  "../packages/core/src/subagent/runner.ts"
);
const { wrapSubagentPortWithForegroundPolicy } = await import(
  "../packages/core/src/subagent/foreground-policy.ts"
);
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

// tests/ 的上一级即 apps/acode-cli（源码断言路径以此为根）。
const root = fileURLToPath(new URL("../", import.meta.url));

function makeProfile(overrides = {}) {
  return {
    description: "probe agent",
    name: "probe-agent",
    source: "user",
    systemPrompt: "probe",
    ...overrides,
  };
}

function makePort(dir, profiles) {
  return createExploreSubagentPort({
    outputRootDir: dir,
    profiles,
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      return {
        events: [],
        response: "probe finished",
        traceId: request.traceContext.traceId,
      };
    },
    emitParentEvent: async () => undefined,
  });
}

function launchRequest(dir, runInBackground) {
  return {
    agentType: "probe-agent",
    description: "probe run",
    parentToolCallId: "toolu_probe",
    prompt: "probe",
    sessionId: createSessionId("sess_bg_tristate"),
    trace: { traceId: createTraceId() },
    workingDirectory: dir,
    workspaceRoot: dir,
    // 显式 undefined 与缺省键在 ?? 判定下同义；矩阵用缺省键形态更贴近 handler 透传。
    ...(runInBackground === undefined ? {} : { runInBackground }),
  };
}

test("(场景1) 三态矩阵：undefined 跟随 profile 默认，true 强制后台，false 强制前台", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-bg-tristate-"));
  try {
    // profile.background = true：undefined → 后台；false → 前台（R1 核心修复）；true → 后台。
    const bgPort = makePort(dir, [makeProfile({ background: true })]);
    assert.equal((await bgPort.launch(launchRequest(dir, undefined))).status, "async_launched");
    assert.equal((await bgPort.launch(launchRequest(dir, false))).status, "completed");
    assert.equal((await bgPort.launch(launchRequest(dir, true))).status, "async_launched");

    // profile.background 缺省：undefined → 前台；false → 前台；true → 后台。
    const fgPort = makePort(dir, [makeProfile()]);
    assert.equal((await fgPort.launch(launchRequest(dir, undefined))).status, "completed");
    assert.equal((await fgPort.launch(launchRequest(dir, false))).status, "completed");
    assert.equal((await fgPort.launch(launchRequest(dir, true))).status, "async_launched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(场景2) deny 死循环解除：deny + 缺省仍拒绝，deny + 显式 false 前台执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-bg-deny-"));
  try {
    const port = makePort(dir, [makeProfile({ background: true })]);
    const denyOptions = {
      modelOverride: {
        selection: { providerId: "provider-a", modelId: "model-a" },
        background: "deny",
      },
    };

    // 现状语义不变：background 请求（含 profile 默认触发）在 deny 下抛可恢复错误。
    await assert.rejects(
      port.launch(launchRequest(dir, undefined), denyOptions),
      (error) => {
        assert.match(error.message, /Idle-time tasks do not support background agents/u);
        // R2：文案必须给出可执行指令（三态下显式 false 真实可达）。
        assert.match(error.message, /run_in_background: false/u);
        return true;
      },
    );

    // 修复点：照错误指令重派（显式 false）→ 不进 background 分支、不触 deny，前台完成。
    const output = await port.launch(launchRequest(dir, false), denyOptions);
    assert.equal(output.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(场景3) foreground 策略包装：launch 重写为前台，其余方法原样保留", async () => {
  const seen = [];
  const fakePort = {
    launch: async (request, options) => {
      seen.push({ request, options });
      return { status: "completed" };
    },
    run: async () => ({ status: "completed" }),
    start: async () => ({ status: "async_launched" }),
  };
  const wrapped = wrapSubagentPortWithForegroundPolicy(fakePort);

  const options = { signal: undefined };
  await wrapped.launch({ runInBackground: true, agentType: "x" }, options);
  await wrapped.launch({ agentType: "x" }, options);

  // profile 默认与显式 true 都被重写为 false（R3：一次性会话没有后台语义）。
  assert.equal(seen.length, 2);
  assert.equal(seen[0].request.runInBackground, false);
  assert.equal(seen[1].request.runInBackground, false);
  assert.equal(seen[0].options, options, "launchOptions 必须原样透传");
  // 包装不吞方法：非 launch 成员保持同一引用。
  assert.equal(wrapped.run, fakePort.run);
  assert.equal(wrapped.start, fakePort.start);
});

test("(场景5) 源码钉住：handler 三态透传、策略位接线、-p 声明点（防折叠回退）", () => {
  const handler = readFileSync(
    join(root, "packages/core/src/tool/handlers/agent.ts"),
    "utf8",
  );
  assert.match(handler, /runInBackground: parsed\.run_in_background,/u);
  assert.doesNotMatch(
    handler,
    /parsed\.run_in_background === true/u,
    "handler 又把三态折叠回二态了",
  );

  const methods = readFileSync(
    join(root, "packages/core/src/runtime/methods/subagent.ts"),
    "utf8",
  );
  assert.match(
    methods,
    /autoBackgroundMs: foregroundPolicy \? undefined : this\.config\.subagents\?\.autoBackgroundMs/u,
    "foreground 策略必须同时压制超时转后台（R3 防御钉住）",
  );
  assert.match(
    methods,
    /return foregroundPolicy \? wrapSubagentPortWithForegroundPolicy\(port\) : port;/u,
  );

  const promptCommand = readFileSync(join(root, "packages/cli/src/prompt-command.ts"), "utf8");
  assert.match(
    promptCommand,
    /subagents: \{ backgroundPolicy: "foreground" as const \}/u,
    "-p 装配点必须声明前台策略（R3 唯一声明点）",
  );
});
