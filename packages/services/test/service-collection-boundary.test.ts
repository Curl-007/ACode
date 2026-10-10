import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceCollection, createServiceDescriptor } from "../src/index.js";
import {
  IOAuthService,
  ICredentialService,
  ITerminalService,
  IProviderSettingsService,
  IACodeAgentService,
  createACodeAgentConnectionScope,
  readTrustedACodeAgentV4Connection,
} from "../src/index.js";
import { ChannelClient, ChannelServer, createQueuePair, Emitter } from "@acode/rpc";
import { V4_WIRE_PROTOCOL_VERSION } from "@acode/shared/acode-protocol-v4";
import { OAuthService } from "../src/oauth/oauthService.js";

interface PublicService {
  read(): string;
}

const descriptor = createServiceDescriptor<PublicService>("boundary-test", {
  allowedMethods: ["read"],
});

class SensitiveService implements PublicService {
  read(): string {
    return "ok";
  }

  // This method intentionally represents a runtime-private implementation helper.
  persistOAuthSession(): string {
    return "must not be remote";
  }
}

test("ServiceCollection forwards descriptor method allowlists to ProxyChannel", async () => {
  let channel:
    | { call<T>(context: unknown, command: string, args?: unknown[]): Promise<T> }
    | undefined;
  const server = {
    registerChannel(_name: string, value: typeof channel): void {
      channel = value;
    },
  };

  new ServiceCollection()
    .register(descriptor, new SensitiveService())
    .exposeOnChannelServer(server);

  assert.ok(channel);
  assert.equal(await channel.call<string>(undefined, "read"), "ok");
  assert.throws(
    () => channel.call(undefined, "persistOAuthSession"),
    /Method not found: persistOAuthSession/,
  );
});

test("descriptor copies and freezes the method table before callers can mutate it", () => {
  const names: Array<keyof PublicService> = ["read"];
  const descriptor = createServiceDescriptor<PublicService>("frozen-boundary", {
    allowedMethods: names,
  });
  names.length = 0;
  assert.deepEqual(descriptor.allowedMethods, ["read"]);
  assert.equal(Object.isFrozen(descriptor.allowedMethods), true);
});

test("descriptor copies the argument validator table and does not expose a mutating Map", () => {
  const descriptor = createServiceDescriptor<PublicService>("frozen-validators", {
    allowedMethods: ["read"],
    argumentValidators: { read: () => undefined },
  });
  assert.equal(Object.isFrozen(descriptor.argumentValidators), true);
  assert.equal(descriptor.argumentValidators.has("read"), true);
  assert.equal("set" in descriptor.argumentValidators, false);
});

test("真实 OAuth RPC 公开方法正常，内部凭据写入方法在执行前拒绝", async () => {
  const writes: string[] = [];
  const service = new OAuthService(
    {
      load: async () => null,
      save: async (key) => {
        writes.push(key);
      },
      delete: async (key) => {
        writes.push(key);
      },
    },
    { adapters: [] },
  );
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "boundary");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection().register(IOAuthService, service).exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(IOAuthService.channelName);
    assert.deepEqual(await channel.call("getProviders", []), []);
    for (const command of ["persistOAuthSession", "clearPendingState", "toString", "constructor"]) {
      await assert.rejects(
        channel.call(command, ["bigmodel", {}, {}]),
        new RegExp(`Method not found: ${command}`),
      );
    }
    assert.deepEqual(writes, []);
  } finally {
    client.dispose();
    server.dispose();
  }
});

test("敏感服务的畸形 RPC 参数在方法体前稳定拒绝", async () => {
  const writes: string[] = [];
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "boundary");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection()
    .register(
      ICredentialService,
      {
        load: async (key: string) => {
          writes.push(`load:${key}`);
          return null;
        },
        save: async (key: string, value: string) => {
          writes.push(`save:${key}:${value}`);
        },
        delete: async (key: string) => {
          writes.push(`delete:${key}`);
        },
      },
    )
    .exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(ICredentialService.channelName);
    await assert.rejects(
      channel.call("save", [{ token: "secret" }, "value"]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "rpc-invalid-arguments");
        assert.equal((error as { method?: string }).method, "save");
        assert.equal(String((error as { details?: string }).details).includes("secret"), false);
        return true;
      },
    );
    assert.deepEqual(writes, []);
    await channel.call("save", ["provider", "value"]);
    assert.deepEqual(writes, ["save:provider:value"]);
  } finally {
    client.dispose();
    server.dispose();
  }
});

test("真实 Terminal descriptor 保留公开动态事件，同时拒绝 override 新增的内部方法", async () => {
  const data = new Emitter<string>();
  const overrides = new Map([
    [
      ITerminalService.channelName,
      {
        write: async ({ data }: { data: string }) => data,
        onDynamicData: (_id: string) => data.event,
        killAllInternal: () => {
          throw new Error("内部方法不得执行");
        },
      },
    ],
  ]);
  let channel;
  new ServiceCollection().register(ITerminalService, {} as ITerminalService).exposeOnChannelServer(
    {
      registerChannel: (_name, exposed) => {
        channel = exposed;
      },
    },
    overrides,
  );
  const received: string[] = [];
  const listener = channel.listen(
    undefined,
    "onDynamicData",
    "terminal-1",
  )((value: string) => received.push(value));
  try {
    assert.equal(
      await channel.call(undefined, "write", [{ id: "terminal-1", data: "hello" }]),
      "hello",
    );
    assert.throws(
      () => channel.listen(undefined, "onDynamicData", { terminalId: "secret" }),
      (error: unknown) =>
        (error as { code?: string }).code === "rpc-invalid-arguments" &&
        (error as { method?: string }).method === "onDynamicData",
    );
    data.fire("output");
    assert.deepEqual(received, ["output"]);
    assert.throws(
      () => channel.call(undefined, "killAllInternal"),
      /Method not found: killAllInternal/,
    );
  } finally {
    listener.dispose();
    data.dispose();
  }
});

