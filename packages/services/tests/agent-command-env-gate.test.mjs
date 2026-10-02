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

// (4)/(4b) 外部引擎 binaryEnvVar 用例已随引擎槽位下线移除
// （spec: packages/shared/specs/agent-engine-external-slots-removal.md；
//  CODEX/OPENCODE/GEMINI_BINARY_PATH 概念不复存在，env 门禁仅覆盖 native 链路）。

// ── 场景 6（R4，2026-09-30 深度扫描分诊补充）：ACODE_CUA_DEV_ROOT 打包态门禁 ──
//
// 威胁模型与 R1 相同：dev-root 目录下的 JS 会被 helper host fork，用户级 env 注入
// 即可替换执行面。判定用同一 isPackagedACodeDesktopRuntime 谓词（R2：统一谓词）。
// 注入 env 参数与假文件系统，测试不触真实磁盘、不依赖宿主平台（platform 注入 win32）。

const { resolveWindowsCuaRuntime } = await import(
  "../src/cua-permission-broker/windowsCuaDevRuntime.ts"
);

/** stat 一律 ENOENT：足以证明「进入了 dev 解析链」，不需要真实目录。 */
const enoentFs = {
  stat: async () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  },
};

test("(6) packaged: ACODE_CUA_DEV_ROOT ignored → packaged chain (missing-resources-path)", async () => {
  await assert.rejects(
    resolveWindowsCuaRuntime({
      platform: "win32",
      env: { ...PACKAGED, ACODE_CUA_DEV_ROOT: "C:\\acode-cua-dev" },
      fileSystem: enoentFs,
    }),
    (err) => {
      // 门禁生效的证据：错误来自 packaged 链（无 resourcesPath），而非任何 development-* 分支。
      assert.equal(
        err.reason,
        "missing-resources-path",
        "打包态仍命中 dev-root 分支：R4 门禁失效（env 注入可替换 CUA helper 执行面）",
      );
      return true;
    },
  );
});

test("(6b) unpackaged: ACODE_CUA_DEV_ROOT still honored → dev chain (zero regression)", async () => {
  await assert.rejects(
    resolveWindowsCuaRuntime({
      platform: "win32",
      env: { ACODE_CUA_DEV_ROOT: "C:\\acode-cua-dev" },
      fileSystem: enoentFs,
    }),
    (err) => {
      // dev 工作流零回归的证据：进入了 dev 解析链并对注入的假 ENOENT 文件系统报根目录缺失。
      assert.equal(
        err.reason,
        "development-root-not-found",
        "非打包态 dev-root 未被采纳：CUA helper 开发工作流被门禁破坏",
      );
      return true;
    },
  );
});
