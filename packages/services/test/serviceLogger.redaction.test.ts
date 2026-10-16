import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServiceLogger } from "../src/logger/serviceLogger.js";
import { resetServiceLogRedactorForTest } from "../src/logger/logPrivacy.js";

/**
 * serviceLogger 脱敏漏斗（specs/log-privacy-redaction.md services R1-R6）：
 * 字符串与 Error 在源头脱敏，对象原样透传（形状不变），
 * 不合格式会话 token 整行抑制，脱敏幂等。
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
