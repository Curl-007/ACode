// specs/web-reconnect.md 验收 8-9 / R5.5：bfcache / 真卸载的页面生命周期分派。
// 这是 FIX 1（bfcache 死界面）的核心不变量接线——pagehide 按 persisted 分派 pause/cancel，
// pageshow(persisted) 触发 resume。抽成 attachWebReconnectPageLifecycle 后可注入假事件/假 target
// 单测，无需浏览器 window/DOM。
import assert from "node:assert/strict";
import test from "node:test";
import {
  attachWebReconnectPageLifecycle,
  type PageLifecycleController,
  type PageLifecycleTarget,
  type PageTransitionEventLike,
} from "../src/reconnect/pageLifecycle.js";

/** 记录调用序列的假控制器。 */
function makeRecordingController() {
  const calls: string[] = [];
  const controller: PageLifecycleController = {
    pause: () => calls.push("pause"),
    cancel: () => calls.push("cancel"),
    resume: () => calls.push("resume"),
  };
  return { controller, calls };
}

/** 假 event target：按 type 登记 listener，fire 时同步分发。 */
function makeFakeTarget() {
  const listeners = new Map<string, Set<(event: PageTransitionEventLike) => void>>();
  const target: PageLifecycleTarget = {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    fire(type: string, event: PageTransitionEventLike): void {
      // Set 迭代对并发删除安全；假 target 的 listener 不会在 fire 期间增删，故直接迭代。
      for (const listener of listeners.get(type) ?? new Set<(e: PageTransitionEventLike) => void>()) {
        listener(event);
      }
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test("pagehide(persisted=true) pauses (bfcache), NOT cancel — avoids terminal dead UI", () => {
  const { controller, calls } = makeRecordingController();
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => controller, fake.target);
  fake.fire("pagehide", { persisted: true });
  // 关键回归：bfcache 进入必须 pause（非终态），不得 cancel（终态会让 start() 永久 no-op → 死界面）。
  assert.deepEqual(calls, ["pause"]);
  assert.ok(!calls.includes("cancel"), "bfcache entry must NOT terminally cancel");
});

test("pagehide(persisted=false) cancels (true unload) — clears timers, no leak", () => {
  const { controller, calls } = makeRecordingController();
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => controller, fake.target);
  fake.fire("pagehide", { persisted: false });
  assert.deepEqual(calls, ["cancel"], "true unload must terminally cancel to clear pending timers");
});

test("pageshow(persisted=true) resumes the frozen loop after a bfcache round-trip", () => {
  const { controller, calls } = makeRecordingController();
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => controller, fake.target);
  // 完整 bfcache 往返：pagehide(persisted) → pageshow(persisted)。
  fake.fire("pagehide", { persisted: true });
  fake.fire("pageshow", { persisted: true });
  assert.deepEqual(calls, ["pause", "resume"], "bfcache round-trip: pause then resume");
});

test("pageshow(persisted=false) is a no-op (ordinary first load, loop not frozen)", () => {
  const { controller, calls } = makeRecordingController();
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => controller, fake.target);
  fake.fire("pageshow", { persisted: false });
  assert.deepEqual(calls, [], "non-persisted pageshow must not resume");
});

test("listeners stay registered across a bfcache round-trip (NOT { once: true })", () => {
  const { controller, calls } = makeRecordingController();
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => controller, fake.target);
  assert.equal(fake.count("pagehide"), 1);
  assert.equal(fake.count("pageshow"), 1);
  // 首次 bfcache 进入后监听器必须仍在（once:true 会在此移除，导致后续真卸载无清理、泄漏 timer）。
  fake.fire("pagehide", { persisted: true });
  assert.equal(fake.count("pagehide"), 1, "pagehide listener must survive bfcache entry");
  // 随后真卸载仍能被处理（cancel），证明监听器未被 once 移除。
  fake.fire("pagehide", { persisted: false });
  assert.equal(fake.count("pagehide"), 1);
  assert.deepEqual(calls, ["pause", "cancel"], "both bfcache pause and true-unload cancel dispatched");
});

test("getController() returning null is ignored (no throw during teardown)", () => {
  const fake = makeFakeTarget();
  attachWebReconnectPageLifecycle(() => null, fake.target);
  // controller 尚未创建 / 已销毁：事件到达时安全忽略。
  assert.doesNotThrow(() => {
    fake.fire("pagehide", { persisted: true });
    fake.fire("pagehide", { persisted: false });
    fake.fire("pageshow", { persisted: true });
  });
});

test("getController() always reads the latest controller (survives retryNow re-generation)", () => {
  const fake = makeFakeTarget();
  const first = makeRecordingController();
  const second = makeRecordingController();
  let current = first.controller;
  attachWebReconnectPageLifecycle(() => current, fake.target);
  // retryNow 换代：入口把 controller 换成新的；生命周期接线须驱动最新那个。
  current = second.controller;
  fake.fire("pagehide", { persisted: true });
  assert.deepEqual(first.calls, [], "old controller must not be driven after re-generation");
  assert.deepEqual(second.calls, ["pause"], "latest controller is driven");
});

test("detach() removes both listeners", () => {
  const { controller } = makeRecordingController();
  const fake = makeFakeTarget();
  const detach = attachWebReconnectPageLifecycle(() => controller, fake.target);
  assert.equal(fake.count("pagehide"), 1);
  assert.equal(fake.count("pageshow"), 1);
  detach();
  assert.equal(fake.count("pagehide"), 0);
  assert.equal(fake.count("pageshow"), 0);
});
