import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeACodeBuiltinRelease } from "@acode/provider-node";
import { logger } from "./logger.js";

export function resolveACodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)["ACODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) {
    // 加固（2026-10-30 智谱退役实测）：桌面宿主会把运行时缓存路径经该 env 注入其
    // agent/构建进程；条目退役后旧缓存命中 release 拒绝清单，若仍无条件采用显式源，
    // Bundled/Active 两候选同源同败 → provider 面整体不可用。显式源解码失败时回落
    // 应用默认 builtin 路径（与构建侧 scripts/builtin-provider-config.mjs 回落同语义）。
    try {
      decodeACodeBuiltinRelease(JSON.parse(readFileSync(explicitPath, "utf8")));
      return explicitPath;
    } catch (error) {
      logger.warn(
        `[desktop-provider-config] ACODE_BUILTIN_PROVIDER_CONFIG_FILE 显式源解码失败，回落默认 builtin 路径: ${explicitPath} (${
          error instanceof Error ? String(error.cause ?? error.message) : String(error)
        })`,
      );
    }
  }
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/acode-builtin.json",
    );
  }
  // 开发态与打包共用唯一线上配置源。
  const filename = "acode-builtin.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}
