export const ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ACODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const ACODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "ACODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ACODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly acodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.acodeBuiltinFilePath,
    [ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const acodeBuiltinFilePath = env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!acodeBuiltinFilePath && !personalFilePath) return null;
  if (!acodeBuiltinFilePath || !personalFilePath) {
    throw new Error("ACode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ acodeBuiltinFilePath, personalFilePath });
}
