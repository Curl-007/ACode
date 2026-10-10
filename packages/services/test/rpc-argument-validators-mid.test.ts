import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelClient,
  ChannelServer,
  createQueuePair,
  type IChannel,
  type IServerChannel,
} from "@acode/rpc";
import {
  ServiceCollection,
  type ServiceDescriptor,
  IBotsService,
  IGitService,
  IPluginManagementService,
  IACodeSessionService,
  IFeedbackService,
  IModelSelectionService,
  IProviderSettingsService,
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
} from "../src/index.js";

/**
 * ARCH-01 迁移验收：为新登记 argumentValidators 的中间层 descriptor 补充非法参数行为测试。
 * 全部经真实 ProxyChannel.fromService + ChannelClient/ChannelServer 往返，验证：
 *  - 失败统一返回 code "rpc-invalid-arguments"、正确 method、value-free details；
 *  - 服务方法体在校验失败时不执行（stub + call tracking）；
 *  - 合法调用正常放行并执行方法体。
 */

interface RpcErrorShape {
  code?: string;
  method?: string;
  details?: string;
  message?: string;
}

/** 断言 RpcArgumentError 形态稳定，且 details/message 不回显任何传入的敏感值。 */
function assertRpcArgumentError(
  error: unknown,
  method: string,
  forbidden: readonly string[],
): void {
  const err = error as RpcErrorShape;
  assert.equal(err.code, "rpc-invalid-arguments", `code for ${method}`);
  assert.equal(err.method, method, `method for ${method}`);
  const details = String(err.details ?? "");
  const message = String(err.message ?? "");
  assert.ok(details.length > 0, `details present for ${method}`);
  for (const token of forbidden) {
    assert.equal(details.includes(token), false, `details leaked ${token} for ${method}`);
    assert.equal(message.includes(token), false, `message leaked ${token} for ${method}`);
  }
}

/** 经真实 ChannelClient/ChannelServer 往返打开一个 channel，测试结束自动 dispose。 */
async function withWire<T>(
  descriptor: ServiceDescriptor<T>,
  stub: object,
  run: (channel: IChannel) => Promise<void>,
): Promise<void> {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "mid-validators");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection().register(descriptor, stub as unknown as T).exposeOnChannelServer(server);
  try {
    await run(client.getChannel(descriptor.channelName));
  } finally {
    client.dispose();
    server.dispose();
  }
}

/** 直接暴露服务端 channel，用于同步抛出的动态事件 listen 校验。 */
function exposeServerChannel<T>(descriptor: ServiceDescriptor<T>, stub: object): IServerChannel {
  let channel: IServerChannel | undefined;
  new ServiceCollection().register(descriptor, stub as unknown as T).exposeOnChannelServer({
    registerChannel: (_name: string, exposed: IServerChannel) => {
      channel = exposed;
    },
  });
  assert.ok(channel, "channel exposed");
  return channel;
}

// ---------------------------------------------------------------------------
// bots —— saveConfig / deleteBot
// ---------------------------------------------------------------------------

