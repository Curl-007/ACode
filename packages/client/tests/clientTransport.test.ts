// packages/client/specs/module-boundary.md 验收 3/5：远程/传输访问面的纯逻辑测试。
// 覆盖新增的幂等 dispose 语义（关闭底层传输 + ChannelClient），以及 connectViaWebSocket 的
// 就绪前失败 reject 路径、connectViaProtocol 的传输收口、RemoteServiceAccess 代理展开与 dispose 守卫、
// MessagePort 连接的一次性释放边界。全部用注入的假 WebSocket / 假 protocol / 假 port，无 live server、无 jsdom。
import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteServiceAccess,
  connectViaProtocol,
  connectViaWebSocket,
  createMessagePortServiceConnection,
  type WebSocketConnectionCloseEvent,
} from "../src/index.js";

// messageport 在非生产构建下会 console.log 连接调试日志；测试里显式静音，保持输出干净。
(globalThis as typeof globalThis & { __ACODE_RENDERER_DISABLE_LOGGING__?: boolean })
  .__ACODE_RENDERER_DISABLE_LOGGING__ = true;

// ── 假 WebSocket：手动 fire 事件，记录 close/send 次数。 ──────────────────────────
type Listener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** 每个测试开头清空，避免跨用例串扰。 */
  static instances: FakeWebSocket[] = [];

  binaryType = "";
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    // Set 迭代对并发删除安全；假 WebSocket 的 listener 不会在 fire 期间增删，故直接迭代。
    for (const cb of this.listeners.get(type) ?? new Set<Listener>()) {
      cb(event);
    }
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

/** 在测试期间把 globalThis.WebSocket 换成假实现，回调结束后恢复。 */
async function withFakeWebSocket<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  // connectViaWebSocket 在调用时动态读取 `new WebSocket` 与 `WebSocket.OPEN`，故换全局即可注入。
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
  }
}

// ── connectViaWebSocket：就绪前失败 reject；open → 可 dispose 的门面 ───────────────

test("connectViaWebSocket rejects with a connection-failed error when the socket errors before open", async () => {
  await withFakeWebSocket(async () => {
    const promise = connectViaWebSocket("ws://example.test/ws");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.fire("error");
    await assert.rejects(promise, /WebSocket connection failed: ws:\/\/example\.test\/ws/);
  });
});

test("connectViaWebSocket rejects with reason when the socket closes before open (with reason)", async () => {
  await withFakeWebSocket(async () => {
    const promise = connectViaWebSocket("ws://example.test/ws");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.fire("close", { code: 1006, reason: "gone", wasClean: false });
    await assert.rejects(promise, /WebSocket closed before ready: gone/);
  });
});

test("connectViaWebSocket rejects with code when the socket closes before open (no reason)", async () => {
  await withFakeWebSocket(async () => {
    const promise = connectViaWebSocket("ws://example.test/ws");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.fire("close", { code: 1001, reason: "", wasClean: false });
    await assert.rejects(promise, /WebSocket closed before ready \(1001\)/);
  });
});

