import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceCollection, IACodeAgentService } from "../src/index.js";
import { ChannelClient, ChannelServer, createQueuePair, Emitter } from "@acode/rpc";

/**
 * ARCH-01：IACodeAgentService descriptor 的 argumentValidators 行为测试。
 * 校验必须发生在服务方法体执行前（ProxyChannel.fromService call/listen），
 * 失败统一为 code = "rpc-invalid-arguments"、带 method、details 不回显参数值。
 * 覆盖优先变更/写路径：session 创建/发送/关闭、模型切换、v4 command、插件安装、
 * workspace 释放与附件分块写入。
 */

const SENTINEL = "sentinel-value-that-must-never-appear-in-errors";

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createTrackedStub(
  calls: RecordedCall[],
  streamEvents: Emitter<unknown>,
): IACodeAgentService {
  const track =
    (method: string) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      return Promise.resolve({ ok: method });
    };
  return {
    // 变更/写路径
    createSession: track("createSession"),
    sendPrompt: track("sendPrompt"),
    setModel: track("setModel"),
    closeSession: track("closeSession"),
    compactSession: track("compactSession"),
    sendConversationCommandV4: track("sendConversationCommandV4"),
    installPlugin: track("installPlugin"),
    setPluginEnabled: track("setPluginEnabled"),
    disposeWorkspace: track("disposeWorkspace"),
    attachmentChunkV4: track("attachmentChunkV4"),
    // 无参方法
    helloConversationV4: track("helloConversationV4"),
    listAllAutomations: track("listAllAutomations"),
    disposeAll: track("disposeAll"),
    hasActiveCuaOperationTurn: (...args: unknown[]) => {
      calls.push({ method: "hasActiveCuaOperationTurn", args });
      return false;
    },
    // 可选 AbortSignal 入参
    collectLocalRuntimeChildProcesses: track("collectLocalRuntimeChildProcesses"),
    // 动态事件
    onDynamicConversationFrame: (...args: unknown[]) => {
      calls.push({ method: "onDynamicConversationFrame", args });
      return streamEvents.event;
    },
    onDynamicPluginOperationProgress: (...args: unknown[]) => {
      calls.push({ method: "onDynamicPluginOperationProgress", args });
      return streamEvents.event;
    },
    onDynamicProcessResourceSample: (...args: unknown[]) => {
      calls.push({ method: "onDynamicProcessResourceSample", args });
      return streamEvents.event;
    },
    onDynamicSessionEvent: (...args: unknown[]) => {
      calls.push({ method: "onDynamicSessionEvent", args });
      return streamEvents.event;
    },
    // 普通事件（listener 风格）
    onAgentRuntimeRestarted: (...args: unknown[]) => {
      calls.push({ method: "onAgentRuntimeRestarted", args });
      return { dispose: () => undefined };
    },
  } as unknown as IACodeAgentService;
}

function assertRpcArgumentError(error: unknown, method: string): void {
  const rpcError = error as {
    code?: string;
    method?: string;
    details?: string;
    message?: string;
  };
  assert.equal(
    rpcError.code,
    "rpc-invalid-arguments",
    `expected rpc-invalid-arguments for ${method}`,
  );
  assert.equal(rpcError.method, method);
  // details/message 只做安全摘要，绝不回显参数值。
  const details = String(rpcError.details ?? "");
  assert.equal(details.includes(SENTINEL), false, `details leaked value for ${method}`);
  assert.equal(details.includes("session-1"), false, `details leaked value for ${method}`);
  assert.equal(
    String(rpcError.message ?? "").includes(SENTINEL),
    false,
    `message leaked value for ${method}`,
  );
}

test("descriptor 为每个公开成员登记参数校验器", () => {
  for (const method of IACodeAgentService.allowedMethods) {
    assert.equal(
      IACodeAgentService.argumentValidators.has(method),
      true,
      `${method} 缺少 argumentValidator`,
    );
    assert.equal(
      typeof IACodeAgentService.argumentValidators.get(method),
      "function",
      `${method} 的 argumentValidator 必须是函数`,
    );
  }
  assert.equal(
    IACodeAgentService.argumentValidators.size,
    IACodeAgentService.allowedMethods.length,
  );
});

test("ACodeAgent 变更方法的畸形参数在方法体执行前稳定拒绝", async () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "acode-agent-validators");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection()
    .register(IACodeAgentService, createTrackedStub(calls, stream))
    .exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(IACodeAgentService.channelName);
    const malformed: ReadonlyArray<{ readonly method: string; readonly args: unknown[] }> = [
      // 缺必填 params
      { method: "createSession", args: [] },
      // params 为原始值（字符串）而非对象
      { method: "createSession", args: [SENTINEL] },
      // 多传参数（签名只声明 1 个 params）
      {
        method: "sendPrompt",
        args: [{ workspacePath: "/w", sessionId: "session-1", content: "hi" }, SENTINEL],
      },
      // params 为 null
      { method: "setModel", args: [null] },
      // 多传参数
      { method: "closeSession", args: [{}, {}] },
      // params 为 number
      { method: "compactSession", args: [42] },
      // v4 command 写路径：params 为字符串
      { method: "sendConversationCommandV4", args: [SENTINEL] },
      // params 为数组（顶层必须是普通对象）
      { method: "installPlugin", args: [[SENTINEL]] },
      // 必填 params 显式 undefined
      { method: "setPluginEnabled", args: [undefined] },
      // workspace 释放：params 为字符串
      { method: "disposeWorkspace", args: [SENTINEL] },
      // 附件分块写入：缺 params
      { method: "attachmentChunkV4", args: [] },
      // 无参方法收到多余参数
      { method: "helloConversationV4", args: [SENTINEL] },
      { method: "disposeAll", args: [{}] },
      // 可选 AbortSignal：超过 1 个参数 / signal 为字符串
      { method: "collectLocalRuntimeChildProcesses", args: [SENTINEL, SENTINEL] },
      { method: "collectLocalRuntimeChildProcesses", args: [SENTINEL] },
    ];
    for (const { method, args } of malformed) {
      await assert.rejects(
        channel.call(method, args),
        (error: unknown) => {
          assertRpcArgumentError(error, method);
          return true;
        },
        `expected rpc-invalid-arguments rejection for ${method}`,
      );
    }
    // 所有畸形调用都必须在服务方法体之前被拒绝。
    assert.deepEqual(calls, []);
  } finally {
    client.dispose();
    server.dispose();
    stream.dispose();
  }
});

