import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServiceLogger } from "../src/logger/serviceLogger.js";
import { resetServiceLogRedactorForTest } from "../src/logger/logPrivacy.js";

/**
 * serviceLogger 脱敏漏斗（specs/log-privacy-redaction.md services R1-R6）：
 * 字符串与 Error 在源头脱敏，对象按引用透传（R2-04：对象内容脱敏在终局字符串化
 * 漏斗，非桌面进程缺口为已登记跨文件事项），不合格式会话 token 整行抑制，脱敏幂等。
 */

interface CapturedCall {
  fn: string;
  args: unknown[];
}

function createCapturingSink() {
  const calls: CapturedCall[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
    };
  return {
    calls,
    sink: {
      log: record("log"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
  };
}

test("字符串参数在漏斗内脱敏：家目录、机密 kv、URL origin 收敛", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink, isDebugEnabled: true });
  const secretLine = `open ${join(homedir(), "secret.txt")} failed api_key="hunter2-secret-value" see https://api.example.com/v1/x?sig=1`;
  logger.info(undefined, secretLine);
  assert.equal(calls.length, 1);
  const out = String(calls[0]!.args[1]);
  assert.ok(!out.includes("hunter2-secret-value"), out);
  assert.ok(out.includes("<redacted>"), out);
  assert.ok(!out.includes("sig=1"), out);
  assert.ok(out.includes("https://api.example.com/<path>"), out);
  // 家目录若出现在消息里必须变成 <home>（Windows 短路径形态差异时至少不残留原样）。
  if (secretLine.includes(homedir()) && homedir().length >= 4) {
    assert.ok(!out.includes(homedir()), out);
  }
});

test("Error 参数展平为脱敏后的 name+message+stack 字符串", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink });
  const error = new Error(`cannot read ${join(homedir(), "private.key")}`);
  logger.error(undefined, error);
  const out = String(calls[0]!.args[1]);
  assert.ok(out.startsWith("Error: cannot read"), out);
  if (homedir().length >= 4) {
    assert.ok(!out.includes(homedir()), out);
  }
});

test("对象参数原样透传（不改变日志形状）", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink });
  const payload = { workspacePath: "D:/repo", count: 3 };
  logger.warn(undefined, "context:", payload);
  assert.equal(calls[0]!.args[2], payload, "对象必须按引用透传");
});

/**
 * 守护 R2-04 契约边界（review 2026-10-22 security §2 第三条）：
 * 含敏感字段的对象在服务层源头漏斗**按引用透传、不脱敏**——对象内容的脱敏由
 * 终局字符串化漏斗（桌面 main write() / host reportHostLog，见 desktop 与 shared
 * 的 redactArgValue 测试）负责。此测试钉住「源头不对对象 JSON 化脱敏」这一
 * 承重不变量的现状：acode-agent session start timing 观测面（spec R3）依赖经
 * console 拦截读取对象的结构化字段，源头字符串化会破坏它。任何要在源头对对象
 * 脱敏的改动都必须先更新 specs/log-privacy-redaction.md R2-04 并复核 R3 观测面。
 */
test("非桌面 sink：含敏感字段的对象在源头按引用透传（不在本层脱敏，守护 R2-04）", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  // 用明显的假值，不写真实凭据。
  const logger = createServiceLogger("unit-test", { sink });
  const payload = { accessToken: "sk-fake1234567890abcdefghij", note: "terminal funnel redacts" };
  logger.info(undefined, payload);
  // 现状：对象按引用透传，源头漏斗不改其内容（脱敏责任在终局字符串化漏斗）。
  assert.equal(calls[0]!.args[1], payload, "对象必须按引用透传给 sink");
  // 字符串/Error 仍在源头脱敏（R2），与对象透传形成对照。
  logger.warn(undefined, "access_token=sk-fake1234567890abcdefghij");
  const strOut = String(calls[1]!.args[1]);
  assert.ok(!strOut.includes("sk-fake1234567890abcdefghij"), strOut);
});

test("不合格式会话 token → 整行 <withheld>（fail-closed）", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink });
  logger.info(undefined, `leaked sess_${"x".repeat(200)} tail`);
  assert.equal(calls[0]!.args[1], "<withheld>");
});

test("合法 sess_ id 保留（本地日志需要排障关联键）", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink });
  const sessionId = "sess_12345678-1234-1234-1234-123456789abc";
  logger.info(undefined, `session ${sessionId} started`);
  assert.ok(String(calls[0]!.args[1]).includes(sessionId));
});

test("脱敏幂等：同一文本过两次漏斗输出不变", () => {
  resetServiceLogRedactorForTest();
  const first = createCapturingSink();
  const second = createCapturingSink();
  const message = `path ${join(homedir(), "a.txt")} url https://api.example.com/p?q=1 kv token=abc123456789`;
  createServiceLogger("t1", { sink: first.sink }).info(undefined, message);
  const once = String(first.calls[0]!.args[1]);
  createServiceLogger("t2", { sink: second.sink }).info(undefined, once);
  assert.equal(String(second.calls[0]!.args[1]), once);
});

test("debug 门控不受脱敏影响：未开启时不写 sink", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("unit-test", { sink, isDebugEnabled: false });
  logger.debug(undefined, "nope");
  assert.equal(calls.length, 0);
});

/**
 * 守护 R2-03：OAuth/凭据面 log helper 改走 createServiceLogger 漏斗后，
 * 含 token/code/redirect 字样的参数必须在源头被脱敏，不再直落 stdout。
 * 这里用假值验证漏斗对 OAuth 常见形态（Bearer 头、access_token kv、redirect URL）
 * 的脱敏，等价于 oauthService/zaiProviderAdapter helper 经 serviceLog.info 的效果。
 */
test("OAuth 凭据面参数经漏斗脱敏：Bearer token / access_token kv / redirect URL（R2-03）", () => {
  resetServiceLogRedactorForTest();
  const { calls, sink } = createCapturingSink();
  const logger = createServiceLogger("oauthService", { sink });
  // 假值：Bearer 头形态、access_token kv、长 base64 blob、redirect URL 带 state/code。
  logger.info(
    undefined,
    "token request Authorization: Bearer fakeBearerTokenValue12345 access_token=sk-fake0123456789abcdef",
  );
  logger.info(
    undefined,
    "redirect https://acode.example.com/callback?code=fakeAuthCode98765&state=abc123",
  );
  const bearerLine = String(calls[0]!.args[1]);
  const redirectLine = String(calls[1]!.args[1]);
  // Bearer token 原值不落 sink（Authorization 键值 + Bearer 形态双规则均命中，收敛为占位符）。
  assert.ok(!bearerLine.includes("fakeBearerTokenValue12345"), bearerLine);
  // access_token 的 sk- 长 token 值形态被脱敏，原值不落 sink。
  assert.ok(!bearerLine.includes("sk-fake0123456789abcdef"), bearerLine);
  assert.ok(bearerLine.includes("access_token"), bearerLine);
  // redirect URL 的 query（含 code/state）被收敛，code 原值不落 sink。
  assert.ok(!redirectLine.includes("fakeAuthCode98765"), redirectLine);
  assert.ok(!redirectLine.includes("code=fakeAuthCode98765"), redirectLine);
});
