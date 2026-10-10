/**
 * ARCH-01 参数校验迁移（小服务批次）的行为测试。
 *
 * 全部经真实 ServiceCollection → ProxyChannel.fromService → ChannelServer/ChannelClient
 * 链路验证：畸形参数在服务方法体执行前被拒绝，客户端收到稳定的
 * code="rpc-invalid-arguments" + method + 不含参数值的 details；合法调用不受影响。
 * 模式沿用 service-collection-boundary.test.ts 的敏感服务畸形参数用例。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelClient, ChannelServer, Emitter, createQueuePair, type IChannel } from "@acode/rpc";
import {
  IBroadcastService,
  ICommandsService,
  IFileWatcherService,
  IHooksService,
  IMcpSyncService,
  IMemoryService,
  IProviderProvisioningTargetService,
  ISettingService,
  ISettingsSyncService,
  ISkillsService,
  ISubagentsService,
  ServiceCollection,
  type ServiceDescriptor,
} from "../src/index.js";

interface RpcErrorShape {
  code?: string;
  method?: string;
  details?: string;
  message?: string;
}

/** 稳定的结构化拒绝断言：code/method 精确匹配，details 与 message 不回显参数值。 */
function assertInvalidArguments(error: unknown, method: string, secrets: string[] = []): true {
  const shaped = error as RpcErrorShape;
  assert.equal(shaped.code, "rpc-invalid-arguments");
  assert.equal(shaped.method, method);
  assert.equal(typeof shaped.details, "string");
  for (const secret of secrets) {
    assert.equal(shaped.details?.includes(secret), false, "details 不得回显参数值");
    assert.equal(String(shaped.message).includes(secret), false, "message 不得回显参数值");
  }
  return true;
}

/** 建立一条真实 client/server 通道并注册单个 descriptor + 桩服务。 */
async function withServiceChannel<T>(
  descriptor: ServiceDescriptor<T>,
  service: T,
  run: (channel: IChannel) => Promise<void>,
): Promise<void> {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "rpc-validators-small");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection().register(descriptor, service).exposeOnChannelServer(server);
  try {
    await run(client.getChannel(descriptor.channelName));
  } finally {
    client.dispose();
    server.dispose();
  }
}

test("hooks.saveHooks 畸形 hooks 在方法体前拒绝，合法保存正常执行", async () => {
  const calls: string[] = [];
  const service = {
    loadHooks: async () => {
      calls.push("loadHooks");
      return { hooks: [], hooksEnabled: true };
    },
    saveHooks: async () => {
      calls.push("saveHooks");
    },
  } as unknown as IHooksService;
  await withServiceChannel(IHooksService, service, async (channel) => {
    await assert.rejects(
      channel.call("saveHooks", [{ workspacePath: "ws", hooks: "SECRET-HOOKS" }]),
      (error: unknown) => assertInvalidArguments(error, "saveHooks", ["SECRET-HOOKS"]),
    );
    // hook 条目缺 command 字符串同样属于畸形写入
    await assert.rejects(
      channel.call("saveHooks", [{ workspacePath: "ws", hooks: [{ id: "h1" }] }]),
      (error: unknown) => assertInvalidArguments(error, "saveHooks"),
    );
    assert.deepEqual(calls, []);
    await channel.call("saveHooks", [
      {
        workspacePath: "ws",
        hooks: [
          { id: "h1", event: "pre-tool", type: "command", command: "echo hi", enabled: true },
        ],
      },
    ]);
    assert.deepEqual(calls, ["saveHooks"]);
  });
});

