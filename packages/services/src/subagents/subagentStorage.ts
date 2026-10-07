import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findACodeAgentRuntimeNodeBundle } from "../runtime-tools/providerRuntimeResolver.js";

const HOME_PREFIX = "~/";

/** bundled 内容包内的官方预置 agent 目录：<pack root>/agents，与 skills/ 平级（spec: builtin-subagent-catalog.md R1/R7）。 */
const BUNDLED_PACK_AGENTS_SEGMENTS = ["packages", "bundled-skills", "agents"] as const;

/**
 * 按与 agent spawn（acode.cjs）同一条资源定位链推导官方预置 agent 目录。
 *
 * installed 形态（resources/glm）与桌面 dev 形态（bundled-agents/<platform>/glm）都由
 * prepare-agent-node-bundle 把 `packages/bundled-skills` stage 到 acode.cjs 旁，这里复用
 * findACodeAgentRuntimeNodeBundle 的既有候选链取其同级目录；monorepo dev 直跑源码时
 * （cwd 可能是仓库根、packages/desktop 或 packages/server）退回仓库内
 * apps/acode-cli/packages/bundled-skills。找不到返回 undefined，调用方按缺省姿态降级
 * （GUI 不显示 bundled 成员、不报错、不伪造条目）。
 *
 * TODO(builtin-subagent-catalog 集成期)：@acode/bootstrap 将导出 resolveBundledContentPackRoot
 * 作为三形态 pack root 的单点解析；待 services/desktop → bootstrap 依赖方向确认合法后，
 * 用其替换这里的候选推导，避免与 CLI 侧并行维护两份候选布局。
 */
export function resolveBundledAgentsRoot(): string | undefined {
  const candidates: string[] = [];
  const nodeBundlePath = findACodeAgentRuntimeNodeBundle();
  if (nodeBundlePath) {
    candidates.push(join(dirname(nodeBundlePath), ...BUNDLED_PACK_AGENTS_SEGMENTS));
  }
  const cwd = process.cwd();
  candidates.push(resolve(cwd, "apps", "acode-cli", ...BUNDLED_PACK_AGENTS_SEGMENTS));
  candidates.push(resolve(cwd, "..", "..", "apps", "acode-cli", ...BUNDLED_PACK_AGENTS_SEGMENTS));
  // 与 providerRuntimeResolver 的启动期资源定位同款：装配是同步上下文，只做存在性探测。
  return candidates.find((candidate) => existsSync(candidate));
}

export interface SubagentStorageOptions {
  homeDir?: string;
}

export function resolveUserHomeDir(options?: SubagentStorageOptions): string {
  if (options?.homeDir && options.homeDir.trim().length > 0) {
    return options.homeDir;
  }
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export async function resolveUserSubagentRoot(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveACodeStorageRoot(options), "agents");
}

export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  return join(workspacePath, ".acode", "agents");
}

export async function resolveSubagentStateFile(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveACodeStorageRoot(options), "v2", "agents-state.json");
}

export async function resolveACodeStorageRoot(options?: SubagentStorageOptions): Promise<string> {
  const config = await readUserCliConfig(options);
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  const storageDir =
    typeof storage.dir === "string" && storage.dir.trim().length > 0
      ? storage.dir.trim()
      : "~/.acode";
  return resolveConfigPath(storageDir, options);
}

export function resolveConfigPath(path: string, options?: SubagentStorageOptions): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(options), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

async function readUserCliConfig(
  options?: SubagentStorageOptions,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(
      join(resolveUserHomeDir(options), ".acode", "cli", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
