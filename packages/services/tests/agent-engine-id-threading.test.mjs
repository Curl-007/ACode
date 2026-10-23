import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * engineId 贯通链验收（agent-engine-jcode-slot.md R4 + 验收场景 8 的 service 层部分）。
 *
 * 与 jcode-bridge-real-client.test.mjs / jcode-bridge-service-layer.test.mjs 的区别：
 * 那两份用 `ACODE_AGENT_SERVER_COMMAND` env 覆盖驱动 shim，**绕过了注册表 engineId dispatch**
 * （env 分支在 resolver 最前面短路）。本文件验证的是本轮新建的那条链路：
 *   Settings.agentEngine → node.ts resolveAgentEngineFromSettings
 *     → createACodeAgentService({ resolveAgentEngine })
 *     → service.getClient 前 withResolvedEngineId 拼 params.engineId
 *     → processManager.startClient 归一 → commandResolver({engineId})
 *     → getEngineRuntime(engineId).spawnArgs
 *
 * 用 commandResolver spy 捕获实际 spawn 命令，**不需要真 jcode、不需要凭据、可进 CI 常绿**。
 */

const { ACodeAgentProcessManager } = await import("../src/acode-agent/acodeAgentProcessManager.ts");
const { createACodeAgentService } = await import("../src/acode-agent/acodeAgentService.ts");
const { resolveDefaultACodeAgentCommand } =
  await import("../src/acode-agent/acodeAgentProcessManager.ts");

/** 记录 commandResolver 收到的 context，用于断言 engineId 真的贯通到了 resolver。 */
function createSpyResolver(record) {
  return (context) => {
    record.push({ engineId: context.engineId, workspaceKey: context.workspaceKey });
    // 委托真实 resolver（它已按 engineId dispatch spawnArgs），只加一层记录。
    return resolveDefaultACodeAgentCommand(context);
  };
}

test("R4: service 注入 resolveAgentEngine=jcode 时，engineId 贯通到 commandResolver", async () => {
  const record = [];
  const manager = new ACodeAgentProcessManager({
    commandResolver: createSpyResolver(record),
    presentationSurface: "desktop",
  });

  try {
    // 直接验证 process manager 层：engineId 经 getClient params 透传到 resolver。
    // 用一个必然失败的 workspace 触发 startClient（resolver 被调用即够，不必真 spawn 成功）。
    await manager
      .getClient({ workspacePath: "Z:/nonexistent-workspace-for-spy", engineId: "jcode" })
      .catch(() => undefined); // spawn 会失败（无此目录/无 bundle），但 resolver 已被调用

    assert.ok(record.length > 0, "commandResolver 应被调用");
    assert.equal(
      record[0].engineId,
      "jcode",
      `engineId 必须贯通到 commandResolver，实得 ${record[0].engineId}`,
    );
  } finally {
    await manager.disposeAllAndWait().catch(() => undefined);
  }
});

test("R4: service 层 resolveAgentEngine 注入后，engineId 从 settings 贯通到 spawn 命令", async () => {
  const record = [];
  const service = createACodeAgentService({
    presentationSurface: "desktop",
    commandResolver: createSpyResolver(record),
    // 模拟 node.ts 的 resolveAgentEngineFromSettings 返回 jcode（Settings 选了 jcode）。
    resolveAgentEngine: async () => "jcode",
    // provider 就绪门禁：给一个 ≥1 provider+model 的假 view，让 getClient 不因
    // providerNotReady 抛错（acodeAgentService.ts:3134/3151）。
    modelSelectionReadinessSource: {
      getView: async () => ({
        revision: 1,
        providers: [{ providerId: "fake", models: [{ modelId: "fake-model" }] }],
      }),
    },
  });

  try {
    // getStorageStartupState / prepareStorage 都会经 getClient → resolver。
    // 用 prepareStorage 触发（它与会话 client 同一引擎解析，见 acodeAgentService.ts 的注释）。
    await service
      .prepareStorage({ workspacePath: "Z:/nonexistent-workspace-for-spy" })
      .catch(() => undefined); // spawn 失败无妨，resolver 已被调用即验证贯通

    assert.ok(record.length > 0, "commandResolver 应被 service 层触发");
    assert.equal(
      record[0].engineId,
      "jcode",
      `service 注入的 resolveAgentEngine 必须贯通到 resolver，实得 ${record[0].engineId}`,
    );
  } finally {
    await service.disposeAllAndWait().catch(() => undefined);
  }
});

test("R4: 不注入 resolveAgentEngine 时回退 native（旧调用方零行为变化）", async () => {
  const record = [];
  const manager = new ACodeAgentProcessManager({
    commandResolver: createSpyResolver(record),
  });

  try {
    // 不传 engineId（旧调用方形态）。
    await manager
      .getClient({ workspacePath: "Z:/nonexistent-workspace-for-spy" })
      .catch(() => undefined);

    assert.ok(record.length > 0);
    assert.equal(
      record[0].engineId,
      "glm",
      `缺省必须归一回 native glm（旧调用方零行为变化），实得 ${record[0].engineId}`,
    );
  } finally {
    await manager.disposeAllAndWait().catch(() => undefined);
  }
});
