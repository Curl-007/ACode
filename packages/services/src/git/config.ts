import { join } from "node:path";

export const DEFAULT_GIT_DISCOVERY_TIMEOUT_MS = 3_000;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 15_000;
// `git push` 可能会被仓库的 pre-push hook 阻塞较长时间（例如执行 `pnpm test`）。
// 继续沿用普通 Git 命令的 15s 超时会把显式 push 误判成失败，因此单独放宽 push 超时。
export const DEFAULT_GIT_PUSH_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_GIT_DIFF_TIMEOUT_MS = 20_000;
export const DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024;
// pre-push hook 可能会输出完整测试日志；继续沿用普通 Git 命令的 512KB 上限，
// 会在真正 push 完成前因为日志过多被截断终止。这里仅给 push 单独放宽输出配额。
export const DEFAULT_GIT_PUSH_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GIT_DIFF_BYTES = 1024 * 1024;
export const GIT_UNTRACKED_STAT_MAX_BYTES = 1024 * 1024;
export const GIT_UNTRACKED_STAT_CHUNK_BYTES = 64 * 1024;
export const GIT_UNTRACKED_STAT_CONCURRENCY = 4;

const WINDOWS_GIT_BINARY_CANDIDATES = [
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "cmd",
    "git.exe",
  ),
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "bin",
    "git.exe",
  ),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "cmd", "git.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "git.exe"),
];
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

/**
 * 网络传输协议白名单（GIT_ALLOW_PROTOCOL）。
 * services 漏斗唯一的网络命令是用户显式 push（gitCliRepo.push），远端可能是
 * https 或 ssh；checkpoint/临时仓库走本地 file 语义。封死 ext（remote-helper
 * 任意命令执行，RCE 主向量）、git（无认证守护）、fd、http（明文凭据）。
 * 判定依据见 specs/git-invocation-hardening.md R4。
 */
export const GIT_ALLOW_PROTOCOL_WHITELIST = "file:https:ssh";

/**
 * env 层硬化矩阵：进程级变量天然继承给 git 及其子进程（ssh/remote-helper）。
 * - GIT_TERMINAL_PROMPT=0：无人值守关键项——凭据/确认提示不再挂死等 stdin，立即失败；
 * - GIT_ASKPASS=""：遮蔽宿主环境（编辑器/SSH 会话）注入的 GUI askpass；
 *   git 对空值按未设置处理，随后落到 config 层 core.askPass=（同样清空），双路径全封；
 * - GIT_NO_LAZY_FETCH=1：partial clone 仓库的只读命令缺对象时直接报错，不懒取打网络；
 * - GIT_ALLOW_PROTOCOL：见白名单常量注释。
 * credential.helper 有意不清空：清空会连"从系统凭据库静默取已存凭据"一起废掉，
 * 显式 push（https 远端）将全体认证失败——见 spec R3 偏差登记。
 */
export const GIT_HARDENING_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: GIT_ALLOW_PROTOCOL_WHITELIST,
} as const;

/**
 * hooksPath 专用空设备路径：win32 用设备命名空间形式 `\\.\NUL`（与还原工程证据一致），
 * POSIX 用 /dev/null。hooksPath 被 git 拼接为 `<hooksPath>/<hook-name>`，指向空设备后
 * 任何 hook 文件都打不开，等效整体停用仓库 hooks——防止服务进程执行仓库内任意代码。
 * 与既有 getGitNullDevicePath()（`git diff --no-index` 的文件参数用 "NUL" 形态）分设，
 * 两者语义不同，禁止混用。
 */
export function getGitHooksNullDevicePath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
}

/**
 * config 层硬化矩阵（`-c` 等价物），经 GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n> 注入
 * （git ≥ 2.31 命令行作用域，优先级压过 system/global/local）。
 * 走 env 而非改写各调用点 args：漏斗只有 getGitCommandEnv 一处（providers/repo 层
 * 不在所有权内），且继承的 GIT_CONFIG_* 已先被剥离，用户环境无法覆盖本矩阵。
 * 键值语义见 specs/git-invocation-hardening.md R2。
 */
