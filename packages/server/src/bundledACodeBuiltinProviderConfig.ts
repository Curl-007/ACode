import { materializeACodeBuiltinProviderConfig } from "@acode/services/node";

declare const __ACODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledACodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 ACode Built-in Provider Config。 */
export function readBundledACodeBuiltinProviderConfig(): string {
  if (typeof __ACODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 ACode Built-in Provider Config");
  }
  return __ACODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 ACode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledACodeBuiltinProviderConfig(
  options: MaterializeBundledACodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeACodeBuiltinProviderConfig(options);
}
