import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transpileModule, ModuleKind } from "typescript";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

/**
 * 安全加固 P0-1 / P0-2 的不变量守护测试。
 *
 * 仿照 packages/desktop/tests/no-telemetry.test.mjs / no-official-platform.test.mjs 的写法：
 * 纯共享原语直接 import（Node 25 type-stripping）；http.ts 依赖 @acode/rpc（其内部 .js 规格
 * 在 type-stripping 下无法解析），故用 transpileModule + 注入 stub require 的方式加载，
 * 把真实 hono / @hono/node-server / ws 与真实共享原语喂进去，跑真实 HTTP 行为。
 *
 * 仅用临时端口 / loopback / 内存 fixture：绝不读写真实 ~/.acode 或任何真实凭据，绝不绑定公网网卡。
 */

// 真实共享原语（dependency-light leaf，可直接 import）。
const serverAuth = await import("../node_modules/@acode/shared/src/node/serverAuth.ts");
const hostCapability = await import("../node_modules/@acode/shared/src/node/hostCapability.ts");
const credentialAccess =
  await import("../node_modules/@acode/shared/src/node/credentialChannelAccess.ts");
const serverRemote = await import("../node_modules/@acode/shared/src/server-remote.ts");

async function load(path, imports = {}) {
  const exports = {};
  new Function(
    "require",
    "exports",
    "module",
    transpileModule(await read(path), {
      compilerOptions: { module: ModuleKind.CommonJS, target: 99 },
    }).outputText,
  )(
    (name) => {
      assert.ok(name in imports, `unexpected import ${name}`);
      return imports[name];
    },
    exports,
    { exports },
  );
  return exports;
}

// http.ts / server-core/http.ts 的 stub 依赖：RPC 与服务集合在本测试中不参与鉴权/能力路径，
// 给最小占位即可（onOpen 不会被触发，因为我们只验证升级前的鉴权与拒绝边界）。
const sharedStub = {
  ...serverRemote,
  ACODE_RPC_HOST_CAPABILITY_HEADER: "x-acode-rpc-host-capability",
  ACODE_VERSION: "0.0.0-test",
  formatLogPrefix: (scope, pid) => `[${scope}:${pid}]`,
  formatZodError: (error) => String(error),
  botProviders: ["webhook", "wecom"],
  remoteTargetSchema: {
    safeParse: () => ({ success: false, error: { issues: [{ message: "stub" }] } }),
  },
};

const rpcStub = {
  Emitter: class {
    constructor() {
      this.event = () => () => undefined;
    }
    fire() {}
  },
  VSBuffer: { wrap: (value) => value },
  SocketProtocol: class {},
  ChannelServer: class {
    dispose() {}
  },
  LoggingChannelServer: class {
    dispose() {}
  },
};

function makeServiceCollectionStub() {
  return class ServiceCollection {
    getOptional() {
      return undefined;
    }
    exposeOnChannelServer() {}
    register() {
      return this;
    }
  };
}

const ServiceCollection = makeServiceCollectionStub();
const servicesStub = {
  ServiceCollection,
  IACodeAgentService: { channelName: "agent" },
  ICredentialService: { channelName: "credential" },
  IFileService: {},
  IGitService: {},
  ISystemService: {},
  ITerminalService: {},
  IBotsService: {},
  IProviderProvisioningTargetService: { channelName: "prov" },
  createACodeAgentConnectionScope: () => undefined,
};

const remoteStub = {
  connectRemote: async () => {
    throw new Error("stub");
  },
  createRemoteBackend: async () => {
    throw new Error("stub");
  },
};

const hono = await import("hono");
const nodeServer = await import("@hono/node-server");
const nodeWs = await import("@hono/node-ws");
const nodeCrypto = await import("node:crypto");
const nodeFsPromises = await import("node:fs/promises");
const nodePath = await import("node:path");
const nodeOs = await import("node:os");
// 原生 WebSocket 客户端（不带 Origin 头）：模拟 Node `ws` / SSH 隧道内的合法客户端。
const RawWebSocket = (await import("ws")).default ?? (await import("ws"));

// server-core 的 createServiceLogger stub 捕获 warn/info，供 P0-3 拒绝日志与 M1 启动告警断言。
const coreWarnLines = [];
const coreInfoLines = [];

async function loadServerHttp() {
  return load("packages/server/src/http.ts", {
    "node:crypto": nodeCrypto,
    "node:fs/promises": nodeFsPromises,
    "node:path": nodePath,
    "node:os": nodeOs,
    hono,
    "@hono/node-server": nodeServer,
    "@hono/node-ws": nodeWs,
    "@acode/rpc": rpcStub,
    "@acode/services": servicesStub,
    "@acode/shared": sharedStub,
    "@acode/shared/node": { ...serverAuth, ...hostCapability, ...credentialAccess },
    "./remote/index.js": remoteStub,
  });
}

async function loadServerCoreHttp() {
  return load("packages/acode-server-cli/src/server-core/http.ts", {
    "node:crypto": nodeCrypto,
    "node:os": nodeOs,
    hono,
    "@hono/node-server": nodeServer,
    "@hono/node-ws": nodeWs,
    "@acode/rpc": rpcStub,
    "@acode/services": servicesStub,
    "@acode/services/node": {
      createServiceLogger: () => ({
        debug: () => undefined,
        info: (...args) => coreInfoLines.push(args.join(" ")),
        warn: (...args) => coreWarnLines.push(args.join(" ")),
      }),
    },
    "@acode/shared": sharedStub,
    "@acode/shared/node": { ...serverAuth, ...hostCapability, ...credentialAccess },
  });
}

async function startHttp(createHttpServer, options) {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, { host: "127.0.0.1", ...options });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startCore(createCoreHttpServer, options) {
  const services = new ServiceCollection();
  const core = await createCoreHttpServer(services, { host: "127.0.0.1", ...options });
  return { core, port: core.port, close: () => core.close() };
}

/**
 * 发起真实 WebSocket 升级并回传握手结果：`{ opened: true, status: 101 }` 或服务器拒绝状态。
 * 仅连 loopback 临时端口；意外错误 reject，避免把「连接被拒」误当成功。
 * 返回 socket 引用供调用方 terminate，防止已升级连接卡住 server.close()。
 */
function wsHandshake(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new RawWebSocket(url, { headers, handshakeTimeout: 5000 });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve({ socket, ...value });
    };
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish({ opened: false, status: response.statusCode });
    });
    socket.on("open", () => finish({ opened: true, status: 101 }));
    socket.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

