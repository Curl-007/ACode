/**
 * WI-17 patterns 匹配矩阵单测（specs/transcript-secret-obfuscation.md 验收场景 1）。
 * 全部使用合成秘密（任务纪律：真实凭据永不进测试快照）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CREDENTIAL_PATTERNS } from "../src/security/secret-redaction/patterns.js";
import {
  builtinCredentialSecretEntries,
  collectEnvSecrets,
  CONNECTION_URL_PASSWORD_RE,
  MIN_ENV_VALUE_LENGTH,
  SECRET_ENV_PATTERNS,
} from "../src/security/secret-redaction/collect.js";

function regexOf(name: string): RegExp {
  const pattern = CREDENTIAL_PATTERNS.find((entry) => entry.name === name);
  assert.ok(pattern, `pattern ${name} must exist`);
  return new RegExp(pattern.source, pattern.flags ?? "");
}

// 每个内置正则族的「真阳性 / 近邻假阳性」矩阵（omp patterns 清单裁剪后的有效集）。
const PATTERN_MATRIX: ReadonlyArray<{
  name: string;
  positive: readonly string[];
  negative: readonly string[];
}> = [
  {
    name: "Credential",
    positive: [
      `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`, // GitHub PAT（36+ token 字符）
      `github_pat_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
      `glpat-${"A1b2C3d4E5f6G7h8I9j0"}`, // GitLab PAT（20+）
      `sk-proj-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
      `sk-ant-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
      `sk-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4"}`, // 裸 sk-（48+）
    ],
    negative: [
      "ghp_tooshort", // 长度不足
      `xghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`, // 左边界粘连
      "task_token_expiry_seconds", // 普通标识符（无通用关键词规则的纪律断言）
    ],
  },
  {
    name: "AWSAccessKey",
    positive: ["AKIAIOSFODNN7SYNTH01", "ASIAJ5T2VQ3WNRYNTH01"], // AKIA/ASIA + 16 位大写数字
    negative: ["AKIAIOSFODNN7SYNTH", "xAKIAIOSFODNN7SYNTH01", "AKIAiosfodnn7synth01"], // 位数不足 / 左粘连 / 小写
  },
  {
    name: "GoogleAPIKey",
    positive: [`AIzaSy${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4"}`],
    negative: ["AIzaSyShort", "xAIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4"],
  },
  {
    name: "SlackToken",
    positive: ["xoxb-123456789012-abcdef", "xoxp-1234567890-abcd"],
    negative: ["xoxz-1234567890-abcd", "xoxb-short"],
  },
  {
    name: "NpmToken",
    positive: [`npm_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`],
    negative: ["npm_short", "NPM_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"],
  },
  {
    name: "StripeKey",
    positive: [`sk_live_${"A1b2C3d4E5f6G7h8I9j0"}`, `rk_test_${"A1b2C3d4E5f6G7h8I9j0"}`],
    negative: [`sk_staging_${"A1b2C3d4E5f6G7h8I9j0"}`, "sk_live_short"],
  },
  {
    name: "StripeWebhookSecret",
    positive: [`whsec_${"A1b2C3d4E5f6G7h8I9j0"}`],
    negative: ["whsec_short"],
  },
  {
    name: "HuggingFaceToken",
    positive: [`hf_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`],
    negative: ["hf_short"],
  },
  {
    name: "SendGridKey",
    positive: [`SG.${"A1b2C3d4E5f6G7h8I9j0K1"}.${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"}`],
    negative: ["SG.short.short"],
  },
  {
    name: "JWT",
    positive: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.c2ludGhldGljc2ln"],
    negative: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJz", "not-a-jwt"], // 两段 / 无形态
  },
  {
    name: "BearerToken",
    positive: ["Authorization: Bearer A1b2C3d4E5f6G7h8I9j0", "bearer a1b2c3d4e5f6g7h8i9j0"],
    negative: ["Bearer short", "Basic A1b2C3d4E5f6G7h8I9j0K1"],
  },
  {
    name: "PrivateKey",
    positive: [
      "-----BEGIN RSA PRIVATE KEY-----\nTUlJQlZBSUJBREFOQmdrcWhraUc5dzBC\n-----END RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\nTUlJQlZBSUJBREFOQmdrcWhraUc5dzBC\n-----END PRIVATE KEY-----",
    ],
    negative: ["-----BEGIN CERTIFICATE-----\nTUlJQlZB\n-----END CERTIFICATE-----"],
  },
];

test("内置凭据正则族：真阳性/近邻假阳性矩阵", () => {
  for (const row of PATTERN_MATRIX) {
    const regex = regexOf(row.name);
    for (const positive of row.positive) {
      if (positive === "") continue; // 防御空串占位
      assert.ok(regex.test(positive), `${row.name} 应命中: ${positive.slice(0, 12)}…`);
      regex.lastIndex = 0;
    }
    for (const negative of row.negative) {
      assert.ok(!regex.test(negative), `${row.name} 不应命中: ${negative.slice(0, 24)}…`);
      regex.lastIndex = 0;
    }
  }
});

test("literalPrefixes 门对每个 pattern 的每个真阳性至少命中一个字面量", () => {
  // 性能门的正确性前提（omp patterns.ts 注释：门必须对 alternative 穷尽）。
  for (const row of PATTERN_MATRIX) {
    const pattern = CREDENTIAL_PATTERNS.find((entry) => entry.name === row.name);
    assert.ok(pattern?.literalPrefixes, `${row.name} 必须声明 literalPrefixes`);
    const caseInsensitive = pattern?.flags?.includes("i") === true;
    for (const positive of row.positive) {
      if (positive === "") continue;
      const probe = caseInsensitive ? positive.toLowerCase() : positive;
      const hit = pattern!.literalPrefixes!.some((literal) =>
        probe.includes(caseInsensitive ? literal.toLowerCase() : literal),
      );
      assert.ok(hit, `${row.name} 的字面量门漏掉了真阳性: ${positive.slice(0, 12)}…`);
    }
  }
});

test("env 名字模式矩阵（omp SECRET_ENV_PATTERNS 语义）", () => {
  const positive = [
    "API_KEY",
    "MY_SECRET",
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "USER_PASS",
    "AUTH",
    "OAUTH_CLIENT_CREDENTIAL",
    "PRIVATE_SIGNING",
    "SERVICE_AUTH_TOKEN",
    "api_key",
    "lowercase_secret",
  ];
  const negative = ["KEYBOARD", "MONKEYS_VALUE", "AUTHORITY_NAME_X", "PATH", "USERNAME"];
  for (const name of positive) {
    assert.ok(SECRET_ENV_PATTERNS.test(name), `应收集: ${name}`);
  }
  for (const name of negative) {
    // KEYBOARD/AUTHORITY：关键词后既非 _ 也非结尾。
    assert.ok(!SECRET_ENV_PATTERNS.test(name), `不应收集: ${name}`);
  }
});

test("collectEnvSecrets：长度门、去重、连接串密码（含 percent-decoded）", () => {
  const env: NodeJS.ProcessEnv = {
    API_KEY: "synthetic-env-secret-value-1", // ≥8，收集
    SHORT_TOKEN: "abc123", // <8（MIN_ENV_VALUE_LENGTH），跳过
    DUPLICATE_SECRET: "synthetic-env-secret-value-1", // 值重复，去重
    DATABASE_URL: "postgres://dbuser:supersecretpw1@db.internal:5432/app",
    ENCODED_REDIS: "redis://:p%40ssw0rd-synth@cache.internal:6379",
    PLAIN_VAR: "just-a-normal-value", // 名字不命中，值也非连接串
    HOME: "/home/synthetic",
  };
  const entries = collectEnvSecrets(env);
  const contents = new Set(entries.map((entry) => entry.content));
  assert.ok(contents.has("synthetic-env-secret-value-1"));
  assert.ok(!contents.has("abc123"), "短于 8 的值不收集");
  assert.equal(
    entries.filter((entry) => entry.content === "synthetic-env-secret-value-1").length,
    1,
    "同值去重",
  );
  assert.ok(contents.has("supersecretpw1"), "连接串密码收集（无视变量名）");
  assert.ok(contents.has("p%40ssw0rd-synth"), "编码形态收集");
  assert.ok(contents.has("p@ssw0rd-synth"), "percent-decoded 形态也收集");
  assert.ok(!contents.has("just-a-normal-value"));
  assert.ok(entries.every((entry) => entry.type === "plain"));
  assert.ok(MIN_ENV_VALUE_LENGTH === 8);
});

test("连接串密码提取只认 scheme://user:password@ 形态", () => {
  assert.ok(CONNECTION_URL_PASSWORD_RE.test("mysql://u:password123@h/db"));
  assert.ok(!CONNECTION_URL_PASSWORD_RE.test("https://example.com/path"));
  assert.ok(!CONNECTION_URL_PASSWORD_RE.test("not a url :// x"));
});

test("builtinCredentialSecretEntries：每个 pattern 都成为 regex 条目并带友好名", () => {
  const entries = builtinCredentialSecretEntries();
  assert.equal(entries.length, CREDENTIAL_PATTERNS.length);
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.type, "regex");
    assert.equal(entry.content, CREDENTIAL_PATTERNS[index].source);
    assert.equal(entry.friendlyName, CREDENTIAL_PATTERNS[index].name);
    // 每个 source 必须可编译（防手写正则语法漂移）。
    assert.ok(new RegExp(entry.content, entry.flags ?? "") instanceof RegExp);
  }
});
