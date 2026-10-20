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
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

/**
 * git 传输协议闭集（证据同款七项，见 specs/git-hardening-presets.md P1）。
 * 矩阵对未显式放行的协议逐个 `protocol.<p>.allow=never`，
 * 另有 `protocol.allow=never` 兜底未来新增协议名。
 */
export type GitProtocolName = "ext" | "fd" | "file" | "git" | "http" | "https" | "ssh";

export const GIT_PROTOCOL_NAMES: readonly GitProtocolName[] = [
  "ext",
  "fd",
  "file",
  "git",
  "ssh",
  "http",
  "https",
];

/**
 * 按调用点协议放行选项（specs/git-hardening-presets.md P1/P6）。
 * 调用点表达协议需求的唯一通道：默认（缺省/空数组）= 拒绝一切传输；
 * 远端命令调用点（当前唯一：gitCliRepo.push）显式声明最小集。
 */
export interface GitCommandEnvOptions {
  allowedProtocols?: readonly GitProtocolName[];
}

/**
 * 唯一远端命令（用户显式 push，gitCliRepo.push）的调用点白名单：
 * 远端可能是 https 或 ssh，本地 bare 远端走 file；ext（remote-helper
 * 任意命令执行，RCE 主向量）、git（无认证守护）、fd、http（明文凭据）
 * 在任何调用点都不放行。取代既有全局 GIT_ALLOW_PROTOCOL_WHITELIST——
 * 协议放行从"全漏斗生效"收紧为"仅此调用点生效"，判定见
 * specs/git-hardening-presets.md P1（含 git 2.46 实测优先级裁决表）。
 */
export const GIT_PUSH_PROTOCOL_ALLOWLIST: readonly GitProtocolName[] = ["file", "https", "ssh"];

/**
 * rename 检测上限（证据同款 7000）：钉死上界防仓库/用户配置设无上限值，
 * 让自动 status/diff 路径陷入 O(n²) 无界 CPU 消耗（DoS 面）。
 */
const GIT_RENAME_LIMIT = 7000;

/**
 * alias 哨兵名：`denied_by_acode::<url>` 形态 URL 会解析到
 * `alias.remote-denied_by_acode.command` 定义的 remote-helper——矩阵把该键置空，
 * 继承/仓库配置即使定义了同名 alias 也不执行（command scope 压过一切配置层）。
 */
const GIT_ALIAS_SENTINEL = "denied_by_acode";

/**
 * GIT_GRAFT_FILE 专用的稳定不存在路径：可执行文件（execPath 是常规文件）的
 * 子路径必然打开失败（ENOTDIR/ENOENT），无法被攻击者预先创建；git 读不到
 * 任何 grafts，封死 `.git/info/grafts` 历史伪冒面（git 2.46 实测 grafts 仍被
 * 读取，仅 deprecation hint）。execPath 缺失的嵌入形态退化为空设备子路径，
 * 同样必然不存在。安全依据见 specs/git-hardening-presets.md P3。
 */
export function getGitGraftNullFilePath(): string {
  const base = process.execPath || getGitHooksNullDevicePath();
  return join(base, "no-grafts");
}

/**
 * env 层硬化矩阵：进程级变量天然继承给 git 及其子进程（ssh/remote-helper）。
 * - GIT_TERMINAL_PROMPT=0：无人值守关键项——凭据/确认提示不再挂死等 stdin，立即失败；
 * - GIT_ASKPASS=""：遮蔽宿主环境（编辑器/SSH 会话）注入的 GUI askpass；
 *   git 对空值按未设置处理，随后落到 config 层 core.askPass=（同样清空），双路径全封；
 * - GIT_NO_LAZY_FETCH=1：partial clone 仓库的只读命令缺对象时直接报错，不懒取打网络；
 * - GIT_NO_REPLACE_OBJECTS=1 + GIT_GRAFT_FILE：replace-ref/graft 完整性三件套的 env
 *   两件套（第三件是 config 层 core.useReplaceRefs=false）——ACode 读到的对象必须是
 *   仓库真实存储内容，不受 refs/replace 与 info/grafts 伪冒（spec P3）；
 * - GIT_ALLOW_PROTOCOL 不在此静态矩阵：它是 per-call 计算值（默认空串=全拒，
 *   push 调用点显式放行），在 getGitCommandEnv 尾部写入（spec P1）。
 * credential.helper 有意不清空：清空会连"从系统凭据库静默取已存凭据"一起废掉，
 * 显式 push（https 远端）将全体认证失败——见 git-invocation-hardening.md R3 偏差登记。
 */
export const GIT_HARDENING_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: getGitGraftNullFilePath(),
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
 * 键值语义见 specs/git-invocation-hardening.md R2 与 specs/git-hardening-presets.md
 * P3/P4（完整性与 kill switch 增量）、P1（协议矩阵，allowedProtocols 参数）。
 * 协议条目排在矩阵尾部：先全局 never + 未放行协议逐个 never，再放行协议 always，
 * 同一键不重复出现（git 2.46 实测 config 层独立生效；env 层 GIT_ALLOW_PROTOCOL
 * 设置时严格压过 config，两层永远由同一 allowedProtocols 同源构建）。
 */
