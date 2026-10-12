import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROMPT_SNIPPET_FRAMEWORK_DEPENDENCIES,
  PROMPT_SNIPPET_FRAMEWORKS,
  type PromptSnippetFramework,
} from "@acode/shared";

/** 探测结果缓存有效期。package.json 在会话内极少变化，60s 足够避免每次开面板都读盘。 */
export const FRAMEWORK_DETECTION_CACHE_TTL_MS = 60_000;

interface FrameworkDetectionCacheEntry {
  frameworks: PromptSnippetFramework[];
  expiresAt: number;
}

const cache = new Map<string, FrameworkDetectionCacheEntry>();

export interface FrameworkDetectionResult {
  frameworks: PromptSnippetFramework[];
  /** 命中缓存时为 true，用于 debug 日志区分。 */
  cached: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDependencyNames(manifest: unknown): Set<string> {
  const names = new Set<string>();
  if (!isRecord(manifest)) {
    return names;
  }
  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = manifest[field];
    if (!isRecord(section)) {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * 依赖名 → 白名单框架。**精确键名相等**：`react` 只看 `react`，
 * 不会因为存在 `react-dom` 就把 `react` 判出来（反之亦然）。
 */
export function mapDependencyNamesToFrameworks(
  dependencyNames: ReadonlySet<string>,
): PromptSnippetFramework[] {
  const matched: PromptSnippetFramework[] = [];
  for (const framework of PROMPT_SNIPPET_FRAMEWORKS) {
    const keys = PROMPT_SNIPPET_FRAMEWORK_DEPENDENCIES[framework];
    if (keys.some((key) => dependencyNames.has(key))) {
      matched.push(framework);
    }
  }
  return matched;
}

export interface DetectFrameworksOptions {
  workspacePath: string;
  workspaceKey: string;
  /** 远程工作区里 workspacePath 是本机路径，探测不成立；调用方必须显式声明。 */
  isRemote?: boolean;
  now?: number;
}

/**
 * 读 `<workspacePath>/package.json` 的 dependencies / devDependencies 映射到白名单。
 *
 * 失败语义（§3.7）：读不到、非法 JSON、远程工作区 → 返回空数组，`framework` 分组整体
 * 不出现；不影响其他 4 组。**不抛错**，由调用方决定是否记 debug。
 */
export async function detectFrameworks(
  options: DetectFrameworksOptions,
): Promise<FrameworkDetectionResult> {
  const now = options.now ?? Date.now();
  if (options.isRemote) {
    return { frameworks: [], cached: false };
  }

  const cached = cache.get(options.workspaceKey);
  if (cached && cached.expiresAt > now) {
    return { frameworks: cached.frameworks, cached: true };
  }

  let frameworks: PromptSnippetFramework[] = [];
  try {
    const raw = await readFile(join(options.workspacePath, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    frameworks = mapDependencyNamesToFrameworks(collectDependencyNames(parsed));
  } catch {
    // 无 package.json / 非法 JSON / 权限失败都归为「探测不到」。
    frameworks = [];
  }

  cache.set(options.workspaceKey, {
    frameworks,
    expiresAt: now + FRAMEWORK_DETECTION_CACHE_TTL_MS,
  });
  return { frameworks, cached: false };
}

/** 测试与工作区切换时清缓存；生产路径不主动调用。 */
export function clearFrameworkDetectionCache(): void {
  cache.clear();
}