test("真实 Provider descriptor 保留普通事件，内部事件不得订阅", () => {
  const changes = new Emitter<string>();
  const internal = new Emitter<string>();
  let channel;
  new ServiceCollection()
    .register(IProviderSettingsService, {
      onDidChange: changes.event,
      onInternalChanged: internal.event,
    } as unknown as IProviderSettingsService)
    .exposeOnChannelServer({
      registerChannel: (_name, exposed) => {
        channel = exposed;
      },
    });
  const received: string[] = [];
  const listener = channel.listen(
    undefined,
    "onDidChange",
  )((value: string) => received.push(value));
  try {
    changes.fire("changed");
    assert.deepEqual(received, ["changed"]);
    assert.throws(
      () => channel.listen(undefined, "onInternalChanged"),
      /Event not found: onInternalChanged/,
    );
    assert.throws(() => channel.call(undefined, "onDidChange"), /Method not found: onDidChange/);
  } finally {
    listener.dispose();
    changes.dispose();
    internal.dispose();
  }
});

test("运行时遗漏显式表的 descriptor 按空表拒绝，不能回退原型发现", () => {
  let channel;
  new ServiceCollection()
    .register({ channelName: "missing-table" } as never, new SensitiveService())
    .exposeOnChannelServer({
      registerChannel: (_name, exposed) => {
        channel = exposed;
      },
    });
  assert.throws(() => channel.call(undefined, "read"), /Method not found: read/);
  assert.throws(
    () => channel.call(undefined, "persistOAuthSession"),
    /Method not found: persistOAuthSession/,
  );
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`真实 connection scope 的 RPC 保留握手、角色和可信 context 边界 (${clientMode})`, async () => {
    const calls: string[] = [];
    const commandContexts: unknown[] = [];
    const resources = new Emitter<unknown>();
    const base = {
      helloConversationV4: async () => {
        calls.push("base-hello");
      },
      initializeConversationV4: async () => {
        calls.push("base-initialize");
      },
      setConnectionFlowStateV4: async () => {
        calls.push("base-flow");
      },
      sendConversationCommandV4: async (params: unknown) => {
        calls.push("base-command");
        commandContexts.push(readTrustedACodeAgentV4Connection(params));
        return { accepted: true };
      },
      onDynamicProcessResourceSample: () => {
        calls.push("base-resources");
        return resources.event;
      },
    } as unknown as IACodeAgentService;
    const scope = createACodeAgentConnectionScope(base, {
      connectionId: "connection-1",
      clientMode,
    });
    const [clientProtocol, serverProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "connection-boundary");
    const client = new ChannelClient(clientProtocol);
    new ServiceCollection()
      .register(IACodeAgentService, base)
      .exposeOnChannelServer(server, new Map([[IACodeAgentService.channelName, scope.service]]));
    try {
      const channel = client.getChannel(IACodeAgentService.channelName);
      const params = { workspacePath: "/workspace", envelope: { clientId: "client-1" } };
      await assert.rejects(
        channel.call("sendConversationCommandV4", [params]),
        /handshakeRequired/,
      );
      await assert.rejects(
        channel.call("setConnectionFlowStateV4", [{ state: "saturated" }]),
        /flowControlForbidden/,
      );
      const hello = await channel.call<{ connectionId: string; clientMode: string }>(
        "helloConversationV4",
      );
      assert.equal(hello.connectionId, "connection-1");
      assert.equal(hello.clientMode, clientMode);
      await channel.call("initializeConversationV4", [
        {
          kind: "clientHello",
          protocolVersion: V4_WIRE_PROTOCOL_VERSION,
          clientId: "client-1",
          appVersion: "test",
        },
      ]);
      await assert.rejects(
        channel.call("sendConversationCommandV4", [
          {
            ...params,
            envelope: { clientId: "foreign-client" },
          },
        ]),
        /clientMismatch/,
      );
      await channel.call("sendConversationCommandV4", [
        {
          ...params,
          __acodeTrustedV4Connection: {
            connectionId: "forged",
            clientMode: "web-remote-replayable",
          },
        },
      ]);
      assert.deepEqual(calls, ["base-command"]);
      assert.deepEqual(commandContexts, [{ connectionId: "connection-1", clientMode }]);
      let exposed;
      new ServiceCollection().register(IACodeAgentService, scope.service).exposeOnChannelServer({
        registerChannel: (_name, channel) => {
          exposed = channel;
        },
      });
      const received: unknown[] = [];
      const listener = exposed.listen(
        undefined,
        "onDynamicProcessResourceSample",
      )((value: unknown) => received.push(value));
      resources.fire({ pid: 1 });
      listener.dispose();
      assert.deepEqual(received, []);
      assert.deepEqual(
        calls,
        ["base-command"],
        "终端 attachment 不能绕过 scope 订阅 Host 资源事件",
      );
    } finally {
      client.dispose();
      server.dispose();
      await scope.dispose();
      resources.dispose();
    }
  });
}
