/**
 * 目的驱动网络端点注册表（价值提取第二轮 T1-s4 骨架，spec 见
 * packages/desktop/specs/update-gates-endpoint-registry.md）。
 *
 * 单一登记表：每个对外用途一条 {id, toggleKey?, labelKey, endpoints[]}。一期消费点是
 * desktopNetworkPolicy.ts 的「按 host+path 查询登记用途」与未登记出站面 warn 诊断；
 * 阻断策略、三档隐私开关、被阻断请求合成 503 均为登记不做（触发条件见 spec）。
 *
 * 本模块无 IO、无网络、不 import electron：注册表是静态数据 + 纯查询，构建失败
 * （运行时异常）时按「全部未登记」fail-closed 并 warn 一次——保守方向是多报不漏报。
 */

export type NetworkEndpointOrigin = "main" | "renderer" | "subprocess";

export interface NetworkEndpointRegistrationEntry {
  /** 全等匹配（小写、去尾点）。子域通配登记为后续演进。 */
  host: string;
  /** 路径前缀匹配；与 exactPath/pathSuffix 组合见 lookup 规则。 */
  path?: string;
  /** 路径后缀匹配。 */
  pathSuffix?: string;
  /** true 时 path 为全等匹配而非前缀。 */
  exactPath?: boolean;
  origin: NetworkEndpointOrigin;
  /** i18n 键（ui locales 不由本模块维护；键清单随交付报告登记）。 */
  purposeKey: string;
  /** 登记信息：该端点是否跟随重定向（如 GitHub release 下载 302 到资产 CDN）。 */
  followRedirects?: boolean;
}

export interface NetworkEndpointUsageRegistration {
  id: string;
  /** 关联的现有官方服务开关键（登记信息，一期不消费；三档隐私开关为企业面后续）。 */
  toggleKey?: string;
  /** i18n 键。 */
  labelKey: string;
  endpoints: NetworkEndpointRegistrationEntry[];
}

export interface NetworkEndpointLookupResult {
  usageId: string;
  labelKey: string;
  purposeKey: string;
  origin: NetworkEndpointOrigin;
  toggleKey?: string;
  followRedirects?: boolean;
}

/**
 * 首批条目＝只读盘点现状，不改任何请求路径：
 * - update-feed：electron-updater GitHub provider（github-updates.md 的 Curl-007/ACode 承诺），
 *   Releases API + release 下载及其资产 CDN 重定向目标。
 * - official-plugin-cdn：官方插件市场（cdn-zcode.z.ai /zcode/official-plugin/，pluginSync 在
 *   Host 子进程消费）与随包资源 CDN（/zcode/electron/releases/，remoteCdn.ts/desktopRuntimeEnv.ts）；
 *   zcode.z.ai 平台 API 的路径→开关归属单源在 officialPlatformPolicy.resolveOfficialServiceForUrl，
 *   注册表只登记 host 级归属，不复制路径词表（避免双表漂移）。
 * - official-platform-account：api.z.ai OAuth/业务面（desktopMainIpcRemote/desktopWindowChrome
 *   导航白名单现状），origin renderer。
 * - provider-api：类别条目（endpoints 为空）——模型 provider baseUrl 是用户逐 provider 配置的
 *   动态 host，无法静态登记；请求从 Host/agent 子进程发出、不经 Electron session，
 *   webRequest 观察面天然不可见。入表仅为盘点完整性。
 */
function buildNetworkEndpointRegistry(): NetworkEndpointUsageRegistration[] {
  const registry: NetworkEndpointUsageRegistration[] = [
    {
      id: "update-feed",
      labelKey: "networkEndpoint.usage.updateFeed.label",
      endpoints: [
        {
          host: "api.github.com",
          path: "/repos/Curl-007/ACode/releases",
          origin: "main",
          purposeKey: "networkEndpoint.purpose.updateFeedCheck",
        },
        {
          host: "github.com",
          path: "/Curl-007/ACode/releases/download/",
          origin: "main",
          purposeKey: "networkEndpoint.purpose.updateDownload",
          followRedirects: true,
        },
        {
          host: "objects.githubusercontent.com",
          origin: "main",
          purposeKey: "networkEndpoint.purpose.updateDownloadRedirect",
        },
        {
          host: "release-assets.githubusercontent.com",
          origin: "main",
          purposeKey: "networkEndpoint.purpose.updateDownloadRedirect",
        },
      ],
    },
    {
      id: "official-plugin-cdn",
      toggleKey: "officialServices.marketplace",
      labelKey: "networkEndpoint.usage.officialPluginCdn.label",
      endpoints: [
        {
          host: "cdn-zcode.z.ai",
          path: "/zcode/official-plugin/",
          origin: "subprocess",
          purposeKey: "networkEndpoint.purpose.officialPluginMarketplace",
        },
        {
          host: "cdn-zcode.z.ai",
          path: "/zcode/electron/releases/",
          origin: "main",
          purposeKey: "networkEndpoint.purpose.bundledAssetCdn",
        },
        {
          host: "zcode.z.ai",
          origin: "subprocess",
          purposeKey: "networkEndpoint.purpose.officialPlatformApi",
        },
      ],
    },
    {
      id: "official-platform-account",
      toggleKey: "officialServices.account",
      labelKey: "networkEndpoint.usage.officialPlatformAccount.label",
      endpoints: [
        {
          host: "api.z.ai",
          origin: "renderer",
          purposeKey: "networkEndpoint.purpose.officialAccountOAuth",
        },
      ],
    },
    {
      id: "provider-api",
      labelKey: "networkEndpoint.usage.providerApi.label",
      endpoints: [],
    },
  ];
  for (const usage of registry) Object.freeze(usage);
  return Object.freeze(registry) as NetworkEndpointUsageRegistration[];
}

