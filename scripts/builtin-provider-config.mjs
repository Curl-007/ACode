import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ACODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ACODE_ENV !== undefined) value = parsed.ACODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ACODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const repoDefaultPath = resolve(root, "config/provider/acode-builtin.json");
  const explicitPath = env.ACODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  const sourcePath = resolve(root, explicitPath || "config/provider/acode-builtin.json");
  // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
  // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
  // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
  const { decodeACodeBuiltinRelease } = await tsImport(
    pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/acode-builtin-release.ts"))
      .href,
    import.meta.url,
  );
  const tryLoad = async (path) => {
    const content = await readFile(path, "utf8");
    decodeACodeBuiltinRelease(JSON.parse(content));
    return content;
  };
  try {
    return { environment, sourcePath, content: await tryLoad(sourcePath) };
  } catch (error) {
    // 桌面宿主会把运行时缓存路径经 ACODE_BUILTIN_PROVIDER_CONFIG_FILE 注入其 agent/构建
    // 进程；条目退役后旧缓存命中拒绝清单。与运行时 Source「回落兼容候选」同语义：显式源
    // 解码失败而仓库源可解码时告警回落，避免注入 env 挡掉会话内一切构建。
    if (explicitPath && sourcePath !== repoDefaultPath) {
      try {
        const content = await tryLoad(repoDefaultPath);
        const reason = error instanceof Error ? (error.cause ?? error).message : String(error);
        console.warn(
          `[builtin-provider-config] 显式源解码失败，回落仓库源: ${sourcePath} -> ${repoDefaultPath} (${reason})`,
        );
        return { environment, sourcePath: repoDefaultPath, content };
      } catch {
        // 仓库源同样非法：保留原始报错路径
      }
    }
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "acode-builtin.json"), config.content, "utf8");
  return config;
}
