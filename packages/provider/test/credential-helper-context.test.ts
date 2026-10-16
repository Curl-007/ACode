import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACODE_HELPER_CONTEXT_ENV_KEY,
  CREDENTIAL_HELPER_CONTEXTS,
  isUserPresentCredentialHelperContext,
  parseCredentialHelperContext,
} from "../src/credential-helper-context.js";

/**
 * 凭据 helper 上下文标记五值闭集的验收测试（W2-SEC5）。
 * 覆盖 packages/provider/specs/credential-helper-context.md 场景 1–4。
 */

test("(1) all five contexts parse to themselves; closed set is exactly five", () => {
  assert.deepEqual(
    [...CREDENTIAL_HELPER_CONTEXTS],
    ["interactive", "mid-session-refresh", "background", "scheduled-task", "setup-test"],
    "闭集封闭性锚点：加值必须走代码评审 + spec 更新",
  );
  for (const context of CREDENTIAL_HELPER_CONTEXTS) {
    assert.equal(parseCredentialHelperContext(context), context);
  }
});

test("(2) unknown/empty values fail closed to undefined; trim+case normalize", () => {
  // 未知值（含未来值传到旧解析器、拼错）→ undefined，调用方必须落到无人值守分支。
  assert.equal(parseCredentialHelperContext("cron"), undefined);
  assert.equal(parseCredentialHelperContext("interaktive"), undefined, "拼错不近似命中");
  assert.equal(parseCredentialHelperContext(""), undefined);
  assert.equal(parseCredentialHelperContext("   "), undefined);
  assert.equal(parseCredentialHelperContext(undefined), undefined);
  // trim + 小写归一后命中闭集（大小写/首尾空白是 env 传递的常态噪声）。
  assert.equal(parseCredentialHelperContext("INTERACTIVE "), "interactive");
  assert.equal(parseCredentialHelperContext("SCHEDULED-TASK"), "scheduled-task");
  assert.equal(parseCredentialHelperContext(" setup-test "), "setup-test");
});

test("(3) user-present predicate: only interactive/setup-test may prompt", () => {
  assert.equal(isUserPresentCredentialHelperContext("interactive"), true);
  assert.equal(isUserPresentCredentialHelperContext("setup-test"), true);
  // 无人值守三值 + 缺席（undefined）一律禁止交互提示（fail-closed）。
  assert.equal(isUserPresentCredentialHelperContext("mid-session-refresh"), false);
  assert.equal(isUserPresentCredentialHelperContext("background"), false);
  assert.equal(isUserPresentCredentialHelperContext("scheduled-task"), false);
  assert.equal(isUserPresentCredentialHelperContext(undefined), false);
});

test("(4) env key constant is the reserved cross-process channel name", () => {
  assert.equal(ACODE_HELPER_CONTEXT_ENV_KEY, "ACODE_HELPER_CONTEXT");
});
