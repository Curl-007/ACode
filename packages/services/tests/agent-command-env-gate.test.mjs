import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P2 的验收测试：打包态 agent 命令 env 门禁。
 * 覆盖 packages/services/specs/agent-command-env-gate.md 的 R1/R2 与验收场景 1–4。
 *
 * 威胁模型：launchctl setenv / shell profile / Windows 用户环境变量可在用户级权限下
 * 注入 GUI 应用启动环境；ACODE_AGENT_SERVER_COMMAND 与引擎 binaryEnvVar 能整体替换
 * agent 子进程二进制。打包态必须忽略；dev/独立 CLI/远程 server（无标记）照常生效。
 */

const { isPackagedACodeDesktopRuntime } = await import(
  "../../../packages/shared/src/env.ts"
);
const { findACodeAgentRuntimeBinary } = await import(
  "../src/runtime-tools/providerRuntimeResolver.ts"
);
const { resolveExternalEngineCommand } = await import(
  "../src/acode-agent/externalEngineCommandResolver.ts"
);
const { resolveDefaultACodeAgentCommand } = await import(
  "../src/acode-agent/acodeAgentProcessManager.ts"
);

const PACKAGED = { ACODE_APP_IS_PACKAGED: "1" };

/** 临时设置 process.env（null 表示删除该键），跑完恢复原值。 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withTempFile(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-p2-env-gate-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const agentContext = {
  workspacePath: join(tmpdir(), "acode-p2-ws"),
  workspaceKey: join(tmpdir(), "acode-p2-ws"),
  presentationSurface: "desktop",
};

test("(1) predicate: marker semantics", () => {
  assert.equal(isPackagedACodeDesktopRuntime({ ACODE_APP_IS_PACKAGED: "1" }), true);
  assert.equal(isPackagedACodeDesktopRuntime({ ACODE_APP_IS_PACKAGED: "0" }), false);
  assert.equal(isPackagedACodeDesktopRuntime({ ACODE_APP_IS_PACKAGED: "true" }), false);
  assert.equal(isPackagedACodeDesktopRuntime({}), false);
});

test("(2) packaged: ACODE_AGENT_SERVER_COMMAND injection is ignored", async () => {
  await withEnv({ ...PACKAGED, ACODE_AGENT_SERVER_COMMAND: "/tmp/evil-agent" }, () => {
    const command = resolveDefaultACodeAgentCommand(agentContext);
    // 落回 bundled/Electron/deployed 候选链（测试环境可能为 null）；绝不是注入值。
    assert.notEqual(command?.command, "/tmp/evil-agent");
    assert.notEqual(command?.command, "\\tmp\\evil-agent");
  });
});

test("(2b) unpackaged: ACODE_AGENT_SERVER_COMMAND still honored (zero regression)", async () => {
  await withEnv(
    { ACODE_APP_IS_PACKAGED: null, ACODE_AGENT_SERVER_COMMAND: "/tmp/custom-agent" },
    () => {
      const command = resolveDefaultACodeAgentCommand(agentContext);
      assert.equal(command?.command, "/tmp/custom-agent");
    },
  );
});

test("(3) packaged: GLM_BINARY_PATH injection is ignored by the native candidate chain", () => {
  withTempFile("evil-glm", (fakeBinary) => {
    return withEnv({ ...PACKAGED, GLM_BINARY_PATH: fakeBinary }, () => {
      const resolved = findACodeAgentRuntimeBinary();
      assert.notEqual(resolved, fakeBinary, "packaged runtime must not honor GLM_BINARY_PATH");
    });
  });
});

test("(3b) unpackaged: GLM_BINARY_PATH still first candidate (zero regression)", () => {
  withTempFile("custom-glm", (fakeBinary) => {
    return withEnv({ ACODE_APP_IS_PACKAGED: null, GLM_BINARY_PATH: fakeBinary }, () => {
      assert.equal(findACodeAgentRuntimeBinary(), fakeBinary);
    });
  });
});

test("(4) packaged: external engine binaryEnvVar ignored → standard chain / missing diagnostic", () => {
  withTempFile("evil-codex", (fakeBinary) => {
    return withEnv({ ...PACKAGED, CODEX_BINARY_PATH: fakeBinary }, () => {
      const result = resolveExternalEngineCommand("codex", agentContext.workspacePath);
      assert.notEqual(result.command?.command, fakeBinary);
      // 测试机标准候选链没有 codex → 未安装诊断（而不是 env 注入的假 binary）。
      assert.equal(result.command, null);
      assert.ok(result.missingBinaryMessage, "missing engine must surface its diagnostic");
    });
  });
});

test("(4b) unpackaged: external engine binaryEnvVar still honored", () => {
  withTempFile("custom-codex", (fakeBinary) => {
    return withEnv({ ACODE_APP_IS_PACKAGED: null, CODEX_BINARY_PATH: fakeBinary }, () => {
      const result = resolveExternalEngineCommand("codex", agentContext.workspacePath);
      assert.equal(result.command?.command, fakeBinary);
    });
  });
});