test("setting.update / updateDataBaseDir 畸形参数拒绝，合法调用执行", async () => {
  const calls: string[] = [];
  const service = {
    get: async () => {
      calls.push("get");
      return {};
    },
    update: async () => {
      calls.push("update");
    },
    updateDataBaseDir: async () => {
      calls.push("updateDataBaseDir");
    },
    ensureDefaultProject: async () => {
      calls.push("ensureDefaultProject");
      return { path: "p", created: false };
    },
  } as unknown as ISettingService;
  await withServiceChannel(ISettingService, service, async (channel) => {
    await assert.rejects(channel.call("update", ["SECRET-PATCH"]), (error: unknown) =>
      assertInvalidArguments(error, "update", ["SECRET-PATCH"]),
    );
    await assert.rejects(
      channel.call("update", [{ theme: "dark" }, "SECRET-EXPECTED"]),
      (error: unknown) => assertInvalidArguments(error, "update", ["SECRET-EXPECTED"]),
    );
    await assert.rejects(channel.call("updateDataBaseDir", [42]), (error: unknown) =>
      assertInvalidArguments(error, "updateDataBaseDir"),
    );
    assert.deepEqual(calls, []);
    await channel.call("update", [{ memoryEnabled: true }]);
    await channel.call("updateDataBaseDir", ["/tmp/acode-data"]);
    assert.deepEqual(calls, ["update", "updateDataBaseDir"]);
  });
});

test("memory 畸形定位参数拒绝；无参方法拒绝多余参数", async () => {
  const calls: string[] = [];
  const service = {
    listProjectMemories: async () => {
      calls.push("listProjectMemories");
      return [];
    },
    readProjectMemoryFile: async () => {
      calls.push("readProjectMemoryFile");
      return { content: "", updatedAt: 0 };
    },
  } as unknown as IMemoryService;
  await withServiceChannel(IMemoryService, service, async (channel) => {
    await assert.rejects(
      channel.call("readProjectMemoryFile", [{ workspaceId: "ws", fileName: 42 }]),
      (error: unknown) => assertInvalidArguments(error, "readProjectMemoryFile"),
    );
    await assert.rejects(
      channel.call("readProjectMemoryFile", [{ workspaceId: "", fileName: "index.md" }]),
      (error: unknown) => assertInvalidArguments(error, "readProjectMemoryFile"),
    );
    // 无参方法带多余参数必须在方法体前拒绝
    await assert.rejects(
      channel.call("listProjectMemories", [{ secret: "SECRET-EXTRA" }]),
      (error: unknown) => assertInvalidArguments(error, "listProjectMemories", ["SECRET-EXTRA"]),
    );
    assert.deepEqual(calls, []);
    await channel.call("listProjectMemories", []);
    await channel.call("readProjectMemoryFile", [{ workspaceId: "ws", fileName: "index.md" }]);
    assert.deepEqual(calls, ["listProjectMemories", "readProjectMemoryFile"]);
  });
});

test("subagents.setEnabled / deleteAgent 畸形写入拒绝，合法写入执行", async () => {
  const calls: string[] = [];
  const service = {
    setEnabled: async () => {
      calls.push("setEnabled");
    },
    deleteAgent: async () => {
      calls.push("deleteAgent");
    },
  } as unknown as ISubagentsService;
  await withServiceChannel(ISubagentsService, service, async (channel) => {
    await assert.rejects(
      channel.call("setEnabled", [{ agentId: "a1", enabled: "yes" }]),
      (error: unknown) => assertInvalidArguments(error, "setEnabled"),
    );
    await assert.rejects(
      channel.call("deleteAgent", [{ agentId: "", filePath: "agent.md" }]),
      (error: unknown) => assertInvalidArguments(error, "deleteAgent"),
    );
    await assert.rejects(
      channel.call("deleteAgent", [{ agentId: "a1", filePath: "" }]),
      (error: unknown) => assertInvalidArguments(error, "deleteAgent"),
    );
    assert.deepEqual(calls, []);
    await channel.call("setEnabled", [{ agentId: "a1", enabled: true }]);
    await channel.call("deleteAgent", [{ agentId: "a1", filePath: "agent.md" }]);
    assert.deepEqual(calls, ["setEnabled", "deleteAgent"]);
  });
});

