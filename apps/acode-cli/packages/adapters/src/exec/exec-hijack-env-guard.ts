import { win32 as win32Path } from "node:path";
import {
  ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY,
  isToolEnvInheritAllowed,
  parseToolEnvInheritAllowlist,
} from "@acode/shared";

/**
 * 子进程 env 的执行劫持向量封闭键集（specs/subprocess-env-credential-allowlist.md R4）。
 *
 * 威胁模型与凭据类（sensitive-env-guard）不同：这些键的值**不含秘密**，泄密判定
 * 永远抓不到它们。它们的危害是「让子进程执行攻击者代码或降级 TLS」——
 * NODE_OPTIONS=--require=… 让每个 node 子进程先加载注入代码；BASH_ENV/ENV 让每个
 * 非交互 shell 先 source 攻击者脚本；GIT_SSH_COMMAND/GIT_ASKPASS 让模型执行的每条
 * git 命令 spawn 任意程序；NODE_TLS_REJECT_UNAUTHORIZED/GODEBUG/CA 指针把子进程的
 * TLS 校验静默摘除。继承链上的攻击者控制点（direnv/.envrc、被篡改的 shell rc、
 * 恶意父进程）都可能把这些键带进 agent 的启动环境。
 *
 * 键集来源：对照第三方产品还原件的结构性分析（仅本地、只读）自撰整理；封闭集合，
 * 扩展走代码评审 + spec 更新，不接受运行时配置扩展（防「配置面被用来解除剥离」）。
 * 大小写不敏感匹配（Windows env 语义，与 sensitive-env-guard 一致）。
 *
 * 与既有固定黑名单（shared/runtimeEnv.ts SANITIZED_RUNTIME_ENV_KEYS）的关系：
 * 固定黑名单在所有 sanitize 边界**无条件**剥离且不经 allowlist 恢复（NODE_OPTIONS/
 * ELECTRON_RUN_AS_NODE/代理/证书等）；本键集只在「不可信工具子进程」边界生效，与
 * 固定黑名单重叠的键重复列出（双保险 + 键集自文档化），其余键可经
 * ACODE_TOOL_ENV_INHERIT_ALLOWLIST 由用户在启动 env 显式放行（与凭据类同通道，
 * 子进程内无法自我放行）。
 */

/**
 * 代码注入类：解释器/运行时的启动钩子、模块搜索路径、profiler 注入点。
 * 命中即子进程在用户命令之前先执行了别的代码。
 */
export const EXEC_HIJACK_CODE_INJECTION_ENV_KEYS = [
  // Node（NODE_OPTIONS/ELECTRON_RUN_AS_NODE 亦在固定黑名单，重复列出为双保险）
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  // POSIX shell 启动钩子：非交互 bash source $BASH_ENV，sh source $ENV
  "BASH_ENV",
  "ENV",
  // glibc 注入面：GCONV_PATH 重定向字符集转换库（可载任意 .so），
  // GLIBC_TUNABLES 的 ld.so 子项可改动态链接行为
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  // Python：启动脚本/模块路径/解释器定位/用户 site 目录
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONUSERBASE",
  // JVM：三个 *_OPTIONS 都被 JVM 自动拾取，可注入 -javaagent/-agentlib
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  // Perl / Ruby：选项注入、库路径、调试钩子、gem 依赖文件
  "PERL5OPT",
  "PERL5LIB",
  "PERL5DB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "RUBYGEMS_GEMDEPS",
  // zsh 配置目录重定向（rc 文件即代码）
  "ZDOTDIR",
  // .NET：启动 hook、附加依赖、CLR profiler 族（profiler DLL 在进程内执行任意代码）
  "DOTNET_STARTUP_HOOKS",
  "DOTNET_ADDITIONAL_DEPS",
  "CORECLR_PROFILER",
  "CORECLR_PROFILER_PATH",
  "CORECLR_ENABLE_PROFILING",
  "COR_ENABLE_PROFILING",
  "COR_PROFILER",
  "COR_PROFILER_PATH",
  "COR_PROFILER_PATH_32",
  "COR_PROFILER_PATH_64",
  // Go 工具链：GOFLAGS 可带 -exec=任意程序，GOROOT/GOENV/GOTOOLCHAIN 重定向工具链，
  // GOPATH/GOBIN 影响二进制解析，模块/构建缓存路径可指向攻击者目录
  "GOFLAGS",
  "GOENV",
  "GOROOT",
  "GOTOOLCHAIN",
  "GOPATH",
  "GOBIN",
  "GOMODCACHE",
  "GOCACHE",
  // PowerShell 模块搜索路径（模块即代码）
  "PSMODULEPATH",
] as const;

/**
 * 网络重定向类：把子进程的网络出口、TLS 信任或凭据提示程序指到别处。
 * 危害是中间人/降级/钓鱼，不是继承值本身泄漏。
 */
export const EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS = [
  // glibc 主机别名文件：改写子进程的主机名解析
  "HOSTALIASES",
  // git：SSH_COMMAND 指定 git 执行的 ssh 程序（任意命令执行放大器），
  // GIT_ASKPASS/SSH_ASKPASS 族是凭据钓鱼面（SSH_ASKPASS* 归 sensitive-env-guard
  // 凭据类所有，不在此重复）
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  // CA/证书指针族：把 TLS 信任锚指向攻击者 CA（SSL_CERT_DIR 已由固定黑名单覆盖，
  // 不重复入集）
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  // TLS 校验开关
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // proxy 族（大小写不敏感匹配天然覆盖 http_proxy 等小写形态；亦在固定黑名单）
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // Go 模块拉取面：GOPROXY 重定向下载源，GOSUMDB/GONOSUMDB/GONOSUMCHECK/
  // GOINSECURE 关闭校验和验证，GODEBUG 可降级 TLS/http2 行为
  "GOPROXY",
  "GOSUMDB",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOINSECURE",
  "GODEBUG",
] as const;

