/**
 * CLI 自有 git 调用硬化漏斗（apps/acode-cli/specs/git-invocation-hardening.md）。
 *
 * 语义与 packages/services/src/git/config.ts 对齐（services 侧同名 spec R1–R7，
 * 含两条有据偏差照搬：credential.helper 不清空、LFS 只取 filter.lfs.required=false），
 * 消费面是 acode-cli 五个包（core/adapters/cli-workflow/cli/bootstrap）的 git spawn 点
 * ——它们不走 services 漏斗。落点 shared 而非任务预案的 core/adapters：两者是兄弟包
 * 互不可达且 package.json/core barrel 冻结，shared 是全部消费方唯一已声明的公共
 * 依赖（spec R1 裁决）。两份实现、一份语义：键闭集由两侧各自测试守护，services/*
 * 为冻结面不做反向抽取。
 *
 * 禁止任何 CLI git spawn 点手写硬化单键——矩阵只写在本文件。
 */

/**
 * 网络传输协议白名单（GIT_ALLOW_PROTOCOL），CLI 面调查结论（spec R3）：
 * 比 services 的 file:https:ssh 多一项 http——marketplace 级源解析显式接受
 * http:// 前缀的 *.git 且不经过插件级 host/protocol 门，封掉会破坏存量安装面。
 * 封死 ext（remote-helper 任意命令执行，RCE 主向量）、git（无认证守护）、fd。
 * git+https/git+ssh 不纳入：非 git 原生 transport，git clone 本就无法处理。
 */
export const CLI_GIT_ALLOW_PROTOCOL_WHITELIST = "file:http:https:ssh";

/**
 * env 层硬化矩阵：进程级变量天然继承给 git 及其子进程（ssh/remote-helper）。
 * credential.helper 有意不清空（会连"从系统凭据库静默取已存凭据"一起废掉，
 * marketplace https clone 将全体认证失败——同 services spec R3 偏差登记）。
 */
export const CLI_GIT_HARDENING_ENV = {
  // 无人值守关键项：凭据/确认提示立即失败，不挂死等 stdin。
  GIT_TERMINAL_PROMPT: "0",
  // 遮蔽宿主环境（编辑器/SSH 会话）注入的 GUI askpass；git 对空值按未设置处理，
  // 随后落到 config 层 core.askPass=（同样清空），两条 askpass 解析路径全封。
  GIT_ASKPASS: "",
  // partial clone（promisor）仓库缺对象时直接报错，不懒取打网络。
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: CLI_GIT_ALLOW_PROTOCOL_WHITELIST,
  // 只读命令不拿可选锁（与 services 既有语义同款）。
  GIT_OPTIONAL_LOCKS: "0",
} as const;

/** GIT local env 剥离清单（防串仓，与 services config.ts 的 GIT_LOCAL_ENV_VARS 同款）。 */
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
 * config 层硬化矩阵（`-c` 等价物），键值 = services spec R2 表逐项同款；
 * 经 GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n> 注入（git ≥ 2.31 命令行作用域，优先级
 * 压过 system/global/local）。git < 2.31 时 config 层静默失效、env 层仍生效
 * （登记的残余，同 services R1）。
 */
export function getCliGitHardenedConfigEntries(
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<readonly [string, string]> {
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
  ];
}

/** config 层矩阵 → GIT_CONFIG_* 编号 env。 */
function buildCliHardenedConfigEnv(platform: NodeJS.Platform): Record<string, string> {
  const entries = getCliGitHardenedConfigEntries(platform);
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
 * local env 与继承的 GIT_CONFIG_* 编号键（防串仓/防夹带），再写入矩阵。
 * baseEnv 可注入：marketplace 以其 buildMarketplaceGitEnv()（sanitize + 网络出口
 * proxy/CA 恢复）为基底叠加，既有代理语义不动。
 */
export function getCliGitInvocationEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if ((GIT_LOCAL_ENV_VARS as readonly string[]).includes(key)) continue;
    if (GIT_CONFIG_NUMBERED_KEY_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    ...buildCliHardenedConfigEnv(platform),
    ...CLI_GIT_HARDENING_ENV,
    ...CLI_GIT_STABLE_OUTPUT_ENV,
  };
}

/**
 * ExecutionPort overlay 形态（port.run({command:{mode:"argv",file:"git"}}) 点用）：
 * 走 ExecutionRequest.env 既有契约字段，buildExecutionEnv 先应用 unset 后应用 set，
 * 矩阵后写、继承值不能覆盖。返回形状与 ExecutionEnvOverlay 结构兼容（shared 不依赖
 * contracts——contracts 依赖 shared，反向导入会成环）。
 * 只叠加在 file:"git" 的命令上；world.run 任意命令面不是 git 漏斗消费方（spec R2）。
 */
export function getCliGitInvocationEnvOverlay(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { set: Record<string, string>; unset: string[] } {
  const unset: string[] = [...GIT_LOCAL_ENV_VARS];
  for (const key of Object.keys(sourceEnv)) {
    // 超出矩阵长度的继承编号键也要显式清掉（set 只覆盖 0..N-1）。
    if (GIT_CONFIG_NUMBERED_KEY_PATTERN.test(key)) unset.push(key);
  }
  return {
    set: {
      ...buildCliHardenedConfigEnv(platform),
      ...CLI_GIT_HARDENING_ENV,
      ...CLI_GIT_STABLE_OUTPUT_ENV,
    },
    unset,
  };
}