/** close 带超时兜底：已升级连接若因 stub 未完全收敛而挂着，不让测试进程永久卡死。 */
async function closeWithTimeout(close, ms = 2000) {
  await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, ms))]);
}

// ── 纯共享原语单测 ───────────────────────────────────────────────────────────

test("assertServerAuthInvariant refuses non-loopback bind without auth and allows loopback/authed", () => {
  // (d) 非 loopback + 无 token => 拒绝启动（共享不变量，两套 server 同源）。
  assert.throws(
    () => serverAuth.assertServerAuthInvariant({ host: "0.0.0.0", authRequired: false }),
    /requires an auth token/i,
  );
  assert.throws(
    () => serverAuth.assertServerAuthInvariant({ host: "::", authRequired: false }),
    /requires an auth token/i,
  );
  assert.throws(
    () => serverAuth.assertServerAuthInvariant({ host: "192.168.1.10", authRequired: false }),
    /requires an auth token/i,
  );
  // loopback 无 token 允许；非 loopback 有 token 允许。
  assert.doesNotThrow(() =>
    serverAuth.assertServerAuthInvariant({ host: "127.0.0.1", authRequired: false }),
  );
  assert.doesNotThrow(() =>
    serverAuth.assertServerAuthInvariant({ host: "::1", authRequired: false }),
  );
  assert.doesNotThrow(() =>
    serverAuth.assertServerAuthInvariant({ host: "0.0.0.0", authRequired: true }),
  );
});

test("isLoopbackBindHost treats 0.0.0.0/:: as non-loopback", () => {
  assert.equal(serverAuth.isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(serverAuth.isLoopbackBindHost("localhost"), true);
  assert.equal(serverAuth.isLoopbackBindHost("::1"), true);
  assert.equal(serverAuth.isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(serverAuth.isLoopbackBindHost("::"), false);
  assert.equal(serverAuth.isLoopbackBindHost("10.0.0.5"), false);
});

test("resolveRequestOriginTrust rejects non-allowlisted browser Origin and Host", () => {
  // (b) 恶意浏览器 Origin 被拒。
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({ origin: "http://evil.test", host: "127.0.0.1:3030" }),
    { allowed: false, reason: "origin" },
  );
  // 沙箱 iframe 的字面量 Origin: null 也被拒（非 loopback、非白名单）。
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({ origin: "null", host: "127.0.0.1:3030" }),
    { allowed: false, reason: "origin" },
  );
  // 原生客户端无 Origin => 放行（交由能力 ticket 把关）。
  assert.deepEqual(serverAuth.resolveRequestOriginTrust({ host: "127.0.0.1:3030" }), {
    allowed: true,
  });
  // (7) loopback Origin => 放行。
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({
      origin: "http://127.0.0.1:5173",
      host: "127.0.0.1:3030",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({
      origin: "http://localhost:5173",
      host: "localhost:3030",
    }),
    { allowed: true },
  );
  // 显式白名单 Origin => 放行。
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({
      origin: "http://192.168.1.10:3030",
      host: "192.168.1.10:3030",
      allowedOrigins: ["http://192.168.1.10:3030"],
    }),
    { allowed: true },
  );
  // DNS-rebinding：loopback Origin 但 Host 指向非 loopback 且不在白名单 => 拒（reason=host）。
  assert.deepEqual(
    serverAuth.resolveRequestOriginTrust({
      origin: "http://127.0.0.1:5173",
      host: "attacker.rebind.test:3030",
    }),
    { allowed: false, reason: "host" },
  );
});

test("parseBearerToken and timingSafeTokenEquals behave correctly", () => {
  // (e) Authorization: Bearer 解析。
  assert.equal(serverAuth.parseBearerToken("Bearer abc123"), "abc123");
  assert.equal(serverAuth.parseBearerToken("bearer   abc123 "), "abc123");
  assert.equal(serverAuth.parseBearerToken("Basic abc123"), undefined);
  assert.equal(serverAuth.parseBearerToken(undefined), undefined);
  // 定长比较：相等真、不等假、长度不等假、缺省假。
  assert.equal(serverAuth.timingSafeTokenEquals("abc", "abc"), true);
  assert.equal(serverAuth.timingSafeTokenEquals("abc", "abd"), false);
  assert.equal(serverAuth.timingSafeTokenEquals("abc", "abcd"), false);
  assert.equal(serverAuth.timingSafeTokenEquals(undefined, "abc"), false);
});

test("fingerprintPrincipal is stable, token-free and bounded", () => {
  const fp = serverAuth.fingerprintPrincipal("super-secret-token");
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, serverAuth.fingerprintPrincipal("super-secret-token"));
  assert.notEqual(fp, serverAuth.fingerprintPrincipal("other-token"));
  // 指纹绝不包含原始 token。
  assert.ok(!fp.includes("super-secret-token"));
});

test("host capability store binds principal, is single-use and short-TTL", () => {
  let clock = 1_000_000;
  const store = hostCapability.createHostCapabilityStore({ now: () => clock });
  const principal = { fingerprint: "deadbeef" };
  const ticket = store.issue(principal);
  assert.equal(typeof ticket.capability, "string");
  assert.equal(ticket.expiresAt, clock + hostCapability.DEFAULT_HOST_CAPABILITY_TTL_MS);

  // (c) 首次兑换返回绑定主体。
  assert.deepEqual(store.consume(ticket.capability), principal);
  // (c) 二次兑换同一 capability 失败（单次兑换）。
  assert.equal(store.consume(ticket.capability), null);
  // 未知/缺省 capability 失败。
  assert.equal(store.consume("does-not-exist"), null);
  assert.equal(store.consume(undefined), null);

  // 过期后兑换失败（短 TTL）。
  const expired = store.issue({ fingerprint: "cafe" });
  clock += hostCapability.DEFAULT_HOST_CAPABILITY_TTL_MS + 1;
  assert.equal(store.consume(expired.capability), null);

  // 缺省主体为 anonymous。
  clock = 2_000_000;
  const anon = store.issue();
  assert.deepEqual(
    store.consume(anon.capability),
    hostCapability.ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
  );
});

