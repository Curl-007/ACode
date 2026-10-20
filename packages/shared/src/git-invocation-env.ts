/**
 * CLI 自有 git 调用硬化漏斗（apps/acode-cli/specs/git-invocation-hardening.md，
 * 含 R3 修订与 R4 硬化预设增量——镜像 packages/services/specs/git-hardening-presets.md）。
 *
 * 语义与 packages/services/src/git/config.ts 对齐（services 侧同名 spec R1–R7 +
 * 预设增量 P1–P5，含两条有据偏差照搬：credential.helper 不清空、LFS 只取
 * filter.lfs.required=false），消费面是 acode-cli 五个包（core/adapters/
 * cli-workflow/cli/bootstrap）的 git spawn 点——它们不走 services 漏斗。落点
 * shared 而非任务预案的 core/adapters：两者是兄弟包互不可达且 package.json/core
 * barrel 冻结，shared 是全部消费方唯一已声明的公共依赖（spec R1 裁决）。两份实现、
 * 一份语义：键闭集由两侧各自测试守护，services/* 为冻结面不做反向抽取；防再分叉
 * 纪律与允许差异集（闭集）见 spec R5——任何一侧的硬化增量必须同批落另一侧或在其
 * spec 登记接线需求。
 *
 * 禁止任何 CLI git spawn 点手写硬化单键（含 GIT_ALLOW_PROTOCOL）——矩阵只写在本
 * 文件，协议放行的唯一通道是 options.allowedProtocols。
 */
import { join } from "node:path";

/**
 * git 传输协议闭集（与 services GitProtocolName 同款七项，spec R3 修订/R4）。
 * 矩阵对未显式放行的协议逐个 `protocol.<p>.allow=never`，
 * 另有 `protocol.allow=never` 兜底未来新增协议名。
 */
export type CliGitProtocolName = "ext" | "fd" | "file" | "git" | "http" | "https" | "ssh";

export const CLI_GIT_PROTOCOL_NAMES: readonly CliGitProtocolName[] = [
  "ext",
  "fd",
  "file",
  "git",
  "ssh",
  "http",
  "https",
];

/**
 * 按调用点协议放行选项（spec R3 修订）：默认（缺省/空数组）= 拒绝一切传输；
 * 远端命令调用点（当前唯一：marketplace execGitCommand）显式声明最小集。
 */
export interface CliGitEnvOptions {
  allowedProtocols?: readonly CliGitProtocolName[];
}

/**
 * 唯一网络面调用点（marketplace clone/sparse-checkout/checkout，消费点 #2）的
 * 显式白名单：内容与已废除的全局 CLI_GIT_ALLOW_PROTOCOL_WHITELIST 等值，但范围
 * 收窄到该调用点——其余 7 个消费点全部是本地命令，默认全拒（spec R3 修订/R5）。
 * - http：marketplace 级源解析显式接受 http:// 前缀的 *.git 且不经过插件级
 *   host/protocol 门，封掉会破坏存量安装面（CLI 面与 services 的唯一协议差异，
 *   登记于 spec R5 允许差异集）；
 * - https：GitHub archive 失败回退 clone、https://...git 源、owner/repo 简写归一；
 * - ssh：scp-like git@host:path 与插件级门放行的 ssh:；
 * - file：本地仓库/临时仓语义与测试 fixture。
 * ext（remote-helper 任意命令执行，RCE 主向量）、git（无认证守护）、fd 在任何
 * 调用点都不放行；git+https/git+ssh 非 git 原生 transport，不纳入。
 */
export const CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST: readonly CliGitProtocolName[] = [
  "file",
  "http",
  "https",
  "ssh",
];

/**
 * rename 检测上限（证据同款 7000，镜像 services P4）：钉死上界防仓库/用户配置设
 * 无上限值，让自动 status/diff 路径（git-snapshot、world-read、overnight 采集）
 * 陷入 O(n²) 无界 CPU 消耗（DoS 面）。
 */
const CLI_GIT_RENAME_LIMIT = 7000;

/**
 * alias 哨兵名（镜像 services P4）：`denied_by_acode::<url>` 形态 URL 会解析到
 * `alias.remote-denied_by_acode.command` 定义的 remote-helper——矩阵把该键置空，
 * 继承/仓库配置即使定义了同名 alias 也不执行（command scope 压过一切配置层）。
 */
const CLI_GIT_ALIAS_SENTINEL = "denied_by_acode";

