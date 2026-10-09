import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../src/foundation.js";
import { ProxyChannel, RpcArgumentError } from "../src/proxy-channel.js";

class PrototypeService {
  calls = 0;

  read(value: string): string {
    this.calls += 1;
    return `read:${value}`;
  }

  write(value: string): string {
    this.calls += 1;
    return `write:${value}`;
  }
}

test("ProxyChannel keeps declared class methods but rejects prototype escape hatches", async () => {
  const service = new PrototypeService();
  const channel = ProxyChannel.fromService(service);

  assert.equal(await channel.call(undefined, "read", ["ok"]), "read:ok");
  assert.equal(service.calls, 1);

  for (const command of ["constructor", "__proto__", "prototype", "toString", "missing"]) {
    assert.throws(
      () => channel.call(undefined, command, []),
      new RegExp(`Method not found: ${command}`),
    );
  }
  assert.equal(service.calls, 1, "rejected members must not execute service code");
});

test("ProxyChannel honors a non-callable own member shadowing a prototype method", () => {
  const service = new PrototypeService();
  Object.defineProperty(service, "read", {
    configurable: true,
    enumerable: true,
    value: undefined,
    writable: true,
  });
  const channel = ProxyChannel.fromService(service);

  assert.throws(() => channel.call(undefined, "read", ["blocked"]), /Method not found: read/);
  assert.equal(service.calls, 0);
});

test("ProxyChannel explicit method allowlist is enforced at runtime", async () => {
  const service = new PrototypeService();
  const channel = ProxyChannel.fromService(service, undefined, { allowedMethods: ["read"] });

  assert.equal(await channel.call(undefined, "read", ["ok"]), "read:ok");
  assert.throws(() => channel.call(undefined, "write", ["blocked"]), /Method not found: write/);
  assert.throws(() => channel.call(undefined, "missing", []), /Method not found: missing/);
  assert.equal(service.calls, 1);
});

test("ProxyChannel explicit allowlist also gates dynamic events", () => {
  const emitter = new Emitter<string>();
  const service = Object.assign(new PrototypeService(), {
    onDynamicData: () => emitter.event,
  });
  const channel = ProxyChannel.fromService(service, undefined, { allowedMethods: ["read"] });

  assert.throws(
    () => channel.listen(undefined, "onDynamicData", "session-1"),
    /Event not found: onDynamicData/,
  );
});

test("ProxyChannel allowlist can explicitly retain dynamic events", () => {
  const emitter = new Emitter<string>();
  const service = Object.assign(new PrototypeService(), {
    onDynamicData: () => emitter.event,
  });
  const channel = ProxyChannel.fromService(service, undefined, {
    allowedMethods: ["read", "onDynamicData"],
  });
  const received: string[] = [];

  channel.listen(undefined, "onDynamicData", "session-1")((value) => received.push(value));
  emitter.fire("changed");
  assert.deepEqual(received, ["changed"]);
});

test("ProxyChannel preserves own Event-valued onXxx members", () => {
  const emitter = new Emitter<string>();
  const service = Object.assign(new PrototypeService(), { onDidChange: emitter.event });
  const channel = ProxyChannel.fromService(service);
  const received: string[] = [];

  channel.listen(undefined, "onDidChange")((value) => received.push(value));
  emitter.fire("changed");
  assert.deepEqual(received, ["changed"]);
});