test("host capability store caps live entries (no unbounded memory growth)", () => {
  // 对抗评审 #2：POST /api/rpc-host-capability 在默认无 token 的 loopback 配置下无鉴权，
  // 且是不需要 CORS 预检的 simple request——恶意网页可跨源狂刷把 Map 撑大（内存耗尽 DoS）。
  // purgeExpired 只删已过期项，故必须有存活条目上限。
  let clock = 1_000_000;
  const store = hostCapability.createHostCapabilityStore({ now: () => clock, maxLive: 3 });
  const first = store.issue();
  const second = store.issue();
  const third = store.issue();
  assert.ok(first && second && third, "under the cap, minting must succeed");
  // 达上限即拒绝铸造（返回 null），而不是无限增长。
  assert.equal(store.issue(), null, "minting beyond maxLive must be refused");
  // 兑换释放名额后可再铸造。
  assert.ok(store.consume(first.capability), "consume must return the bound principal");
  assert.ok(store.issue(), "after one entry is consumed, minting must succeed again");
  // 过期条目被清理后也释放名额：推进时钟让其余条目过期。
  clock += hostCapability.DEFAULT_HOST_CAPABILITY_TTL_MS + 1;
  assert.ok(store.issue(), "expired entries must free budget via purgeExpired");
});

test("capability cap defaults to a bounded value, not unbounded", () => {
  assert.equal(typeof hostCapability.MAX_LIVE_HOST_CAPABILITIES, "number");
  assert.ok(hostCapability.MAX_LIVE_HOST_CAPABILITIES > 0);
  assert.ok(
    hostCapability.MAX_LIVE_HOST_CAPABILITIES <= 100_000,
    "default cap must be bounded to a sane number",
  );
});

test("resolveHostCapabilityBinding enforces the minted principal (not decorative)", () => {
  // 对抗评审 #1：consume() 的返回值此前被两处调用点丢弃，主体绑定形同虚设。
  // 绑定校验必须比较「铸造时的主体」与「本次升级出示的主体」。
  const tokenA = "token-a";
  const principalA = { fingerprint: serverAuth.fingerprintPrincipal(tokenA) };

  // 出示同一 token => 放行。
  assert.deepEqual(
    serverAuth.resolveHostCapabilityBinding({
      boundPrincipal: principalA,
      configuredToken: tokenA,
      presentedToken: tokenA,
    }),
    { allowed: true },
  );

  // 出示另一个 token => 拒绝（主体混淆：A 铸造的能力不能被 B 兑换）。
  const mismatch = serverAuth.resolveHostCapabilityBinding({
    boundPrincipal: principalA,
    configuredToken: tokenA,
    presentedToken: "token-b",
  });
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, "principal-mismatch");

  // 配了 token 但本次升级没出示任何 token => 拒绝（不能靠「不带凭据」绕过绑定）。
  assert.equal(
    serverAuth.resolveHostCapabilityBinding({
      boundPrincipal: principalA,
      configuredToken: tokenA,
      presentedToken: undefined,
    }).allowed,
    false,
  );

  // 未配置 token（loopback 无鉴权）=> 放行；该场景下主体恒为 anonymous，
  // 绑定不提供屏障，真实边界是 loopback 绑定 + fail-closed + 启动告警。
  assert.deepEqual(
    serverAuth.resolveHostCapabilityBinding({
      boundPrincipal: hostCapability.ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
      configuredToken: undefined,
      presentedToken: undefined,
    }),
    { allowed: true },
  );
});

// ── packages/server http.ts 集成行为 ─────────────────────────────────────────

test("server: mint capability without token is 401 when auth required (a)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test("server: mint rejects browser Origin BEFORE occupying a capability slot", async () => {
  // 对抗评审 + fork 复核共同确认的残留 DoS：MAX_LIVE_HOST_CAPABILITIES 只封住了内存耗尽，
  // 默认无 token 的 loopback 配置下 POST /api/rpc-host-capability 仍无鉴权，且浏览器跨源
  // simple POST 不需要 CORS 预检——恶意网页即使读不到响应也能灌满槽位，让合法桌面 host
  // 铸造就吃 503（把内存 DoS 换成可用性 DoS）。修法是在 issue() **之前**做 Origin 裁决。
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, {});
  try {
    const evil = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { origin: "http://evil.test" },
    });
    assert.equal(evil.status, 403, "browser Origin must be rejected at mint");
    assert.match((await evil.json()).error, /untrusted origin/i);

    // 关键断言：被拒的请求**不得**占掉槽位。灌很多次之后，无 Origin 的合法铸造仍须成功。
    for (let i = 0; i < 300; i += 1) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
        method: "POST",
        headers: { origin: "http://evil.test" },
      });
      assert.equal(res.status, 403);
    }
    const legit = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(
      legit.status,
      200,
      "legitimate native mint must still succeed after 300 rejected browser mints " +
        "(rejected requests must not consume capability slots)",
    );
    assert.equal(typeof (await legit.json()).capability, "string");
  } finally {
    await ctx.close();
  }
});

test("server-core: mint rejects browser Origin before occupying a slot", async () => {
  // server-core 恒 loopback 且无 token 概念，故 Origin 裁决是该端点上唯一现实的远程屏障。
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const ctx = await startCore(createCoreHttpServer);
  try {
    const evil = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { origin: "http://evil.test" },
    });
    assert.equal(evil.status, 403);
    for (let i = 0; i < 300; i += 1) {
      await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
        method: "POST",
        headers: { origin: "http://evil.test" },
      });
    }
    const legit = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(legit.status, 200, "native mint must survive browser-Origin flooding");
  } finally {
    await ctx.close();
  }
});

test("server: cookie-encoded token authenticates consistently across middleware and binding", async () => {
  // 回归守护：readPresentedLiteToken 曾对 cookie 做 decodeURIComponent，而 hasValidLiteToken
  // 比较原值——含 %XX 的 token 会被中间件认可却被绑定校验算成不同主体（合法升级吃 403），
  // 含裸 % 的 token 还会让 decodeURIComponent 抛 URIError → 500。两处现在共用 readLiteTokenCookie。
  const { createHttpServer } = await loadServerHttp();
  for (const token of ["plain-token", "abc%41", "100%", "a%2Fb%3Fc", "%E4%B8%AD%E6%96%87"]) {
    const ctx = await startHttp(createHttpServer, { authToken: token, authRequired: true });
    try {
      // R2 后 HTTP 路由不再接受 query token（cookie 回写也随之移除），直接按回写曾经的
      // 产物构造 cookie 头：`acode_lite_token=${encodeURIComponent(token)}`。
      const cookieValue = `acode_lite_token=${encodeURIComponent(token)}`;

      // 仅带 cookie（不带 Authorization / query）铸造：必须 200，
      // 且不得因为编码差异而 403（principal-mismatch）或 500（URIError）。
      const viaCookie = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
        method: "POST",
        headers: { cookie: cookieValue },
      });
      assert.equal(
        viaCookie.status,
        200,
        `cookie-authenticated mint must succeed for token ${JSON.stringify(token)} ` +
          `(got ${viaCookie.status})`,
      );
      const { capability } = await viaCookie.json();

      // 用该能力做原生 /ws/host 升级：不得因主体不一致被 403（绑定校验读的必须是同一个 token）。
      const upgrade = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
        headers: { cookie: cookieValue, "x-acode-rpc-host-capability": capability },
      });
      assert.notEqual(
        upgrade.status,
        403,
        `cookie-authenticated upgrade must not be rejected as principal-mismatch for ${JSON.stringify(token)}`,
      );
      assert.notEqual(
        upgrade.status,
        500,
        `upgrade must not throw (URIError) for ${JSON.stringify(token)}`,
      );
    } finally {
      await ctx.close();
    }
  }
});

