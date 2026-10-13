import { CuaHelperError } from "./broker.js";

export const HELPER_ADDON_ENV = "ACODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "acode-cua-windows-dev/v1";

const UNAVAILABLE = "Computer Use is not available in this build.";

function unavailableReject() {
  return Promise.reject(new CuaHelperError(UNAVAILABLE));
}

export function buildHelperOpenArgs(_spec, _launcherPid) {
  return [];
}

export async function resolveHelperPermissionSubjectIdentity(_appPath) {
  throw new CuaHelperError(UNAVAILABLE);
}

export function isCuaLocalDevelopmentRuntime(_env, _compiledLocalDevelopmentRuntime) {
  return false;
}

export function createCuaHelperInstaller(_options) {
  return {
    ensureInstalled: unavailableReject,
    verifyInstalled: unavailableReject,
  };
}

export const defaultCuaHelperVerifierDependencies = {
  readExecutableArchs: unavailableReject,
  verifyCodeSignature: unavailableReject,
  verifyTeamIdentifier: unavailableReject,
};

export function cuaBrokerRefreshMarkerPath(_socketPath) {
  return undefined;
}

export async function publishCuaBrokerRefreshMarker(_socketPath, _options) {
  return { path: undefined };
}

export function loadRealNativeAddon(_options) {
  throw new CuaHelperError(UNAVAILABLE);
}

export function resolvePackagedNativeAddonPath(_options) {
  return undefined;
}

export function resolveInTreeAddonPath(_options) {
  return undefined;
}

export function createAxReadOnlyMethods(_source, _registry, _options) {
  return {};
}

export const ROLE_TO_KIND = {};

export function roleToKind(_role) {
  return undefined;
}

export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  constructor(dispose) {
    this.#dispose = dispose;
    this.#current = undefined;
  }
  async acquire(options) {
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
      return undefined;
    }
    const managed = options?.create?.();
    this.#current = managed;
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
  }
}

export class CuaProductHelperWorkspaceRegistry {
  setEnabled(_context, _enabled) {}
}

export function createProductCuaHelperHost(_options) {
  return createUnavailableCuaHelperHost();
}

