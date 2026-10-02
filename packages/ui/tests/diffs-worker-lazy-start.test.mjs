import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiffsWorkerPoolLazyController } from "../src/root/DiffsWorkerPoolProvider.tsx";

/**
 * Diffs worker 池懒启动(spec renderer-memory-budget 规则 6 / 所有者表「Diffs worker 池」行):
 * 挂载不初始化,首个 diff 渲染才物化。这里只测可注入工厂的纯状态机,
 * 不真 spawn worker——工厂调用次数就是「是否初始化」的直接证据。
 */

function createCountingFactory() {
  const created = [];
  let attempts = 0;
  let failNextCreations = false;
  const factory = () => {
    attempts += 1;
    if (failNextCreations) {
      throw new Error("simulated worker spawn failure");
    }
    const manager = {
      label: `stub-pool-${created.length + 1}`,
      terminated: false,
      terminate() {
        this.terminated = true;
      },
    };
    created.push(manager);
    return manager;
  };
  return {
    factory,
    created,
    get callCount() {
      return attempts;
    },
    failNext() {
      failNextCreations = true;
    },
    recover() {
      failNextCreations = false;
    },
  };
}

test("no pool is created before ensure/materialize is triggered", () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
  });

  assert.equal(stub.callCount, 0, "controller construction must not create the pool");
  assert.equal(controller.isDiffsWorkerPoolMaterialized(), false);
  assert.equal(controller.getMaterializedDiffsWorkerPool(), undefined);
});

test("ensure is idempotent: first call creates once, repeats reuse the same pool", async () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
  });

  const first = await controller.ensureDiffsWorkers();
  const second = await controller.ensureDiffsWorkers();
  const third = await controller.ensureDiffsWorkers();

  assert.ok(first, "first ensure must materialize the pool");
  assert.equal(stub.callCount, 1, "repeated ensure must not spawn again");
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(controller.isDiffsWorkerPoolMaterialized(), true);
  assert.equal(controller.getMaterializedDiffsWorkerPool(), first);
});

test("render-path materialize and ensure share a single pool", async () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
  });

  // 惰性代理路径:首个 diff 渲染实例调用池方法时同步物化。
  const viaRenderPath = controller.materializeDiffsWorkerPool();
  assert.ok(viaRenderPath);
  assert.equal(stub.callCount, 1);

  const viaEnsure = await controller.ensureDiffsWorkers();
  assert.equal(viaEnsure, viaRenderPath, "ensure after render-path materialize must reuse it");
  assert.equal(stub.callCount, 1);
});

test("materialization notifies subscribers once; late subscribers receive current pool", async () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
  });

  const events = [];
  const unsubscribe = controller.subscribeToDiffsWorkerPoolMaterialization((manager) => {
    events.push(manager.label);
  });

  await controller.ensureDiffsWorkers();
  assert.deepEqual(events, ["stub-pool-1"], "materialization must notify exactly once");

  const lateEvents = [];
  controller.subscribeToDiffsWorkerPoolMaterialization((manager) => {
    lateEvents.push(manager.label);
  });
  assert.deepEqual(lateEvents, ["stub-pool-1"], "late subscriber must read current pool");

  unsubscribe();
});

test("failed creation is not cached: next ensure retries instead of sticking to failure", async () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
    onControllerError: () => {},
  });

  stub.failNext();
  const failed = await controller.ensureDiffsWorkers();
  assert.equal(failed, undefined, "ensure must never reject; failure resolves to undefined");
  assert.equal(controller.isDiffsWorkerPoolMaterialized(), false);

  stub.recover();
  const recovered = await controller.ensureDiffsWorkers();
  assert.ok(recovered, "retry after a failed creation must materialize a fresh pool");
  assert.equal(controller.isDiffsWorkerPoolMaterialized(), true);
  assert.equal(stub.callCount, 2, "failed attempt must not be cached as the outcome");
});

test("terminate resets the controller so a later ensure rebuilds the pool", async () => {
  const stub = createCountingFactory();
  const controller = createDiffsWorkerPoolLazyController({
    createPoolManager: stub.factory,
  });

  const first = await controller.ensureDiffsWorkers();
  controller.terminateDiffsWorkerPool();

  assert.equal(first.terminated, true, "terminate must stop the previous pool");
  assert.equal(controller.isDiffsWorkerPoolMaterialized(), false);

  const second = await controller.ensureDiffsWorkers();
  assert.notEqual(second, first, "post-terminate ensure must rebuild instead of reusing");
  assert.equal(second?.label, "stub-pool-2");
  assert.equal(stub.callCount, 2);
});