test("server: token via Authorization header authenticates (e)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
  try {
    const ok = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(typeof body.capability, "string");
    assert.ok(body.capability.length > 0);
    // 错误 token 仍被拒。
    const bad = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(bad.status, 401);
  } finally {
    await ctx.close();
  }
});

test("server: ?token= rejected on HTTP routes with one-time warning, still accepted for /ws upgrades (R2/f)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // HTTP 路由：合法 query token 不再接受（兼容窗已按 spec 承诺关闭）→ 401，且不回写 cookie。
    const res = await fetch(
      `http://127.0.0.1:${ctx.port}/api/rpc-host-capability?token=secret-token`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok(
      warnings.some((line) => /DEPRECATION REMOVED/i.test(line) && /\?token=/i.test(line)),
      `expected a ?token= removal warning, got: ${JSON.stringify(warnings)}`,
    );

    // WS 升级路径：query 是唯一保留面（标准 WebSocket API 无法携带自定义 header）。
    // 无 Upgrade 头不会真的 101，但只要不是 401 即证明鉴权中间件放行了 query 凭据；
    // 错误 token 仍必须 401。超时护栏防止升级处理器对非升级请求的行为差异拖死测试。
    const wsOk = await fetch(`http://127.0.0.1:${ctx.port}/ws?token=secret-token`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.notEqual(wsOk.status, 401);
    const wsBad = await fetch(`http://127.0.0.1:${ctx.port}/ws?token=wrong-token`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(wsBad.status, 401);
  } finally {
    console.warn = originalWarn;
    await ctx.close();
  }
});

test("server: /ws/host upgrade with Origin http://evil.test is rejected 403 (b)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
  try {
    // 先合法铸造一个 capability，证明拒绝来自 Origin 门而非缺票。
    const mint = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    const { capability } = await mint.json();
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: "http://evil.test",
        "x-acode-rpc-host-capability": capability,
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /untrusted origin/i);
  } finally {
    await ctx.close();
  }
});

test("server: same capability cannot be redeemed twice (c)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
  try {
    const mint = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    const { capability } = await mint.json();
    // 第一次：原生客户端无 Origin，能力有效 => 不被 401 能力门拦（走到升级，GET 无 upgrade 头
    // 由 hono 返回 4xx/升级失败，但关键是不再是能力门的 401）。
    const first = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: { authorization: "Bearer secret-token", "x-acode-rpc-host-capability": capability },
    });
    assert.notEqual(
      first.status,
      401,
      `first redemption should pass the capability gate, got ${first.status}`,
    );
    // 第二次：同一 capability 已作废 => 能力门 401。
    const second = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: { authorization: "Bearer secret-token", "x-acode-rpc-host-capability": capability },
    });
    assert.equal(second.status, 401);
    const body = await second.json();
    assert.match(body.error, /Invalid or expired host capability/i);
  } finally {
    await ctx.close();
  }
});

test("server: non-loopback bind without token refuses to start (d)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const services = new ServiceCollection();
  // 0.0.0.0 + 无 token：必须在 listen 前抛错（不绑定任何网卡）。
  assert.throws(
    () => createHttpServer(services, 0, { host: "0.0.0.0" }),
    /requires an auth token/i,
  );
  // 0.0.0.0 + 有 token：允许构造（fail-closed 不变量满足）。
  const authed = createHttpServer(services, 0, {
    host: "0.0.0.0",
    authToken: "t",
    authRequired: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  authed.close();
});

test("server: loopback without token starts but logs a loud no-auth warning (P0-2)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const services = new ServiceCollection();
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let server;
  try {
    server = createHttpServer(services, 0, { host: "127.0.0.1" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(
      lines.some((line) => /SECURITY WARNING/i.test(line) && /no auth token/i.test(line)),
      `expected a loud no-auth loopback warning, got: ${JSON.stringify(lines)}`,
    );
  } finally {
    console.log = originalLog;
    server?.close();
  }
});

// ── packages/acode-server-cli server-core 集成行为（同源不变量）─────────────────

test("server-core: non-loopback host refuses to start via shared invariant (d)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const services = new ServiceCollection();
  await assert.rejects(
    () => createCoreHttpServer(services, { host: "0.0.0.0" }),
    /requires an auth token/i,
  );
});

test("server-core: /ws/host upgrade with evil Origin is rejected and capability is single-use (b,c)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const ctx = await startCore(createCoreHttpServer);
  try {
    const mint = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(mint.status, 200);
    const { capability } = await mint.json();
    // 恶意 Origin => 403（在消费能力之前）。
    const evil = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: { origin: "http://evil.test", "x-acode-rpc-host-capability": capability },
    });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error, /untrusted origin/i);
    // 无 Origin 的原生升级：首次过能力门（非 401）。
    const first = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: { "x-acode-rpc-host-capability": capability },
    });
    assert.notEqual(
      first.status,
      401,
      `first redemption should pass capability gate, got ${first.status}`,
    );
    // 同一 capability 二次兑换 => 401。
    const replay = await fetch(`http://127.0.0.1:${ctx.port}/ws/host`, {
      headers: { "x-acode-rpc-host-capability": capability },
    });
    assert.equal(replay.status, 401);
  } finally {
    await ctx.close();
  }
});