/**
 * GIT_GRAFT_FILE 专用的稳定不存在路径（镜像 services P3）：可执行文件（execPath
 * 是常规文件）的子路径必然打开失败（ENOTDIR/ENOENT），无法被攻击者预先创建；git
 * 读不到任何 grafts，封死 `.git/info/grafts` 历史伪冒面（git 2.46 实测 grafts 仍
 * 被读取，仅 deprecation hint）。execPath 缺失的嵌入形态退化为空设备子路径，同样
 * 必然不存在。
 */
export function getCliGitGraftNullFilePath(): string {
  const base = process.execPath || getCliGitHooksNullDevicePath();
  return join(base, "no-grafts");
}

/**
 * env 层硬化矩阵：进程级变量天然继承给 git 及其子进程（ssh/remote-helper）。
 * credential.helper 有意不清空（会连"从系统凭据库静默取已存凭据"一起废掉，
 * marketplace https clone 将全体认证失败——同 services spec R3 偏差登记）。
 * GIT_ALLOW_PROTOCOL 不在此静态矩阵：它是 per-call 计算值（默认空串=全拒，
 * marketplace 调用点显式放行），在漏斗尾部统一写入（spec R3 修订）。
 */
export const CLI_GIT_HARDENING_ENV = {
  // 无人值守关键项：凭据/确认提示立即失败，不挂死等 stdin。
  GIT_TERMINAL_PROMPT: "0",
  // 遮蔽宿主环境（编辑器/SSH 会话）注入的 GUI askpass；git 对空值按未设置处理，
  // 随后落到 config 层 core.askPass=（同样清空），两条 askpass 解析路径全封。
  GIT_ASKPASS: "",
  // partial clone（promisor）仓库缺对象时直接报错，不懒取打网络。
  GIT_NO_LAZY_FETCH: "1",
  // 只读命令不拿可选锁（与 services 既有语义同款）。
  GIT_OPTIONAL_LOCKS: "0",
  // replace-ref/graft 完整性三件套的 env 两件套（第三件是 config 层
  // core.useReplaceRefs=false）：CLI 读到的对象必须是仓库真实存储内容，
  // git-snapshot 上下文/world-read git.log/git.diff 不受伪冒影响（spec R4/P3）。
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: getCliGitGraftNullFilePath(),
} as const;

/**
 * GIT local env 剥离清单（防串仓，与 services config.ts 的 GIT_LOCAL_ENV_VARS 同款）。
 * GIT_CONFIG_GLOBAL/SYSTEM：防宿主环境把全局/系统配置重定向到攻击者文件（等效
 * 任意 config 注入，spec R4/P2）；GIT_GRAFT_FILE/GIT_NO_REPLACE_OBJECTS 先剥后写，
 * 继承值不能弱化完整性三件套。GIT_SSH/GIT_SSH_COMMAND 有意不剥离（用户自定义 ssh
 * 是 marketplace 私有仓 clone 的合法工作流；能设它的敌意父环境同样能改 PATH，
 * 剥离不构成实质边界——同 services P2 残余登记）。
 */
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
] as const;

/** 继承的矩阵编号键：先删净再写，用户环境不能覆盖矩阵、不能借残留编号夹带配置。 */
const GIT_CONFIG_NUMBERED_KEY_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/u;

/**
 * hooksPath 专用空设备路径：win32 用设备命名空间形式 `\\.\NUL`，POSIX 用 /dev/null。
 * git 把 hooksPath 拼接为 `<hooksPath>/<hook-name>`，指向空设备后任何 hook 文件都
 * 打不开，等效整体停用仓库 hooks——防 CLI 进程执行仓库内任意代码（同 services R2）。
 */
export function getCliGitHooksNullDevicePath(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
}

/**
 * config 层硬化矩阵（`-c` 等价物），基础键值 = services spec R2 表逐项同款，
 * 增量键 = services git-hardening-presets.md P3/P4 逐项同款（CLI 面镜像，spec R4）；
 * 经 GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n> 注入（git ≥ 2.31 命令行作用域，优先级
 * 压过 system/global/local）。git < 2.31 时 config 层静默失效、env 层仍生效
 * （登记的残余，同 services R1/P5）。
 * 协议条目排矩阵尾部：先全局 never + 未放行协议逐个 never，再放行协议 always，
 * 同一键不重复出现；两层（env GIT_ALLOW_PROTOCOL / config 协议矩阵）永远由同一
 * allowedProtocols 参数同源构建（git 2.46 实测裁决见 services presets spec P1）。
 */