test("bots: saveConfig/deleteBot 非法参数在方法体前拒绝，合法调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    saveConfig: async (config: unknown) => {
      calls.push("saveConfig");
      return config;
    },
    deleteBot: async (botId: string) => {
      calls.push(`deleteBot:${botId}`);
    },
  };
  await withWire(IBotsService, stub, async (channel) => {
    await assert.rejects(channel.call("saveConfig", ["TOPSECRET-not-object"]), (error) => {
      assertRpcArgumentError(error, "saveConfig", ["TOPSECRET-not-object"]);
      return true;
    });
    await assert.rejects(channel.call("deleteBot", [{ token: "SECRET_BOT" }]), (error) => {
      assertRpcArgumentError(error, "deleteBot", ["SECRET_BOT"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("deleteBot", ["bot-1"]);
    await channel.call("saveConfig", [{ version: 3, bots: [] }]);
    assert.deepEqual(calls, ["deleteBot:bot-1", "saveConfig"]);
  });
});

// ---------------------------------------------------------------------------
// git —— commit / push / stagePaths
// ---------------------------------------------------------------------------

test("git: commit/push/stagePaths 非法参数在方法体前拒绝，合法调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    commit: async () => {
      calls.push("commit");
      return { commitHash: "abc", summary: {} };
    },
    push: async () => {
      calls.push("push");
      return {};
    },
    stagePaths: async () => {
      calls.push("stagePaths");
    },
  };
  await withWire(IGitService, stub, async (channel) => {
    // commit 缺 workspacePath
    await assert.rejects(channel.call("commit", [{ message: "LEAKME-msg" }]), (error) => {
      assertRpcArgumentError(error, "commit", ["LEAKME-msg"]);
      return true;
    });
    // push 非对象
    await assert.rejects(channel.call("push", ["SECRET-path"]), (error) => {
      assertRpcArgumentError(error, "push", ["SECRET-path"]);
      return true;
    });
    // stagePaths paths 非字符串数组
    await assert.rejects(
      channel.call("stagePaths", [{ workspacePath: "/repo", paths: "LEAK-not-array" }]),
      (error) => {
        assertRpcArgumentError(error, "stagePaths", ["LEAK-not-array"]);
        return true;
      },
    );
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("commit", [{ workspacePath: "/repo", message: "fix: thing" }]);
    await channel.call("push", [{ workspacePath: "/repo" }]);
    await channel.call("stagePaths", [{ workspacePath: "/repo", paths: ["a.ts", "b.ts"] }]);
    assert.deepEqual(calls, ["commit", "push", "stagePaths"]);
  });
});

// ---------------------------------------------------------------------------
// pluginManagement —— installPlugin / uninstallPlugin + 动态事件
// ---------------------------------------------------------------------------