test("server-core: loopback host starts and reports authRequired false", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const ctx = await startCore(createCoreHttpServer);
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`);
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.authRequired, false);
  } finally {
    await ctx.close();
  }
});

// ── P0-3：普通 `/ws` 升级前 Origin/Host 裁决（验收场景 13）─────────────────────

test("server: /ws upgrade with evil Origin is rejected 403 and connection not established (13)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let ctx;
  try {
    ctx = await startHttp(createHttpServer, {});
    const attempt = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: "http://evil.test",
    });
    attempt.socket.terminate();
    assert.equal(attempt.opened, false, "handshake must not complete for untrusted Origin");
    assert.equal(attempt.status, 403);
    // 拒绝必须记 warn（生产可用安全事件），与既有拒绝/弃用日志风格一致。
    assert.ok(
      warnings.some((line) => /SECURITY/i.test(line) && /untrusted origin/i.test(line)),
      `expected a rejection warn log, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server: native client without Origin upgrades /ws normally (13)", async () => {
  const { createHttpServer } = await loadServerHttp();
  let ctx;
  try {
    ctx = await startHttp(createHttpServer, {});
    // Node `ws` 默认不发 Origin 头：原生客户端（terminal-client / web-remote 客户端）不受 Origin 门拦截。
    const native = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`);
    native.socket.terminate();
    assert.equal(native.opened, true, "no-Origin native upgrade must succeed");
    assert.equal(native.status, 101);
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server: /ws upgrade with loopback Origin is allowed (13)", async () => {
  const { createHttpServer } = await loadServerHttp();
  let ctx;
  try {
    ctx = await startHttp(createHttpServer, {});
    // 同源（loopback）浏览器页面是合法调用方：`Origin: http://127.0.0.1:<port>` 放行。
    const loopback = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: `http://127.0.0.1:${ctx.port}`,
    });
    loopback.socket.terminate();
    assert.equal(loopback.opened, true, "loopback Origin upgrade must be allowed");
    const localhost = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: `http://localhost:${ctx.port}`,
    });
    localhost.socket.terminate();
    assert.equal(localhost.opened, true, "localhost Origin upgrade must be allowed");
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server: token auth runs before the /ws Origin gate (401 before 403)", async () => {
  const { createHttpServer } = await loadServerHttp();
  let ctx;
  try {
    ctx = await startHttp(createHttpServer, { authToken: "secret-token", authRequired: true });
    // 无凭据 + 恶意 Origin：鉴权中间件先拦（spec 要求裁决在「鉴权之后、升级之前」）。
    const unauthenticated = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: "http://evil.test",
    });
    unauthenticated.socket.terminate();
    assert.equal(unauthenticated.status, 401);
    // 合法凭据 + 恶意 Origin：过鉴权后被 Origin 门拦为 403。
    const authenticated = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: "http://evil.test",
      authorization: "Bearer secret-token",
    });
    authenticated.socket.terminate();
    assert.equal(authenticated.opened, false);
    assert.equal(authenticated.status, 403);
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server: /ws/remote/:id one-shot endpoint is covered by the same Origin gate (13)", async () => {
  // P0-3 核查：/ws/remote/:id 是独立升级路由，不经 `/ws` 处理器；未挂门时未知 id 也会先完成
  // 101 握手再在 onOpen 里 close(4004)。断言 403 证明升级前的 Origin 裁决覆盖了该端点。
  const { createHttpServer } = await loadServerHttp();
  let ctx;
  try {
    ctx = await startHttp(createHttpServer, {});
    const evil = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws/remote/whatever`, {
      origin: "http://evil.test",
    });
    evil.socket.terminate();
    assert.equal(evil.opened, false);
    assert.equal(evil.status, 403);
    const native = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws/remote/whatever`);
    native.socket.terminate();
    // 无 Origin 原生客户端过 Origin 门（随后由 onOpen 的 id 校验 close，非本断言关注点）。
    assert.notEqual(native.status, 403);
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server-core: /ws upgrade with evil Origin is rejected 403 with warn (13)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  let ctx;
  try {
    ctx = await startCore(createCoreHttpServer);
    const evil = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: "http://evil.test",
    });
    evil.socket.terminate();
    assert.equal(evil.opened, false, "handshake must not complete for untrusted Origin");
    assert.equal(evil.status, 403);
    assert.ok(
      coreWarnLines.some((line) => /SECURITY/i.test(line) && /untrusted origin/i.test(line)),
      `expected a server-core rejection warn log, got: ${JSON.stringify(coreWarnLines)}`,
    );
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("server-core: native and loopback-Origin clients upgrade /ws normally (13)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  let ctx;
  try {
    ctx = await startCore(createCoreHttpServer);
    // 无 Origin 原生客户端（SSH 隧道内的 terminal-client）：放行并完成握手。
    const native = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`);
    native.socket.terminate();
    assert.equal(native.opened, true, "no-Origin native upgrade must succeed on server-core");
    // loopback Origin：放行并完成握手。
    const loopback = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`, {
      origin: `http://127.0.0.1:${ctx.port}`,
    });
    loopback.socket.terminate();
    assert.equal(loopback.opened, true, "loopback Origin upgrade must be allowed on server-core");
  } finally {
    if (ctx) await closeWithTimeout(ctx.close);
  }
});

