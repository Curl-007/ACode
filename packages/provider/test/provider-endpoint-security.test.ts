import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlaintextHttpBaseUrl } from "../src/config/provider-endpoint-security.js";

/**
 * 安全加固 P2 #7 的验收测试：http 明文端点判定（纯函数层）。
 *
 * 判定是 UI 内联警告的唯一事实源：只有「合法 URL 且 protocol 为 http:」才告警。
 * 非法 URL 不在此分类（schema 的 url 校验负责），空值/草稿不得误报。
 */
test("http:// base URLs are flagged as plaintext endpoints", () => {
  assert.equal(isPlaintextHttpBaseUrl("http://api.example.com/v1"), true);
  assert.equal(isPlaintextHttpBaseUrl("http://192.168.1.10:8080"), true);
  assert.equal(isPlaintextHttpBaseUrl("http://api.example.com/v1/with/path?q=1"), true);
  // 协议大小写按 WHATWG URL 规范归一为小写 http:。
  assert.equal(isPlaintextHttpBaseUrl("HTTP://api.example.com"), true);
  // 前后空白是表单草稿常态，判定按 trim 后解析。
  assert.equal(isPlaintextHttpBaseUrl("  http://api.example.com  "), true);
});

test("https and non-URL values are not flagged", () => {
  assert.equal(isPlaintextHttpBaseUrl("https://api.example.com/v1"), false);
  assert.equal(isPlaintextHttpBaseUrl("HTTPS://api.example.com"), false);
  // 尚未输入完成的草稿/占位符不是安全问题，不告警。
  assert.equal(isPlaintextHttpBaseUrl(""), false);
  assert.equal(isPlaintextHttpBaseUrl("   "), false);
  assert.equal(isPlaintextHttpBaseUrl("api.example.com"), false);
  assert.equal(isPlaintextHttpBaseUrl("not a url"), false);
  assert.equal(isPlaintextHttpBaseUrl(null), false);
  assert.equal(isPlaintextHttpBaseUrl(undefined), false);
  assert.equal(isPlaintextHttpBaseUrl(123 as unknown as string), false);
});
