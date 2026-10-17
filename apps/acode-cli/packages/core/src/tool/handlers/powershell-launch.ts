// ============================================================
// PowerShell 可执行文件解析（specs/powershell-tool.md R2）
// ============================================================
// pwsh（PowerShell 7+）优先，Windows PowerShell 5.1（系统自带面）兜底；
// 解析不到返回 undefined——handler 侧 fail-closed，绝不静默换 shell。

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PowerShellEdition } from "./powershell-prompt.js";

export interface PowerShellLaunch {
  edition: PowerShellEdition;
  file: string;
}

export function resolvePowerShellLaunch(
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): PowerShellLaunch | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((path: string) => existsSync(path));

  const pwshName = platform === "win32" ? "pwsh.exe" : "pwsh";
  const pwsh = findExecutableInPath(pwshName, env, exists, platform);
  if (pwsh) return { edition: "pwsh", file: pwsh };
  if (platform !== "win32") return undefined;

  // Windows PowerShell 5.1 是系统自带面：SystemRoot 固定路径优先，PATH 兜底。
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const legacy = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(legacy)) return { edition: "windows-powershell", file: legacy };
  const fromPath = findExecutableInPath("powershell.exe", env, exists, platform);
  return fromPath ? { edition: "windows-powershell", file: fromPath } : undefined;
}

function findExecutableInPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
): string | undefined {
  // Windows env 键大小写不敏感（PATH/Path 都真实存在），两个拼写都要看。
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return undefined;
  // PATH 分隔符必须跟目标 platform 走，不能用宿主的 node:path.delimiter：platform 是
  // 可注入的纯函数参数，Linux CI 上解析 win32 PATH 会被 ":" 切碎导致解析恒空
  // （PS-04 CI 抓出的回归）。真实运行 platform 恒等于宿主，行为不变。
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const entry of pathValue.split(pathDelimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

let cachedLaunch: PowerShellLaunch | undefined;
let launchResolved = false;

/** 进程内一次性解析缓存（entry 构造期用；测试可经 createPowerShellToolEntry 注入覆盖）。 */
export function defaultPowerShellLaunch(): PowerShellLaunch | undefined {
  if (!launchResolved) {
    launchResolved = true;
    try {
      cachedLaunch = resolvePowerShellLaunch();
    } catch {
      cachedLaunch = undefined;
    }
  }
  return cachedLaunch;
}
