import assert from "node:assert/strict";
import { test } from "node:test";

const { createWindowRemoteConnectionRegistry } = await import(
  "../src/host/windowRemoteConnectionRegistry.ts"
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const target = {
  kind: "ssh",
  host: "example.test",
  port: 22,
  username: "acode",
};

test("connecting SSH target is not reused across concurrent requestIds", async () => {
  const deferred = createDeferred();
  const registry = createWindowRemoteConnectionRegistry({
    connect: () => deferred.promise,
    createId: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
  });

  const first = registry.connect({ requestId: "first", target, remoteAssets: {} });
  await assert.rejects(
    registry.connect({ requestId: "second", target, remoteAssets: {} }),
    /同一 SSH 目标正在等待主机密钥确认/u,
  );

  registry.cancelConnect("first");
  await assert.rejects(first, /远程连接已取消/u);
  deferred.resolve({ services: {}, dispose() {} });
  await registry.dispose();
});