test("static: both /ws upgrade gates adjudicate with the same shared helper (13)", async () => {
  // 不变量守护：两套 server 的 `/ws` 升级门必须调用同一个共享 resolveRequestOriginTrust
  // （@acode/shared/node），不允许任一侧另起兜底分支。
  const serverHttp = await read("packages/server/src/http.ts");
  const coreHttp = await read("packages/acode-server-cli/src/server-core/http.ts");
  // packages/server：/ws 与 /ws/remote/:id 挂同一裁决中间件，中间件内调用共享 helper。
  assert.match(serverHttp, /const rejectUntrustedUpgradeOrigin[\s\S]*?resolveRequestOriginTrust\(/);
  assert.match(serverHttp, /app\.use\(\s*"\/ws",\s*rejectUntrustedUpgradeOrigin\s*\)/);
  assert.match(serverHttp, /app\.use\(\s*"\/ws\/remote\/:id",\s*rejectUntrustedUpgradeOrigin\s*\)/);
  // Server Core：/ws 升级裁决内联调用同一个共享 helper。
  assert.match(coreHttp, /app\.use\(\s*"\/ws",[\s\S]*?resolveRequestOriginTrust\(/);
});

// ── 安全修复 M1/M2/M4/M10/M11（server-auth.md 验收场景 14-20）──────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待谓词成立（WS onOpen 装配是异步的），超时抛错防止测试卡死。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("waitFor: condition not met within timeout");
}

test("shared: resolveServerTokenAuth / readPresentedServerToken single adjudication (20)", () => {
  const view = (over = {}) => ({ url: "http://127.0.0.1:3030/api/x", ...over });
  // Bearer 优先。
  assert.deepEqual(
    serverAuth.resolveServerTokenAuth(view({ authorizationHeader: "Bearer t" }), "t"),
    { valid: true, viaDeprecatedQuery: false },
  );
  // cookie 安全解码：与写入端 encodeURIComponent 对称，%XX 编码比较解码后的原值。
  assert.deepEqual(
    serverAuth.resolveServerTokenAuth(view({ cookieHeader: "acode_lite_token=abc%41" }), "abcA"),
    { valid: true, viaDeprecatedQuery: false },
  );
  // 含裸 % 的 cookie 不抛 URIError，按「不匹配」处理。
  assert.deepEqual(
    serverAuth.resolveServerTokenAuth(view({ cookieHeader: "acode_lite_token=100%" }), "t"),
    { valid: false, viaDeprecatedQuery: false },
  );
  // HTTP 路由出示合法 query → 拒绝且 viaDeprecatedQuery=true（调用点打一次性迁移告警）。
  assert.deepEqual(
    serverAuth.resolveServerTokenAuth(view({ url: "http://127.0.0.1:3030/api/x?token=t" }), "t"),
    { valid: false, viaDeprecatedQuery: true },
  );
  // /ws* 升级路径 query 是唯一保留面 → 有效。
  assert.deepEqual(
    serverAuth.resolveServerTokenAuth(view({ url: "http://127.0.0.1:3030/ws?token=t" }), "t"),
    { valid: true, viaDeprecatedQuery: false },
  );
  // readPresentedServerToken 与裁决同源：Bearer > cookie > query。
  assert.equal(serverAuth.readPresentedServerToken(view({ authorizationHeader: "Bearer a" })), "a");
  assert.equal(
    serverAuth.readPresentedServerToken(view({ cookieHeader: "acode_lite_token=b%42" })),
    "bB",
  );
  assert.equal(serverAuth.readPresentedServerToken(view({ url: "http://x/ws?token=q" })), "q");
  // 受保护路径单一判定。
  assert.equal(serverAuth.isTokenProtectedPathname("/api/server-info"), true);
  assert.equal(serverAuth.isTokenProtectedPathname("/ws/host"), true);
  assert.equal(serverAuth.isTokenProtectedPathname("/index.html"), false);
  assert.equal(serverAuth.isTokenProtectedPathname("/"), false);
});

test("static: cross-drive Windows path is rejected by containment (14/M10)", async () => {
  // 注入 win32 path 语义 + 内存 fs stub：CI 为 ubuntu，测试必须 OS 无关，验证的是
  // isInsideDirectory 在 path.win32.relative 跨盘符语义下的纯函数行为与路由级结果。
  const files = new Map([
    ["C:\\Windows\\win.ini", "[extensions]"], // 攻击目标：另一盘符上的敏感文件
    ["D:\\web\\index.html", "<html>root-index</html>"], // staticRoot 内合法文件
    ["D:\\secret.txt", "TOP-SECRET"], // 同盘但 staticRoot 外
  ]);
  const fsStub = {
    stat: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return { isDirectory: () => false, isFile: () => true };
    },
    readFile: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return files.get(p);
    },
  };
  const { createHttpServer } = await load("packages/server/src/http.ts", {
    "node:crypto": nodeCrypto,
    "node:fs/promises": fsStub,
    "node:path": nodePath.win32,
    "node:os": nodeOs,
    hono,
    "@hono/node-server": nodeServer,
    "@hono/node-ws": nodeWs,
    "@acode/rpc": rpcStub,
    "@acode/services": servicesStub,
    "@acode/shared": sharedStub,
    "@acode/shared/node": { ...serverAuth, ...hostCapability, ...credentialAccess },
    "./remote/index.js": remoteStub,
  });
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    staticRoot: "D:\\web",
    spaFallback: true,
  });
  await sleep(120);
  const port = server.address().port;
  try {
    // 修复前：path.win32.relative("D:\\web","C:\\Windows\\win.ini") 原样返回绝对路径
    // （不以 ".." 开头）→ 旧判定放行 → 200 泄漏文件内容。修复后必须在进入 fs 前拒绝。
    const crossDrive = await fetch(`http://127.0.0.1:${port}/C:/Windows/win.ini`);
    assert.equal(crossDrive.status, 404, "cross-drive static path must be rejected");
    assert.ok(!(await crossDrive.text()).includes("[extensions]"));
    // 同盘目录内合法文件仍正常服务（正控）。
    const inside = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(inside.status, 200);
    assert.equal(await inside.text(), "<html>root-index</html>");
    // `..` 逃逸（%2e%2e%2f 全编码，绕过 URL 规范化）不得读到 staticRoot 外内容——
    // 包含判定失败在进入 fs 前直接 null → 404（不走 SPA fallback）。
    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fsecret.txt`);
    assert.equal(traversal.status, 404);
    const traversalBody = await traversal.text();
    assert.ok(!traversalBody.includes("TOP-SECRET"), "traversal must not leak outside staticRoot");
  } finally {
    await closeWithTimeout(() => new Promise((resolve) => server.close(() => resolve())));
  }
});

test("server: /api/connect-remote rejects browser Origin before side effects (15/M11)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const ctx = await startHttp(createHttpServer, {});
  try {
    // 跨源 text/plain simple POST（免 CORS 预检的现实攻击形态）→ 403，先于 body 解析与
    // createRemoteBackend（SSH 外联 / WSL / Docker spawn）副作用。
    const evil = await fetch(`http://127.0.0.1:${ctx.port}/api/connect-remote`, {
      method: "POST",
      headers: { origin: "http://evil.test", "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ kind: "wsl" }),
    });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error, /untrusted origin/i);
    // 无 Origin 的原生客户端 → 正常进入 body 校验（stub schema 恒 fail → 400，证明已过 Origin 门）。
    const native = await fetch(`http://127.0.0.1:${ctx.port}/api/connect-remote`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(native.status, 400);
    // loopback Origin（同源 Web 客户端）→ 不被 Origin 门拒绝。
    const loopback = await fetch(`http://127.0.0.1:${ctx.port}/api/connect-remote`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${ctx.port}` },
      body: "{}",
    });
    assert.equal(loopback.status, 400);
  } finally {
    await ctx.close();
  }
});

test("server: /api/connect-remote caps pending unclaimed connections (16/M11)", async () => {
  // 自定义 stub：schema 通过、backend 连接成功，使条目真正落入 remoteConnections。
  let spawned = 0;
  const remoteOkStub = {
    createRemoteBackend: async () => {
      spawned += 1;
      return { kind: "wsl" };
    },
    connectRemote: async () => ({
      services: {},
      dispose: async () => undefined,
      disposeAndWait: async () => undefined,
    }),
  };
  const { createHttpServer } = await load("packages/server/src/http.ts", {
    "node:crypto": nodeCrypto,
    "node:fs/promises": nodeFsPromises,
    "node:path": nodePath,
    "node:os": nodeOs,
    hono,
    "@hono/node-server": nodeServer,
    "@hono/node-ws": nodeWs,
    "@acode/rpc": rpcStub,
    "@acode/services": servicesStub,
    "@acode/shared": {
      ...sharedStub,
      remoteTargetSchema: { safeParse: (data) => ({ success: true, data }) },
    },
    "@acode/shared/node": { ...serverAuth, ...hostCapability, ...credentialAccess },
    "./remote/index.js": remoteOkStub,
  });
  // 上限常量从源码解析，避免测试与实现各写一份魔法数。
  const src = await read("packages/server/src/http.ts");
  const maxPending = Number(src.match(/MAX_PENDING_REMOTE_CONNECTIONS = (\d+)/)?.[1] ?? "0");
  assert.ok(maxPending > 0 && maxPending <= 1000, "cap must be a bounded positive constant");
  const ctx = await startHttp(createHttpServer, {});
  try {
    for (let i = 0; i < maxPending; i += 1) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/connect-remote`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(res.status, 200, `pending connection #${i} must succeed under the cap`);
      assert.equal(typeof (await res.json()).id, "string");
    }
    const overflow = await fetch(`http://127.0.0.1:${ctx.port}/api/connect-remote`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(overflow.status, 503, "budget exhausted must be 503");
    assert.equal(spawned, maxPending, "rejected request must not spawn another backend");
  } finally {
    await ctx.close();
  }
});

