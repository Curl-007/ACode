import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 引擎作用域的命令解析验收（agent-engine-jcode-slot.md 验收场景 3 + R3/R5）。
 *
 * 覆盖 resolveDefaultACodeAgentCommand 的 `!engine.native` 分支：jcode 引擎必须
 * 解析成 `jcode-bridge --stdio`（而非 glm 的 `app-server --stdio`），且仍复用同一
 * ACode CLI bundle（storagePreparationEntry 在位，桌面 storage 准备不受影响）。
 *
 * 与 agent-command-env-gate.test.mjs 互补：那份守护「打包态忽略 env 覆盖」的安全门禁，
 * 本份守护「引擎选择真的改变了 spawn 的子命令」。
 */

const { resolveDefaultACodeAgentCommand } =
  await import("../src/acode-agent/acodeAgentProcessManager.ts");
const { buildJcodeBinaryPathEnv } = await import("../src/runtime-tools/agentProxyEnv.ts");
const { sanitizeACodeRuntimeEnv } = await import("../../../packages/shared/src/runtimeEnv.ts");

const PACKAGED = { ACODE_APP_IS_PACKAGED: "1" };

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

/** 建一个临时 monorepo 形状：apps/acode-cli/packages/cli/dist/acode.cjs 存在。 */
async function withFakeBundle(fn) {
  const root = await mkdtemp(join(tmpdir(), "acode-engine-resolve-"));
  const distDir = join(root, "apps/acode-cli/packages/cli/dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "acode.cjs"), "// fake bundle\n", "utf8");
  // resolver 用 findUpwardRepoFile 从 process.cwd() 向上找 bundle，故须切到临时根。
  // node --test 每个文件独立进程，chdir 不会串扰其它测试文件。
  const prevCwd = process.cwd();
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(prevCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("场景3: jcode 引擎解析成 jcode-bridge 子命令，glm 仍是 app-server", async () => {
  await withFakeBundle(async () => {
    await withEnv({ ACODE_APP_IS_PACKAGED: null, ACODE_AGENT_SERVER_COMMAND: null }, () => {
      const base = { workspacePath: process.cwd(), workspaceKey: process.cwd() };
      const jcode = resolveDefaultACodeAgentCommand({ ...base, engineId: "jcode" });
      const glm = resolveDefaultACodeAgentCommand({ ...base, engineId: "glm" });
      const fallback = resolveDefaultACodeAgentCommand(base);

      assert.ok(jcode, "jcode 引擎应解析出命令");
      assert.ok(
        jcode.args?.includes("jcode-bridge"),
        `jcode 应走 jcode-bridge 子命令，实得 ${JSON.stringify(jcode.args)}`,
      );
      assert.ok(jcode.args?.includes("--stdio"), "jcode 仍需 --stdio");
      assert.ok(!jcode.args?.includes("app-server"), "jcode 不得混入 glm 的 app-server 子命令");

      assert.ok(glm?.args?.includes("app-server"), "glm 仍走 app-server");
      // 缺省 engineId（旧调用方）回退 native，行为逐字不变。
      assert.deepEqual(
        fallback?.args,
        glm?.args,
        "缺省 engineId 必须与 glm 逐字一致（旧调用方零行为变化）",
      );
    });
  });
});

test("场景3: jcode 引擎仍带 storagePreparationEntry（桌面 storage 准备不受影响，R6 正交性）", async () => {
  await withFakeBundle(async () => {
    await withEnv({ ACODE_APP_IS_PACKAGED: null, ACODE_AGENT_SERVER_COMMAND: null }, () => {
      const command = resolveDefaultACodeAgentCommand({
        workspacePath: process.cwd(),
        workspaceKey: process.cwd(),
        engineId: "jcode",
      });
      // 关键：jcode 走 bundled 分支，故 storage 能力字段在位（这正是 env 覆盖通道
      // 缺失的东西，A.8 的 unsupported_runtime 根因）。
      assert.equal(command?.supportsStorageStartup, true);
      assert.ok(
        typeof command?.storagePreparationEntry === "string" &&
          command.storagePreparationEntry.endsWith("acode.cjs"),
        `jcode 引擎的 storagePreparationEntry 应指向 acode.cjs bundle，实得 ${command?.storagePreparationEntry}`,
      );
      // storage 入口与会话子命令解耦：entry 是 bundle，args 是 jcode-bridge。
      assert.ok(command?.args?.includes("jcode-bridge"));
    });
  });
});

test("R5: jcodeBinaryPath env 只在引擎=jcode 且路径非空时注入", () => {
  // 引擎是 glm：不注入（glm 会话不该带上无关 env）。
  assert.deepEqual(
    buildJcodeBinaryPathEnv({ agentEngine: "glm", jcodeBinaryPath: "/x/jcode" }),
    {},
  );
  // 引擎是 jcode 但未填路径：不注入空值（shim 侧按 CLI > env > PATH 自行解析并报错）。
  assert.deepEqual(buildJcodeBinaryPathEnv({ agentEngine: "jcode" }), {});
  assert.deepEqual(buildJcodeBinaryPathEnv({ agentEngine: "jcode", jcodeBinaryPath: "   " }), {});
  // 引擎是 jcode 且填了路径：注入（trim 后）。
  assert.deepEqual(
    buildJcodeBinaryPathEnv({ agentEngine: "jcode", jcodeBinaryPath: "  /opt/bin/jcode  " }),
    { ACODE_JCODE_BINARY_PATH: "/opt/bin/jcode" },
  );
  // 未设置引擎：不注入（回退 native 语义）。
  assert.deepEqual(buildJcodeBinaryPathEnv({ jcodeBinaryPath: "/x/jcode" }), {});
});

test("R5: ACODE_JCODE_BINARY_PATH 被 sanitize 剔除（strip-then-inject，继承值无效）", () => {
  // 用户级 env 注入必须被剔除——否则可把 jcode 指向攻击者二进制
  // （与 agent-command-env-gate.md R1 同一威胁模型）。
  const sanitized = sanitizeACodeRuntimeEnv({
    ACODE_JCODE_BINARY_PATH: "/tmp/evil-jcode",
    PATH: "/usr/bin",
  });
  assert.equal(
    sanitized.ACODE_JCODE_BINARY_PATH,
    undefined,
    "继承的 ACODE_JCODE_BINARY_PATH 必须被剔除，只有 Host 从 Settings 装配后注入的值存活",
  );
  // 对照：无关的 PATH 保留（证明剔除是精准的，不是整体清空）。
  assert.equal(sanitized.PATH, "/usr/bin");
});

test("R1: 打包态仍忽略 ACODE_AGENT_SERVER_COMMAND（env-gate 不因加引擎而放宽）", async () => {
  await withFakeBundle(async () => {
    await withEnv({ ...PACKAGED, ACODE_AGENT_SERVER_COMMAND: "/tmp/evil" }, () => {
      const command = resolveDefaultACodeAgentCommand({
        workspacePath: process.cwd(),
        workspaceKey: process.cwd(),
        engineId: "jcode",
      });
      assert.notEqual(command?.command, "/tmp/evil", "打包态必须忽略 env 覆盖的会话命令");
      // 且 jcode 引擎在打包态仍解析成 jcode-bridge（走 bundled/Electron 候选链）。
      assert.ok(command?.args?.includes("jcode-bridge"));
    });
  });
});
