import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * T1#9 browser-relay 租约计数验收（specs/browser-relay-inplace-capture.md A5）：
 * 首租启动、并发首租 singleflight、重复租约复用不重绑、归零停止、
 * release 与在途关闭交叠时 acquire 排队等待不复活、多端口键控互不影响。
 * 用注入的假服务端工厂验证启停时序，不绑定真实端口。
 */

const { RelayLeaseManager } = await import("../packages/browser-use-plugin/src/relay/lease.ts");

/** 假 RelayServer：记录 start/stop 次数；stop 后经定时器异步 resolve whenStopped（拟真 close 事件时序）。 */
function makeFakeServer(port) {
  const listeners = [];
  return {
    port,
    whenListening: Promise.resolve(port),
    whenStopped: new Promise((resolve) => listeners.push(resolve)),
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      // 真实 server 的 close 事件异步到达；用 25ms 定时器模拟，让「acquire 等关闭」
      // 的断言可确定性观察。
      setTimeout(() => {
        for (const resolve of listeners.splice(0)) resolve();
      }, 25);
    },
  };
}

test("A5 首租启动服务端，重复 acquire 复用同一实例（不重复 bind）", async () => {
  const servers = [];
  const manager = new RelayLeaseManager({
    port: 9224,
    serverFactory: (opts) => {
      const server = makeFakeServer(opts.port);
      servers.push(server);
      return server;
    },
  });
  const leaseA = await manager.acquire();
  const leaseB = await manager.acquire();
  assert.equal(servers.length, 1, "concurrent/sequential acquire must reuse one server");
  assert.equal(manager.leaseCount, 2);
  assert.equal(manager.running, true);
  leaseA.release();
  assert.equal(manager.running, true, "second lease keeps the server up");
  leaseB.release();
  assert.equal(manager.running, false, "last release stops the server");
  assert.equal(servers[0].stopCalls, 1);
  await servers[0].whenStopped;
});

test("A5 并发首租共享同一启动 promise（singleflight）", async () => {
  let factoryCalls = 0;
  const manager = new RelayLeaseManager({
    port: 9224,
    serverFactory: (opts) => {
      factoryCalls += 1;
      return makeFakeServer(opts.port);
    },
  });
  const [a, b, c] = await Promise.all([manager.acquire(), manager.acquire(), manager.acquire()]);
  assert.equal(factoryCalls, 1);
  assert.equal(manager.leaseCount, 3);
  a.release();
  b.release();
  c.release();
  assert.equal(manager.running, false);
});

test("A5 归零后重启：等真实关闭完成再起新代（同端口不与关闭竞速）", async () => {
  const servers = [];
  const manager = new RelayLeaseManager({
    port: 9224,
    serverFactory: (opts) => {
      const server = makeFakeServer(opts.port);
      servers.push(server);
      return server;
    },
  });
  const lease = await manager.acquire();
  lease.release();
  assert.equal(manager.running, false, "released generation no longer counts as running");
  assert.equal(servers[0].stopCalls, 1);
  // 拟真时序：stop 已调用（25ms 后 close 才到）。重启 acquire 必须等 close。
  const restart = manager.acquire();
  let restarted = false;
  void restart.then(() => {
    restarted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(restarted, false, "acquire must wait for the previous generation to close");
  const lease2 = await restart;
  assert.equal(servers.length, 2, "restart creates a new generation");
  assert.equal(servers[0].port, servers[1].port, "same port served by the new generation");
  assert.equal(manager.leaseCount, 1);
  lease2.release();
  await servers[1].whenStopped;
  assert.equal(manager.running, false);
});

test("A5 重复 release 幂等，不把计数扣成负数", async () => {
  const manager = new RelayLeaseManager({ port: 9224, serverFactory: (opts) => makeFakeServer(opts.port) });
  const lease = await manager.acquire();
  await manager.acquire();
  lease.release();
  lease.release();
  assert.equal(manager.leaseCount, 1);
  assert.equal(manager.running, true);
});

test("A5 工厂抛错（端口被占）：acquire 显式失败，后续 acquire 可重试", async () => {
  let failNext = true;
  const manager = new RelayLeaseManager({
    port: 9224,
    serverFactory: () => {
      if (failNext) throw new Error("EADDRINUSE: port taken by another process");
      return makeFakeServer(9224);
    },
  });
  await assert.rejects(manager.acquire(), /EADDRINUSE/);
  failNext = false;
  const lease = await manager.acquire();
  assert.equal(manager.leaseCount, 1);
  lease.release();
});

test("A5 多端口键控互不影响", async () => {
  const servers9224 = [];
  const servers9300 = [];
  const managerA = new RelayLeaseManager({
    port: 9224,
    serverFactory: (opts) => {
      const server = makeFakeServer(opts.port);
      servers9224.push(server);
      return server;
    },
  });
  const managerB = new RelayLeaseManager({
    port: 9300,
    serverFactory: (opts) => {
      const server = makeFakeServer(opts.port);
      servers9300.push(server);
      return server;
    },
  });
  const leaseA = await managerA.acquire();
  const leaseB = await managerB.acquire();
  assert.equal(servers9224[0].port, 9224);
  assert.equal(servers9300[0].port, 9300);
  leaseA.release();
  assert.equal(managerA.running, false);
  assert.equal(managerB.running, true, "other port's server unaffected");
  leaseB.release();
  assert.equal(managerB.running, false);
});
