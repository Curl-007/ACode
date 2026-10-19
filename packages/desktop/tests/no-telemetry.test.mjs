import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        return entry.isDirectory() ? sources(url) : /\.(ts|tsx|js)$/.test(entry.name) ? [url] : [];
      }),
    )
  ).flat();
}
// WI-14（apps/acode-cli/specs/otel-telemetry.md）修订审计边界：desktop main 允许
// **唯一一个** env 门禁、懒加载的 OTel Resource 初始化模块（desktopTelemetry.ts），
// 其余常开 exporter/身份注入/IPC 转发桥面维持删除态。守卫方式：
// 1. @opentelemetry/ 只允许出现在 desktopTelemetry.ts，且必须是函数内动态 import
//   （无顶层静态 import——保证无端点默认态零加载）；
// 2. 该文件必须保留端点门禁（无 OTEL_EXPORTER_OTLP_* 端点 = no_endpoint no-op）；
// 3. package.json 的 @opentelemetry 依赖钉死为最小四件套；@arms 全面禁止不变。
const GATED_TELEMETRY_FILE = "src/main/desktopTelemetry.ts";
const ALLOWED_OTEL_DEPENDENCIES = [
  "@opentelemetry/api",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-trace-base",
];

test("desktop cannot initialize telemetry exporters or forwarding bridges", async () => {
  for (const file of await sources(new URL("src/", root))) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(
      content,
      /@arms\/rum-electron|createTelemetryCore|createDesktopTelemetryFetch|installArmsRumBridgeIpcForward|new NetworkTelemetryChannelServer|registerHostNetworkTelemetry/,
      file.pathname,
    );
    assert.doesNotMatch(
      content,
      /ipcRenderer\.(?:invoke|send)\(PlatformChannels\.(?:ReportTelemetryEvent|ReportArmsCustomEvent|ReportLocalTtftBatch|ReportRendererActionTraceBatch|SyncTelemetryContext)/,
      file.pathname,
    );
    if (file.pathname.replaceAll("\\", "/").endsWith(GATED_TELEMETRY_FILE)) {
      // 门禁模块本体：@opentelemetry 只允许 await import(...) 动态形态，
      // 禁止任何顶层静态 import（默认启动路径零 OTel 模块图）。
      // 正则说明：静态形态是 `import <空白或引号>`，动态形态是 `import(`——
      // `[^(]` 在 import 关键字后拒绝左括号，即只命中静态 import 行。
      assert.doesNotMatch(
        content,
        /^\s*import\s*[^(][^\n]*@opentelemetry\//m,
        "desktopTelemetry.ts 不得静态 import @opentelemetry/*",
      );
      // 端点门禁必须在场：无端点 = no_endpoint no-op（spec 开关矩阵第 5 行）。
      assert.match(content, /no_endpoint/, "desktopTelemetry.ts 必须保留端点门禁");
      assert.match(content, /ACODE_TELEMETRY/, "desktopTelemetry.ts 必须保留用户 opt-out 总开关");
      assert.match(content, /OTEL_SDK_DISABLED/, "desktopTelemetry.ts 必须保留 kill-switch");
      continue;
    }
    assert.doesNotMatch(content, /@opentelemetry\//, file.pathname);
  }
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const dependencyNames = Object.keys(manifest.dependencies);
  assert.equal(
    dependencyNames.some((name) => name.startsWith("@arms/")),
    false,
  );
  // @opentelemetry 依赖钉死为最小四件套（新增必须过 spec 评审）。
  const otelDependencies = dependencyNames
    .filter((name) => name.startsWith("@opentelemetry/"))
    .sort();
  assert.deepEqual(otelDependencies, ALLOWED_OTEL_DEPENDENCIES);
});

// 以 Electron 边界替身执行真实模块，检查删除旁路后业务事件仍能流转。
async function loadModule(relative, imports) {
  const { transpileModule, ModuleKind } = await import("typescript");
  const source = await readFile(new URL(relative, root), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

test("Host environment discards exporter settings while retaining business configuration", async () => {
  const { omitDesktopTelemetryEnvironment } = await loadModule(
    "src/main/desktopTelemetryPolicy.ts",
    {},
  );
  const input = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.invalid",
    ACODE_TELEMETRY_DEVICE_MID: "test",
    ACODE_MODEL_TELEMETRY_ENABLED: "true",
    HTTPS_PROXY: "http://localhost:8080",
    PATH: "/test/bin",
  };
  assert.deepEqual(omitDesktopTelemetryEnvironment(input), {
    HTTPS_PROXY: input.HTTPS_PROXY,
    PATH: input.PATH,
  });
  assert.equal(input.ACODE_MODEL_TELEMETRY_ENABLED, "true");
});

test("database startup still forwards ordered state, starts ready listeners and accepts controls", async () => {
  const { EventEmitter } = await import("node:events");
  const ipcMain = new EventEmitter();
  const win = new EventEmitter();
  const child = new EventEmitter();
  const forwarded = [],
    controls = [];
  win.isDestroyed = () => false;
  win.webContents = { isDestroyed: () => false, send: (_channel, state) => forwarded.push(state) };
  child.postMessage = (message) => controls.push(message);
  const relay = await loadModule("src/main/databaseStartupRelay.ts", {
    "node:crypto": await import("node:crypto"),
    electron: { ipcMain },
    "@acode/shared": {
      HostMessageTypes: { DatabaseStartupControl: "control" },
      InternalChannels: { DatabaseStartupState: "state", DatabaseStartupControl: "control" },
      databaseStartupControlSchema: { safeParse: (data) => ({ success: true, data }) },
    },
  });
  let ready = 0;
  relay.onLocalDatabaseStartupReady(() => ready++);
  const binding = relay.bindDatabaseStartupRelay(win, child, "startup");
  binding.receive({ startupId: "stale", sequence: 5, phase: "ready" });
  binding.receive({ startupId: "startup", sequence: 1, phase: "ready" });
  binding.receive({ startupId: "startup", sequence: 1, phase: "ready" });
  assert.equal(ready, 1);
  assert.equal(forwarded.length, 1);
  ipcMain.emit("control", { sender: win.webContents }, { action: "snapshot" });
  assert.equal(forwarded.length, 2);
  assert.equal(controls.length, 1);
  child.emit("exit");
  assert.equal(forwarded.at(-1).phase, "failed");
  win.emit("closed");
  assert.equal(ipcMain.listenerCount("control"), 0);
});

test("OAuth delivery and remote connection retain business behavior without telemetry handlers", async () => {
  const handlers = new Map();
  const channels = new Proxy({}, { get: (_target, key) => key });
  let delivered = 0;
  const registeredLogHostNames = [];
  const win = {};
  const { registerRemoteIpcHandlers } = await loadModule("src/main/desktopMainIpcRemote.ts", {
    electron: {
      app: { on() {} },
      BrowserWindow: { fromWebContents: () => win },
      ipcMain: {
        on: (name, cb) => handlers.set(name, cb),
        handle: (name, cb) => handlers.set(name, cb),
      },
    },
    "@acode/shared": {
      PlatformChannels: channels,
      InternalChannels: channels,
      remoteTargetSchema: { safeParse: (data) => ({ success: true, data }) },
      normalizeUnknownError: (error) => ({ message: error.message }),
    },
    "./desktopNotifications.js": {},
    "./desktopOAuthDeepLink.js": { deliverPendingDeepLink: () => delivered++ },
    "./desktopMainIpcHelpers.js": {},
    // 运行期日志脱敏收名（specs/log-privacy-redaction.md desktop R4-R6）：真实模块依赖
    // node:* 与 @acode/shared，本测试只验证连接建立点确实收名，用记录型替身。
    "./logPrivacyIdentity.js": {
      registerLogHostName: (name) => registeredLogHostNames.push(name),
    },
    // 窗口 ID 品牌类型模块（纯函数、零 IO）：加载真实实现，不做替身。
    "./desktopWindowIds.js": await loadModule("src/main/desktopWindowIds.ts", {}),
    // ipcMain.handle 同步段计时包装（W1-6 接线）：纯 Node 模块，加载真实实现。
    "./ipcSyncTiming.js": await loadModule("src/main/ipcSyncTiming.ts", {}),
  });
  let args;
  registerRemoteIpcHandlers({
    logger: { warn() {}, error() {} },
    createRemoteWorkspaceSession: async (...input) => {
      args = input;
      return "session";
    },
  });
  handlers.get("RendererReady")({ sender: {} });
  assert.equal(delivered, 1);
  const target = { kind: "ssh", host: "example.invalid" };
  assert.deepEqual(
    await handlers.get("ConnectRemote")(
      { sender: {} },
      { target, requestId: "request", workspacePath: "/project", workspaceIdentity: "identity" },
    ),
    { success: true, sessionId: "session" },
  );
  assert.deepEqual(args, [
    win,
    target,
    "request",
    { workspacePath: "/project", workspaceIdentity: "identity" },
  ]);
  for (const name of handlers.keys()) assert.doesNotMatch(name, /Telemetry|Arms|Trace|Ttft/);
  // SSH 连接建立点把对端主机名交给脱敏注册表（收名本身不影响连接结果，上面已断言 success）。
  assert.deepEqual(registeredLogHostNames, ["example.invalid"]);
});