test("commands.writeCommandFile 缺 config 拒绝，合法写入执行", async () => {
  const calls: string[] = [];
  const service = {
    writeCommandFile: async () => {
      calls.push("writeCommandFile");
      return { command: {} };
    },
    deleteCommandFile: async () => {
      calls.push("deleteCommandFile");
    },
  } as unknown as ICommandsService;
  await withServiceChannel(ICommandsService, service, async (channel) => {
    await assert.rejects(
      channel.call("writeCommandFile", [{ agentSource: "acode" }]),
      (error: unknown) => assertInvalidArguments(error, "writeCommandFile"),
    );
    await assert.rejects(
      channel.call("deleteCommandFile", [{ commandId: "c1", filePath: "" }]),
      (error: unknown) => assertInvalidArguments(error, "deleteCommandFile"),
    );
    assert.deepEqual(calls, []);
    await channel.call("writeCommandFile", [{ config: { name: "c1", prompt: "do it" } }]);
    assert.deepEqual(calls, ["writeCommandFile"]);
  });
});

test("skills.deleteSkill 空 skillId 拒绝，合法删除执行", async () => {
  const calls: string[] = [];
  const service = {
    deleteSkill: async () => {
      calls.push("deleteSkill");
    },
    setEnabled: async () => {
      calls.push("setEnabled");
    },
  } as unknown as ISkillsService;
  await withServiceChannel(ISkillsService, service, async (channel) => {
    await assert.rejects(
      channel.call("deleteSkill", [{ workspacePath: "ws", skillId: "" }]),
      (error: unknown) => assertInvalidArguments(error, "deleteSkill"),
    );
    await assert.rejects(
      channel.call("setEnabled", [{ workspacePath: "ws", skillId: "s1", enabled: "on" }]),
      (error: unknown) => assertInvalidArguments(error, "setEnabled"),
    );
    assert.deepEqual(calls, []);
    await channel.call("deleteSkill", [{ workspacePath: "ws", skillId: "s1" }]);
    assert.deepEqual(calls, ["deleteSkill"]);
  });
});

test("mcp-sync.saveMcpToUserDirectory 畸形 name 拒绝，合法写入执行", async () => {
  const calls: string[] = [];
  const service = {
    saveMcpToUserDirectory: async () => {
      calls.push("saveMcpToUserDirectory");
    },
    importMcpServers: async () => {
      calls.push("importMcpServers");
      return { items: [] };
    },
  } as unknown as IMcpSyncService;
  await withServiceChannel(IMcpSyncService, service, async (channel) => {
    await assert.rejects(
      channel.call("saveMcpToUserDirectory", [
        { action: "upsert", source: "acodeagentmcp", name: 7 },
      ]),
      (error: unknown) => assertInvalidArguments(error, "saveMcpToUserDirectory"),
    );
    await assert.rejects(
      channel.call("importMcpServers", [{ servers: "SECRET-SERVERS", localHomeDir: "/home" }]),
      (error: unknown) => assertInvalidArguments(error, "importMcpServers", ["SECRET-SERVERS"]),
    );
    assert.deepEqual(calls, []);
    await channel.call("saveMcpToUserDirectory", [
      { action: "upsert", source: "acodeagentmcp", name: "srv" },
    ]);
    assert.deepEqual(calls, ["saveMcpToUserDirectory"]);
  });
});

test("settings-sync.importSelected 畸形 selections 拒绝，合法导入执行", async () => {
  const calls: string[] = [];
  const service = {
    importSelected: async () => {
      calls.push("importSelected");
      return { results: [] };
    },
    markFirstRunPromptHandled: async () => {
      calls.push("markFirstRunPromptHandled");
    },
  } as unknown as ISettingsSyncService;
  await withServiceChannel(ISettingsSyncService, service, async (channel) => {
    await assert.rejects(
      channel.call("importSelected", [{ selections: "SECRET-SELECTIONS" }]),
      (error: unknown) => assertInvalidArguments(error, "importSelected", ["SECRET-SELECTIONS"]),
    );
    await assert.rejects(channel.call("markFirstRunPromptHandled", ["extra"]), (error: unknown) =>
      assertInvalidArguments(error, "markFirstRunPromptHandled"),
    );
    assert.deepEqual(calls, []);
    await channel.call("importSelected", [
      { selections: [{ agent: "claude", category: "skills" }] },
    ]);
    assert.deepEqual(calls, ["importSelected"]);
  });
});