test("connectViaWebSocket resolves on open, fires onOpenSocket/onClose, and dispose() closes the socket", async () => {
  await withFakeWebSocket(async () => {
    const closeEvents: WebSocketConnectionCloseEvent[] = [];
    const openedSockets: unknown[] = [];
    const promise = connectViaWebSocket("ws://example.test/ws", {
      onClose: (event) => closeEvents.push(event),
      onOpenSocket: (socket) => openedSockets.push(socket),
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.fire("open");

    const services = await promise;
    // open 后 onOpenSocket 收到裸 ws；门面是 IServiceAccessor + dispose。
    assert.equal(openedSockets.length, 1);
    assert.equal(typeof services.dispose, "function");
    assert.ok(services.fileService, "accessor expands service getters (fileService proxy present)");

    // open 后 close → onClose 带 code/reason/wasClean（此时已 settled，不 reject）。
    ws.fire("close", { code: 1000, reason: "bye", wasClean: true });
    assert.deepEqual(closeEvents, [{ code: 1000, reason: "bye", wasClean: true }]);

    // dispose 关闭底层 WebSocket（transport → socket.dispose → ws.close）。
    assert.equal(ws.closeCalls, 0, "socket open until dispose");
    services.dispose();
    assert.equal(ws.closeCalls, 1, "dispose must close the underlying WebSocket");
    // 幂等：重复 dispose 不再关闭第二次。
    services.dispose();
    assert.equal(ws.closeCalls, 1, "dispose is idempotent (transport released once)");
  });
});

// ── connectViaProtocol：传输收口顺序 + 幂等 ────────────────────────────────────

function makeFakeProtocol() {
  const disposed = { count: 0 };
  const protocol = {
    send: () => {},
    onMessage: () => ({ dispose: () => {} }),
    dispose: () => {
      disposed.count += 1;
    },
  };
  return { protocol, disposed };
}

test("connectViaProtocol binds a transport whose dispose() is idempotent and disposes protocol + extraTransport", () => {
  const { protocol, disposed } = makeFakeProtocol();
  let extraDisposed = 0;
  const services = connectViaProtocol(protocol, { dispose: () => (extraDisposed += 1) });
  assert.equal(typeof services.dispose, "function");
  services.dispose();
  services.dispose(); // 幂等
  assert.equal(disposed.count, 1, "protocol.dispose called exactly once");
  assert.equal(extraDisposed, 1, "extraTransport.dispose called exactly once");
});

test("connectViaProtocol without an extra transport still yields a safe idempotent dispose()", () => {
  const { protocol } = makeFakeProtocol();
  const services = connectViaProtocol(protocol);
  assert.doesNotThrow(() => {
    services.dispose();
    services.dispose();
  });
});

// ── RemoteServiceAccess：代理展开 + dispose 守卫（transport 注入 / 缺省） ────────────

function makeFakeChannelClient() {
  const channels: string[] = [];
  const client = {
    channels,
    // IChannelClient.getChannel 是泛型 <T extends IChannel>；假实现返回一个满足 IChannel 结构的对象，
    // 用泛型签名 + as 抹平 T 的任意性（测试只关心 getChannel 被按 descriptor 调用，不跑真实 RPC）。
    getChannel<T>(name: string): T {
      channels.push(name);
      return { call: async () => undefined, listen: () => ({ dispose: () => {} }) } as T;
    },
  };
  return client as unknown as { channels: string[] } & import("@acode/rpc").IChannelClient;
}

test("RemoteServiceAccess expands service getters via getChannel for each descriptor", () => {
  const client = makeFakeChannelClient();
  const access = new RemoteServiceAccess(client);
  // 构造时按 getter 一次性展开代理，每个 descriptor 触发一次 getChannel。
  assert.ok(client.channels.length > 10, "many service channels requested at construction");
  assert.ok(client.channels.includes("file"), "file channel requested");
  assert.ok(access.gitService, "gitService proxy present");
});

test("RemoteServiceAccess.dispose() runs the injected transport once and is idempotent", () => {
  const client = makeFakeChannelClient();
  let transportDisposed = 0;
  const access = new RemoteServiceAccess(client, { dispose: () => (transportDisposed += 1) });
  access.dispose();
  access.dispose();
  assert.equal(transportDisposed, 1, "transport disposed exactly once across repeat dispose()");
});

test("RemoteServiceAccess.dispose() is a safe no-op when no transport is injected", () => {
  const client = makeFakeChannelClient();
  const access = new RemoteServiceAccess(client);
  assert.doesNotThrow(() => {
    access.dispose();
    access.dispose();
  });
});

// ── MessagePort 连接：connection.dispose 与 services.dispose 共用一次性释放边界 ───────

function makeFakeMessagePort() {
  const state = { closeCalls: 0, startCalls: 0, posted: 0 };
  const listeners = new Map<string, Set<Listener>>();
  const port = {
    addEventListener(type: string, cb: Listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    },
    removeEventListener(type: string, cb: Listener) {
      listeners.get(type)?.delete(cb);
    },
    postMessage() {
      state.posted += 1;
    },
    start() {
      state.startCalls += 1;
    },
    close() {
      state.closeCalls += 1;
    },
  };
  return { port: port as unknown as MessagePort, state, listenerCount: (t: string) => listeners.get(t)?.size ?? 0 };
}

test("createMessagePortServiceConnection starts the port and exposes services + dispose", () => {
  const { port, state } = makeFakeMessagePort();
  const connection = createMessagePortServiceConnection(port);
  assert.equal(state.startCalls, 1, "MessagePortProtocol starts the port");
  assert.ok(connection.services.fileService, "services facade present");
  assert.equal(typeof connection.dispose, "function");
});

test("MessagePort connection.dispose() and services.dispose() share one release boundary (port closed once)", () => {
  const { port, state, listenerCount } = makeFakeMessagePort();
  const connection = createMessagePortServiceConnection(port);
  assert.equal(listenerCount("message"), 1, "message listener attached");
  // 两条释放路径（connection.dispose 与门面 services.dispose）共用 disposed 守卫：只生效一次。
  connection.dispose();
  (connection.services as { dispose?: () => void }).dispose?.();
  assert.equal(state.closeCalls, 1, "port closed exactly once across both dispose paths");
  assert.equal(listenerCount("message"), 0, "message listener detached on disconnect");
});

test("MessagePort connection.dispose() is idempotent on its own", () => {
  const { port, state } = makeFakeMessagePort();
  const connection = createMessagePortServiceConnection(port);
  connection.dispose();
  connection.dispose();
  connection.dispose(new Error("late reason"));
  assert.equal(state.closeCalls, 1, "repeat dispose does not re-close the port");
});