export function getGitHardenedConfigEntries(
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<readonly [string, string]> {
  return [
    // 废仓库 hooks（pre-commit/pre-push/post-checkout 不再从服务进程执行任意代码）。
    ["core.hooksPath", getGitHooksNullDevicePath(platform)],
    // 不吃仓库配置的 fsmonitor 守护，防后台进程与仓库写。
    ["core.fsmonitor", ""],
    // askpass 双保险的 config 层（与 GIT_ASKPASS="" 配对）。
    ["core.askPass", ""],
    // 不吃用户全局 gitignore/attributes：check-ignore、ls-files --exclude-standard
    // 只反映仓库级规则，行为可复现（与 .acodeignore 的仓库级语义对齐，见 spec R6）。
    ["core.excludesFile", ""],
    ["core.attributesFile", ""],
    // 只读命令不触发 auto-gc / 后台维护 / commit-graph 写（防服务进程重写仓库、长时间持锁）。
    // 任务清单的 commitGraph.write=false 按真实 git 键名落地为下面两键。
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["core.commitGraph", "false"],
    ["gc.writeCommitGraph", "false"],
    // log/commit graph 不自动 spawn gpg 验签（防挂死）。
    ["log.showSignature", "false"],
    // ref 更新不写 reflog：服务进程少写仓库；用户终端操作不受影响。
    ["core.logAllRefUpdates", "false"],
    // 仓库配置 submodule.recurse=true 时，status/switch 等不得自动递归子模块（防顺带网络 fetch）。
    ["submodule.recurse", "false"],
    // git-lfs 二进制缺失时降级为原始内容而非整条命令失败。
    // filter.lfs.clean/smudge/process 有意不清空：ACode 漏斗承载 switch/commit，
    // 清空会把 LFS 仓库的工作区/入库语义写坏（见 spec R2 判定）。
    ["filter.lfs.required", "false"],
  ];
}

export function getGitBinaryCandidates(): string[] {
  const candidates = [process.env.ACODE_GIT_BINARY?.trim(), "git"];
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GIT_BINARY_CANDIDATES);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

export function getGitCommandEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // pre-push hook 会向子进程注入当前仓库的 GIT_DIR/GIT_WORK_TREE 等 local env。
  // 如果这里原样透传，Git 服务命令会“串仓”到 hook 所在仓库，临时仓库/远端仓库操作都会被污染。
  // 统一先清理 local env，再叠加 ACode 约束变量，保证命令只依赖显式 cwd。
  for (const variableName of GIT_LOCAL_ENV_VARS) {
    delete env[variableName];
  }
  // GIT_CONFIG_COUNT/GIT_CONFIG_PARAMETERS 已在上面剥离，但编号键（KEY_<n>/VALUE_<n>）
  // 也可能被宿主环境注入；硬化矩阵自己使用同一编号空间，先删净再写，
  // 保证继承值既不能覆盖矩阵、也不能借残留编号夹带配置。
  for (const variableName of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(variableName)) {
      delete env[variableName];
    }
  }

  const hardenedConfigEntries = getGitHardenedConfigEntries();
  const hardenedConfigEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: String(hardenedConfigEntries.length),
  };
  hardenedConfigEntries.forEach(([key, value], index) => {
    hardenedConfigEnv[`GIT_CONFIG_KEY_${index}`] = key;
    hardenedConfigEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return {
    ...env,
    ...hardenedConfigEnv,
    GIT_OPTIONAL_LOCKS: "0",
    ...GIT_HARDENING_ENV,
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    LC_ALL: "C",
    LANG: "C",
  };
}

export function getGitNullDevicePath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeGitPath(path)
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : ".";
}

export function isPathInWorkspaceScope(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): boolean {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return true;
  }

  return (
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

export function toWorkspaceRelativeGitPath(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): string {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return normalizedPath;
  }

  if (normalizedPath === normalizedWorkspace) {
    return ".";
  }

  return normalizedPath.startsWith(`${normalizedWorkspace}/`)
    ? normalizedPath.slice(normalizedWorkspace.length + 1)
    : normalizedPath;
}
