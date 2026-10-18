// 凭据通道（specs/websearch-multi-engine.md §5）：只读 process.env，绝不写入任何
// 凭据存储。omp 引擎里依赖 authStorage broker 的取钥路径统一改接这里（env 通道）。
// adapters/src/auth 的只读复用见 spec §7 共享桶申请——当前不做跨模块入边。

/** 各引擎的 env 变量名（非 `<ID>_API_KEY` 通用形的例外）。 */
const ENGINE_ENV_KEYS: Record<string, readonly string[]> = {
  // Kimi Code 搜索服务（api.kimi.com）凭据体系独立于 Moonshot 开放平台；
  // MOONSHOT_API_KEY 在此不适用（omp issue #5762 同源问题）。
  kimi: ["KIMI_SEARCH_API_KEY", "MOONSHOT_SEARCH_API_KEY"],
  ollama: ["OLLAMA_CLOUD_API_KEY"],
};

function envKeyCandidates(id: string): readonly string[] {
  const specific = ENGINE_ENV_KEYS[id];
  if (specific) return specific;
  return [`${id.toUpperCase().replaceAll("-", "_")}_API_KEY`];
}

/** 读取引擎的 env 凭据；缺失返回 undefined。 */
export function resolveEngineApiKey(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of envKeyCandidates(id)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** SearXNG 实例端点（唯一的非 key 配置引擎）；缺失返回 undefined。 */
export function resolveSearxngEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SEARXNG_ENDPOINT?.trim() || undefined;
}

/** SearXNG 可选 bearer token。 */
export function resolveSearxngToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SEARXNG_TOKEN?.trim() || undefined;
}

/** 供错误文案引用的规范 env 变量名（第一个候选）。 */
export function envKeyNameFor(id: string): string {
  return envKeyCandidates(id)[0];
}
