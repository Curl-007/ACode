import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * T1#9 快赢验收（specs/browser-relay-inplace-capture.md R1 / A1、A2）：
 * whileDrawing 以桩 CDP 会话断言 screencast 开→截→关时序、capture 抛错仍清理、
 * 拒绝 screencast 时降级直截、先中止不开 screencast。
 */

const { whileDrawing } = await import("../packages/adapters/src/browser/while-drawing.ts");

/** 录制调用序列的桩 CDP 会话；可对 startScreencast 注入失败。 */
function makeStubSession({ failStart = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Page.startScreencast" && failStart) {
        throw new Error("Screencast is not supported");
      }
      return {};
    },
    async detach() {
      calls.push({ method: "detach" });
    },
  };
}

const captureMarker = Symbol("captured");

test("whileDrawing 开启 1x1 jpeg screencast 后捕获，再 stop+detach", async () => {
  const session = makeStubSession();
  const page = {};
  const result = await whileDrawing(
    page,
    undefined,
    async () => captureMarker,
    async () => session,
  );
  assert.equal(result, captureMarker);
  assert.deepEqual(
    session.calls.map((call) => call.method),
    ["Page.startScreencast", "Page.stopScreencast", "detach"],
  );
  assert.deepEqual(session.calls[0].params, { format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1 });
});

test("capture 抛错时仍执行 stopScreencast + detach 再上抛原错误", async () => {
  const session = makeStubSession();
  await assert.rejects(
    whileDrawing(
      {},
      undefined,
      async () => {
        throw new Error("capture boom");
      },
      async () => session,
    ),
    /capture boom/,
  );
  assert.deepEqual(
    session.calls.map((call) => call.method),
    ["Page.startScreencast", "Page.stopScreencast", "detach"],
  );
});

test("拒绝 screencast 的浏览器降级为直接捕获，半开会话仍被清理", async () => {
  const session = makeStubSession({ failStart: true });
  const result = await whileDrawing(
    {},
    undefined,
    async () => captureMarker,
    async () => session,
  );
  assert.equal(result, captureMarker);
  // omp 原语义：start 失败后 finally 仍 stop+detach 清理这路半开会话。
  assert.deepEqual(
    session.calls.map((call) => call.method),
    ["Page.startScreencast", "Page.stopScreencast", "detach"],
  );
});

test("先中止再调用：抛 AbortError 且不开启 screencast", async () => {
  const session = makeStubSession();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    whileDrawing(
      {},
      controller.signal,
      async () => captureMarker,
      async () => session,
    ),
    (error) => error.name === "AbortError",
  );
  assert.deepEqual(session.calls, []);
});

test("capture 期间中止：捕获竞争失败并照常清理", async () => {
  const session = makeStubSession();
  const controller = new AbortController();
  const promise = whileDrawing(
    {},
    controller.signal,
    async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return captureMarker;
    },
    async () => session,
  );
  await assert.rejects(promise, (error) => error.name === "AbortError");
  assert.deepEqual(
    session.calls.map((call) => call.method),
    ["Page.startScreencast", "Page.stopScreencast", "detach"],
  );
});