test("ACodeAgent 合法调用仍到达服务方法体", async () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "acode-agent-validators-ok");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection()
    .register(IACodeAgentService, createTrackedStub(calls, stream))
    .exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(IACodeAgentService.channelName);
    // 完整 session 发送：可选字段（attribution、clientMode 等）在场不得被误拒。
    await channel.call("sendPrompt", [
      {
        workspacePath: "/workspace",
        workspaceIdentity: "identity-1",
        sessionId: "session-1",
        content: "hello",
        clientMode: "desktop-continuous",
        inputId: "input-1",
      },
    ]);
    // 无参方法：无参数调用。
    await channel.call("helloConversationV4");
    await channel.call("listAllAutomations", []);
    // 可选 signal：省略与传对象都合法（AbortSignal 序列化退化形态按对象处理）。
    await channel.call("collectLocalRuntimeChildProcesses");
    await channel.call("collectLocalRuntimeChildProcesses", [{}]);
    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "sendPrompt",
        "helloConversationV4",
        "listAllAutomations",
        "collectLocalRuntimeChildProcesses",
        "collectLocalRuntimeChildProcesses",
      ],
    );
    assert.deepEqual(calls[0].args, [
      {
        workspacePath: "/workspace",
        workspaceIdentity: "identity-1",
        sessionId: "session-1",
        content: "hello",
        clientMode: "desktop-continuous",
        inputId: "input-1",
      },
    ]);
    assert.deepEqual(calls[3].args, []);
    assert.deepEqual(calls[4].args, [{}]);
  } finally {
    client.dispose();
    server.dispose();
    stream.dispose();
  }
});

test("ACodeAgent 动态事件在订阅前校验参数，普通事件仍可订阅", () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  let channel;
  new ServiceCollection()
    .register(IACodeAgentService, createTrackedStub(calls, stream))
    .exposeOnChannelServer({
      registerChannel: (_name, exposed) => {
        channel = exposed;
      },
    });
  assert.ok(channel);

  // workspace target 必须是对象：字符串订阅参数拒绝
  assert.throws(
    () => channel.listen(undefined, "onDynamicConversationFrame", SENTINEL),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicConversationFrame");
      return true;
    },
  );
  // 必填 params 缺席同样拒绝
  assert.throws(
    () => channel.listen(undefined, "onDynamicConversationFrame"),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicConversationFrame");
      return true;
    },
  );
  // operationId 必须是 string
  assert.throws(
    () => channel.listen(undefined, "onDynamicPluginOperationProgress", { operationId: SENTINEL }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicPluginOperationProgress");
      return true;
    },
  );
  // 无参动态事件不得携带订阅参数
  assert.throws(
    () => channel.listen(undefined, "onDynamicProcessResourceSample", { workspacePath: SENTINEL }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicProcessResourceSample");
      return true;
    },
  );
  assert.deepEqual(calls, [], "校验失败的订阅不得触达服务成员");

  const received: unknown[] = [];
  // 合法订阅：对象 workspace target、string operationId、无参动态事件、普通事件。
  const listeners = [
    channel.listen(undefined, "onDynamicConversationFrame", {
      workspacePath: "/workspace",
      workspaceIdentity: "identity-1",
    })((value: unknown) => received.push(`frame:${String(value)}`)),
    channel.listen(
      undefined,
      "onDynamicPluginOperationProgress",
      "operation-1",
    )((value: unknown) => received.push(`plugin:${String(value)}`)),
    channel.listen(
      undefined,
      "onDynamicProcessResourceSample",
    )((value: unknown) => received.push(`resource:${String(value)}`)),
    channel.listen(
      undefined,
      "onAgentRuntimeRestarted",
    )((value: unknown) => received.push(`restart:${String(value)}`)),
  ];
  try {
    stream.fire("event-1");
    assert.deepEqual(received, ["frame:event-1", "plugin:event-1", "resource:event-1"]);
    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "onDynamicConversationFrame",
        "onDynamicPluginOperationProgress",
        "onDynamicProcessResourceSample",
        // 普通事件经 listen 订阅：bufferEvent 以服务成员注册本地 listener。
        "onAgentRuntimeRestarted",
      ],
    );
    // 普通事件的 listener 由 RPC 层本地附加，wire 上没有参数。
    assert.equal(typeof calls[3].args[0], "function");
  } finally {
    for (const listener of listeners) listener.dispose();
    stream.dispose();
  }
});
