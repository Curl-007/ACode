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

export function isPotentialACodeCuaAgentMcpServer(_server) {
  return false;
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
