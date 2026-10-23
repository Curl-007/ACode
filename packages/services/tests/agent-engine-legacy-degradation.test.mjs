import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/**
 * 外部引擎 legacy 方法 -32601 时 Host 降级守卫的 **CI 常绿**回归测试。
 *
 * 背景（2026-10-24 真实 Electron e2e 实证的 bug）：jcode shim 的 dispatch 只处理 v4 方法，
 * 对 legacy push（workspace/updateInteractionPreferences、provider/updateAccountConfig 等）
 * 回标准 JSON-RPC -32601（dispatch.ts default 分支，spec「legacy 不做」）。Host 侧
 * `enqueueInteractionPreferenceSync` 的第一条 push 此前**缺** method-not-found 降级守卫
 * （同函数第二条 modelIo push、offPeak、dynamicWorkflow 三处都有），-32601 直接 reject
 * 整条 interactionPreferencesReady（Promise.all）→ 杀死 getClient → agent init 失败 →
 * warmup unavailable。修复：给第一条 push 补齐同款 isProtocolMethodNotFoundError 守卫。
 *
 * 为什么 CI 常绿（不 gate ACODE_JCODE_E2E、不需真 jcode/凭据/网络）：
 *   shim 北向 `connection.start()`（entry.ts:225）**先于**南向 southboundReady（227），
 *   南向 spawn 失败只 logger.error 不杀北向（254）。故 spawn 真 shim + **假 jcode 二进制**
 *   （不存在的路径 → 南向 ENOENT）时，北向 v4 通道照常服务，对 legacy push 回 -32601。
 *   getClient 只 await legacy push（interactionPreferencesReady），**不** await 南向
 *   （南向是 createSession/sendText 才 await），故 initialize 快速返回、不卡南向超时。
 *
 * 断言：initialize().available === true —— 证明 interactionPreferences 的 -32601 被降级守卫
 * 吞掉、getClient 未被阻断。若守卫被删（回归），getClient reject → available:false 且
 * reason 含 -32601，本测试判红。
 *
 * account config 降级（syncAccountProviderConfigToClient 的同款守卫）由真机 Level 2
 * （jcode-bridge-service-layer.test.mjs，注入 accountProviderConfigSource + 真 jcode 跑通
 * completedSuccess）覆盖：CI 假 jcode 下 createSession 会卡南向 30s 超时，不适合常绿守卫。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
// Windows 上 node 的 ESM 只接受 file/data/node scheme，裸 C:/ 会被当协议 "c:"。
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cliEntry = join(repoRoot, "apps/acode-cli/packages/cli/src/main.ts");
const agentServiceModule = pathToFileURL(
  join(repoRoot, "packages/services/src/acode-agent/acodeAgentService.ts"),
).href;

const { createACodeAgentService } = await import(agentServiceModule);

test("外部引擎对 legacy preference push 回 -32601 时，Host 降级守卫保住 agent init（available:true）", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acode-legacy-degrade-"));
  const dataDir = await mkdtemp(join(tmpdir(), "acode-legacy-degrade-data-"));
  // 假 jcode 二进制：不存在的路径 → 南向 spawn ENOENT（北向不受影响，见文件头注）。
  // 放 workspace 内（非 jcode repo），故 self-dev 防护 assertNotJcodeRepo 不命中。
  const fakeJcodeBinary = join(workspace, "definitely-not-a-real-jcode-binary");

  const savedEnv = { ...process.env };
  // env 覆盖 spawn 真 shim（agent-command-env-gate.md R1：非打包态生效）。
  process.env.ACODE_AGENT_SERVER_COMMAND = process.execPath;
  process.env.ACODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
    "--import",
    tsxLoader,
    cliEntry,
    "jcode-bridge",
    "--stdio",
    "--jcode-binary",
    fakeJcodeBinary,
  ]);
  process.env.ACODE_AGENT_SERVER_CWD = workspace;
  process.env.ACODE_DATA_BASE_DIR = dataDir;
  delete process.env.ACODE_APP_IS_PACKAGED;
  process.env.JCODE_NO_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";

  // 假 provider 就绪源：getClient 的 resolveStartupReadiness 缺它会抛 providerNotReady，
  // initialize 就 available:false（reasonCode provider_not_ready）——那不是本测试要验的降级。
  const modelSelectionReadinessSource = {
    getView: async () => ({
      revision: 1,
      providers: [{ providerId: "fake-provider", models: [{ modelId: "fake-model" }] }],
    }),
  };

  const service = createACodeAgentService({
    presentationSurface: "desktop",
    modelSelectionReadinessSource,
  });

  try {
    // 先设 app 运行时偏好：真实 Host 在 agent init 前就有偏好快照。此时无 active client，
    // syncAppRuntimePreferences 只设全局 latestAppRuntimePreferences、不推送（遍历空集）。
    // 随后 initialize → getClient 构造 entry 时，while(latestAppRuntimePreferences) 循环
    // 才会推 workspace/updateInteractionPreferences + updateModelIoPreferences（shim 回 -32601）。
    // 不先设这一步，getClient 的 while 循环体不执行，覆盖不到降级守卫。
    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });

    // 决定性断言：initialize 触发 getClient → interactionPreferencesReady（两条 legacy push
    // 均 -32601）→ 降级守卫吞掉 → getClient 成功 → available:true。
    const result = await service.initialize({ workspacePath: workspace });

    assert.equal(
      result.available,
      true,
      `外部引擎 legacy push 的 -32601 必须被降级守卫吞掉、不得阻断 init；` +
        `实得 available=${result.available} reason=${result.reason ?? "-"} ` +
        `reasonCode=${result.reasonCode ?? "-"}（若含 -32601/updateInteractionPreferences 即守卫被删的回归）`,
    );
    // 反证：available:true 时不得带 provider_not_ready（那会是另一条路径的假通过）。
    assert.notEqual(result.reasonCode, "provider_not_ready");
  } finally {
    try {
      await service.disposeAllAndWait();
    } catch {
      // dispose 里二次关闭可能已断；不影响断言结论。
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("外部引擎对 workspace/readPresentation 回 -32601 时，Host 降级为空 presentation（composer 目录不卡 error 态）", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acode-presentation-degrade-"));
  const dataDir = await mkdtemp(join(tmpdir(), "acode-presentation-degrade-data-"));
  const fakeJcodeBinary = join(workspace, "definitely-not-a-real-jcode-binary");

  const savedEnv = { ...process.env };
  process.env.ACODE_AGENT_SERVER_COMMAND = process.execPath;
  process.env.ACODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
    "--import",
    tsxLoader,
    cliEntry,
    "jcode-bridge",
    "--stdio",
    "--jcode-binary",
    fakeJcodeBinary,
  ]);
  process.env.ACODE_AGENT_SERVER_CWD = workspace;
  process.env.ACODE_DATA_BASE_DIR = dataDir;
  delete process.env.ACODE_APP_IS_PACKAGED;
  process.env.JCODE_NO_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";

  const modelSelectionReadinessSource = {
    getView: async () => ({
      revision: 1,
      providers: [{ providerId: "fake-provider", models: [{ modelId: "fake-model" }] }],
    }),
  };
  const service = createACodeAgentService({
    presentationSurface: "desktop",
    modelSelectionReadinessSource,
    // 与生产接线同形（node.ts 注入 resolveAgentEngineFromSettings）：env 覆盖只决定 spawn
    // 通道，降级逻辑的引擎身份必须来自设置 resolver，否则测试验的是「env 通道绕过注册表」
    // 的错配形态而非生产路径。
    resolveAgentEngine: async () => "jcode",
  });

  try {
    // 先让 workspace client 起来（同上一个测试的降级链）。
    const init = await service.initialize({ workspacePath: workspace });
    assert.equal(init.available, true, "init 应先成功（前置降级守卫已验）");

    // 决定性断言：readWorkspacePresentation 不得上抛 -32601，应降级为空 presentation。
    // jcode 引擎唯一权限档是 yolo → mode 取 yolo（descriptor.defaultPermissionMode）。
    const presentation = await service.readWorkspacePresentation({ workspacePath: workspace });
    assert.deepEqual(presentation.slashCommands, [], "降级 presentation 的 slash 目录应为空");
    assert.equal(
      presentation.mode,
      "yolo",
      `jcode 引擎降级 mode 应取其唯一权限档 yolo，实得 ${presentation.mode}`,
    );
    assert.equal(presentation.workspace.workspacePath, workspace);
  } finally {
    try {
      await service.disposeAllAndWait();
    } catch {
      // 收尾不上抛。
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