test("pluginManagement: install/uninstall 非法参数拒绝，动态事件 listen 校验生效", async () => {
  const calls: string[] = [];
  const stub = {
    installPlugin: async () => {
      calls.push("installPlugin");
      return {};
    },
    uninstallPlugin: async () => {
      calls.push("uninstallPlugin");
      return {};
    },
    onDynamicPluginOperationProgress: () => {
      calls.push("onDynamicPluginOperationProgress");
      return () => ({ dispose: () => undefined });
    },
  };
  await withWire(IPluginManagementService, stub, async (channel) => {
    await assert.rejects(
      channel.call("installPlugin", [
        { workspacePath: "/w", marketplace: { token: "SECRET_MARKET" }, pluginName: "p" },
      ]),
      (error) => {
        assertRpcArgumentError(error, "installPlugin", ["SECRET_MARKET"]);
        return true;
      },
    );
    await assert.rejects(channel.call("uninstallPlugin", [{}]), (error) => {
      assertRpcArgumentError(error, "uninstallPlugin", []);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("installPlugin", [
      { workspacePath: "/w", marketplace: "m", pluginName: "p" },
    ]);
    await channel.call("uninstallPlugin", [{ workspacePath: "/w" }]);
    assert.deepEqual(calls, ["installPlugin", "uninstallPlugin"]);
  });

  // 动态事件：listen 传入非字符串 operationId 时同步拒绝（对齐 terminal 动态事件）。
  const serverChannel = exposeServerChannel(IPluginManagementService, stub);
  assert.throws(
    () => serverChannel.listen(undefined, "onDynamicPluginOperationProgress", { id: "SECRET_OP" }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicPluginOperationProgress", ["SECRET_OP"]);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// acodeSession —— setModel / setMode / closeSession（写操作）
// ---------------------------------------------------------------------------

test("acodeSession: setModel/setMode/closeSession 非法参数拒绝，合法调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    setModel: async () => {
      calls.push("setModel");
      return {};
    },
    setMode: async () => {
      calls.push("setMode");
      return {};
    },
    closeSession: async () => {
      calls.push("closeSession");
    },
  };
  await withWire(IACodeSessionService, stub, async (channel) => {
    await assert.rejects(
      channel.call("setModel", [{ workspacePath: "/w", sessionId: "s", model: "LEAK-not-object" }]),
      (error) => {
        assertRpcArgumentError(error, "setModel", ["LEAK-not-object"]);
        return true;
      },
    );
    // setMode 缺 mode
    await assert.rejects(
      channel.call("setMode", [{ workspacePath: "/w", sessionId: "s" }]),
      (error) => {
        assertRpcArgumentError(error, "setMode", []);
        return true;
      },
    );
    // closeSession 缺 sessionId
    await assert.rejects(channel.call("closeSession", [{ workspacePath: "/w" }]), (error) => {
      assertRpcArgumentError(error, "closeSession", []);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("setModel", [
      { workspacePath: "/w", sessionId: "s", model: { providerId: "p", modelId: "m" } },
    ]);
    await channel.call("setMode", [{ workspacePath: "/w", sessionId: "s", mode: "build" }]);
    await channel.call("closeSession", [{ workspacePath: "/w", sessionId: "s" }]);
    assert.deepEqual(calls, ["setModel", "setMode", "closeSession"]);
  });
});

// ---------------------------------------------------------------------------
// feedback —— create / comment（写操作）+ 动态事件
// ---------------------------------------------------------------------------

test("feedback: create/comment 非法参数拒绝，动态事件 listen 校验生效", async () => {
  const calls: string[] = [];
  const stub = {
    create: async () => {
      calls.push("create");
      return {};
    },
    comment: async () => {
      calls.push("comment");
      return {};
    },
    onDynamicUploadProgress: () => {
      calls.push("onDynamicUploadProgress");
      return () => ({ dispose: () => undefined });
    },
  };
  await withWire(IFeedbackService, stub, async (channel) => {
    await assert.rejects(channel.call("create", ["TOPSECRET-not-object"]), (error) => {
      assertRpcArgumentError(error, "create", ["TOPSECRET-not-object"]);
      return true;
    });
    // comment body 非字符串
    await assert.rejects(channel.call("comment", ["id-1", { leak: "SECRET_BODY" }]), (error) => {
      assertRpcArgumentError(error, "comment", ["SECRET_BODY"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("create", [{ title: "t", description: "d", type: "bug" }]);
    await channel.call("comment", ["id-1", "looks good"]);
    assert.deepEqual(calls, ["create", "comment"]);
  });

  const serverChannel = exposeServerChannel(IFeedbackService, stub);
  assert.throws(
    () => serverChannel.listen(undefined, "onDynamicUploadProgress", { id: "SECRET_PROG" }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicUploadProgress", ["SECRET_PROG"]);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// providerSettings —— setPersonalModelEnabled / savePersonalProviderOverlay / deletePersonalProvider
// ---------------------------------------------------------------------------

test("providerSettings: 写入方法非法参数拒绝，合法调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    setPersonalModelEnabled: async () => {
      calls.push("setPersonalModelEnabled");
      return {};
    },
    savePersonalProviderOverlay: async () => {
      calls.push("savePersonalProviderOverlay");
      return {};
    },
    deletePersonalProvider: async () => {
      calls.push("deletePersonalProvider");
      return {};
    },
  };
  await withWire(IProviderSettingsService, stub, async (channel) => {
    await assert.rejects(
      channel.call("setPersonalModelEnabled", ["p", "m", "LEAK-not-bool"]),
      (error) => {
        assertRpcArgumentError(error, "setPersonalModelEnabled", ["LEAK-not-bool"]);
        return true;
      },
    );
    await assert.rejects(
      channel.call("savePersonalProviderOverlay", ["SECRET_PROVIDER", "not-object"]),
      (error) => {
        assertRpcArgumentError(error, "savePersonalProviderOverlay", ["SECRET_PROVIDER"]);
        return true;
      },
    );
    await assert.rejects(
      channel.call("deletePersonalProvider", [{ id: "SECRET_PID" }]),
      (error) => {
        assertRpcArgumentError(error, "deletePersonalProvider", ["SECRET_PID"]);
        return true;
      },
    );
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("setPersonalModelEnabled", ["p", "m", true]);
    await channel.call("savePersonalProviderOverlay", ["p", { api: {} }]);
    await channel.call("deletePersonalProvider", ["p"]);
    assert.deepEqual(calls, [
      "setPersonalModelEnabled",
      "savePersonalProviderOverlay",
      "deletePersonalProvider",
    ]);
  });
});

// ---------------------------------------------------------------------------
// modelSelection —— getView（唯一入口，input 可选对象）
// ---------------------------------------------------------------------------

test("modelSelection: getView 非法 input 拒绝，缺省/合法 input 放行", async () => {
  const calls: string[] = [];
  const stub = {
    getView: async () => {
      calls.push("getView");
      return {};
    },
  };
  await withWire(IModelSelectionService, stub, async (channel) => {
    await assert.rejects(channel.call("getView", ["SECRET-input"]), (error) => {
      assertRpcArgumentError(error, "getView", ["SECRET-input"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("getView", []);
    await channel.call("getView", [{ selection: null }]);
    assert.deepEqual(calls, ["getView", "getView"]);
  });
});

// ---------------------------------------------------------------------------
// codingPlanSubscription —— createSign / getStaticProducts（写 + 无参读）
// ---------------------------------------------------------------------------

test("codingPlan: createSign 非法参数拒绝，无参读方法拒绝多余实参", async () => {
  const calls: string[] = [];
  const stub = {
    createSign: async () => {
      calls.push("createSign");
      return {};
    },
    getStaticProducts: async () => {
      calls.push("getStaticProducts");
      return {};
    },
  };
  await withWire(ICodingPlanSubscriptionService, stub, async (channel) => {
    // bizId 非字符串
    await assert.rejects(
      channel.call("createSign", [{ bizId: { leak: "SECRET_BIZ" } }]),
      (error) => {
        assertRpcArgumentError(error, "createSign", ["SECRET_BIZ"]);
        return true;
      },
    );
    // 无参读方法带多余实参
    await assert.rejects(channel.call("getStaticProducts", ["LEAK-extra"]), (error) => {
      assertRpcArgumentError(error, "getStaticProducts", ["LEAK-extra"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("createSign", [{ bizId: "biz-1" }]);
    await channel.call("getStaticProducts", []);
    assert.deepEqual(calls, ["createSign", "getStaticProducts"]);
  });
});

// ---------------------------------------------------------------------------
// offPeakTask —— createTask / deleteTask（写操作）
// ---------------------------------------------------------------------------

test("offPeakTask: createTask/deleteTask 非法参数拒绝，合法调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    createTask: async () => {
      calls.push("createTask");
      return { ok: true };
    },
    deleteTask: async (offPeakTaskId: string) => {
      calls.push(`deleteTask:${offPeakTaskId}`);
    },
  };
  await withWire(IOffPeakTaskService, stub, async (channel) => {
    // createTask 缺 workspacePath
    await assert.rejects(channel.call("createTask", [{ title: "t" }]), (error) => {
      assertRpcArgumentError(error, "createTask", []);
      return true;
    });
    // createTask 缺 modelSelection
    await assert.rejects(
      channel.call("createTask", [{ workspacePath: "/w", modelSelection: "LEAK-not-object" }]),
      (error) => {
        assertRpcArgumentError(error, "createTask", ["LEAK-not-object"]);
        return true;
      },
    );
    // deleteTask 非字符串
    await assert.rejects(channel.call("deleteTask", [{ id: "SECRET_TASK" }]), (error) => {
      assertRpcArgumentError(error, "deleteTask", ["SECRET_TASK"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("createTask", [
      {
        workspacePath: "/w",
        modelSelection: { providerId: "p", modelId: "m" },
        title: "t",
        prompt: "p",
        permissionMode: "build",
      },
    ]);
    await channel.call("deleteTask", ["task-1"]);
    assert.deepEqual(calls, ["createTask", "deleteTask:task-1"]);
  });
});
