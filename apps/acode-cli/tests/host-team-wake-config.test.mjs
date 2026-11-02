// 宿主团队唤醒配置链（apps/acode-cli/specs/host-team-wake.md R7）：schema 解析 / 默认值 /
// 覆盖 / merge / store 面（autoResume 配置链同构）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigScope, DefaultRuntimeConfig } from "../packages/contracts/src/index.ts";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../packages/adapters/src/config/schema.ts";
import {
  createPrioritizedConfig,
  mergeConfigs,
} from "../packages/adapters/src/config/config-merger.ts";
import { createConfigPort } from "../packages/adapters/src/config/index.ts";
import { resolveTeamWakeConfig } from "../packages/core/src/runtime/team-wake/types.ts";

describe("ACodeConfigFileSchema - agentTeams.hostWake", () => {
  it("parses the full hostWake section", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
      agentTeams: {
        hostWake: {
          enabled: false,
          maxWakePrompts: 1,
          maxDeliveryAttempts: 5,
          intentTtlMs: 60_000,
          waitDefaultMs: 120_000,
          waitMaxMs: 300_000,
        },
      },
    });
    assert.deepEqual(config.agentTeams, {
      hostWake: {
        enabled: false,
        maxWakePrompts: 1,
        maxDeliveryAttempts: 5,
        intentTtlMs: 60_000,
        waitDefaultMs: 120_000,
        waitMaxMs: 300_000,
      },
    });
  });

  it("accepts partial overrides and strips unknown inner keys", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
      agentTeams: { hostWake: { bogus: 1, enabled: false } },
    });
    assert.deepEqual(config.agentTeams, { hostWake: { enabled: false } });
  });

  it("omits agentTeams from the patch when absent", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({});
    assert.equal(config.agentTeams, undefined);
  });

  it("rejects invalid values (non-positive counters, wrong types)", () => {
    for (const hostWake of [
      { maxWakePrompts: 0 },
      { maxDeliveryAttempts: -1 },
      { intentTtlMs: 0 },
      { enabled: "yes" },
    ]) {
      assert.throws(
        () => parseConfigFileToRuntimePatchWithDiagnostics({ agentTeams: { hostWake } }),
        undefined,
        JSON.stringify(hostWake),
      );
    }
  });
});

describe("DefaultRuntimeConfig.agentTeams - spec 默认值", () => {
  it("matches enabled=true / 2 / 3 / 10min / 5min / 8min", () => {
    assert.deepEqual(DefaultRuntimeConfig.agentTeams, {
      hostWake: {
        enabled: true,
        maxWakePrompts: 2,
        maxDeliveryAttempts: 3,
        intentTtlMs: 600_000,
        waitDefaultMs: 300_000,
        waitMaxMs: 480_000,
      },
    });
  });
});

describe("mergeConfigs - agentTeams.hostWake 逐字段合并", () => {
  it("user partial override inherits the remaining default fields", () => {
    const merged = mergeConfigs(
      createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
      createPrioritizedConfig(
        { agentTeams: { hostWake: { maxWakePrompts: 1 } } },
        ConfigScope.User,
      ),
    );
    assert.deepEqual(merged.agentTeams.hostWake, {
      enabled: true,
      maxWakePrompts: 1,
      maxDeliveryAttempts: 3,
      intentTtlMs: 600_000,
      waitDefaultMs: 300_000,
      waitMaxMs: 480_000,
    });
  });

  it("higher scope override wins for the declared field only", () => {
    const merged = mergeConfigs(
      createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
      createPrioritizedConfig({ agentTeams: { hostWake: { enabled: false } } }, ConfigScope.User),
      createPrioritizedConfig(
        { agentTeams: { hostWake: { maxDeliveryAttempts: 1 } } },
        ConfigScope.Cli,
      ),
    );
    assert.deepEqual(merged.agentTeams.hostWake, {
      enabled: false,
      maxWakePrompts: 2,
      maxDeliveryAttempts: 1,
      intentTtlMs: 600_000,
      waitDefaultMs: 300_000,
      waitMaxMs: 480_000,
    });
  });
});