test("server: server-info reports authRequired truthfully; legacy env name is dead (17/M2)", async () => {
  const { createHttpServer } = await loadServerHttp();
  // 只传 authToken（不显式传 authRequired）：中间件已挂载 → server-info 必须如实报 true
  // （修复前 fallback 读错变量名会报 false，即「实际有鉴权、自报无鉴权」的反向分叉）。
  const ctx = await startHttp(createHttpServer, { authToken: "secret-token" });
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).authRequired, true);
  } finally {
    await ctx.close();
  }

  // legacy 变量名 ACODE_SERVER_TOKEN 已无任何消费点：只设它 → authRequired:false 且无中间件
  // （修复前 createServerInfo 会因它误报 true →「自报已鉴权、实际无鉴权」）。
  const legacyName = "ACODE_SERVER_TOKEN";
  const savedLegacy = process.env[legacyName];
  process.env[legacyName] = "legacy-token";
  try {
    const ctx2 = await startHttp(createHttpServer, {});
    try {
      const res2 = await fetch(`http://127.0.0.1:${ctx2.port}/api/server-info`);
      assert.equal(res2.status, 200, "no middleware must be attached from the legacy env name");
      assert.equal((await res2.json()).authRequired, false);
    } finally {
      await ctx2.close();
    }
  } finally {
    if (savedLegacy === undefined) delete process.env[legacyName];
    else process.env[legacyName] = savedLegacy;
  }

  // 静态守护：http.ts 源码不再出现 "ACODE_SERVER_TOKEN" 字面量（只允许 AUTH 变量名）。
  const src = await read("packages/server/src/http.ts");
  assert.ok(!src.includes('"ACODE_SERVER_TOKEN"'), "legacy env literal must be gone");
  const coreSrc = await read("packages/acode-server-cli/src/server-core/http.ts");
  assert.ok(!coreSrc.includes('"ACODE_SERVER_TOKEN"'), "legacy env literal must be gone");
});

/** 捕获 exposeOnChannelServer(server, overrides) 的服务集合 stub + 真实凭据服务 fixture。 */
function makeCredentialCaptureCollection() {
  const captures = [];
  const realCredential = {
    load: async (key) => `value:${key}`,
    save: async () => {
      throw new Error("real credential save must not be reachable from a narrowed connection");
    },
    delete: async () => {
      throw new Error("real credential delete must not be reachable from a narrowed connection");
    },
  };
  class CapturingServiceCollection {
    getOptional(descriptor) {
      if (descriptor && descriptor.channelName === "credential") return realCredential;
      return undefined;
    }
    exposeOnChannelServer(_server, overrides) {
      captures.push(overrides ?? new Map());
    }
    register() {
      return this;
    }
  }
  return { CapturingServiceCollection, captures, realCredential };
}

/** 断言 terminal-client 的 credential guard：allowlist 键只读放行，其余 load/save/delete 拒绝。 */
async function assertTerminalCredentialGuard(guard) {
  assert.equal(await guard.load("oauth:active_provider"), "value:oauth:active_provider");
  assert.equal(await guard.load("oauth:zai:access_token"), "value:oauth:zai:access_token");
  assert.equal(
    await guard.load("oauth:bigmodel:access_token"),
    "value:oauth:bigmodel:access_token",
  );
  await assert.rejects(() => guard.load("remote-workspace:any:token"), /restricted/i);
  await assert.rejects(() => guard.load("mcp:server:token"), /restricted/i);
  await assert.rejects(() => guard.load("auth_token"), /restricted/i);
  await assert.rejects(() => guard.save("oauth:zai:access_token", "x"), /restricted/i);
  await assert.rejects(() => guard.delete("oauth:active_provider"), /restricted/i);
}

test("server: credential channel narrowed for terminal-client, full for desktop (18/M4)", async () => {
  const { createHttpServer } = await loadServerHttp();
  const { CapturingServiceCollection, captures } = makeCredentialCaptureCollection();
  const server = createHttpServer(new CapturingServiceCollection(), 0, { host: "127.0.0.1" });
  await sleep(120);
  const port = server.address().port;
  try {
    // terminal-client（/ws）：overrides 必须含 credential guard。
    const terminal = await wsHandshake(`ws://127.0.0.1:${port}/ws`);
    await waitFor(() => captures.length >= 1);
    const terminalOverrides = captures[0];
    assert.ok(
      terminalOverrides.has("credential"),
      "terminal-client must get a narrowed credential channel",
    );
    await assertTerminalCredentialGuard(terminalOverrides.get("credential"));
    terminal.socket.terminate();

    // desktop-continuous（/ws/host + capability）：不收窄，保持全量（renderer 登录态依赖）。
    const mint = await fetch(`http://127.0.0.1:${port}/api/rpc-host-capability`, {
      method: "POST",
    });
    const { capability } = await mint.json();
    const desktop = await wsHandshake(`ws://127.0.0.1:${port}/ws/host`, {
      "x-acode-rpc-host-capability": capability,
    });
    await waitFor(() => captures.length >= 2);
    assert.equal(desktop.opened, true);
    assert.equal(
      captures[1].has("credential"),
      false,
      "desktop-continuous must keep the full credential channel",
    );
    desktop.socket.terminate();
  } finally {
    await closeWithTimeout(() => new Promise((resolve) => server.close(() => resolve())));
  }
});

