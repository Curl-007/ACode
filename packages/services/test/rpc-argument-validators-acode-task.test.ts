import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceCollection, IACodeTaskService } from "../src/index.js";
import { ChannelClient, ChannelServer, createQueuePair, Emitter } from "@acode/rpc";

/**
 * ARCH-01：IACodeTaskService descriptor 的 argumentValidators 行为测试。
 * 校验必须发生在服务方法体执行前（ProxyChannel.fromService call/listen），
 * 失败统一为 code = "rpc-invalid-arguments"、带 method、details 不回显参数值。
 */

const SENTINEL = "sentinel-value-that-must-never-appear-in-errors";

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createTrackedStub(
  calls: RecordedCall[],
  streamEvents: Emitter<unknown>,
): IACodeTaskService {
  const track =
    (method: string) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      return Promise.resolve({ ok: method });
    };
  return {
    sendPrompt: track("sendPrompt"),
    enqueueTaskCommand: track("enqueueTaskCommand"),
    promoteTaskCommand: track("promoteTaskCommand"),
    stopGeneration: track("stopGeneration"),
    createTask: track("createTask"),
    setTaskPinned: track("setTaskPinned"),
    setModel: track("setModel"),
    deleteArchivedTasks: track("deleteArchivedTasks"),
    listPinnedTaskIds: track("listPinnedTaskIds"),
    onDynamicStreamEvent: (_taskId: string) => streamEvents.event,
    onDynamicTaskEvent: (_params: unknown) => streamEvents.event,
    onDynamicWorkspaceEvent: (_workspace: unknown) => streamEvents.event,
    onError: streamEvents.event,
  } as unknown as IACodeTaskService;
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
  assert.equal(details.includes("task-1"), false, `details leaked value for ${method}`);
  assert.equal(
    String(rpcError.message ?? "").includes(SENTINEL),
    false,
    `message leaked value for ${method}`,
  );
}

test("ACodeTask 变更方法的畸形参数在方法体执行前稳定拒绝", async () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "acode-task-validators");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection()
    .register(IACodeTaskService, createTrackedStub(calls, stream))
    .exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(IACodeTaskService.channelName);
    const malformed: ReadonlyArray<{ readonly method: string; readonly args: unknown[] }> = [
      // taskId 非 string
      { method: "sendPrompt", args: [{ taskId: 42, traceId: "trace-1", content: SENTINEL }] },
      // 缺必填 traceId
      { method: "sendPrompt", args: [{ taskId: "task-1", content: SENTINEL }] },
      // 缺 params
      { method: "sendPrompt", args: [] },
      // 缺必填 content
      {
        method: "enqueueTaskCommand",
        args: [
          {
            workspacePath: "w",
            taskId: "task-1",
            commandId: "cmd-1",
            traceId: "trace-1",
            type: "send_prompt",
          },
        ],
      },
      // params 为 null
      { method: "stopGeneration", args: [null] },
      // workspacePath 非 string
      { method: "createTask", args: [{ workspacePath: 7 }] },
      // pinned 非 boolean
      { method: "setTaskPinned", args: [{ taskId: "task-1", workspacePath: "w", pinned: "yes" }] },
      // modelSelection 缺必填 modelId
      {
        method: "setModel",
        args: [{ taskId: "task-1", traceId: "trace-1", modelSelection: { providerId: "p" } }],
      },
      // taskIds 非 string[]
      { method: "deleteArchivedTasks", args: [{ workspacePath: "w", taskIds: "not-an-array" }] },
      // 无参方法收到多余参数
      { method: "listPinnedTaskIds", args: [SENTINEL] },
      // params 非对象（字符串）
      { method: "promoteTaskCommand", args: [SENTINEL] },
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

test("ACodeTask 合法调用仍到达服务方法体", async () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "acode-task-validators-ok");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection()
    .register(IACodeTaskService, createTrackedStub(calls, stream))
    .exposeOnChannelServer(server);
  try {
    const channel = client.getChannel(IACodeTaskService.channelName);
    await channel.call("stopGeneration", [{ taskId: "task-1", workspacePath: "w" }]);
    // attribution（automationId）等可选字段存在时不得被误拒。
    await channel.call("sendPrompt", [
      { taskId: "task-1", traceId: "trace-1", content: "hello", automationId: "auto-1" },
    ]);
    await channel.call("setTaskPinned", [{ taskId: "task-1", workspacePath: "w", pinned: true }]);
    await channel.call("listPinnedTaskIds", []);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["stopGeneration", "sendPrompt", "setTaskPinned", "listPinnedTaskIds"],
    );
    assert.deepEqual(calls[1].args, [
      { taskId: "task-1", traceId: "trace-1", content: "hello", automationId: "auto-1" },
    ]);
  } finally {
    client.dispose();
    server.dispose();
    stream.dispose();
  }
});

test("ACodeTask 动态事件在订阅前校验参数，普通事件 onError 仍可订阅", () => {
  const calls: RecordedCall[] = [];
  const stream = new Emitter<unknown>();
  let channel;
  new ServiceCollection()
    .register(IACodeTaskService, createTrackedStub(calls, stream))
    .exposeOnChannelServer({
      registerChannel: (_name, exposed) => {
        channel = exposed;
      },
    });
  assert.ok(channel);

  // taskId 非 string
  assert.throws(
    () => channel.listen(undefined, "onDynamicStreamEvent", { taskId: SENTINEL }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicStreamEvent");
      return true;
    },
  );
  // 缺必填 taskId
  assert.throws(
    () => channel.listen(undefined, "onDynamicTaskEvent", { workspacePath: "w" }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicTaskEvent");
      return true;
    },
  );
  // 对象成员缺必填 workspacePath
  assert.throws(
    () => channel.listen(undefined, "onDynamicWorkspaceEvent", { workspaceIdentity: SENTINEL }),
    (error: unknown) => {
      assertRpcArgumentError(error, "onDynamicWorkspaceEvent");
      return true;
    },
  );

  const received: unknown[] = [];
  // 合法订阅：string taskId、string workspace、对象 workspace、普通事件 onError。
  const listeners = [
    channel.listen(
      undefined,
      "onDynamicStreamEvent",
      "task-1",
    )((value: unknown) => received.push(`stream:${String(value)}`)),
    channel.listen(
      undefined,
      "onDynamicWorkspaceEvent",
      "workspace-a",
    )((value: unknown) => received.push(`workspace-string:${String(value)}`)),
    channel.listen(undefined, "onDynamicWorkspaceEvent", {
      workspacePath: "w",
      workspaceIdentity: "id",
    })((value: unknown) => received.push(`workspace-object:${String(value)}`)),
    channel.listen(
      undefined,
      "onError",
    )((value: unknown) => received.push(`error:${String(value)}`)),
  ];
  try {
    stream.fire("event-1");
    assert.deepEqual(received, [
      "stream:event-1",
      "workspace-string:event-1",
      "workspace-object:event-1",
      "error:event-1",
    ]);
    assert.deepEqual(calls, []);
  } finally {
    for (const listener of listeners) listener.dispose();
    stream.dispose();
  }
});
