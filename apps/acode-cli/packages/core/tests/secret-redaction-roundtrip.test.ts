/**
 * WI-17 占位符可逆性单测（specs/transcript-secret-obfuscation.md 验收场景 2）：
 * 混淆→还原逐字节相等、幂等、确定性、大小写 hint、未知形态放行。
 * 全部使用合成秘密。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor } from "../src/security/secret-redaction/redactor.js";
import {
  builtinCredentialSecretEntries,
  type SecretEntry,
} from "../src/security/secret-redaction/collect.js";
import {
  buildHashBase,
  createPlaceholderRegex,
  inferCaseHint,
  MIN_OBFUSCATE_SECRET_LEN,
} from "../src/security/secret-redaction/placeholder.js";

// 合成密钥（43 字符形态，仅测试用，非真实凭据）。
const TEST_KEY = "synthetic-test-key-0123456789abcdefghijklmn";

function createRedactor(plainSecrets: string[], key: string = TEST_KEY): SecretRedactor {
  const entries: SecretEntry[] = [
    ...plainSecrets.map((content) => ({ type: "plain" as const, content })),
    ...builtinCredentialSecretEntries(),
  ];
  return new SecretRedactor({ entries, keyProvider: () => key });
}

const SYNTH_GITHUB = `ghp_${"S1y2N3t4H5e6T7i8C9a0L1b2C3d4E5f6G7h8"}`;
const SYNTH_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzeW50aCI6InRlc3QifQ.c3ludGhldGljc2lnbmF0";
const SYNTH_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nTUlJQlZBSUJBREFOQmdrcWhraUc5dzBC\n-----END RSA PRIVATE KEY-----";

test("plain 秘密：混淆→还原逐字节相等（含多处出现与首尾位置）", () => {
  const secret = "synthetic-env-secret-Value-123";
  const redactor = createRedactor([secret]);
  const text = `${secret} 开头；中段再次出现 ${secret}；结尾 ${secret}`;
  const obfuscated = redactor.obfuscateText(text);
  assert.ok(!obfuscated.includes(secret), "混淆后不得含原文");
  assert.ok(obfuscated.includes("$$"), "应产生占位符");
  const restored = redactor.restoreValue(obfuscated);
  assert.equal(restored.value, text, "逐字节相等");
  assert.equal(restored.unresolvedPlaceholders, 0);
});

test("大小写 hint 四态（U/L/C/M）与无字母态", () => {
  assert.equal(inferCaseHint("ABC123"), "U");
  assert.equal(inferCaseHint("abc123"), "L");
  assert.equal(inferCaseHint("Abc123"), "C");
  assert.equal(inferCaseHint("aBc123"), "M");
  assert.equal(inferCaseHint("12345678"), undefined, "无 cased 字母则无 hint");

  const redactor = createRedactor(["SYNTHUPPER1", "synthlower1", "Synthcap1", "sYnthmix1"]);
  const obfuscated = redactor.obfuscateText("SYNTHUPPER1 synthlower1 Synthcap1 sYnthmix1");
  assert.match(obfuscated, /\$\$[A-Z0-9]{12}:U\$\$/);
  assert.match(obfuscated, /\$\$[A-Z0-9]{12}:L\$\$/);
  assert.match(obfuscated, /\$\$[A-Z0-9]{12}:C\$\$/);
  assert.match(obfuscated, /\$\$[A-Z0-9]{12}:M\$\$/);
  assert.equal(
    redactor.restoreValue(obfuscated).value,
    "SYNTHUPPER1 synthlower1 Synthcap1 sYnthmix1",
  );
});

test("仅大小写不同的秘密获得独立占位符基（防 hint 合成）", () => {
  const redactor = createRedactor(["SyntheticCaseValue", "syntheticcasevalue"]);
  const obfuscated = redactor.obfuscateText("SyntheticCaseValue syntheticcasevalue");
  const bases = [...obfuscated.matchAll(/\$\$([A-Z0-9]{12})(?::[ULCM])?\$\$/g)].map((m) => m[1]);
  assert.equal(bases.length, 2);
  assert.notEqual(bases[0], bases[1], "HMAC 输入是精确原文，基必须不同");
});

test("内置正则族：友好名前缀占位符 + 别名还原", () => {
  const redactor = createRedactor([]);
  const text = `token=${SYNTH_GITHUB} jwt=${SYNTH_JWT}`;
  const obfuscated = redactor.obfuscateText(text);
  assert.ok(!obfuscated.includes(SYNTH_GITHUB));
  assert.ok(!obfuscated.includes(SYNTH_JWT));
  assert.match(obfuscated, /\$\$CREDENTIAL_[A-Z0-9]{12}(?::[ULCM])?\$\$/, "Credential 族友好名");
  assert.match(obfuscated, /\$\$JWT_[A-Z0-9]{12}(?::[ULCM])?\$\$/, "JWT 族友好名");
  assert.equal(redactor.restoreValue(obfuscated).value, text);

  // 模型可能省略友好前缀回写——去前缀别名也要能还原（omp 同款别名语义）。
  const aliasOnly = obfuscated.replace(
    /\$\$CREDENTIAL_([A-Z0-9]{12}(?::[ULCM])?)\$\$/,
    (_match, inner: string) => `$$${inner}$$`,
  );
  const restoredAlias = redactor.restoreValue(aliasOnly);
  assert.ok(String(restoredAlias.value).includes(SYNTH_GITHUB), "别名形态应还原");
});

test("PEM 多行私钥块整体占位并可逆", () => {
  const redactor = createRedactor([]);
  const text = `before\n${SYNTH_PEM}\nafter`;
  const obfuscated = redactor.obfuscateText(text);
  assert.ok(!obfuscated.includes("PRIVATE KEY"));
  assert.match(obfuscated, /\$\$PRIVATEKEY_[A-Z0-9]{12}(?::[ULCM])?\$\$/);
  assert.equal(redactor.restoreValue(obfuscated).value, text);
});

test("幂等：二次混淆恒等；占位符不会被内置正则再次命中", () => {
  const redactor = createRedactor(["synthetic-env-secret-Value-123"]);
  const text = `env=synthetic-env-secret-Value-123 github=${SYNTH_GITHUB}`;
  const once = redactor.obfuscateText(text);
  const twice = redactor.obfuscateText(once);
  assert.equal(twice, once);
});

test("identity：无命中文本返回原引用（不复制）", () => {
  const redactor = createRedactor(["synthetic-env-secret-Value-123"]);
  const clean = "这是一段不含任何秘密的普通转录文本 token_expiry_seconds=30";
  assert.equal(redactor.obfuscateText(clean), clean, "同值");
  const messages = [{ role: "user" as const, content: clean }];
  assert.equal(redactor.projectModelMessages(messages), messages, "消息数组同引用");
});

test("确定性：同 key 同秘密 → 同占位符；异 key → 异占位符", () => {
  const a = createRedactor(["synthetic-env-secret-Value-123"], TEST_KEY);
  const b = createRedactor(["synthetic-env-secret-Value-123"], TEST_KEY);
  const other = createRedactor(
    ["synthetic-env-secret-Value-123"],
    "YW5vdGhlci1zeW50aGV0aWMtdGVzdC1rZXktMTIzNA",
  );
  const text = "synthetic-env-secret-Value-123";
  assert.equal(a.obfuscateText(text), b.obfuscateText(text), "跨实例稳定（跨重启还原的前提）");
  assert.notEqual(
    a.obfuscateText(text),
    other.obfuscateText(text),
    "私钥不同则基不同（防字典还原）",
  );
  // 基是 keyed digest：无 key 的裸哈希不可复现占位符。
  assert.equal(buildHashBase(TEST_KEY, text).length, 12);
});

test("还原面：深结构（对象/数组/嵌套）与未知 $$…$$ 形态放行", () => {
  const secret = "synthetic-env-secret-Value-123";
  const redactor = createRedactor([secret]);
  const obfuscated = redactor.obfuscateText(secret);
  const input = {
    command: `curl -H "Authorization: Bearer ${obfuscated}" https://example.internal`,
    files: [{ path: "/tmp/x", content: obfuscated }, "plain", 42, null, true],
    nested: { deep: { value: obfuscated } },
  };
  const outcome = redactor.restoreValue(input);
  const restored = outcome.value as typeof input;
  assert.ok(restored.command.includes(secret));
  assert.equal(restored.files[0].content, secret);
  assert.equal((restored.nested.deep as { value: string }).value, secret);
  assert.equal(outcome.unresolvedPlaceholders, 0);

  // 未知形态：宽松 $FOO$ / 短基 / Makefile 风格 $$ 字面量 → 原样放行且不计 unresolved。
  const unknown = redactor.restoreValue({
    cmd: "echo $$ && make $$@$$ && ref $$SHORT$$ and $$AAAAAAAAAAAA$$",
  });
  assert.equal(
    (unknown.value as { cmd: string }).cmd,
    "echo $$ && make $$@$$ && ref $$SHORT$$ and $$AAAAAAAAAAAA$$",
    "未知形态逐字节放行",
  );
  // $$AAAAAAAAAAAA$$ 是严格铸造形态（12 位基）但不在表内 → 计入 unresolved（fail-loud 触发面）。
  assert.equal(unknown.unresolvedPlaceholders, 1);
});

test("短秘密门槛：plain <8 不注册；正则匹配 <8 不占位", () => {
  const redactor = createRedactor(["abc123"]); // 6 字符
  assert.equal(redactor.plainSecretCount, 0);
  assert.equal(redactor.obfuscateText("abc123"), "abc123");
  assert.equal(MIN_OBFUSCATE_SECRET_LEN, 8);
  // PLACEHOLDER 正则本身与 omp 同款形态。
  const regex = createPlaceholderRegex();
  assert.ok(regex.test("$$CREDENTIAL_ABC123DEF456:M$$"));
});

test("长秘密包含短秘密：长度降序替换不产生碎片泄漏", () => {
  const long = "synthetic-LONG-secret-value-999";
  const short = "synthetic-LONG-secret"; // long 的前缀，同样 ≥8
  const redactor = createRedactor([short, long]);
  const obfuscated = redactor.obfuscateText(long);
  assert.ok(!obfuscated.includes(long));
  assert.ok(!obfuscated.includes(short), "短秘密不得先啃掉长秘密的中段");
  assert.equal(redactor.restoreValue(obfuscated).value, long);
});
