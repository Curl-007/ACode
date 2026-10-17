import assert from "node:assert/strict";
import test from "node:test";

import {
  isSensitiveLogKeyName,
  normalizeLogKeyName,
  SENSITIVE_KEY_EXACT_NAME_PATTERN,
  SENSITIVE_KEY_SUFFIX_PATTERN,
} from "../src/sensitiveKeyNames.js";

/**
 * 敏感键名单源化（specs/log-privacy-redaction.md R1）：
 * feedbackPrivacy / 日志管线 / exportLogs 共用的唯一词表。
 * 这里冻结「新增键必须命中、白名单必须放行」两个方向的边界。
 */

test("归一化剥分隔符并小写", () => {
  assert.equal(normalizeLogKeyName("X-Api-Key_v2"), "xapikeyv2");
  assert.equal(normalizeLogKeyName("  DB_URL "), "dburl");
});

test("新增精确键与版本号形态命中", () => {
  for (const key of [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key-v2",
    "x-amz-security-token",
    "x-goog-api-key",
    "ocp-apim-subscription-key",
    "x-subscription-token",
    "private-token",
    "x-functions-key",
    "x-honeycomb-team",
    "token_v10",
  ]) {
    assert.equal(isSensitiveLogKeyName(key), true, `${key} 应判敏感`);
  }
});

test("组合后缀（-keys/-secrets/-tokens + 版本号）命中", () => {
  for (const key of [
    "client-signing-keys",
    "master_keys_v2",
    "encryption-secrets",
    "session_tokens",
    "access_keys-v3",
    "license-key",
    "signingkey",
    "clientsecret",
  ]) {
    assert.equal(isSensitiveLogKeyName(key), true, `${key} 应判敏感`);
  }
  assert.ok(SENSITIVE_KEY_SUFFIX_PATTERN.test("clientsigningkeysv2"));
  assert.ok(SENSITIVE_KEY_EXACT_NAME_PATTERN.test("xapikeyv2"));
});

test("原 feedbackPrivacy 与 exportLogs 族全部保留", () => {
  for (const key of [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "apiKey",
    "accesskey",
    "privatekey",
    "cookie",
    "credential",
    "pwd",
    "dsn",
    "auth",
    "conn_str",
    "connection-string",
    "database_url",
    "db-url",
    "db_password",
    "my_secret",
  ]) {
    assert.equal(isSensitiveLogKeyName(key), true, `${key} 应判敏感`);
  }
});

test("白名单放行 LLM 计数与普通词（防过度抑制）", () => {
  for (const key of [
    "max_tokens",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "budget_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
    "tool_use_prompt_tokens",
    "token_count",
    "tokenizer",
    "author",
    "authors",
    "authority",
    "public_key",
    "keywords",
    "keyword",
  ]) {
    assert.equal(isSensitiveLogKeyName(key), false, `${key} 不应判敏感`);
  }
});

test("空键与未知键不误伤", () => {
  assert.equal(isSensitiveLogKeyName(""), false);
  assert.equal(isSensitiveLogKeyName("level"), false);
  assert.equal(isSensitiveLogKeyName("workspacePath"), false);
});
