// Overnight（K3）完成信号的 main 侧派发测试（specs/overnight-completion-notify.md §7）。
// 被测：packages/desktop/src/main/desktopHostProcess.ts 的 child.on("message") 派发分支——
// host→main 的 OvernightCompletionNotify 消息经 hostResponseMessageSchema.safeParse 严格校验后，
// 路由到 dependencies.onOvernightCompletionNotify(win, signal)；畸形/未知载荷在 schema 阶段被拒，
// 绝不静默透传到 notifier。
//
// house style（对齐 overnight-completion-notify.test.mjs）：transpile TS→CJS + 注入替身，
// 但 @acode/shared 用**真实**模块（这样 hostResponseMessageSchema 判别联合是真身——
// 证明新变体确已注册、不会在 Main 边界被 safeParse 丢弃）。无 electron、无真实 host 子进程。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
// 真实 shared：派发分支的 schema 校验用真身，覆盖「判别联合已注册新变体」这一事实。
const realShared = await import("@acode/shared");

async function readSource(relative) {
  return readFile(new URL(relative, root), "utf8");
}

async function loadMain(relative, imports = {}) {
  const source = await readSource(`src/main/${relative}.ts`);
  // transpileModule 输出 CJS，源码里的 `import.meta.dirname`（在未调用的 loadFile 助手内）
  // 会让 new Function(CJS) 抛「Cannot use 'import.meta' outside a module」。它不在本测试路径上，
  // 故在转译前把它替换成字面量占位，避免解析期失败——不改变被测派发逻辑。
  const patched = source.replace(/import\.meta\.dirname/g, '"__main_dirname_stub__"');
  const output = transpileModule(patched, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) return nodeRequire(name);
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

// ── 可控替身 ─────────────────────────────────────────────────────────
const captured = { messageHandlers: [], exitHandlers: [], posted: [] };

function makeFakeChild() {
  return {
    pid: 4242,
    stderr: { on() {} },
    stdout: { on() {} },
    on(event, cb) {
      if (event === "message") captured.messageHandlers.push(cb);
      else if (event === "exit") captured.exitHandlers.push(cb);
    },
    postMessage(message) {
      captured.posted.push(message);
    },
    kill() {},
  };
}

const electronStub = {
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], fromId: () => null, fromWebContents: () => null },
  MessageChannelMain: class {
    constructor() {
      this.port1 = {};
      this.port2 = {};
    }
  },
  utilityProcess: { fork: () => makeFakeChild() },
};

const noopRelay = { onStderr() {}, onStdout() {}, onStructuredLog() {}, flushRawLogs() {} };

const imports = {
  "@acode/shared": realShared,
  electron: electronStub,
  "./databaseStartupRelay.js": {
    bindDatabaseStartupRelay: () => ({ startupId: "db-startup-1", receive() {} }),
  },
  "./desktopWindowIds.js": { asWebContentsId: (n) => n, asWindowId: (n) => n },
  "./desktopLaunchMarks.js": { getMainLaunchPartialMarks: () => ({}) },
  "./broadcastHub.js": { BroadcastHub: class {} },
  "./taskRealtimeBus.js": {},
  "./hostLogRelay.js": { createHostLogRelay: () => noopRelay },
  "./resourceManagerWindow.js": {
    registerHostProcess() {},
    unregisterHostProcess() {},
    registerHostAgentProcess() {},
    unregisterHostAgentProcess() {},
  },
  "./resourceManagerHostSampling.js": { resolveHostResourceUsageResult() {} },
  "./desktopNetworkCaptureIpc.js": {
    bindNetworkCaptureHostChild() {},
    unbindNetworkCaptureHostChild() {},
    receiveNetworkCaptureRecords() {},
    receiveNetworkCaptureSetEnabledResult() {},
  },
  "./desktopRuntimeEnv.js": {
    buildHostProcessEnv: () => ({}),
    hostModulePath: "/fake/host.js",
    resolveBundledGlmBinaryPath: () => undefined,
  },
  "./exportLogs.js": { createFeedbackLogArchiveFromExportLogs: async () => ({ ok: true }) },
  "./e2eCoverage.js": { buildHostE2ECoverageEnv: () => ({}) },
};

const mod = await loadMain("desktopHostProcess", imports);