export function getCliGitHardenedConfigEntries(
  platform: NodeJS.Platform = process.platform,
  allowedProtocols: readonly CliGitProtocolName[] = [],
): ReadonlyArray<readonly [string, string]> {
  const allowed = new Set<CliGitProtocolName>(allowedProtocols);
  return [
    // 废仓库 hooks（pre-commit/post-checkout/post-merge 不再从 CLI 进程执行任意代码）。
    ["core.hooksPath", getCliGitHooksNullDevicePath(platform)],
    // 不吃仓库配置的 fsmonitor 守护，防后台进程与仓库写。
    ["core.fsmonitor", ""],
    // askpass 双保险的 config 层（与 GIT_ASKPASS="" 配对）。
    ["core.askPass", ""],
    // 不吃用户全局 gitignore/attributes：只读命令输出只反映仓库级规则，行为可复现。
    ["core.excludesFile", ""],
    ["core.attributesFile", ""],
    // 只读命令不触发 auto-gc / 后台维护 / commit-graph 写（防重写仓库、长时间持锁）。
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["core.commitGraph", "false"],
    ["gc.writeCommitGraph", "false"],
    // log 不自动 spawn gpg 验签（防挂死）。
    ["log.showSignature", "false"],
    // ref 更新不写 reflog：agent 侧操作少写仓库；用户终端操作不受影响。
    ["core.logAllRefUpdates", "false"],
    // 仓库配置 submodule.recurse=true 时不得自动递归子模块（防顺带网络 fetch）。
    ["submodule.recurse", "false"],
    // git-lfs 二进制缺失时降级为原始内容而非整条命令失败；clean/smudge/process
    // 有意不清空（会写坏 LFS 仓库的工作区/入库语义——同 services R2 判定）。
    ["filter.lfs.required", "false"],
    // ---- 硬化预设增量（spec R4，镜像 services P3/P4）----
    // replace-ref 完整性三件套的 config 层（env 层 GIT_NO_REPLACE_OBJECTS/
    // GIT_GRAFT_FILE 丢失时的第二道）：读取对象时忽略 refs/replace/*。
    ["core.useReplaceRefs", "false"],
    // 拒绝目录发现落入 bare 仓库（防 workspace 祖先被放置攻击者 bare .git 劫持
    // 全部命令；bare 面 UX 等价裁决见 services P4 表）。
    ["safe.bareRepository", "explicit"],
    // 子命令拼写偏差不得被 git 自动纠正执行成另一条命令。
    ["help.autocorrect", "0"],
    // 哨兵 alias 置空：`denied_by_acode::` 形态 URL 的 remote-helper 命令为空，
    // 继承/仓库配置即使定义同名 alias 也不执行任意命令。
    [`alias.remote-${CLI_GIT_ALIAS_SENTINEL}.command`, ""],
    // 不写 .git/rr-cache（rerere 副作用收口；CLI 面 merge 命令存在——消费点 #6，
    // 冲突保留现场语义不依赖 rerere，防御性关闭）。
    ["rerere.enabled", "false"],
    // 关闭目录重命名推断：确定性输出，不产生推断性冲突。
    ["merge.directoryRenames", "false"],
    // rename 检测上限钉死：防仓库配置设无上限值导致自动 status/diff 的 O(n²) CPU DoS。
    ["merge.renameLimit", String(CLI_GIT_RENAME_LIMIT)],
    ["diff.renameLimit", String(CLI_GIT_RENAME_LIMIT)],
    // index 写入单文件化，去掉 sharedindex.* 第二文件面（CLI 写 index 时会把用户
    // 的 split index 合并为单文件——git 双向兼容无损坏，行为变化登记见 spec R4）。
    ["core.splitIndex", "false"],
    // ---- 协议矩阵（spec R3 修订）：默认全拒，按调用点显式放行 ----
    // 全局兜底 never 覆盖七协议闭集之外的任何协议名（含未来 git 新增）。
    ["protocol.allow", "never"],
    ...CLI_GIT_PROTOCOL_NAMES.filter((protocol) => !allowed.has(protocol)).map(
      (protocol) => [`protocol.${protocol}.allow`, "never"] as const,
    ),
    ...CLI_GIT_PROTOCOL_NAMES.filter((protocol) => allowed.has(protocol)).map(
      (protocol) => [`protocol.${protocol}.allow`, "always"] as const,
    ),
  ];
}