describe("ConfigPort - agentTeams store 合并", () => {
  it("getAll returns defaults; merge shallow-merges hostWake", () => {
    const port = createConfigPort();
    assert.deepEqual(port.getAll().agentTeams, DefaultRuntimeConfig.agentTeams);
    port.merge({ agentTeams: { hostWake: { enabled: false } } }, ConfigScope.User);
    assert.equal(port.getAll().agentTeams.hostWake.enabled, false);
    assert.equal(port.getAll().agentTeams.hostWake.maxWakePrompts, 2);
  });
});

describe("resolveTeamWakeConfig - 生效配置回落", () => {
  it("absent config → defaults (enabled=true)", () => {
    assert.deepEqual(resolveTeamWakeConfig(undefined), {
      enabled: true,
      maxWakePrompts: 2,
      maxDeliveryAttempts: 3,
      intentTtlMs: 600_000,
    });
  });

  it("explicit enabled=false is honored (escape hatch, EI-149)", () => {
    assert.equal(resolveTeamWakeConfig({ enabled: false }).enabled, false);
  });

  it("invalid/absent values fall back to hardcoded defaults", () => {
    const resolved = resolveTeamWakeConfig({ maxWakePrompts: 0, intentTtlMs: -1 });
    assert.equal(resolved.maxWakePrompts, 2);
    assert.equal(resolved.intentTtlMs, 600_000);
  });

  it("非布尔 enabled 收窄回默认（不把真值当开启）", () => {
    assert.equal(resolveTeamWakeConfig({ enabled: "yes" }).enabled, true);
    assert.equal(resolveTeamWakeConfig({ enabled: 0 }).enabled, true);
    assert.equal(resolveTeamWakeConfig({ enabled: false }).enabled, false);
  });
});

// ── 回归：resolveAppRuntimeConfig 的 agentTeams 缺段默认链（EI-152，「旧配置直接可读」） ──
// 触发场景：旧配置文件 / 未设置 agentTeams 的环境 / 手写夹具的 config 无该段时，直接下钻
// `.hostWake` 会 TypeError（apps/acode-cli/tests/ambient-budget-scheduler.test.mjs 实测）。
describe("resolveAppRuntimeConfig - agentTeams 缺段不崩且逐字段落默认", () => {
  it("config 无 agentTeams 段 → 物化 DefaultRuntimeConfig.agentTeams.hostWake", async () => {
    const { resolveAppRuntimeConfig } = await import(
      "../packages/bootstrap/src/app/runtime-config.ts"
    );
    const { runtimeConfig } = resolveAppRuntimeConfig({
      cliStorageRoot: "C:\\tmp",
      configResult: {
        config: {
          features: {},
          hooks: {},
          mcp: { servers: {} },
          memory: { use: true },
          modelAnomalyGuard: {},
          permission: {},
          skills: {},
          toolConcurrency: {},
        },
        sources: { project: {}, user: {} },
      },
      options: { runtimeConfig: { workingDirectory: "C:\\w" } },
      subagentOutputRootDir: "agents",
      workingDirectory: "C:\\w",
    });
    assert.deepEqual(runtimeConfig.agentTeams.hostWake, {
      enabled: true,
      maxWakePrompts: 2,
      maxDeliveryAttempts: 3,
      intentTtlMs: 600_000,
      waitDefaultMs: 300_000,
      waitMaxMs: 480_000,
    });
  });

  it("部分覆盖 hostWake 时其余字段落默认（call-level 覆盖 config 层）", async () => {
    const { resolveAppRuntimeConfig } = await import(
      "../packages/bootstrap/src/app/runtime-config.ts"
    );
    const { runtimeConfig } = resolveAppRuntimeConfig({
      cliStorageRoot: "C:\\tmp",
      configResult: {
        config: {
          agentTeams: { hostWake: { maxWakePrompts: 1 } },
          features: {},
          hooks: {},
          mcp: { servers: {} },
          memory: { use: true },
          modelAnomalyGuard: {},
          permission: {},
          skills: {},
          toolConcurrency: {},
        },
        sources: { project: {}, user: {} },
      },
      options: {
        runtimeConfig: { workingDirectory: "C:\\w", agentTeams: { hostWake: { enabled: false } } },
      },
      subagentOutputRootDir: "agents",
      workingDirectory: "C:\\w",
    });
    assert.deepEqual(runtimeConfig.agentTeams.hostWake, {
      enabled: false,
      maxWakePrompts: 1,
      maxDeliveryAttempts: 3,
      intentTtlMs: 600_000,
      waitDefaultMs: 300_000,
      waitMaxMs: 480_000,
    });
  });
});