export interface NetworkEndpointRegistryLogger {
  warn: (...args: unknown[]) => void;
}

interface RegistryState {
  entries: readonly NetworkEndpointUsageRegistration[];
  loadFailed: boolean;
}

let registryState: RegistryState | null = null;
let registrySourceOverride: (() => NetworkEndpointUsageRegistration[]) | null = null;

function ensureRegistry(logger?: NetworkEndpointRegistryLogger): RegistryState {
  if (registryState) return registryState;
  try {
    const build = registrySourceOverride ?? buildNetworkEndpointRegistry;
    registryState = { entries: build(), loadFailed: false };
  } catch (error) {
    // fail-closed：注册表构建失败按「全部未登记」处理（查询恒 null，诊断恒 warn），
    // 向保守方向倾斜；warn 一次，不随每次查询重复。
    registryState = { entries: [], loadFailed: true };
    logger?.warn(
      "[network-endpoint-registry] registry build failed; treating all egress as unregistered",
      error instanceof Error ? error.message : String(error),
    );
  }
  return registryState;
}

/** 只读盘点入口（审计清单用途）；构建失败时返回空表。 */
export function getNetworkEndpointRegistry(
  logger?: NetworkEndpointRegistryLogger,
): readonly NetworkEndpointUsageRegistration[] {
  return ensureRegistry(logger).entries;
}

export function isNetworkEndpointRegistryLoadFailed(): boolean {
  return ensureRegistry().loadFailed;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/u, "");
}

function endpointMatchesPath(endpoint: NetworkEndpointRegistrationEntry, path: string): boolean {
  if (endpoint.exactPath) {
    return endpoint.path !== undefined && path === endpoint.path;
  }
  if (endpoint.pathSuffix !== undefined) {
    if (!path.endsWith(endpoint.pathSuffix)) return false;
    // pathSuffix 可与 path 前缀组合（参考实现同款形状）；未给 path 时仅后缀匹配。
    return endpoint.path === undefined || path.startsWith(endpoint.path);
  }
  if (endpoint.path !== undefined) {
    return path.startsWith(endpoint.path);
  }
  // 无路径限定＝host 级登记，任意路径命中。
  return true;
}

/**
 * 按表查询某 host+path 的登记用途；未登记返回 null。
 * 命中多条时返回第一条（表内用途互斥，顺序即优先级）。
 */
export function lookupNetworkEndpointRegistration(
  host: string,
  path: string,
  logger?: NetworkEndpointRegistryLogger,
): NetworkEndpointLookupResult | null {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return null;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  for (const usage of ensureRegistry(logger).entries) {
    for (const endpoint of usage.endpoints) {
      if (normalizeHost(endpoint.host) !== normalizedHost) continue;
      if (!endpointMatchesPath(endpoint, normalizedPath)) continue;
      return {
        usageId: usage.id,
        labelKey: usage.labelKey,
        purposeKey: endpoint.purposeKey,
        origin: endpoint.origin,
        ...(usage.toggleKey ? { toggleKey: usage.toggleKey } : {}),
        ...(endpoint.followRedirects !== undefined
          ? { followRedirects: endpoint.followRedirects }
          : {}),
      };
    }
  }
  return null;
}

/**
 * 测试专用：清空缓存的注册表状态，可选注入替身 registry source
 * （注入抛错 source 用于验证 fail-closed「全部未登记」路径）。
 */
export function resetNetworkEndpointRegistryForTest(
  source?: (() => NetworkEndpointUsageRegistration[]) | null,
): void {
  registryState = null;
  registrySourceOverride = source ?? null;
}