/** config 层矩阵 → GIT_CONFIG_* 编号 env。 */
function buildCliHardenedConfigEnv(
  platform: NodeJS.Platform,
  allowedProtocols: readonly CliGitProtocolName[],
): Record<string, string> {
  const entries = getCliGitHardenedConfigEntries(platform, allowedProtocols);
  const configEnv: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    configEnv[`GIT_CONFIG_KEY_${index}`] = key;
    configEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return configEnv;
}

/** 输出/解析稳定性约束（与 services 漏斗尾部同款）。 */
const CLI_GIT_STABLE_OUTPUT_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  TERM: "dumb",
  LC_ALL: "C",
  LANG: "C",
} as const;

/**
 * 完整 env（直接 execFile/spawn 点用，spec R2）：以 baseEnv 为基底，先剥离 GIT
 * local env、继承的 GIT_CONFIG_* 编号键与 GIT_ALLOW_PROTOCOL（防串仓/防夹带/
 * 防协议名单透传，不依赖 spread 顺序兜底——spec R4/P2），再写入矩阵与 per-call
 * 协议值。baseEnv 可注入：marketplace 以其 buildMarketplaceGitEnv()（sanitize +
 * 网络出口 proxy/CA 恢复）为基底叠加，既有代理语义不动。
 * options.allowedProtocols：按调用点协议放行（spec R3 修订），缺省 = 拒绝一切
 * 传输（本地命令零影响；远端命令必须显式声明，当前唯一放行点是 marketplace
 * execGitCommand 经 CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST）。
 */
export function getCliGitInvocationEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options?: CliGitEnvOptions,
): Record<string, string> {
  const allowedProtocols = options?.allowedProtocols ?? [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if ((GIT_LOCAL_ENV_VARS as readonly string[]).includes(key)) continue;
    if (GIT_CONFIG_NUMBERED_KEY_PATTERN.test(key)) continue;
    // GIT_ALLOW_PROTOCOL 显式剥离：per-call 值在尾部统一写入（spec R4/P2）。
    if (key === "GIT_ALLOW_PROTOCOL") continue;
    env[key] = value;
  }
  return {
    ...env,
    ...buildCliHardenedConfigEnv(platform, allowedProtocols),
    ...CLI_GIT_HARDENING_ENV,
    ...CLI_GIT_STABLE_OUTPUT_ENV,
    // 协议面生效通道（git 2.46 实测：GIT_ALLOW_PROTOCOL 设置时严格压过 config 层，
    // 空串 = 拒绝一切传输）；config 协议矩阵是同源的"env 单独丢失"第二层防御。
    GIT_ALLOW_PROTOCOL: allowedProtocols.join(":"),
  };
}

/**
 * ExecutionPort overlay 形态（port.run({command:{mode:"argv",file:"git"}}) 点用）：
 * 走 ExecutionRequest.env 既有契约字段，buildExecutionEnv 先应用 unset 后应用 set，
 * 矩阵后写、继承值不能覆盖。返回形状与 ExecutionEnvOverlay 结构兼容（shared 不依赖
 * contracts——contracts 依赖 shared，反向导入会成环）。
 * 只叠加在 file:"git" 的命令上；world.run 任意命令面不是 git 漏斗消费方（spec R2）。
 * options.allowedProtocols 语义同 getCliGitInvocationEnv；当前三个 overlay 消费点
 * （merge/world-read/overnight 采集）全是本地命令，均走默认全拒。
 */
export function getCliGitInvocationEnvOverlay(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options?: CliGitEnvOptions,
): { set: Record<string, string>; unset: string[] } {
  const allowedProtocols = options?.allowedProtocols ?? [];
  // GIT_ALLOW_PROTOCOL 进 unset：继承的协议名单必须先删，per-call 值经 set 统一
  // 写入（buildExecutionEnv 先 unset 后 set，顺序契约与完整 env 形态的显式剥离同源）。
  const unset: string[] = [...GIT_LOCAL_ENV_VARS, "GIT_ALLOW_PROTOCOL"];
  for (const key of Object.keys(sourceEnv)) {
    // 超出矩阵长度的继承编号键也要显式清掉（set 只覆盖 0..N-1）。
    if (GIT_CONFIG_NUMBERED_KEY_PATTERN.test(key)) unset.push(key);
  }
  return {
    set: {
      ...buildCliHardenedConfigEnv(platform, allowedProtocols),
      ...CLI_GIT_HARDENING_ENV,
      ...CLI_GIT_STABLE_OUTPUT_ENV,
      GIT_ALLOW_PROTOCOL: allowedProtocols.join(":"),
    },
    unset,
  };
}