/**
 * shell 行为类：改 shell 的分词、调试展开或解释器选择。
 * SHELL 有意不在集内：resolvePosixBashShell 消费构建后 env 的 SHELL 做工具 shell
 * 选型（剥离会把用户 zsh 降级为 fallback 探测），且 bash-shell-provider 对自己的
 * 工具 shell 经 envOverlay 显式重建 SHELL——它同 PATH 一样是自有链路功能消费键
 * （spec R4 有判定依据）。
 */
export const EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS = [
  // IFS 改分词边界（`rm$IFS-rf` 类绕过），SHELLOPTS 预置 shell 选项，
  // PS4 在 xtrace 下被求值（可携带命令替换），COMSPEC 重定向 Windows 命令解释器
  "IFS",
  "SHELLOPTS",
  "PS4",
  "COMSPEC",
  // 解释器的 shell 选择族（perl/ruby 的 system() 落到攻击者解释器）
  "PERL5SHELL",
  "RUBYSHELL",
] as const;

/**
 * 前缀族（封闭清单）：无法穷举键名的注入面。
 * BASH_FUNC_ 是 bash 导出函数（shellshock 形态的函数注入）；LD_/DYLD_ 是动态
 * 链接器注入面（LD_PRELOAD/DYLD_INSERT_LIBRARIES 族）；OPENSSL_ 覆盖 OpenSSL
 * 配置/模块/引擎族（OPENSSL_CONF 可加载任意 engine）。
 */
export const EXEC_HIJACK_ENV_KEY_PREFIXES = ["BASH_FUNC_", "LD_", "DYLD_", "OPENSSL_"] as const;

/** 三类合并的全量键集（测试与文档用；分类信息以三个分表为准）。 */
export const EXEC_HIJACK_ENV_KEYS: readonly string[] = [
  ...EXEC_HIJACK_CODE_INJECTION_ENV_KEYS,
  ...EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS,
  ...EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS,
];

const EXEC_HIJACK_UPPER_KEYS: ReadonlySet<string> = new Set(
  EXEC_HIJACK_ENV_KEYS.map((key) => key.toUpperCase()),
);

/** 某 env 键是否属于执行劫持向量闭集（大小写不敏感；精确键 + 封闭前缀族）。 */
export function isExecHijackEnvKey(key: string): boolean {
  const upperKey = key.trim().toUpperCase();
  if (upperKey.length === 0) return false;
  if (EXEC_HIJACK_UPPER_KEYS.has(upperKey)) return true;
  return EXEC_HIJACK_ENV_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
}

export interface ExecHijackEnvGuardOptions {
  platform?: NodeJS.Platform;
  /**
   * 显式 allowlist（大写形态条目）。缺省从被处理 env 自身的
   * ACODE_TOOL_ENV_INHERIT_ALLOWLIST 解析——与凭据类共用同一 opt-in 通道
   * （来源只能是用户启动 env，子进程内 export 改不了 agent 的 process.env）。
   */
  inheritAllowlist?: readonly string[];
}

/**
 * 在不可信工具子进程边界剥离执行劫持闭集键（与凭据剥离同一漏斗，见 spec R4）。
 * 返回被剥离键的大写规范集（诊断/测试用）。
 *
 * win32 专属重建：COMSPEC 被剥离且缺席时，若 SystemRoot 在场则重建为规范值
 * `%SystemRoot%\System32\cmd.exe`（Windows 自身设置的恒等值）。理由：cmd-shim
 * spawn 解析与子进程内 %COMSPEC% 消费方（Node shell:true、批处理链）保持确定性
 * 绝对路径，而继承值里被篡改的 COMSPEC（指向任意 exe）被规范值取代。allowlist
 * 放行 COMSPEC 时保留用户值（重建只在键缺席时发生）。
 */
export function applyExecHijackEnvGuard(
  env: Record<string, string | undefined>,
  options: ExecHijackEnvGuardOptions = {},
): ReadonlySet<string> {
  const platform = options.platform ?? process.platform;
  const allowlist =
    options.inheritAllowlist ??
    parseToolEnvInheritAllowlist(env[ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY]);

  const stripped = new Set<string>();
  for (const key of Object.keys(env)) {
    if (!isExecHijackEnvKey(key)) continue;
    if (isToolEnvInheritAllowed(key, allowlist)) continue;
    delete env[key];
    stripped.add(key.trim().toUpperCase());
  }

  if (platform === "win32" && !hasEnvKeyIgnoreCase(env, "COMSPEC")) {
    const systemRoot = getEnvValueIgnoreCase(env, "SystemRoot");
    if (systemRoot) {
      // Windows 规范拼写是 ComSpec；本漏斗与 outputEncoding 的读取都大小写不敏感。
      env.ComSpec = win32Path.join(systemRoot, "System32", "cmd.exe");
    }
  }

  return stripped;
}

function hasEnvKeyIgnoreCase(env: Record<string, string | undefined>, key: string): boolean {
  const lowerKey = key.toLowerCase();
  return Object.keys(env).some((candidate) => candidate.toLowerCase() === lowerKey);
}

function getEnvValueIgnoreCase(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  for (const candidate of Object.keys(env)) {
    if (candidate.toLowerCase() !== lowerKey) continue;
    const value = env[candidate]?.trim();
    if (value) return value;
  }
  return undefined;
}