for (const explicit of [false, true]) {
  test(`ProxyChannel preserves and freezes Proxy get overrides (explicit=${explicit})`, async () => {
    const baseEvents = new Emitter<string>();
    const overrideEvents = new Emitter<string>();
    const dynamicArgs: unknown[] = [];
    const base = Object.assign(new PrototypeService(), {
      onDidChange: baseEvents.event,
      onDynamicData: () => baseEvents.event,
    });
    const overrides = {
      read: (value: string) => `guarded:${value}`,
      onDidChange: overrideEvents.event,
      onDynamicData: (arg: unknown) => {
        dynamicArgs.push(arg);
        return overrideEvents.event;
      },
    };
    const service = new Proxy(base, {
      get(target, property, receiver) {
        return Reflect.get(overrides, property, receiver) ?? Reflect.get(target, property, target);
      },
    });
    const channel = ProxyChannel.fromService(
      service,
      undefined,
      explicit ? { allowedMethods: ["read", "onDidChange", "onDynamicData"] } : undefined,
    );
    overrides.read = () => "replaced-after-assembly";
    const received: string[] = [];
    const ordinary = channel.listen(
      undefined,
      "onDidChange",
    )((value: string) => received.push(`ordinary:${value}`));
    const dynamic = channel.listen(
      undefined,
      "onDynamicData",
      "scope-1",
    )((value: string) => received.push(`dynamic:${value}`));
    try {
      assert.equal(await channel.call(undefined, "read", ["ok"]), "guarded:ok");
      baseEvents.fire("base");
      overrideEvents.fire("override");
      assert.equal(base.calls, 0, "底层方法不能绕过 Proxy 的鉴权或 owner 路由覆盖");
      assert.deepEqual(dynamicArgs, ["scope-1"]);
      assert.deepEqual(received, ["ordinary:override", "dynamic:override"]);
    } finally {
      ordinary.dispose();
      dynamic.dispose();
      baseEvents.dispose();
      overrideEvents.dispose();
    }
  });
}

test("ProxyChannel re-exposes a remote toService Proxy through an explicit public surface", async () => {
  const emitter = new Emitter<string>();
  const upstream = ProxyChannel.fromService({
    read: (value: string) => `remote:${value}`,
    internal: () => "must not be forwarded",
    onDidChange: emitter.event,
    onDynamicData: (_scope: string) => emitter.event,
  });
  const remote = ProxyChannel.toService({
    call: (command, args) => upstream.call(undefined, command, args),
    listen: (event, arg) => upstream.listen(undefined, event, arg),
  });
  const bridge = ProxyChannel.fromService(remote, undefined, {
    allowedMethods: ["read", "onDidChange", "onDynamicData"],
  });
  const received: string[] = [];
  const ordinary = bridge.listen(
    undefined,
    "onDidChange",
  )((value: string) => received.push(`ordinary:${value}`));
  const dynamic = bridge.listen(
    undefined,
    "onDynamicData",
    "scope-1",
  )((value: string) => received.push(`dynamic:${value}`));
  try {
    assert.equal(await bridge.call(undefined, "read", ["ok"]), "remote:ok");
    emitter.fire("changed");
    assert.deepEqual(received, ["ordinary:changed", "dynamic:changed"]);
    assert.throws(() => bridge.call(undefined, "internal"), /Method not found: internal/);
    assert.throws(() => bridge.call(undefined, "missing"), /Method not found: missing/);
    assert.throws(() => bridge.listen(undefined, "onInternal"), /Event not found: onInternal/);
    assert.throws(() => bridge.call(undefined, "onDidChange"), /Method not found: onDidChange/);
  } finally {
    ordinary.dispose();
    dynamic.dispose();
    emitter.dispose();
  }
});

test("explicit names cannot expose missing, non-callable or Object.prototype members", () => {
  const channel = ProxyChannel.fromService({ read: undefined }, undefined, {
    allowedMethods: ["read", "missing", "constructor", "__proto__", "prototype", "toString"],
  });
  for (const command of ["read", "missing", "constructor", "__proto__", "prototype", "toString"]) {
    assert.throws(
      () => channel.call(undefined, command),
      new RegExp(`Method not found: ${command}`),
    );
  }
});

test("argument validators reject before service code and expose stable safe details", async () => {
  let calls = 0;
  const channel = ProxyChannel.fromService(
    {
      save: (key: string, value: string) => {
        calls += 1;
        return `${key}:${value}`;
      },
    },
    undefined,
    {
      allowedMethods: ["save"],
      argumentValidators: new Map([
        [
          "save",
          (args) => {
            if (args.length !== 2 || typeof args[0] !== "string" || typeof args[1] !== "string") {
              throw new Error("expected two strings");
            }
          },
        ],
      ]),
    },
  );

  assert.throws(
    () => channel.call(undefined, "save", [{ secret: "do-not-echo" }]),
    (error: unknown) => {
      assert.ok(error instanceof RpcArgumentError);
      assert.equal(error.code, "rpc-invalid-arguments");
      assert.equal(error.method, "save");
      assert.equal(error.message, "Invalid arguments for RPC method: save");
      assert.equal(error.details.includes("do-not-echo"), false);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(await channel.call(undefined, "save", ["key", "value"]), "key:value");
  assert.equal(calls, 1);
});