function makeWin(id = 7) {
  return {
    id,
    webContents: {
      id: id * 10 + 7,
      postMessage() {},
      send() {},
      isDestroyed: () => false,
    },
    isDestroyed: () => false,
  };
}

// 每个测试用一个全新 child + deps，捕获 onOvernightCompletionNotify 的调用。
function spawnHarness() {
  captured.messageHandlers = [];
  captured.exitHandlers = [];
  captured.posted = [];
  const calls = [];
  const win = makeWin();
  const deps = {
    hostProcessLocalEnv: {},
    logger: { info() {}, warn() {}, error() {} },
    broadcastHub: { register() {}, unregister() {} },
    windowHostProcessMap: new Map(),
    hostRunningTaskCountMap: new Map(),
    onOvernightCompletionNotify: (targetWindow, signal) => calls.push([targetWindow, signal]),
  };
  mod.spawnHostProcess(win, "test-host", {}, deps, {
    registerBroadcast: false,
    attachInitialServicePort: false,
  });
  assert.equal(captured.messageHandlers.length, 1, "child.on('message') 已注册");
  return { win, calls, deliver: captured.messageHandlers[0] };
}

const validMessage = {
  type: "overnight-completion-notify",
  runId: "overnight-run-1",
  parentTaskId: "sess-visible-parent",
  outcome: "completed",
  morningReportReady: true,
};

// ── 派发：合法信号路由到 notifier，带正确目标窗口 ──────────────────────
test("派发：合法 OvernightCompletionNotify 路由到 onOvernightCompletionNotify(win, signal)", () => {
  const { win, calls, deliver } = spawnHarness();
  deliver(validMessage);

  assert.equal(calls.length, 1, "恰派发一次");
  assert.equal(calls[0][0], win, "目标窗口 = 发送方 host 所属窗口（同 win 引用）");
  assert.deepEqual(calls[0][1], {
    runId: "overnight-run-1",
    parentTaskId: "sess-visible-parent",
    outcome: "completed",
    morningReportReady: true,
  });
});

test("派发：failed / cancelled 两态各原样透传（不改写 outcome）", () => {
  const { calls, deliver } = spawnHarness();
  deliver({ ...validMessage, runId: "r-failed", outcome: "failed", morningReportReady: false });
  deliver({ ...validMessage, runId: "r-cancel", outcome: "cancelled", morningReportReady: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].outcome, "failed");
  assert.equal(calls[1][1].outcome, "cancelled");
});

// ── schema 闸：畸形载荷在 Main 边界被拒，绝不静默透传 ──────────────────
test("schema 闸：非法 outcome 被 hostResponseMessageSchema 拒绝，不派发", () => {
  const { calls, deliver } = spawnHarness();
  // 负向验证：outcome 不在枚举内 → safeParse 失败 → 顶部 early-return，永不到派发分支。
  deliver({ ...validMessage, outcome: "succeeded" });
  assert.equal(calls.length, 0, "畸形 outcome 不派发（fail-closed）");
});

test("schema 闸：缺 morningReportReady 被拒绝，不派发", () => {
  const { calls, deliver } = spawnHarness();
  const { morningReportReady: _omit, ...noFlag } = validMessage;
  deliver(noFlag);
  assert.equal(calls.length, 0, "缺字段不派发");
});

test("schema 闸：多余字段（coordinatorTaskId）被 .strict() 拒绝，不派发", () => {
  const { calls, deliver } = spawnHarness();
  deliver({ ...validMessage, coordinatorTaskId: "sess-hidden-coordinator" });
  assert.equal(calls.length, 0, "strict schema 拒绝未知字段");
});

test("schema 闸：空白 parentTaskId 被 trim().min(1) 拒绝，不派发", () => {
  const { calls, deliver } = spawnHarness();
  deliver({ ...validMessage, parentTaskId: "   " });
  assert.equal(calls.length, 0, "空白 id 不派发（点击路由会失败）");
});

test("未知消息类型：不触发 overnight 派发（派发分支互不串扰）", () => {
  const { calls, deliver } = spawnHarness();
  // 合法但非本类型的 host 消息（workspace 计数变化）不应触发 overnight 回调。
  deliver({
    type: "workspace-running-task-count-changed",
    workspacePath: "/ws/a",
    runningTaskCount: 2,
  });
  assert.equal(calls.length, 0, "非 overnight 消息不进 overnight 分支");
});
