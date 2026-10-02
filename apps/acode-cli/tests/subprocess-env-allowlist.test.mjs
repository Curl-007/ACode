import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 安全加固 P2 的验收测试：Bash 工具与 MCP stdio 子进程边界的凭据剥离。
 * 覆盖 apps/acode-cli/specs/subprocess-env-credential-allowlist.md 场景 1–6。
 * 纯内存 env 构造，无文件系统/子进程副作用。
 */

const { buildExecutionEnv } = await import(
  "../packages/adapters/src/exec/execution-command.ts"
);
const { buildMcpStdioEnv } = await import("../packages/adapters/src/mcp/network.ts");
const { sanitizeACodeRuntimeEnv, buildACodeToolEnvPassthroughEnv } = await import(
  "../../../packages/shared/src/runtimeEnv.ts"
);

/** 模拟用户 shell：普通工具链变量 + 各类敏感凭据 + allowlist 变量（可选）。 */
function userShellEnv(extra = {}) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/dev",
    LANG: "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    AWS_SECRET_ACCESS_KEY: "aws-secret-value",
    AWS_PROFILE: "work",
    GITHUB_TOKEN: "ghp_secret_value",
    SSH_AUTH_SOCK: "/tmp/ssh-XXXX/agent.1",
    NPM_TOKEN: "npm_secret_value",
    DATABASE_URL: "postgres://user:pass@localhost/db",
    OPENAI_API_KEY: "sk-secret-value",
    TF_VAR_db_password: "tf-secret",
    MYVENDOR_API_KEY: "vendor-secret",
    ...extra,
  };
}

const SENSITIVE_KEYS = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "NPM_TOKEN",
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "TF_VAR_db_password",
  "MYVENDOR_API_KEY",
];

test("(1) bash tool env: sensitive credentials stripped, toolchain vars kept", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: userShellEnv(),
  });
  for (const key of SENSITIVE_KEYS) {
    assert.equal(key in env, false, `${key} must not reach Bash subprocesses`);
  }
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/dev");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("(1b) mcp stdio env: same stripping at the MCP boundary", () => {
  const env = buildMcpStdioEnv({ env: userShellEnv() });
  for (const key of SENSITIVE_KEYS) {
    assert.equal(key in env, false, `${key} must not reach MCP servers`);
  }
  assert.ok(env.PATH, "PATH must survive for MCP server launch");
});

test("(2) allowlist exact key restores only that key", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: userShellEnv({ ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "SSH_AUTH_SOCK" }),
  });
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/ssh-XXXX/agent.1");
  assert.equal("GITHUB_TOKEN" in env, false, "non-allowlisted secrets stay stripped");
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
});

test("(3) allowlist wildcard restores the whole family", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: userShellEnv({ ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "AWS_*" }),
  });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "aws-secret-value");
  assert.equal(env.AWS_PROFILE, "work");
  assert.equal("GITHUB_TOKEN" in env, false);
});

test("(4) explicit overlay.set injection is applied after stripping", () => {
  const env = buildExecutionEnv(
    { set: { GITHUB_TOKEN: "explicit-injection", CUSTOM_VAR: "x" } },
    { platform: "linux", processEnv: userShellEnv() },
  );
  // 继承的 GITHUB_TOKEN 被剥离，但调用方对单个子进程的显式注入照常生效。
  assert.equal(env.GITHUB_TOKEN, "explicit-injection");
  assert.equal(env.CUSTOM_VAR, "x");
  assert.equal("SSH_AUTH_SOCK" in env, false);
});

test("(5) default sanitize (no options) keeps credentials — main→host boundary unchanged", () => {
  const sanitized = sanitizeACodeRuntimeEnv(userShellEnv());
  // 缺省行为与改动前一致：凭据键保留（第一方进程边界），既有黑名单键照常剥离。
  assert.equal(sanitized.GITHUB_TOKEN, "ghp_secret_value");
  assert.equal(sanitized.SSH_AUTH_SOCK, "/tmp/ssh-XXXX/agent.1");
  assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, "aws-secret-value");
  // 既有黑名单仍然生效（NODE_ENV/遥测/CUA broker 等）。
  assert.equal("NODE_ENV" in sanitizeACodeRuntimeEnv({ NODE_ENV: "development" }), false);
});

test("(6) sensitive keys never enter the tool-env-passthrough side channel", () => {
  const passthrough = buildACodeToolEnvPassthroughEnv(userShellEnv());
  const raw = passthrough.ACODE_TOOL_ENV_PASSTHROUGH_JSON;
  if (raw) {
    for (const key of SENSITIVE_KEYS) {
      assert.equal(raw.includes(key), false, `${key} must not ride the passthrough channel`);
    }
    for (const secret of [
      "aws-secret-value",
      "ghp_secret_value",
      "npm_secret_value",
      "sk-secret-value",
    ]) {
      assert.equal(raw.includes(secret), false, "secret values must not ride the passthrough");
    }
  }
});

test("(6b) allowlist variable itself passes through to the agent env", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: userShellEnv({ ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "GH_TOKEN" }),
  });
  // allowlist 变量不是敏感键：必须存活，下游边界才能读到用户意图。
  assert.equal(env.ACODE_TOOL_ENV_INHERIT_ALLOWLIST, "GH_TOKEN");
});