function createUnavailableCuaHelperHost() {
  return {
    get running() {
      return false;
    },
    get socketPath() {
      return null;
    },
    get pluginAuthority() {
      return null;
    },
    get reservedTransport() {
      return undefined;
    },
    start: unavailableReject,
    stop: async () => {},
    restart: unavailableReject,
    restartAfterCurrentStart: unavailableReject,
    waitForTransport: unavailableReject,
    checkHealth: unavailableReject,
    queryScreenCaptureProbe: async () => ({
      ok: false,
      reason: UNAVAILABLE,
    }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => ({}),
  };
}

export function isOfficialCuaPluginEnabledForWorkspace(_options) {
  return false;
}

export function createCuaProductMcpServerResolver(_host, _options) {
  return {
    async resolveMcpServers(servers, _context) {
      return servers;
    },
    async restart() {
      throw new Error(UNAVAILABLE);
    },
    async restartAfterPermissionGrant(_onboardingSessionId) {
      throw new Error(UNAVAILABLE);
    },
  };
}

export async function waitForCuaHelperStartup(startup, deadlineMs) {
  // 有界 deadline race（wire spec / node.ts:1159/:1191 消费）。未传合法 deadline 时直接 await
  // （向后兼容占位语义——不是 bug，只是无 deadline）。占位曾无条件忽略 deadlineMs 直接 await，
  // 使 node.ts:1189「cold launch 没在 1s 内 ready 且无预留才 fail-closed」的有界 race 失效。
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    return await startup;
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // code:"caller_timeout" 被 node.ts:1211 精确判定（isCuaHelperError && code==="caller_timeout"）：
      // 语义 = 共享的 30s startup 仍在后台跑，caller 本次超时但不取消 startup、不设 retryAt。
      reject(new CuaHelperError("Computer Use Helper startup exceeded the caller deadline", { code: "caller_timeout" }));
    }, deadlineMs);
  });
  try {
    // Promise.race 不取消 startup：超时后 startup 继续在后台跑（由 node.ts trackCuaProductHelperStartup
    // 的 .then(onFulfilled,onRejected) 处理其真正成败与 backoff）。race 已对 startup 挂 handler，
    // 故 startup 的迟到 rejection 不会成为 unhandled——此处无需额外 catch。
    return await Promise.race([Promise.resolve(startup), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── CUA candidate MCP server 判别（角色 B 增量 4，module-boundary.md 不变量 1 栏① / 不变量 2 补注）───

// 单一事实源常量（packages/shared/src/mcp.ts:10 ACODE_CUA_OFFICIAL_PLUGIN_ID、:16 ACODE_PLUGIN_ID_ENV_KEY）。
// 不变量 2（requires:[]）禁止 import @acode/shared，故在包内持有等值字面量；
// 字面量漂移由 services 侧对照测试兜底（不变量 2 补注「防漂移方案」）。
const CUA_AGENT_SERVER_NAME = "computer-use";
const CUA_PLUGIN_ID_ENV_NAME = "ACODE_PLUGIN_ID";
const CUA_OFFICIAL_PLUGIN_ID = "computer-use@acode-plugins-official";

// 以下两个模块私有函数逐字复刻 packages/shared/src/mcp.ts:228-252 的私有
// acodeCuaArgLeaf / matchesACodeCuaSpec（单一事实源 isACodeCuaMcpCommand/isACodeCuaMcpPackageArg
// :259-270 的实现体），保证两处判别面一致：下划线归一（PyPI 视 _/- 等价）、
// `@`/`==`/`[`/`.` 包规格边界、路径叶子（先去尾部分隔符，防空串叶子漏判 → fail-open）。
function acodeCuaArgLeaf(value) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? value;
}

function matchesACodeCuaSpec(candidate) {
  const c = candidate.replace(/_/g, "-");
  return (
    c === "acode-cua" ||
    c.startsWith("acode-cua[") ||
    c.startsWith("acode-cua@") ||
    c.startsWith("acode-cua==") ||
    // `.` 分支同时覆盖 `acode-cua.git` / `acode-cua.git@v1` 与 `acode-cua.server` 等 python 子模块。
    c.startsWith("acode-cua.")
  );
}

// command 与 args 共用同一包规格判定（shared 中 isACodeCuaMcpCommand 与 isACodeCuaMcpPackageArg
// 实现体相同）。入参按 unknown 对待：非 string 一律不命中、不抛。
function isACodeCuaMcpToken(value) {
  return typeof value === "string" && (matchesACodeCuaSpec(value) || matchesACodeCuaSpec(acodeCuaArgLeaf(value)));
}

function hasOfficialCuaPluginIdEnv(env) {
  // 不变量 2 补注字段 4：env 是 Array<{name,value}>（mcp.ts:171，非 Record）。官方 plugin server
  // 走 __acode-plugin-host，command/args 都不含 acode-cua 字样，只有 _plugin id env 可识别
  // （mcp-config.ts:174-182）。value 比对对齐 mcp-config.ts:179 的 trim().toLowerCase()。
  if (!Array.isArray(env)) return false; // Record/畸形形状：不抛、env 维度不命中（入参按 unknown 对待）
  return env.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      entry.name === CUA_PLUGIN_ID_ENV_NAME &&
      typeof entry.value === "string" &&
      entry.value.trim().toLowerCase() === CUA_OFFICIAL_PLUGIN_ID,
  );
}

export function isPotentialACodeCuaAgentMcpServer(server) {
  // 消费点 node.ts:789：resolver 跨过 Helper start/health await 后置 stale-terminal 时，
  // 从 servers 列表过滤旧代际 CUA candidate，防止把旧 socket/token 交给晚到 Agent。
  // 漏判 → Agent 回退成 Python 自持 macOS TCC（违反 product broker 边界），故 fail-closed
  // 方向 = 宁可过判不漏判（不变量 1 栏①）。入参按 unknown 对待（broker-server.d.ts:211）：
  // null/非对象/字段缺失一律 false、不抛。判别面与 mcp-config.ts:168-186 isACodeCuaStdioServer
  // 对齐（不变量 2 补注「谓词须匹配的字段 1-4」），任一维度命中即判定。
  if (server === null || typeof server !== "object") return false;
  // ① name 维度：ACODE_CUA_OFFICIAL_PLUGIN_ID 的用户露出名（mcp.ts:10-13；node.ts:1073、
  // mcp-config.ts:173 同字面量判别）。字段 1 未限定变体——http/sse 同名 server 也过判
  // （过判只是在 stale 窗口多滤一个 server，漏判才是安全违规）。
  if (server.name === CUA_AGENT_SERVER_NAME) return true;
  // ②③ stdio 变体的 command / args 任一元素命中 acode-cua 包规格（字段 2/3）。
  // http/sse 变体无 command/args，typeof/Array.isArray 守卫使其自然跳过、不抛。
  if (isACodeCuaMcpToken(server.command)) return true;
  if (Array.isArray(server.args) && server.args.some((arg) => isACodeCuaMcpToken(arg))) return true;
  // ④ env 数组扫描找官方 plugin id（字段 4）。
  return hasOfficialCuaPluginIdEnv(server.env);
}

export function isScreenCaptureProbeSuccess(_probe) {
  return false;
}

// fail-closed admission marker（wire spec / §7.7 回退门槛的强制机制）。host-keyed，用 WeakSet：
// 随 host 对象 GC、不泄漏、不同 host 互不串扰。占位曾使 has 恒 false，导致 node.ts 的
// :1102/:1115/:1142/:1163/:1179/:1197/:1221 七处 BROKER_UNAVAILABLE 早退门全部失效——
// 「Helper 未就绪时 fail-closed 到 broker_unavailable、绝不下发 stale/空凭据」这条回退门槛整体失效。
const agentEnvUnavailableHosts = new WeakSet();

export function markCuaProductHelperAgentEnvUnavailable(host) {
  // node.ts:583/:586（startup 失败且有 Agent 持预留/transport tuple）、:1231（env 构建 catch）调用。
  if (host && typeof host === "object") agentEnvUnavailableHosts.add(host);
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  // node.ts 七处 admission 门控读此标志：为真时返回 BROKER_UNAVAILABLE env 而非 live 凭据元组。
  return Boolean(host && typeof host === "object" && agentEnvUnavailableHosts.has(host));
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  // node.ts:1110（有界健康短探针成功后）调用：Helper 已恢复，解除后续 spawn 的 fail-closed。
  if (host && typeof host === "object") agentEnvUnavailableHosts.delete(host);
}

export async function reapOrphanedHelpers(_options) {}

export async function requestHelperAccessibilityPermissionViaLaunchServices(_options) {
  return { ok: false, reason: UNAVAILABLE };
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(_options) {
  return { ok: false, reason: UNAVAILABLE };
}
