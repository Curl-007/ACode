import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 安全加固 P2 的验收测试：敏感凭据 env 键判定（单一事实源）。
 * 覆盖 apps/acode-cli/specs/subprocess-env-credential-allowlist.md 判定规则与场景 7。
 * 纯函数测试，无文件系统副作用。
 */

const {
  ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY,
  isSensitiveCredentialEnvKey,
  isToolEnvInheritAllowed,
  parseToolEnvInheritAllowlist,
} = await import("../src/sensitive-env-guard.ts");

test("exact keys: cloud/scm/ssh/registry/db secrets are sensitive", () => {
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SSH_AUTH_SOCK",
    "NPM_TOKEN",
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "PGPASSWORD",
    "VAULT_TOKEN",
    "KUBECONFIG",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "STRIPE_SECRET_KEY",
    "SLACK_BOT_TOKEN",
  ]) {
    assert.equal(isSensitiveCredentialEnvKey(key), true, `${key} must be sensitive`);
  }
});

test("prefix rules: AWS_/AZURE_/TF_VAR_/GITHUB_/GH_/GOOGLE_/GCLOUD_ families", () => {
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "TF_VAR_db_password",
    "GITHUB_PAT",
    "GH_ENTERPRISE_TOKEN",
    "GOOGLE_CREDENTIALS",
    "GCLOUD_PROJECT",
  ]) {
    assert.equal(isSensitiveCredentialEnvKey(key), true, `${key} must be sensitive`);
  }
});

test("suffix rules: long-tail vendor keys by naming convention", () => {
  for (const key of [
    "MYVENDOR_API_KEY",
    "SOME_SERVICE_ACCESS_TOKEN",
    "APP_SECRET_KEY",
    "REGISTRY_AUTH",
    "CI_DEPLOY_PASSWORD",
    "SIGNING_PRIVATE_KEY",
    "ACME_SECRET",
  ]) {
    assert.equal(isSensitiveCredentialEnvKey(key), true, `${key} must be sensitive`);
  }
});

test("npm_config_* auth/token/password forms are sensitive; plain npm config is not", () => {
  assert.equal(isSensitiveCredentialEnvKey("npm_config__authToken"), true);
  assert.equal(isSensitiveCredentialEnvKey("NPM_CONFIG_FOO_TOKEN"), true);
  assert.equal(isSensitiveCredentialEnvKey("npm_config_registry"), false);
});

test("ordinary toolchain env is NOT sensitive (no over-stripping)", () => {
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "GIT_TERMINAL_PROMPT",
    "GIT_EDITOR",
    "EDITOR",
    "TERM",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "JAVA_HOME",
    "GOPATH",
    "CARGO_HOME",
    "ACODE_TOOL_ENV_INHERIT_ALLOWLIST",
    "ACODE_TOOL_ENV_PASSTHROUGH_JSON",
  ]) {
    assert.equal(isSensitiveCredentialEnvKey(key), false, `${key} must NOT be sensitive`);
  }
});

test("matching is case-insensitive (windows env semantics)", () => {
  assert.equal(isSensitiveCredentialEnvKey("github_token"), true);
  assert.equal(isSensitiveCredentialEnvKey("Github_Token"), true);
  assert.equal(isSensitiveCredentialEnvKey("aws_secret_access_key"), true);
  assert.equal(isSensitiveCredentialEnvKey("  SSH_AUTH_SOCK  "), true);
});

test("allowlist parsing: comma-separated, trimmed, uppercased, wildcards kept", () => {
  assert.deepEqual(parseToolEnvInheritAllowlist("ssh_auth_sock, GH_TOKEN , aws_*"), [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "AWS_*",
  ]);
  assert.deepEqual(parseToolEnvInheritAllowlist(undefined), []);
  assert.deepEqual(parseToolEnvInheritAllowlist(",, ,"), []);
});

test("allowlist matching: exact and PREFIX* forms", () => {
  const allowlist = parseToolEnvInheritAllowlist("SSH_AUTH_SOCK,AWS_*");
  assert.equal(isToolEnvInheritAllowed("SSH_AUTH_SOCK", allowlist), true);
  assert.equal(isToolEnvInheritAllowed("ssh_auth_sock", allowlist), true);
  assert.equal(isToolEnvInheritAllowed("AWS_PROFILE", allowlist), true);
  assert.equal(isToolEnvInheritAllowed("AWS_SECRET_ACCESS_KEY", allowlist), true);
  assert.equal(isToolEnvInheritAllowed("GITHUB_TOKEN", allowlist), false);
  // 裸 "*" 不是合法通配（entry 去掉星号后前缀为空 → 不放行一切）。
  assert.equal(isToolEnvInheritAllowed("GITHUB_TOKEN", ["*"]), false);
});

test("allowlist env key name is stable (documented contract)", () => {
  assert.equal(ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY, "ACODE_TOOL_ENV_INHERIT_ALLOWLIST");
});