test("broadcast.send 缺 channel 拒绝，合法广播执行；tryClaim 空 key 拒绝", async () => {
  const calls: string[] = [];
  const service = {
    send: async () => {
      calls.push("send");
    },
    tryClaim: async () => {
      calls.push("tryClaim");
      return true;
    },
  } as unknown as IBroadcastService;
  await withServiceChannel(IBroadcastService, service, async (channel) => {
    await assert.rejects(channel.call("send", [{ payload: "SECRET-PAYLOAD" }]), (error: unknown) =>
      assertInvalidArguments(error, "send", ["SECRET-PAYLOAD"]),
    );
    await assert.rejects(channel.call("tryClaim", [""]), (error: unknown) =>
      assertInvalidArguments(error, "tryClaim"),
    );
    assert.deepEqual(calls, []);
    await channel.call("send", [{ channel: "state:theme", payload: "SECRET-PAYLOAD" }]);
    assert.deepEqual(calls, ["send"]);
  });
});

test("providerProvisioning.apply 畸形 credentials 拒绝且不回显，合法 envelope 执行", async () => {
  const calls: string[] = [];
  const service = {
    apply: async () => {
      calls.push("apply");
      return {
        syncId: "sync-1",
        status: "applied",
        personalProviderCount: 0,
        credentialCount: 0,
        rolledBack: false,
      };
    },
  } as unknown as IProviderProvisioningTargetService;
  await withServiceChannel(IProviderProvisioningTargetService, service, async (channel) => {
    await assert.rejects(
      channel.call("apply", [
        {
          schemaVersion: 1,
          syncId: "sync-1",
          personalConfig: {},
          accountSettings: {},
          credentials: "SECRET-CREDENTIALS",
        },
      ]),
      (error: unknown) => assertInvalidArguments(error, "apply", ["SECRET-CREDENTIALS"]),
    );
    await assert.rejects(
      channel.call("apply", [
        {
          schemaVersion: 1,
          syncId: "",
          personalConfig: {},
          accountSettings: {},
          credentials: [],
        },
      ]),
      (error: unknown) => assertInvalidArguments(error, "apply"),
    );
    assert.deepEqual(calls, []);
    await channel.call("apply", [
      {
        schemaVersion: 1,
        syncId: "sync-1",
        personalConfig: {},
        accountSettings: {},
        credentials: [],
      },
    ]);
    assert.deepEqual(calls, ["apply"]);
  });
});

test("fileWatcher.onDynamicChange 畸形订阅参数在建立事件前拒绝，合法订阅可收事件", () => {
  const changes = new Emitter<unknown>();
  let exposed:
    | {
        listen<T>(
          ctx: unknown,
          event: string,
          arg?: unknown,
        ): (listener: (e: T) => void) => { dispose(): void };
      }
    | undefined;
  new ServiceCollection()
    .register(IFileWatcherService, {
      watch: async () => ({ id: "w1" }),
      unwatch: async () => undefined,
      disposeAll: () => undefined,
      onDynamicChange: () => changes.event,
    } as unknown as IFileWatcherService)
    .exposeOnChannelServer({
      registerChannel: (_name, channel) => {
        exposed = channel as typeof exposed;
      },
    });
  assert.ok(exposed);
  // 动态事件订阅参数必须是 watcher id 字符串；对象形态在事件建立前拒绝
  assert.throws(
    () => exposed?.listen(undefined, "onDynamicChange", { watcherId: "SECRET-WATCHER" }),
    (error: unknown) => assertInvalidArguments(error, "onDynamicChange", ["SECRET-WATCHER"]),
  );
  const received: unknown[] = [];
  const listener = exposed.listen<unknown>(
    undefined,
    "onDynamicChange",
    "w1",
  )((value) => received.push(value));
  changes.fire({ type: "change" });
  assert.deepEqual(received, [{ type: "change" }]);
  listener.dispose();
  changes.dispose();
});