test("server-core: credential channel narrowed for terminal-client, full for desktop (18/M4)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const { CapturingServiceCollection, captures } = makeCredentialCaptureCollection();
  const core = await createCoreHttpServer(new CapturingServiceCollection(), { host: "127.0.0.1" });
  try {
    const terminal = await wsHandshake(`ws://127.0.0.1:${core.port}/ws`);
    await waitFor(() => captures.length >= 1);
    assert.ok(
      captures[0].has("credential"),
      "terminal-client must get a narrowed credential channel",
    );
    await assertTerminalCredentialGuard(captures[0].get("credential"));
    terminal.socket.terminate();

    const mint = await fetch(`http://127.0.0.1:${core.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    const { capability } = await mint.json();
    const desktop = await wsHandshake(`ws://127.0.0.1:${core.port}/ws/host`, {
      "x-acode-rpc-host-capability": capability,
    });
    await waitFor(() => captures.length >= 2);
    assert.equal(desktop.opened, true);
    assert.equal(
      captures[1].has("credential"),
      false,
      "desktop-continuous must keep the full credential channel",
    );
    desktop.socket.terminate();
  } finally {
    await closeWithTimeout(() => core.close());
  }
});

test("server-core: token auth gates server-info, mint and /ws (19/M1)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  const ctx = await startCore(createCoreHttpServer, { authToken: "core-secret" });
  try {
    // 无凭据：HTTP 面与 WS 升级面全部 401（此前 server-core 完全无 token 鉴权）。
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`)).status, 401);
    assert.equal(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, { method: "POST" }))
        .status,
      401,
    );
    const noToken = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws`);
    noToken.socket.terminate();
    assert.equal(noToken.opened, false);
    assert.equal(noToken.status, 401);

    // Bearer：server-info 200 且 authRequired 如实为 true。
    const info = await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`, {
      headers: { authorization: "Bearer core-secret" },
    });
    assert.equal(info.status, 200);
    assert.equal((await info.json()).authRequired, true);

    // Bearer 铸造 → 200；/ws?token= 升级握手（标准 WebSocket API 无法带头）→ 101。
    const mint = await fetch(`http://127.0.0.1:${ctx.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer core-secret" },
    });
    assert.equal(mint.status, 200);
    const withToken = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws?token=core-secret`);
    withToken.socket.terminate();
    assert.equal(withToken.opened, true, "query token must remain valid on /ws* upgrades");
    // 错误 token → 401。
    const badToken = await wsHandshake(`ws://127.0.0.1:${ctx.port}/ws?token=wrong`);
    badToken.socket.terminate();
    assert.equal(badToken.status, 401);
  } finally {
    await ctx.close();
  }
});

test("server-core: ACODE_SERVER_AUTH_TOKEN env enables auth; no-token default warns (19/M1)", async () => {
  const { createCoreHttpServer } = await loadServerCoreHttp();
  // env 单一读取点：ACODE_SERVER_AUTH_TOKEN（与 packages/server 同名）。
  const envName = "ACODE_SERVER_AUTH_TOKEN";
  const saved = process.env[envName];
  process.env[envName] = "env-core-token";
  try {
    const ctx = await startCore(createCoreHttpServer);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`)).status, 401);
      const ok = await fetch(`http://127.0.0.1:${ctx.port}/api/server-info`, {
        headers: { authorization: "Bearer env-core-token" },
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).authRequired, true);
    } finally {
      await ctx.close();
    }
  } finally {
    if (saved === undefined) delete process.env[envName];
    else process.env[envName] = saved;
  }

  // 缺省 loopback 无 token：行为与现状一致（server-info 匿名可读、authRequired:false），
  // 且启动告警与 packages/server 对齐（同一串共享文案）。
  const ctx2 = await startCore(createCoreHttpServer);
  try {
    const res = await fetch(`http://127.0.0.1:${ctx2.port}/api/server-info`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).authRequired, false);
    assert.ok(
      coreInfoLines.some((line) => /SECURITY WARNING/i.test(line) && /no auth token/i.test(line)),
      `expected the shared no-auth loopback warning, got: ${JSON.stringify(coreInfoLines)}`,
    );
  } finally {
    await ctx2.close();
  }
});

test("static: both servers share token adjudication and credential guard (20)", async () => {
  // 不变量守护：token 裁决与 credential 收窄都必须走共享单一实现，
  // 任一侧不得内联第二份 cookie 解码 / 接受顺序 / allowlist。
  const serverHttp = await read("packages/server/src/http.ts");
  const coreHttp = await read("packages/acode-server-cli/src/server-core/http.ts");
  for (const [name, src] of [
    ["packages/server", serverHttp],
    ["server-core", coreHttp],
  ]) {
    assert.match(src, /resolveServerTokenAuth\(/, `${name} must use the shared token adjudication`);
    assert.match(
      src,
      /readPresentedServerToken\(/,
      `${name} must use the shared presented-token reader`,
    );
    assert.match(
      src,
      /isTokenProtectedPathname\(/,
      `${name} must use the shared protected-path predicate`,
    );
    assert.match(
      src,
      /createTerminalClientCredentialGuard\(/,
      `${name} must use the shared credential guard`,
    );
    assert.ok(
      !src.includes("acode_lite_token"),
      `${name} must not inline a second cookie name/decode`,
    );
    assert.ok(
      !src.includes("oauth:active_provider"),
      `${name} must not inline a second credential allowlist`,
    );
  }
  // Core 的 /ws/host 绑定必须传真实 token（不再是不提供屏障的字面量 null）。
  assert.match(coreHttp, /configuredToken:\s*authToken/);
  assert.match(coreHttp, /presentedToken:\s*readPresentedServerToken\(/);
});