export function getGitHardenedConfigEntries(
  platform: NodeJS.Platform = process.platform,
  allowedProtocols: readonly GitProtocolName[] = [],
): ReadonlyArray<readonly [string, string]> {
  const allowed = new Set<GitProtocolName>(allowedProtocols);
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
    // ---- specs/git-hardening-presets.md 增量（P3/P4）----
    // replace-ref 完整性三件套的 config 层（env 层 GIT_NO_REPLACE_OBJECTS/GIT_GRAFT_FILE
    // 丢失时的第二道）：读取对象时忽略 refs/replace/*，防恶意仓库伪冒历史内容。
    ["core.useReplaceRefs", "false"],
    // 拒绝目录发现落入 bare 仓库（防 workspace 祖先被放置攻击者 bare .git 劫持全部命令）。
    ["safe.bareRepository", "explicit"],
    // 子命令拼写偏差不得被 git 自动纠正执行成另一条命令。
    ["help.autocorrect", "0"],
    // 哨兵 alias 置空：`denied_by_acode::` 形态 URL 的 remote-helper 命令为空，
    // 继承/仓库配置即使定义同名 alias 也不执行任意命令。
    [`alias.remote-${GIT_ALIAS_SENTINEL}.command`, ""],
    // 不写 .git/rr-cache（rerere 副作用收口；ACode 面当前无 merge 命令，防御性）。
    ["rerere.enabled", "false"],
    // 关闭目录重命名推断：确定性输出，不产生推断性冲突。
    ["merge.directoryRenames", "false"],
    // rename 检测上限钉死：防仓库配置设无上限值导致自动 status/diff 的 O(n²) CPU DoS。
    ["merge.renameLimit", String(GIT_RENAME_LIMIT)],
    ["diff.renameLimit", String(GIT_RENAME_LIMIT)],
    // index 写入单文件化，去掉 sharedindex.* 第二文件面（ACode 写 index 时会把用户
    // 的 split index 合并为单文件——git 双向兼容无损坏，行为变化登记见 spec P4）。
    ["core.splitIndex", "false"],
    // ---- 协议矩阵（P1）：默认全拒，按调用点显式放行 ----
    // 全局兜底 never 覆盖七协议闭集之外的任何协议名（含未来 git 新增）。
    ["protocol.allow", "never"],
    ...GIT_PROTOCOL_NAMES.filter((protocol) => !allowed.has(protocol)).map(
      (protocol) => [`protocol.${protocol}.allow`, "never"] as const,
    ),
    ...GIT_PROTOCOL_NAMES.filter((protocol) => allowed.has(protocol)).map(
      (protocol) => [`protocol.${protocol}.allow`, "always"] as const,
    ),
  ];
}

export function getGitBinaryCandidates(): string[] {
  const candidates = [process.env.ACODE_GIT_BINARY?.trim(), "git"];
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GIT_BINARY_CANDIDATES);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * services 侧全部 git 调用的单一 env 漏斗。
 * options.allowedProtocols：按调用点协议放行（specs/git-hardening-presets.md P1），
 * 缺省 = 拒绝一切传输（本地命令零影响；远端命令必须显式声明，当前唯一放行点
 * 是 gitCliRepo.push 经 GIT_PUSH_PROTOCOL_ALLOWLIST）。
 */
export function getGitCommandEnv(options?: GitCommandEnvOptions): NodeJS.ProcessEnv {
  const allowedProtocols = options?.allowedProtocols ?? [];
  const env = {
    ...process.env,
  };

  // pre-push hook 会向子进程注入当前仓库的 GIT_DIR/GIT_WORK_TREE 等 local env。
  // 如果这里原样透传，Git 服务命令会“串仓”到 hook 所在仓库，临时仓库/远端仓库操作都会被污染。
  // 统一先清理 local env，再叠加 ACode 约束变量，保证命令只依赖显式 cwd。
  // 清单含 GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM：防宿主环境把全局/系统配置重定向到
  // 攻击者文件（等效任意 config 注入，spec P2）；GIT_GRAFT_FILE/GIT_NO_REPLACE_OBJECTS
  // 先剥后写，继承值不能弱化完整性三件套（spec P3）。
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
  // GIT_ALLOW_PROTOCOL 显式剥离：per-call 值在尾部统一写入，不依赖 spread 顺序兜底
  // （防未来重排让继承的放行名单透传，spec P2）。
  delete env["GIT_ALLOW_PROTOCOL"];

  const hardenedConfigEntries = getGitHardenedConfigEntries(process.platform, allowedProtocols);
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
    // 协议面生效通道（git 2.46 实测：GIT_ALLOW_PROTOCOL 设置时严格压过 config 层，
    // 空串 = 拒绝一切传输）；config 协议矩阵是同源的"env 单独丢失"第二层防御（spec P1）。
    GIT_ALLOW_PROTOCOL: allowedProtocols.join(":"),
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
