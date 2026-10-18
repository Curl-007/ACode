import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/model-compat-flags.md R4/R5 —— 管道 fetch 包装：
// 无标志直通（不读 body）、fail-open、no-op 免重序列化、与 option-map 的先后顺序。

const { createCompatTransformFetch } = await import(
  "../packages/adapters/src/model/model-compat-fetch.ts"
);
const { createModelOptionMapFetch } = await import(
  "../packages/adapters/src/model/model-option-map-fetch.ts"
);
const { compileModelOptionMaps } = await import(
  "../../../packages/model-option-map/src/index.ts"
);

/** 记录最内层收到的 request/init，返回固定 200。 */
function spyFetch() {
  const calls = [];
  const fetchImpl = async (request, init) => {
    calls.push({ request, init });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

test("管道：无标志 → 原样直通，init 引用不变（不读 body，字节级零变化）", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({ fetch: spy.fetchImpl, flags: {} });
  const init = { method: "POST", body: JSON.stringify({ messages: [] }) };
  await pipeline("https://api.example.com/v1/chat", init);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].init, init); // 同一引用：连拷贝都没有
});

test("管道：有标志且命中修补 → 内层收到变换后的 body", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({
    fetch: spy.fetchImpl,
    flags: { singleLeadingSystem: true },
  });
  const body = JSON.stringify({
    messages: [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "q" },
    ],
  });
  await pipeline("https://api.example.com/v1/chat", { method: "POST", body });
  const sent = JSON.parse(spy.calls[0].init.body);
  assert.equal(sent.messages.length, 2);
  assert.deepEqual(sent.messages[0], { role: "system", content: "AB" });
});

test("管道：全部转换器 no-op → 转发原 init（不重新序列化）", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({
    fetch: spy.fetchImpl,
    flags: { toolCallIdProfile: "openai-40" },
  });
  const init = {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "tool", tool_call_id: "call_ok", content: "x" }] }),
  };
  await pipeline("https://api.example.com/v1/chat", init);
  assert.equal(spy.calls[0].init, init);
});

test("管道：非 JSON body / 数组 body → fail-open 直通（与 option-map fail-closed 的边界见 spec R4）", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({
    fetch: spy.fetchImpl,
    flags: { singleLeadingSystem: true },
  });
  const notJson = { method: "POST", body: "not-json{{" };
  await pipeline("https://api.example.com/v1/chat", notJson);
  assert.equal(spy.calls[0].init, notJson);
  const arrayBody = { method: "POST", body: "[1,2]" };
  await pipeline("https://api.example.com/v1/chat", arrayBody);
  assert.equal(spy.calls[1].init, arrayBody);
});

test("管道：Request 对象输入 → 重建 Request 且 url/method 保留", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({
    fetch: spy.fetchImpl,
    flags: { requiresStringSystemContent: true },
  });
  const request = new Request("https://api.example.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "system", content: [{ type: "text", text: "rule" }] }],
    }),
  });
  await pipeline(request);
  const sent = spy.calls[0].request;
  assert.ok(sent instanceof Request);
  assert.equal(sent.url, "https://api.example.com/v1/messages");
  assert.equal(sent.method, "POST");
  const sentBody = JSON.parse(await sent.text());
  assert.equal(sentBody.messages[0].content, "rule");
});

test("管道顺序：compat 结构修补先于 option-map 字段 patch（spec R4 链路）", async () => {
  const spy = spyFetch();
  const maps = compileModelOptionMaps({
    reasoningLevel: { values: ["high"], map: "{}" },
    maxOutputTokens: { max: 1000, map: "{'max_tokens': maxOutputTokens}" },
  });
  // model-execution.createFactory 的同构装配：compat(outer) → optionMap(inner) → transport。
  const optionFetch = createModelOptionMapFetch({
    fetch: spy.fetchImpl,
    maps,
    values: { reasoningLevel: "high", maxOutputTokens: 100 },
  });
  const pipeline = createCompatTransformFetch({
    fetch: optionFetch,
    flags: { singleLeadingSystem: true },
  });
  await pipeline("https://api.example.com/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "q" },
      ],
    }),
  });
  const finalBody = JSON.parse(spy.calls[0].init.body);
  // 两套机制各自生效且互不绕：结构（合并 system）+ 字段（CEL patch max_tokens）。
  assert.deepEqual(finalBody.messages[0], { role: "system", content: "AB" });
  assert.equal(finalBody.max_tokens, 100);
});

test("管道：GET 无 body → 直通不报错", async () => {
  const spy = spyFetch();
  const pipeline = createCompatTransformFetch({
    fetch: spy.fetchImpl,
    flags: { singleLeadingSystem: true },
  });
  await pipeline("https://api.example.com/v1/models");
  assert.equal(spy.calls.length, 1);
});
