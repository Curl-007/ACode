/**
 * 日志脱敏身份模型：路径/PII 占位符所需的「真名与真目录」收集
 * （specs/log-privacy-redaction.md R7/R8）。
 *
 * 核心问题：env 会撒谎或缺失（服务账户、runas、便携启动、容器注入），
 * 只信 USERPROFILE/USERNAME 会漏掉真实存在于磁盘与注册表里的用户名，
 * 导致 `C:\Users\RealName\...` 原样落日志。因此身份 = 注册表证据 ∪ env 派生，
 * 全部并入占位符替换与主机名收名。
 *
 * 本模块是纯函数：注册表原始值（字符串数组）由调用方注入
 * （桌面 main 用 reg.exe 收集，见 desktop specs/log-privacy-redaction.md R4-R5），
 * shared 不做任何 IO。
 */

/** 注册表证据（Windows）：调用方从 HKLM ProfileList / LogonUI 读到的原始值。 */
export interface WindowsProfileNameEvidence {
  /** ProfileList 的 ProfilesDirectory 值（如 C:\Users）。 */
  profilesDirectory?: string | null;
  /** 各 SID 子键的 ProfileImagePath / CentralProfile 值。 */
  profileImagePaths?: ReadonlyArray<string | null>;
  /** LogonUI LastLoggedOnDisplayName/SAMUser + SessionData LoggedOn* 值。 */
  logonNames?: ReadonlyArray<string | null>;
}

/** env 派生输入：调用方从 process.env / os 模块取好后注入。 */
export interface LogIdentityEnvInput {
  homedir?: string;
  /** os.userInfo().username（可能抛错的调用方负责兜底为空串）。 */
  userInfoUsername?: string;
  envUsername?: string;
  envUser?: string;
  envLogname?: string;
  envUserProfile?: string;
  computerName?: string;
  userDomain?: string;
  /** 平台（决定路径分隔符派生策略）。 */
  platform?: string;
}

/** 脱敏身份快照（不可变；由 createLogRedactor 消费）。 */
export interface LogRedactionIdentity {
  /** 需要替换为 <home> 的家目录前缀（含注册表 ProfileImagePath 真值）。 */
  homeDirs: readonly string[];
  /** 需要替换为 <user> / 收名进注册表的用户名（注册表真名 ∪ env 派生）。 */
  userNames: readonly string[];
  /** 机器名/域名（收名进注册表，类别 host）。 */
  hostNames: readonly string[];
  /** 用户配置文件根目录（C:\Users、/Users、/home 之外由注册表补充的形态）。 */
  profileDirs: readonly string[];
}

const TRAILING_SEPARATORS = /[\\/]+$/;

/** 剥掉路径尾部分隔符（注册表 ProfileImagePath 常带尾 `\`）。 */
export function trimPathSeparators(value: string): string {
  return value.replace(TRAILING_SEPARATORS, "");
}

/**
 * Windows 账户名后处理：剥 `.000`/`.V2` 类 profile 后缀，
 * 并剥 `域\名` / `机器名\名` 前缀（USERDOMAIN/COMPUTERNAME 大小写不敏感）。
 * 例：`CORP\alice.000` → `alice`；`DESKTOP-1\bob.V2` → `bob`。
 */
export function normalizeWindowsAccountName(
  name: string,
  domains: ReadonlyArray<string | undefined>,
): string {
  let result = name.replace(/\.\d{3}$/, "").replace(/\.V\d$/, "");
  const suffixOwner = domains.find(
    (domain) =>
      typeof domain === "string" &&
      domain.length > 0 &&
      result.toLowerCase().endsWith(`.${domain.toLowerCase()}`),
  );
  if (suffixOwner !== undefined) {
    result = result.slice(0, -(suffixOwner.length + 1));
  }
  return result;
}

function uniqueNonEmpty(values: Iterable<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function pathBasename(value: string): string {
  const normalized = trimPathSeparators(value);
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return cut === -1 ? normalized : normalized.slice(cut + 1);
}

function pathDirname(value: string): string {
  const normalized = trimPathSeparators(value);
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return cut <= 0 ? "" : normalized.slice(0, cut);
}

/**
 * 汇总注册表证据 + env 派生 → 名字/目录三组（纯函数，可单测）：
 * - names：全部候选用户名（含后缀剥离与域前缀剥离后的形态）；
 * - homes：全部候选家目录（ProfileImagePath/CentralProfile 真值）；
 * - dirs：用户配置文件根目录（ProfilesDirectory + 各家目录的父目录）。
 */
export function collectWindowsProfileNames(input: {
  evidence?: WindowsProfileNameEvidence | null;
  env?: LogIdentityEnvInput;
}): { names: string[]; homes: string[]; dirs: string[] } {
  const evidence = input.evidence ?? {};
  const env = input.env ?? {};
  const profilePaths = uniqueNonEmpty(
    (evidence.profileImagePaths ?? []).map((path) => (path ? trimPathSeparators(path) : path)),
  );
  const envUsername = env.userInfoUsername || env.envUsername || "";
  // 域/机器名既用于 `域\名` 前缀剥离，也用于 `名.域` 后缀补全剥离。
  const domains = [env.userDomain, env.computerName];
  const logonNames = uniqueNonEmpty(
    (evidence.logonNames ?? []).map((name) =>
      name ? normalizeWindowsAccountName(name.slice(name.lastIndexOf("\\") + 1), domains) : name,
    ),
  );
  const baseNames = profilePaths.map(pathBasename);
  const names = uniqueNonEmpty([
    envUsername,
    ...baseNames,
    ...baseNames.map((name) => normalizeWindowsAccountName(name, domains)),
    ...logonNames,
  ]);
  const homes = profilePaths;
  const dirs = uniqueNonEmpty([
    evidence.profilesDirectory ? trimPathSeparators(evidence.profilesDirectory) : "",
    env.envUserProfile ? trimPathSeparators(env.envUserProfile) : "",
    ...profilePaths.map(pathDirname),
    env.homedir ? pathDirname(env.homedir) : "",
  ]);
  return { names, homes, dirs };
}

/**
 * 构建脱敏身份快照：注册表证据（若有）∪ env 派生 ∪ 调用方补充名。
 * 任何输入缺失都只降级覆盖面，绝不抛异常（shared spec 失败语义）。
 */
export function buildLogRedactionIdentity(input: {
  env?: LogIdentityEnvInput;
  windowsEvidence?: WindowsProfileNameEvidence | null;
  /** 调用方补充的用户名（如远程会话已知的对端账户）。 */
  extraUserNames?: Iterable<string>;
  /** 调用方补充的主机名（os.hostname()、COMPUTERNAME 等）。 */
  extraHostNames?: Iterable<string>;
}): LogRedactionIdentity {
  const env = input.env ?? {};
  const windows = collectWindowsProfileNames({ evidence: input.windowsEvidence, env });
  const posixNames = uniqueNonEmpty([env.envUser, env.envLogname]);
  const homeDirs = uniqueNonEmpty([
    env.homedir ? trimPathSeparators(env.homedir) : "",
    env.envUserProfile ? trimPathSeparators(env.envUserProfile) : "",
    ...windows.homes,
  ]);
  const userNames = uniqueNonEmpty([
    ...windows.names,
    ...posixNames,
    ...(input.extraUserNames ?? []),
  ]);
  const hostNames = uniqueNonEmpty([
    env.computerName,
    env.userDomain,
    ...(input.extraHostNames ?? []),
  ]);
  const profileDirs = uniqueNonEmpty(windows.dirs);
  return { homeDirs, userNames, hostNames, profileDirs };
}
