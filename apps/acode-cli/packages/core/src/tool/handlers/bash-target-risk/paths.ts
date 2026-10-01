// 路径分级层：目标 blast-radius 判定的 safety-critical core（J1-1）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R2/R3。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode)
// crates/jcode-command-risk/src/paths.rs，自撰 TypeScript 实现，
// 并按 spec 扩展了 Windows/macOS 保护表。
//
// 正确性在这里比其它任何地方都重要：catastrophic 档是唯一「任何论证都不解锁」的
// 保护，所以它被写成绝对而简单的形态——一组永不允许被递归摧毁的路径表，归一化后
// 比较，不依赖对周围命令语法的正确理解。
//
// 硬约束：
// - 纯词法展开，从不触文件系统（对不存在的路径也安全，且不会被恶意参数拖慢）；
// - 未解析的 `$`/反引号/`%VAR%` 绝不 normalize 掉——但 `..` 的词法消除会把变量段
//   一并弹出（`$UNKNOWN/..` 归约成 `/`），因此含未解析段的 `..` 逃逸按 catastrophic
//   处理：变量为空或多段时它就是根。宁可 deny 一个可疑形态，不放行一个删根形态。
// - 不感知符号链接（防御纵深定位，见 spec R6 已知边界）。

import {
  stricterTargetRiskLevel,
  type TargetRiskContext,
  type TargetRiskFinding,
  type TrackedCwd,
} from "./types.js";

/** 归一化词法空间里的路径：正斜杠、盘符小写、`.`/`..` 已消除。模块内部形态。 */
interface NormalizedPath {
  readonly text: string;
  /** 仍含 `$`/反引号/`%VAR%`/`~user` 等未解析段——不能证明其落点。 */
  readonly unresolved: boolean;
  readonly absolute: boolean;
  /** Windows 形态（盘符/UNC）：比较时大小写不敏感。 */
  readonly windowsStyle: boolean;
  /**
   * `..` 弹栈消费了未解析段（对抗复审 HIGH-7）：词法归约把 `$UNKNOWN/../etc` 折成
   * `etc`，仅看落点会漏掉「变量为空/多段时它就是根」。置位时整个目标直接
   * catastrophic，无论归约后形态。
   */
  readonly unresolvedDotDotEscape?: boolean;
}

// ── 保护表（代码内封闭常量，扩展走策略地板，见 spec R2） ─────────────

/** 凭据目录（home 相对，递归保护）：毁掉其中单个私钥与毁掉目录同罪。统一小写存储。 */
const CREDENTIAL_SUBPATHS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".azure",
  ".config/gcloud",
  // Windows %USERPROFILE% 等价物（与既有 sensitiveRead 熔断的封闭清单同一词汇）。
  "appdata/roaming/microsoft/windows/credentials",
  "appdata/local/microsoft/credentials",
  "appdata/local/google/chrome/user data",
  "appdata/local/microsoft/edge/user data",
  // macOS。
  "library/keychains",
];

/**
 * home 配置/文档目录（精确匹配）：整目录销毁不可接受，但其下具体文件本来就在被
 * 合法编辑/删除——`~/.config` 保护而 `~/.config/app/x.toml` 不保护。按平台惯用大小写存储。
 */
const HOME_EXACT_SUBPATHS: readonly string[] = [
  ".config",
  ".acode",
  ".local",
  ".local/share",
  "Documents",
  "Desktop",
  "Downloads",
  // Windows。
  "AppData",
  "AppData/Local",
  "AppData/Roaming",
  "AppData/LocalLow",
  // macOS 用户配置根。
  "Library",
];

/** POSIX 系统路径（精确匹配）。/home 与 /Users 刻意不递归：用户项目住在它们下面。 */
const SYSTEM_EXACT_POSIX: readonly string[] = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
  "/Applications",
  "/System",
  "/Library",
  "/Users",
  "/home",
  "/private",
  "/cores",
  "/Volumes",
];

/** 内容与目录本身同等关键的系统路径（递归保护）：删其中单个文件同样不可接受。 */
const SYSTEM_RECURSIVE_POSIX: readonly string[] = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var/lib",
  "/System",
  "/Library",
];

/** Windows：盘符根精确、Windows 目录递归、Program Files/ProgramData/Users 精确、设备命名空间递归。 */
const WINDOWS_DRIVE_ROOT_PATTERN = /^[a-z]:\/$/;
const WINDOWS_SYSTEM_RECURSIVE_PATTERN = /^[a-z]:\/windows(\/|$)/;
// `users` 分支（评审 J1-1 修复）：spec R2「刻意不递归：/home、/Users、C:/Users 只精确
// 匹配」要求盘符形态的用户配置根同样在精确保护表内——`rm -rf C:/Users` 一次删掉所有
// 用户 profile（含全部凭据目录），此前只落到 low。与 POSIX 的 /home、/Users 同一口径：
// 目录本身不可毁，其下的具体项目路径不受影响。
const WINDOWS_SYSTEM_EXACT_PATTERN =
  /^[a-z]:\/(program files|program files \(x86\)|programdata|users)\/?$/;
/** `<盘>:/` 直接受保护的子目录名（brace/glob 判定的候选集，与上面两张表同源）。 */
const WINDOWS_DRIVE_CHILD_NAMES: readonly string[] = [
  "windows",
  "users",
  "program files",
  "program files (x86)",
  "programdata",
];
const WINDOWS_DEVICE_NAMESPACE_PATTERN = /^\/\/\.(\/|$)/;
/** DOS 设备名（NUL 是安全汇，不在表内）：直写可毁磁盘/端口。 */
const DOS_DEVICE_NAME_PATTERN = /^(con|prn|aux|com[1-9]|lpt[1-9])$/;

/** temp 目录（严格内含即安全；temp 目录本身按「具体路径」处理）。 */
const TEMP_PREFIXES_POSIX: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/private/tmp",
  "/private/var/folders",
];
const WINDOWS_TEMP_PATTERN = /^([a-z]:\/users\/[^/]+\/appdata\/local\/temp)(\/|$)/;

/** 重定向/`dd of=` 的安全汇：写 bit-bucket 无破坏（显式 `rm /dev/null` 不豁免）。 */
const SAFE_WRITE_SINKS: readonly string[] = ["/dev/null", "/dev/stdout", "/dev/stderr", "nul"];

// ── 展开与归一化 ─────────────────────────────────────────────────────

export function isSafeWriteSink(raw: string): boolean {
  const normalized = normalizeConcrete(raw, {});
  const folded = normalized.text.toLowerCase();
  return SAFE_WRITE_SINKS.some((sink) => folded === sink);
}

/**
 * 把调用方注入的运行时路径（PackageScriptSource.directory、trackedCwd 基准等，
 * 来源是文件系统而非模型输入）归一化到与目标分级同一词法空间
 * （正斜杠、盘符小写、`.`/`..` 消除）。npm-scripts.ts 的选择器/source 匹配用——
 * 两边必须同一比较口径，否则 Windows 反斜杠形态的注入目录匹配不上选择器
 * （R6 边界⑥收口，spec npm-script-body-scan.md R2）。
 */
export function normalizeRuntimePath(raw: string, platform: string | undefined): string {
  return normalizeConcrete(raw, { platform }).text;
}

/**
 * 把上下文里的真实路径（cwd/workspaceRoot/homedir）归一化到同一词法空间。
 * 这些路径来自运行时而非模型输入，不含未解析段。
 */
function normalizeConcrete(raw: string, context: TargetRiskContext): NormalizedPath {
  const slashed = toSlashForm(raw.trim(), context.platform);
  const absolute = isAbsoluteForm(slashed);
  return {
    text: foldComponents(slashed),
    unresolved: false,
    absolute,
    windowsStyle: isWindowsStyleForm(slashed),
  };
}

/** `~`/`$HOME`/`${HOME}`/`%USERPROFILE%` 前缀 + 可选剩余段。 */
const HOME_PREFIX_PATTERNS: readonly RegExp[] = [
  /^~(?:$|\/(.*)$)/,
  /^\$(?:HOME|\{HOME\})(?:$|\/(.*)$)/,
  /^%USERPROFILE%(?:$|[\\/](.*)$)/i,
];

/**
 * Windows 受信环境变量引用（评审 J1-1 修复）：`%VAR%`（cmd）与 `$env:VAR`（PowerShell）。
 * 只收录**值可由 homedir/platform 纯词法推出**的变量——它们的落点是宿主事实、与命令
 * 无关，展开后才能命中保护表；其余 `%VAR%`/`$VAR` 仍按未解析处理（confirm）。
 *
 * 为什么必须展开：plan（docs/jcode-inspired-upgrade-plan.md J1-1「需补 Windows …
 * `C:\Windows` …」）要求 Windows 目录绝对保护，而 cmd/PS 拼写 `rd /s /q %WINDIR%`、
 * `Remove-Item -Recurse $env:SystemRoot` 不展开就只到 confirm（yolo 下一次反射 +
 * 25 字符论证即放行），保护形同不存在。
 *
 * 刻意**不**收录 `%TEMP%`/`%TMP%`：展开会把既有 confirm 放宽成 temp 豁免（low），
 * 属放松既有行为语义；temp 豁免只适用于字面路径拼写。
 */
const WINDOWS_ENV_PERCENT_PATTERN = /^%([^%\\/:]+)%(?:$|[\\/](.*)$)/;
const WINDOWS_ENV_POWERSHELL_PATTERN = /^\$env:([A-Za-z0-9_()]+)(?:$|[\\/](.*)$)/i;

/** 变量名（小写）→ 归一化词法空间的绝对路径；返回 undefined 表示本机推不出该值。 */
function resolveWindowsEnvVariable(
  name: string,
  home: NormalizedPath | undefined,
): string | undefined {
  // Windows 保护表本身与盘符无关（`^[a-z]:/windows` 等按任意盘符匹配），所以拿不到
  // homedir 时用 `c:` 占位不会改变分级结果，只是展示形态可能不是真实盘符。
  const drive = home?.text.match(/^([a-z]):\//)?.[1] ?? "c";
  const homeText = home?.text;
  switch (name) {
    case "windir":
    case "systemroot":
      return `${drive}:/Windows`;
    case "systemdrive":
      return `${drive}:/`;
    case "programdata":
    case "allusersprofile":
      return `${drive}:/ProgramData`;
    case "programfiles":
      return `${drive}:/Program Files`;
    case "programfiles(x86)":
      return `${drive}:/Program Files (x86)`;
    case "userprofile":
      return homeText;
    // %HOMEDRIVE%/%HOMEPATH%（对抗复审 MEDIUM-4）：与 %USERPROFILE% 完全同源
    // （home = %HOMEDRIVE%%HOMEPATH%），收录标准「值可由 homedir 纯词法推出」
    // 二者都满足，此前被排除导致 `rd /s /q %HOMEPATH%` 只到 confirm。
    // HOMEDRIVE 取盘符根形态（`c:`），HOMEPATH 取去盘符形态（`/users/z`），
    // 相邻拼接 `%HOMEDRIVE%%HOMEPATH%` 直接得 home；单独出现的 %HOMEPATH% 由
    // expandWindowsEnvReference 补上盘符（等价 home 根）。
    case "homedrive":
      return `${drive}:`;
    case "homepath":
      return homeText ? `/${homeText.replace(/^([a-z]):\//, "")}` : undefined;
    case "appdata":
      // home 推不出时不猜：AppData 是 home 相对路径，落点未知即未解析。
      return homeText ? `${homeText}/AppData/Roaming` : undefined;
    case "localappdata":
      return homeText ? `${homeText}/AppData/Local` : undefined;
    default:
      return undefined;
  }
}

/**
 * 相邻拼接的 `%VAR%%VAR%` 引用组（对抗复审 MEDIUM-4：`%HOMEDRIVE%%HOMEPATH%\.ssh`
 * 必须先展开 `%HOMEDRIVE%` 再展开 `%HOMEPATH%`，与 `%USERPROFILE%\.ssh` 同判）。
 */
const WINDOWS_ENV_PERCENT_GROUPS_PATTERN = /^((?:%[^%\\/:]+%)+)(?:$|[\\/](.*)$)/;

/** 匹配一个受信 Windows 变量引用；认不出的变量返回 undefined（保持未解析语义）。 */
function expandWindowsEnvReference(
  text: string,
  home: NormalizedPath | undefined,
): { text: string; unresolved: boolean } | undefined {
  const percentGroups = text.match(WINDOWS_ENV_PERCENT_GROUPS_PATTERN);
  const percent = percentGroups ? undefined : text.match(WINDOWS_ENV_PERCENT_PATTERN);
  const powershell = percent ? undefined : text.match(WINDOWS_ENV_POWERSHELL_PATTERN);
  if (percentGroups) {
    // 逐组展开相邻引用；HOMEDRIVE 的盘符根形态与 HOMEPATH 的 `/users/z` 形态
    // 直接拼接（`c:` + `/users/z` = `c:/users/z`），随后再拼余下路径段。
    const body = percentGroups[1]!;
    const rest = percentGroups[2] ?? "";
    const names = [...body.matchAll(/%([^%\\/:]+)%/g)].map((m) => m[1]!.toLowerCase());
    let joined = "";
    for (const name of names) {
      const resolved = resolveWindowsEnvVariable(name, home);
      if (resolved === undefined) return { text, unresolved: true };
      if (joined.length === 0) {
        joined = resolved;
        continue;
      }
      joined = joined.endsWith(":") || joined.endsWith("/")
        ? `${joined}${resolved}`
        : `${joined}/${resolved.replace(/^\//, "")}`;
    }
    // 单独的 %HOMEPATH%（首个组、结果无盘符）等价 home 根：补上盘符，
    // 否则 `/users/z` 无法与 home 保护表（`c:/users/z`）命中。
    if (names[0] === "homepath" && !/^[a-z]:/i.test(joined) && joined.startsWith("/")) {
      const drive = home?.text.match(/^([a-z]):\//)?.[1] ?? "c";
      joined = `${drive}:${joined}`;
    }
    return {
      text: rest.length > 0 ? `${joined}/${rest.replaceAll("\\", "/")}` : joined,
      unresolved: false,
    };
  }
  const match = percent ?? powershell;
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  const rest = match[2] ?? "";
  const resolved = resolveWindowsEnvVariable(name, home);
  if (resolved === undefined) {
    // 不在受信表内（或受信但本机推不出值，如无 homedir 时的 %APPDATA%）：落点未知 →
    // 未解析（confirm），与其余 `%VAR%` 同一语义。
    return { text, unresolved: true };
  }
  // 单独出现的 HOMEPATH（$env:HOMEPATH、无相邻 %HOMEDRIVE%）等价 home 根：
  // 补上盘符，否则 `/Users/Z` 无法与 home 保护表（`c:/Users/Z`）命中。
  let effective = resolved;
  if (name === "homepath" && /^\/[^/]/.test(resolved)) {
    const drive = home?.text.match(/^([a-z]):\//)?.[1] ?? "c";
    effective = `${drive}:${resolved}`;
  }
  return { text: rest.length > 0 ? `${effective}/${rest}` : effective, unresolved: false };
}

/**
 * 受信 Windows 变量展开的平台门（对抗复审 LOW-15）：非 win32 宿主上 `%WINDIR%` 是
 * 合法字面文件名，展开它会把无害路径升级成 catastrophic 绝对 deny（无申诉通道）。
 * 仅在 win32 平台、或目标本身呈 Windows 形态（盘符路径/反斜杠路径）时展开；
 * 其余平台维持未解析 → confirm 口径。
 */
function windowsEnvExpansionEnabled(text: string, platform: string | undefined): boolean {
  if (platform === "win32") return true;
  return /^[a-zA-Z]:[\\/]/.test(text) || text.includes("\\") || text.startsWith("\\\\");
}

/**
 * 展开一个（可能来自模型输入的）目标 token：已知 home 前缀用受信 homedir 展开，
 * 其余未解析段保持原样并打上 unresolved 标记。相对路径在能解析时按
 * 段级跟踪的 cwd（HIGH-1）/workingDirectory/workspaceRoot 归位。
 */
function expandTargetPath(raw: string, context: TargetRiskContext): NormalizedPath {
  let text = raw.trim();
  let unresolved = false;

  const home = context.homeDirectory?.trim()
    ? normalizeConcrete(context.homeDirectory, context)
    : undefined;

  // 已知前缀展开：只展开完整的已知变量；$HOME_BACKUP、${HOME:-x} 这类前缀相似形
  // 与 shell 参数操作符保持未解析（recall 偏向：认不出来就升级）。
  let matched = false;
  for (const pattern of HOME_PREFIX_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    matched = true;
    const rest = match[1] ?? "";
    if (home) {
      text = rest.length > 0 ? `${home.text}/${rest}` : home.text;
    } else {
      // 拿不到受信 homedir：`~` 落点未知，按未解析处理（confirm 档）。
      unresolved = true;
    }
    break;
  }
  if (!matched && /^~[^/\s]/.test(text)) {
    // `~user` 形态展开的是别的用户 home，静态不可知。
    unresolved = true;
  }
  if (!matched && !unresolved && windowsEnvExpansionEnabled(text, context.platform)) {
    // Windows 受信变量（%WINDIR%、$env:SystemRoot 等）：展开后才能命中保护表。
    // 平台门见 windowsEnvExpansionEnabled（对抗复审 LOW-15）。
    const windowsEnv = expandWindowsEnvReference(text, home);
    if (windowsEnv) {
      text = windowsEnv.text;
      unresolved = windowsEnv.unresolved;
    }
  }

  // Win32 尾点/尾空格组件规范化（对抗复审 HIGH-3）必须在 toSlashForm（内含 `\\?\`
  // 前缀剥除）之后做，且扩展命名空间来源不剥——`\\?\C:\dir.\file` 的 `dir.` 是字面名。
  const fromExtendedNamespace = /^\\\\\?\\|^\/\/\?\//.test(text);
  text = toSlashForm(text, context.platform);
  if (!fromExtendedNamespace && isWindowsStyleForm(text)) {
    text = stripWindowsComponentTrailingDotsAndSpaces(text);
  }
  const absolute = isAbsoluteForm(text);
  // 未解析标记必须在 fold 之前检测：`$UNKNOWN/..` 的 `..` 弹栈会把 `$UNKNOWN`
  // 段吃掉，fold 后再找 $ 就漏了（这正是「未解析段绝不 normalize 掉」要防的形态）。
  if (!unresolved && /[$`%]/.test(text)) unresolved = true;

  // cwd 跟踪 fail-closed（HIGH-1）：cwd 曾被动态改变且新值不可静态解析时，
  // 相对目标的落点不可知——升至少 confirm，绝不按旧基准归位假装安全。
  if (!unresolved && context.trackedCwd?.unresolved === true && !absolute) {
    unresolved = true;
  }

  // 相对且可解析：先按工作目录归位、再 fold（.. 消除必须在归位之后做，
  // 否则 `rm -rf ..` 会先被弹空成根、丢失「项目父目录」语义）。
  // 未解析段不参与归位——不可信。
  if (!unresolved && !absolute) {
    const base = scopeBase(context);
    if (base) {
      // 基准为根（`cd /` 后的相对目标）时避免拼出 `//etc`——它会被误认成 UNC
      // 形态（foldComponents 的 `//` 前缀分支），必须折叠成单斜杠根。
      const joinedBase = base.text.endsWith("/") ? base.text : `${base.text}/`;
      const joined = foldComponentsDetailed(`${joinedBase}${text}`);
      return {
        text: joined.text,
        unresolved: false,
        absolute: true,
        windowsStyle: base.windowsStyle || isWindowsStyleForm(joined.text),
        unresolvedDotDotEscape: joined.poppedUnresolved,
      };
    }
  }

  const folded = foldComponentsDetailed(text);
  return {
    text: folded.text,
    unresolved,
    absolute: absolute || WINDOWS_DRIVE_ROOT_PATTERN.test(folded.text),
    windowsStyle: isWindowsStyleForm(text) || Boolean(context.platform === "win32" && absolute),
    unresolvedDotDotEscape: folded.poppedUnresolved,
  };
}

/**
 * Win32 非 `\\?\` 命名空间会剥除组件尾部的点和空格（`C:\WINDOWS.` 打开的就是
 * `C:\Windows`，对抗复审 HIGH-3）。逐组件剥 `[. ]+$`；`.`/`..` 是相对导航组件，
 * 不剥（否则破坏 `..` 归一语义）。仅在 win32 形态目标上调用（见 expandTargetPath）。
 */
function stripWindowsComponentTrailingDotsAndSpaces(text: string): string {
  return text
    .split("/")
    .map((part) => {
      if (part.length === 0 || part === "." || part === "..") return part;
      return part.replace(/[. ]+$/, "");
    })
    .join("/");
}

// ── catastrophic 判定 ────────────────────────────────────────────────

/** 摧毁该路径是否属于「绝对不可接受」类。归一化后与封闭保护表比较。 */
function isCatastrophicTarget(path: NormalizedPath, context: TargetRiskContext): boolean {
  return (
    isRecursivelyProtectedPath(path.text, context, path.windowsStyle) ||
    isExactlyProtectedPath(path.text, context, path.windowsStyle)
  );
}

/**
 * 递归保护：该路径**及其下每一个条目**都不可毁（spec R2「其中单个文件同样不可毁」）。
 * glob 判定复用这一半——父目录递归受保护时，任何展开结果都落在保护区内，足迹「未知」
 * 不成立，必须 outright deny 而不是仅询问。
 */
function isRecursivelyProtectedPath(
  rawText: string,
  context: TargetRiskContext,
  caseInsensitiveHint = false,
): boolean {
  const fold = comparisonFold(rawText, context, caseInsensitiveHint);
  const text = fold(rawText);
  if (WINDOWS_DEVICE_NAMESPACE_PATTERN.test(text)) return true;
  if (WINDOWS_SYSTEM_RECURSIVE_PATTERN.test(text)) return true;
  if (SYSTEM_RECURSIVE_POSIX.some((entry) => isUnder(text, fold(entry)))) return true;
  const homeText = trustedHomeText(context, fold);
  if (!homeText) return false;
  // 凭据库：含其内一切。
  return CREDENTIAL_SUBPATHS.some((sub) => isUnder(text, `${homeText}/${fold(sub)}`));
}

/** 精确保护：路径本体不可毁，其下的具体文件本来就在被合法编辑/删除。 */
function isExactlyProtectedPath(
  rawText: string,
  context: TargetRiskContext,
  caseInsensitiveHint = false,
): boolean {
  const fold = comparisonFold(rawText, context, caseInsensitiveHint);
  const text = fold(rawText);
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(text)) return true;
  if (WINDOWS_SYSTEM_EXACT_PATTERN.test(text)) return true;
  if (SYSTEM_EXACT_POSIX.some((entry) => fold(entry) === text)) return true;
  if (!text.includes("/") && DOS_DEVICE_NAME_PATTERN.test(text)) return true;
  const homeText = trustedHomeText(context, fold);
  if (!homeText) return false;
  // home 本体。
  if (text === homeText) return true;
  // 配置/文档根：仅目录本身。
  return HOME_EXACT_SUBPATHS.some((sub) => text === `${homeText}/${fold(sub)}`);
}

/** 比较用大小写折叠：Windows 形态路径与 Windows/macOS 宿主按大小写不敏感比较。 */
function comparisonFold(
  text: string,
  context: TargetRiskContext,
  caseInsensitiveHint = false,
): (value: string) => string {
  const caseInsensitive =
    caseInsensitiveHint || isWindowsStyleForm(text) || isCaseInsensitiveHost(context.platform);
  return (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
}

/** 受信 homedir 在同一比较空间里的形态；拿不到时返回 undefined（home 相关规则不生效）。 */
function trustedHomeText(
  context: TargetRiskContext,
  fold: (value: string) => string,
): string | undefined {
  const home = context.homeDirectory?.trim()
    ? normalizeConcrete(context.homeDirectory, context)
    : undefined;
  return home ? fold(home.text) : undefined;
}

// ── cp/mv 目的操作数分级（对抗复核 F-6a/F-2） ─────────────────────────

/**
 * 已知不可重建的系统关键文件（对抗复核 F-6a）：覆写任一即系统不可用/提权面，
 * 与 rm 同罪。封闭常量，不收配置。判定对象是 basename（`/etc/passwd`、
 * `C:/Windows/System32/drivers/etc/hosts` 同表）。
 */
const CRITICAL_SYSTEM_FILE_NAMES: ReadonlySet<string> = new Set([
  "passwd",
  "shadow",
  "group",
  "gshadow",
  "sudoers",
  "fstab",
  "hosts",
  "crontab",
  "win.ini",
  "system.ini",
]);

/**
 * cp/mv 的**目的**操作数分级（对抗复核 F-6a）。cp 的源是读取不是破坏（敏感读由既有
 * 类 3 熔断兜底），只有目的被覆写/写入；mv 的源另行按删除语义分级（见 assess.ts）。
 * catastrophic=永久 deny 无申诉，所以对「目录放置」这类无害形态必须降级：
 * - 目的以 `/` 结尾、或本体是保护表中的目录条目（home 本体、凭据目录、~/.config 系、
 *   /etc、/usr、<盘>:/Windows、盘符根…）→ 放入一个文件不毁目录 → confirm；
 * - 凭据递归保护区内的具体路径（~/.ssh/authorized_keys）→ 保持 catastrophic
 *   （覆写私钥与栽入 authorized_keys 后门同罪）；
 * - 其它递归保护区内的具体路径：basename 命中关键系统文件清单 → catastrophic；
 *   否则「新建文件 vs 覆写未知已存在文件」静态不可分 → confirm（不静默放行）；
 * - 其余（cwd/temp/区外普通路径、未解析、glob、设备、`..` 逃逸）沿用既有分级，
 *   glob 与设备节点目的不降级。
 */
export function classifyDestinationTarget(
  raw: string,
  context: TargetRiskContext,
): TargetRiskFinding | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return finding(
      "confirm",
      "copy/move received an empty destination, so the overwritten path is unknown",
      raw,
    );
  }
  const baseline = classifyTarget(trimmed, context, { recursive: false });
  if (baseline === undefined || baseline.level !== "catastrophic") return baseline;
  // glob 与设备节点目的不降级：足迹未知/直写设备的破坏不是「无害字面形态」。
  const globProbe = stripExtendedLengthPrefix(trimmed);
  if (globProbe.includes("*") || globProbe.includes("?")) return baseline;
  const expanded = expandTargetPath(trimmed, context);
  if (isDirectoryPlacementTarget(trimmed, expanded, context)) {
    return finding(
      "confirm",
      "copy/move destination is a protected directory itself; placing a file into it does not destroy the directory, but the write lands inside a protected area",
      trimmed,
    );
  }
  if (isDeviceTarget(expanded)) return baseline;
  if (isStrictlyUnderCredentialDirectory(expanded, context)) return baseline;
  if (isStrictlyUnderSystemRecursiveDirectory(expanded, context)) {
    if (!isCriticalSystemFileName(expanded.text)) {
      return finding(
        "confirm",
        "copy/move writes into a protected system directory where whether an existing file is overwritten cannot be verified statically",
        trimmed,
      );
    }
  }
  return baseline;
}

/** 目的是否为「目录放置」形态：以斜杠结尾，或本体恰是保护表中的目录条目。 */
function isDirectoryPlacementTarget(
  raw: string,
  expanded: NormalizedPath,
  context: TargetRiskContext,
): boolean {
  if (/[/\\]$/.test(raw)) return true;
  // 未解析/`..` 逃逸形态不参与目录判定：落点不可证明即维持保守分级。
  if (expanded.unresolved || expanded.unresolvedDotDotEscape === true) return false;
  return isProtectedDirectoryEntry(expanded, context);
}

/** 路径本体是否恰为保护表中的目录条目（含 Windows 目录形态与 home 本体）。 */
function isProtectedDirectoryEntry(
  path: NormalizedPath,
  context: TargetRiskContext,
): boolean {
  const fold = comparisonFold(path.text, context, path.windowsStyle);
  const text = fold(path.text);
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(text)) return true;
  if (WINDOWS_SYSTEM_EXACT_PATTERN.test(text)) return true;
  if (/^[a-z]:\/windows\/?$/.test(text)) return true;
  if (SYSTEM_EXACT_POSIX.some((entry) => fold(entry) === text)) return true;
  if (SYSTEM_RECURSIVE_POSIX.some((entry) => fold(entry) === text)) return true;
  if (text.includes("/") && DOS_DEVICE_NAME_PATTERN.test(text)) return false;
  const homeText = trustedHomeText(context, fold);
  if (!homeText) return false;
  if (text === homeText) return true;
  if (CREDENTIAL_SUBPATHS.some((sub) => text === `${homeText}/${fold(sub)}`)) return true;
  return HOME_EXACT_SUBPATHS.some((sub) => text === `${homeText}/${fold(sub)}`);
}

/** 是否严格位于凭据递归保护区内部（目录本体已由目录放置档处理）。 */
function isStrictlyUnderCredentialDirectory(
  path: NormalizedPath,
  context: TargetRiskContext,
): boolean {
  const home = context.homeDirectory?.trim()
    ? normalizeConcrete(context.homeDirectory, context)
    : undefined;
  if (!home) return false;
  const fold = comparisonFold(path.text, context, path.windowsStyle);
  const text = fold(path.text);
  return CREDENTIAL_SUBPATHS.some((sub) => text.startsWith(`${fold(home.text)}/${fold(sub)}/`));
}

/** 是否严格位于系统递归保护区内部（POSIX 递归表与 <盘>:/Windows 子树）。 */
function isStrictlyUnderSystemRecursiveDirectory(
  path: NormalizedPath,
  context: TargetRiskContext,
): boolean {
  const fold = comparisonFold(path.text, context, path.windowsStyle);
  const text = fold(path.text);
  if (/^[a-z]:\/windows\/.+/.test(text)) return true;
  return SYSTEM_RECURSIVE_POSIX.some((entry) => text.startsWith(`${fold(entry)}/`));
}

function isCriticalSystemFileName(text: string): boolean {
  return CRITICAL_SYSTEM_FILE_NAMES.has(baseOf(text).toLowerCase());
}

// ── 目标分级 ─────────────────────────────────────────────────────────

/**
 * 对一个已提取的目标 token 分级。返回 undefined 表示无 finding（安全）。
 * 检查顺序即产品语义：glob 足迹 → 保护表 → 未解析 → 设备 → 有界白名单 → 具体路径。
 * options.recursive：破坏是否递归（rm -r、find -delete、git clean 等），
 * 只影响 cwd 内 low 与无痕的区分。
 */
export function classifyTarget(
  raw: string,
  context: TargetRiskContext,
  options: { readonly recursive: boolean },
): TargetRiskFinding | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return finding(
      "confirm",
      "destructive command received an empty target argument, which shells may resolve to an unintended path",
      raw,
    );
  }

  // brace 展开（评审 J1-1 修复）：`~/{.ssh,.gnupg}` 是 shell 会展开成多个真实目标的
  // 形态，原样进词法比较时既不匹配凭据表也不含通配符，于是 `find ~/{.ssh,.gnupg} -delete`
  // 只落到 low、yolo 下静默放行——一个 token 就绕过了「凭据库任何论证不解锁」的承诺。
  // 逐个候选分级并取最严者：任一候选命中保护表即 catastrophic。
  if (hasBraceExpansionShape(trimmed)) {
    const candidates = expandBraceAlternatives(trimmed);
    if (candidates === undefined || candidates.length === 0) {
      // 组合数超上限/形态不可静态枚举（含超限序列，对抗复审 MEDIUM-3）：不知道会
      // 碰到什么 → confirm（fail-closed）。
      return finding(
        "confirm",
        "target uses a brace expansion too large to enumerate statically, so the set of affected paths is unknown",
        trimmed,
      );
    }
    if (candidates.length > 1) {
      let strictest: TargetRiskFinding | undefined;
      for (const candidate of candidates) {
        // 候选剥引号（对抗复审 HIGH-2）：bash 的 brace 展开先于 quote removal，
        // `~/{".ssh",x}` 的展开结果与 `~/{.ssh,x}` 完全一致——不剥引号就进不了
        // 凭据保护表，一层引号把 catastrophic 洗成 low。
        const candidateFinding = classifyTarget(stripUnescapedQuotes(candidate), context, options);
        if (!candidateFinding) continue;
        strictest =
          strictest === undefined ||
          stricterTargetRiskLevel(strictest.level, candidateFinding.level) ===
            candidateFinding.level
            ? withBraceOrigin(candidateFinding, trimmed)
            : strictest;
        if (strictest.level === "catastrophic") break;
      }
      return strictest;
    }
  }

  const expanded = expandTargetPath(trimmed, context);
  const displayTarget = displayForm(trimmed, expanded);
  // `..` 弹栈消费未解析段（对抗复审 HIGH-7）：词法归约会把 `$UNKNOWN/../etc` 折成
  // `etc`、`$UNKNOWN/../..` 折成根——只看落点无法排除「变量为空/多段时可达根」。
  // spec R3：含未解析段的 `..` 逃逸判 catastrophic，优先于一切后续分级。
  if (expanded.unresolvedDotDotEscape === true) {
    return finding(
      "catastrophic",
      "target contains `..` that consumes an unresolved segment, so it may lexically reduce to a filesystem root",
      displayTarget,
    );
  }
  // `\\?\`（及 `//?/`、`\\?\UNC\`）扩展长度前缀里的 `?` 是 Windows 命名空间标记，不是
  // glob 通配符（评审 J1-1 修复）：glob 判定必须用剥掉前缀后的文本，否则
  // `rm -rf \\?\C:\Windows` 会先落进 glob 分支被降级成 confirm（一次反射 + 论证即放行），
  // 永远走不到下面的保护表——spec R2 明确要求「`\\?\` 前缀剥掉后按其余规则判」。
  const globProbe = stripExtendedLengthPrefix(trimmed);

  // glob：足迹在执行前不可知。裸 `/*`、`~/*`、`C:\*` 即使没有任何单一解析路径
  // 受保护，效果也是清空保护目录 → catastrophic。
  if ((globProbe.includes("*") || globProbe.includes("?")) && !expanded.unresolved) {
    const parent = parentOf(expanded.text);
    const base = baseOf(expanded.text);
    if ((base === "*" || base === "**") && parent !== undefined) {
      const parentPath: NormalizedPath = { ...expanded, text: parent };
      if (isCatastrophicTarget(parentPath, context)) {
        return finding(
          "catastrophic",
          "glob would destroy the entire contents of a protected directory",
          displayTarget,
        );
      }
    }
    if (parent !== undefined && !parent.includes("*") && !parent.includes("?")) {
      // 父目录递归受保护（/etc、/usr、~/.ssh、<盘>:/Windows…）：任何展开结果都在保护区
      // 内，「足迹未知」不成立——`rm -rf /etc/pass?`、`~/.ssh/id_*` 与删掉整个目录同罪
      // （评审 J1-1 修复，spec R2「递归保护——其中单个文件同样不可毁」）。
      if (isRecursivelyProtectedPath(parent, context, expanded.windowsStyle)) {
        return finding(
          "catastrophic",
          "glob can only expand inside a recursively protected directory, so every possible target is one that must never be destroyed",
          displayTarget,
        );
      }
      // 文件名位 glob 必然命中受保护条目（`~/.*` 命中 .ssh/.gnupg/.config、`~/D*` 命中
      // Documents/Desktop/Downloads、`/b*` 命中 bin/boot）：效果等于毁掉保护条目本体。
      if (matchesProtectedChildEntry(base, parent, context, expanded.windowsStyle)) {
        return finding(
          "catastrophic",
          "glob necessarily expands onto a protected entry of its parent directory",
          displayTarget,
        );
      }
      if (isInsideScope(parent, context) || isTempPath(parent, context, false)) {
        return finding(
          "low",
          "glob is bounded to the working directory or a temp location",
          displayTarget,
        );
      }
    }
    return finding(
      "confirm",
      "target contains a glob, so the exact set of affected files is not known before execution",
      displayTarget,
    );
  }

  // 保护表命中：先于「未解析」检查——`$HOME` 展开后就是受保护路径，必须 outright
  // deny 而不是仅询问；`$UNKNOWN/..` 词法归约到 `/` 也在这里命中。
  if (isCatastrophicTarget(expanded, context)) {
    return finding(
      "catastrophic",
      "targets a protected system, credential, or home path that must never be destroyed",
      displayTarget,
    );
  }

  // 8.3 短名（对抗复审 HIGH-6）：Win32 把 8.3 别名解析到长名本体，纯词法保护表
  // 看不见 `C:\PROGRA~1` = `C:\Program Files`。封闭常量（值可静态推出且在精确保护
  // 表内）判 catastrophic；其余短名段（别名→长名的映射静态不可知）升至少 confirm。
  // 只适用 win32 形态绝对路径：相对路径里的 `file~1.txt` 是普通备份文件名。
  if (expanded.windowsStyle && expanded.absolute) {
    const shortName = hasShortNameComponent(expanded.text);
    if (shortName !== undefined) {
      if (isShortNameCatastrophicConstant(expanded.text, shortName)) {
        return finding(
          "catastrophic",
          "8.3 short name resolves to a protected system path that must never be destroyed",
          displayTarget,
        );
      }
      return finding(
        "confirm",
        "target contains a Windows 8.3 short name whose long-name resolution cannot be verified statically",
        displayTarget,
      );
    }
  }

  // UNC/网络共享（对抗复审 HIGH-5/LOW-14）：win32 形态下归一后以 `//` 开头的目标
  // （`\\server\share`、`\\?\UNC\…`、孤立 `//`）是远端共享——内容静态不可界且删除
  // 不可恢复，但不足以支撑绝对 deny（误报代价是无申诉的永久拒绝）→ confirm。
  // 设备命名空间 `//./` 与保护表命中已在上面返回。
  if (expanded.windowsStyle && expanded.text.startsWith("//")) {
    return finding(
      "confirm",
      "targets a UNC network share whose remote contents cannot be bounded or verified statically",
      displayTarget,
    );
  }

  if (expanded.unresolved) {
    return finding(
      "confirm",
      "target is computed at runtime (variable or command substitution), so its value cannot be checked in advance",
      displayTarget,
    );
  }

  if (isDeviceTarget(expanded)) {
    return finding(
      "catastrophic",
      "writes directly to a device node, which can destroy a filesystem or disk",
      displayTarget,
    );
  }

  if (isInsideScope(expanded.text, context)) {
    // 日常形态：agent 收拾自己的工作区。递归删除记 low（可见于风险日志、不打断）。
    return options.recursive
      ? finding("low", "recursive delete inside the working directory", displayTarget)
      : undefined;
  }

  if (isTempPath(expanded.text, context, true)) return undefined;

  // 工作区外的具体路径本身不是打断 agent 的理由（保护表与未知目标已在上面返回）。
  // 记 low 让操作留在风险日志里。
  return finding(
    "low",
    "destructive operation targets a concrete path outside the working directory",
    displayTarget,
  );
}

// ── 共用助手 ─────────────────────────────────────────────────────────

function finding(
  level: TargetRiskFinding["level"],
  reason: string,
  target?: string,
): TargetRiskFinding {
  return target === undefined ? { level, reason } : { level, reason, target };
}

/** brace 展开命中的 finding 保留原始 token，避免模型看不出是哪一段展开出来的。 */
function withBraceOrigin(candidate: TargetRiskFinding, origin: string): TargetRiskFinding {
  if (candidate.target === undefined) return candidate;
  return { ...candidate, target: `${origin} expands to ${candidate.target}` };
}

/**
 * bash quote removal 的最小子集（对抗复审 HIGH-2）：brace 展开先于 quote removal，
 * 候选里的未转义引号字符最终会被 shell 剥掉（`printf '%s\n' ~/{".ssh",x}` 的输出与
 * 无引号展开一致）。剥除未转义的 `"`/`'`；`\"`/`\'` 还原为字面引号。
 */
function stripUnescapedQuotes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "\\" && (next === '"' || next === "'")) {
      out += next;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") continue;
    out += char;
  }
  return out;
}

// ── 8.3 短名（对抗复审 HIGH-6） ──────────────────────────────────────

/** Win32 8.3 短名形态：`XXX~1`（基名 ≤8 字符 + `~` + 序号）。 */
const SHORT_NAME_COMPONENT_PATTERN = /^[A-Za-z0-9._ -]{1,8}~\d$/;
/** 值可静态推出且在精确保护表内的封闭常量：`PROGRA~1`/`PROGRA~2` = Program Files 系。 */
const SHORT_NAME_CATASTROPHIC_CONSTANTS: ReadonlySet<string> = new Set(["progra~1", "progra~2"]);

function hasShortNameComponent(text: string): string | undefined {
  for (const part of text.split("/")) {
    if (part.length > 0 && SHORT_NAME_COMPONENT_PATTERN.test(part)) return part;
  }
  return undefined;
}

/** 短名恰为精确保护表项本体（`c:/progra~1` → `c:/program files`）→ catastrophic。 */
function isShortNameCatastrophicConstant(text: string, shortName: string): boolean {
  if (!SHORT_NAME_CATASTROPHIC_CONSTANTS.has(shortName.toLowerCase())) return false;
  return text.replace(/^[a-z]:/i, "").toLowerCase() === `/${shortName.toLowerCase()}`;
}

// ── HIGH-1 cwd 跟踪的路径侧助手（assess.ts 消费） ────────────────────

/**
 * 会话初始 cwd 跟踪状态：取受信 workingDirectory（缺省 workspaceRoot）归一化。
 * 两者都缺时返回「未跟踪」状态（保持既有无基准行为，不额外升级）。
 */
export function initialTrackedCwd(context: TargetRiskContext): TrackedCwd {
  const base = context.workingDirectory?.trim() || context.workspaceRoot?.trim();
  if (!base) return { unresolved: false };
  return { resolved: normalizeConcrete(base, context).text, unresolved: false };
}

/**
 * 词法解析一个 cd/pushd 目标为新 cwd（对抗复审 HIGH-1）。含未解析段、
 * `..` 吃未解析段、或无法归出绝对落点（无基准时的相对形态）→ unresolved。
 */
export function resolveCwdTargetLexical(
  raw: string,
  context: TargetRiskContext,
): { resolved?: string; unresolved: boolean } {
  const expanded = expandTargetPath(raw, context);
  if (expanded.unresolved || expanded.unresolvedDotDotEscape === true) return { unresolved: true };
  if (expanded.absolute && expanded.text.length > 0) {
    return { resolved: expanded.text, unresolved: false };
  }
  return { unresolved: true };
}

/**
 * cd 目标解析的 CDPATH 口径（对抗复核 F-3）：bash 对相对目标（首段非 `.`/`..`、
 * 非绝对、非 `~` 前缀）先查 CDPATH，而命令内可见的 `CDPATH=<值>` 前缀赋值对同一
 * cd 生效——落点与「相对当前目录」不同。命中与否静态不可分，取 bash 的首选候选
 * （CDPATH 命中）符合 recall 偏向；值不可解析、含多个冒号条目或候选落点不可解析
 * → unresolved（后续相对目标 fail-closed 升至少 confirm）。
 */
export function resolveCdTargetWithCdpath(
  target: string,
  cdpath: string | undefined,
  context: TargetRiskContext,
): { resolved?: string; unresolved: boolean } {
  if (cdpath === undefined || cdpath.length === 0 || !usesCdpathLookup(target)) {
    return resolveCwdTargetLexical(target, context);
  }
  const entries = cdpath.split(":");
  // 多个冒号条目（`/a:/b`）：哪个命中取决于目标文件系统事实，静态不可分 → fail-closed。
  if (entries.length !== 1) return { unresolved: true };
  const entry = entries[0]!.replace(/\/+$/, "");
  // 空条目（`CDPATH=` 已提前返回；此处兜底）等价按当前目录解析。
  if (entry.length === 0) return resolveCwdTargetLexical(target, context);
  const separator = entry.endsWith("/") ? "" : "/";
  return resolveCwdTargetLexical(`${entry}${separator}${target}`, context);
}

/** bash 只有「相对、首段非 dot、非绝对、非 ~」的目标才走 CDPATH 查找。 */
function usesCdpathLookup(target: string): boolean {
  if (target.length === 0) return false;
  if (target.startsWith("/") || target.startsWith("~") || target.includes("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(target)) return false;
  if (target === "." || target === ".." || target.startsWith("./") || target.startsWith("../")) {
    return false;
  }
  return true;
}

/**
 * 全引号目标的「剥引号后含展开形」判定（对抗复审 LOW-16）：引号内 bash 不做
 * tilde/brace 展开，catastrophic 会变成无申诉的永久拒绝——降 confirm（不静默放行）。
 */
export function isQuotedExpansionShape(value: string): boolean {
  return value.startsWith("~") || hasBraceExpansionShape(value);
}

// ── brace 展开（纯词法、有界；从不触文件系统） ───────────────────────

/** bash 会展开的 brace 形态：顶层逗号（`{a,b}`）或序列（`{1..3}`、`{a..e}`）。 */
const BRACE_ALTERNATIVES_SHAPE = /\{[^{}]*,[^{}]*\}/;
const BRACE_SEQUENCE_SHAPE = /\{[^{}]*\.\.[^{}]*\}/;
/** 组合上限：超过就不枚举（调用方按「足迹不可静态确定」升级 confirm）。 */
const MAX_BRACE_RESULTS = 128;
const MAX_BRACE_SEQUENCE_ITEMS = 128;
const MAX_BRACE_DEPTH = 6;

/** bash 会展开的 brace 形态（LOW-16 全引号降级判定也用它）：顶层逗号或序列。 */
function hasBraceExpansionShape(text: string): boolean {
  return BRACE_ALTERNATIVES_SHAPE.test(text) || BRACE_SEQUENCE_SHAPE.test(text);
}

/**
 * 展开一个 token 里的全部 brace 组。返回 undefined 表示形态超出静态枚举上限
 * （调用方 fail-closed 升级）；返回单元素数组表示 bash 不会展开（`{}`、`{a}` 保持字面）。
 */
function expandBraceAlternatives(token: string): string[] | undefined {
  const out: string[] = [];
  const queue: { readonly text: string; readonly depth: number }[] = [{ text: token, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > MAX_BRACE_DEPTH) return undefined;
    const group = findBraceGroup(item.text);
    if (!group) {
      out.push(item.text);
      if (out.length > MAX_BRACE_RESULTS) return undefined;
      continue;
    }
    // 超限序列（对抗复审 MEDIUM-3）：`{1..200}` 是「可展开但超限」，不是
    // 「bash 不会展开的字面」——整个 token 展开失败 → confirm（fail-closed），
    // 而不是把 `{1..200}` 当目录名放行。
    if (group.overLimit) return undefined;
    const prefix = item.text.slice(0, group.start);
    const suffix = item.text.slice(group.end + 1);
    for (const alternative of group.alternatives) {
      queue.push({ text: `${prefix}${alternative}${suffix}`, depth: item.depth + 1 });
    }
    if (queue.length > MAX_BRACE_RESULTS) return undefined;
  }
  return out;
}

interface BraceGroup {
  readonly start: number;
  readonly end: number;
  readonly alternatives: readonly string[];
  /** 序列可展开但长度超上限（{1..200}）：与「字面（无展开）」必须区分。 */
  readonly overLimit?: boolean;
}

/** 第一个「bash 真会展开」的 brace 组（支持嵌套）；`{}`/`{a}` 这类字面形态跳过。 */
function findBraceGroup(text: string): BraceGroup | undefined {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const close = matchClosingBrace(text, i);
    if (close < 0) continue;
    const body = braceBodyAlternatives(text.slice(i + 1, close));
    if (body === undefined) continue;
    if (body.kind === "overLimit") {
      return { start: i, end: close, alternatives: [], overLimit: true };
    }
    if (body.items.length > 1) {
      return { start: i, end: close, alternatives: body.items };
    }
  }
  return undefined;
}

function matchClosingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * brace 体解析结果：备选列表（长度 ≥2 或经调用方判字面）、或「可展开但超限」。
 * undefined = bash 不会展开的形态（`{}`、`{a}`）。
 */
type BraceBody = { kind: "alternatives"; items: string[] } | { kind: "overLimit" };

/** brace 体 → 备选列表：顶层逗号切分优先，其次 `X..Y[..step]` 数字/字母序列。 */
function braceBodyAlternatives(body: string): BraceBody | undefined {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  if (parts.length > 1) return { kind: "alternatives", items: parts };

  const numeric = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (numeric) {
    return toAlternativesOrOverLimit(
      enumerateSequence(
        Number(numeric[1]),
        Number(numeric[2]),
        numeric[3] === undefined ? 1 : Math.abs(Number(numeric[3])),
        (value) => String(value),
      ),
    );
  }
  const alpha = body.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
  if (alpha) {
    return toAlternativesOrOverLimit(
      enumerateSequence(
        alpha[1]!.codePointAt(0)!,
        alpha[2]!.codePointAt(0)!,
        alpha[3] === undefined ? 1 : Math.abs(Number(alpha[3])),
        (value) => String.fromCharCode(value),
      ),
    );
  }
  return undefined;
}

function toAlternativesOrOverLimit(sequence: string[] | undefined): BraceBody | undefined {
  return sequence === undefined ? { kind: "overLimit" } : { kind: "alternatives", items: sequence };
}

function enumerateSequence(
  from: number,
  to: number,
  rawStep: number,
  render: (value: number) => string,
): string[] | undefined {
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  if (Math.abs(to - from) / step > MAX_BRACE_SEQUENCE_ITEMS) return undefined;
  const out: string[] = [];
  if (from <= to) {
    for (let value = from; value <= to; value += step) out.push(render(value));
  } else {
    for (let value = from; value >= to; value -= step) out.push(render(value));
  }
  return out;
}

// ── glob 与保护条目匹配 ──────────────────────────────────────────────

/**
 * 父目录 parent 下「本体受保护」的条目名，base 通配若能命中其中之一，展开结果必然
 * 包含一个不可毁的目录（`~/.*` → .ssh/.gnupg/.config、`~/D*` → Documents/Desktop、
 * `/b*` → bin/boot）。候选集与保护表同源，不另立清单。
 */
function matchesProtectedChildEntry(
  base: string,
  parent: string,
  context: TargetRiskContext,
  caseInsensitiveHint = false,
): boolean {
  const fold = comparisonFold(parent, context, caseInsensitiveHint);
  const foldedParent = fold(parent);
  const foldedBase = fold(base);
  const candidates: string[] = [];
  const collect = (absolute: string): void => {
    const entryParent = parentOf(absolute);
    const name = baseOf(absolute);
    if (entryParent === undefined || name.length === 0) return;
    if (entryParent === foldedParent) candidates.push(name);
  };
  for (const entry of SYSTEM_EXACT_POSIX) collect(fold(entry));
  for (const entry of SYSTEM_RECURSIVE_POSIX) collect(fold(entry));
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(foldedParent)) {
    for (const name of WINDOWS_DRIVE_CHILD_NAMES) candidates.push(fold(name));
  }
  const home = context.homeDirectory?.trim()
    ? normalizeConcrete(context.homeDirectory, context)
    : undefined;
  if (home) {
    const homeText = fold(home.text);
    for (const sub of CREDENTIAL_SUBPATHS) collect(`${homeText}/${fold(sub)}`);
    for (const sub of HOME_EXACT_SUBPATHS) collect(`${homeText}/${fold(sub)}`);
  }
  return candidates.some((name) => globSegmentMatches(foldedBase, name));
}

/**
 * 单段（不含 `/`）通配匹配：支持 `*`、`?`、`[abc]`/`[a-z]`/`[!a-z]`。
 * 刻意不模拟 bash 的 dotglob 语义（`*` 视为可匹配以 `.` 起的名字）——与既有裸 glob
 * 规则同一保守口径：宁可多判一个 catastrophic，不漏一个 `.ssh`。
 */
function globSegmentMatches(pattern: string, name: string): boolean {
  return matchGlobSegment(pattern, 0, name, 0);
}

function matchGlobSegment(pattern: string, pi: number, name: string, ni: number): boolean {
  let patternIndex = pi;
  let nameIndex = ni;
  while (patternIndex < pattern.length) {
    const char = pattern[patternIndex]!;
    if (char === "*") {
      while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
      if (patternIndex === pattern.length) return true;
      for (let cut = nameIndex; cut <= name.length; cut += 1) {
        if (matchGlobSegment(pattern, patternIndex, name, cut)) return true;
      }
      return false;
    }
    if (nameIndex >= name.length) return false;
    if (char === "?") {
      patternIndex += 1;
      nameIndex += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", patternIndex + 1);
      if (close < 0) {
        // 未闭合的 `[`：bash 视为字面量。
        if (name[nameIndex] !== "[") return false;
        patternIndex += 1;
        nameIndex += 1;
        continue;
      }
      let body = pattern.slice(patternIndex + 1, close);
      let negate = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      if (matchCharClass(body, name[nameIndex]!) === negate) return false;
      patternIndex = close + 1;
      nameIndex += 1;
      continue;
    }
    if (char === "\\" && patternIndex + 1 < pattern.length) {
      if (name[nameIndex] !== pattern[patternIndex + 1]) return false;
      patternIndex += 2;
      nameIndex += 1;
      continue;
    }
    if (char !== name[nameIndex]) return false;
    patternIndex += 1;
    nameIndex += 1;
  }
  return nameIndex === name.length;
}

function matchCharClass(body: string, char: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const isRange = body[i + 1] === "-" && body[i + 2] !== undefined;
    if (isRange) {
      if (char >= body[i]! && char <= body[i + 2]!) return true;
      i += 2;
      continue;
    }
    if (body[i] === char) return true;
  }
  return false;
}

function displayForm(raw: string, expanded: NormalizedPath): string {
  const trimmed = raw.trim();
  return expanded.text !== trimmed ? `${trimmed} -> ${expanded.text}` : trimmed;
}

function scopeBase(context: TargetRiskContext): NormalizedPath | undefined {
  // 段级 cwd 跟踪（HIGH-1）优先：`cd` 后的相对目标按新 cwd 定基。
  // trackedCwd.unresolved 的相对目标在 expandTargetPath 已 fail-closed，不会走到这里。
  const tracked = context.trackedCwd?.unresolved === false ? context.trackedCwd.resolved : undefined;
  const base = tracked?.trim() || context.workingDirectory?.trim() || context.workspaceRoot?.trim();
  return base ? normalizeConcrete(base, context) : undefined;
}

function isInsideScope(text: string, context: TargetRiskContext): boolean {
  const caseInsensitive = isWindowsStyleForm(text) || isCaseInsensitiveHost(context.platform);
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  for (const base of [context.workingDirectory, context.workspaceRoot]) {
    if (!base?.trim()) continue;
    const normalizedBase = normalizeConcrete(base, context);
    if (isUnder(fold(text), fold(normalizedBase.text))) return true;
  }
  return false;
}

/**
 * temp 判定。strictInside=true 时 temp 目录本身不豁免（`rm -rf /tmp` 按「具体路径」
 * 记 low）；glob 父目录的有界性判定用 strictInside=false（`rm -f /tmp/x-*.json`
 * 的展开域就是 /tmp 自身，属有界）。
 */
function isTempPath(text: string, context: TargetRiskContext, strictInside: boolean): boolean {
  const caseInsensitive = isWindowsStyleForm(text) || isCaseInsensitiveHost(context.platform);
  const folded = caseInsensitive ? text.toLowerCase() : text;
  const windowsMatch = folded.match(WINDOWS_TEMP_PATTERN);
  if (windowsMatch) {
    return strictInside ? windowsMatch[2] === "/" : true;
  }
  return TEMP_PREFIXES_POSIX.some((prefix) => {
    const lowered = prefix.toLowerCase();
    return isUnder(folded, lowered) && (!strictInside || folded !== lowered);
  });
}

function isDeviceTarget(path: NormalizedPath): boolean {
  // POSIX /dev 已由递归保护表命中；这里覆盖 Windows 设备命名空间与 DOS 设备名。
  if (WINDOWS_DEVICE_NAMESPACE_PATTERN.test(path.text)) return true;
  return !path.text.includes("/") && DOS_DEVICE_NAME_PATTERN.test(path.text.toLowerCase());
}

/** child 等于 parent 或严格位于其下（按 `/` 分段，不做字符串前缀误判）。 */
function isUnder(child: string, parent: string): boolean {
  if (parent.length === 0) return false;
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function parentOf(text: string): string | undefined {
  const trimmed = text.endsWith("/") && text.length > 1 ? text.slice(0, -1) : text;
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return undefined;
  if (index === 0) return "/";
  // 盘符根（c:/）的 parent 是它自己：`C:\*` 的父目录就是盘符根。
  if (index === 2 && /^[a-z]:/.test(trimmed)) return trimmed.slice(0, index + 1);
  return trimmed.slice(0, index);
}

function baseOf(text: string): string {
  const trimmed = text.endsWith("/") && text.length > 1 ? text.slice(0, -1) : text;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function isCaseInsensitiveHost(platform: string | undefined): boolean {
  // Windows 与 macOS 默认文件系统大小写不敏感：保护表比较跟随宿主语义（recall 偏向）。
  return platform === "win32" || platform === "darwin";
}

function isWindowsStyleForm(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(text) || /^[a-zA-Z]:$/.test(text) || text.startsWith("//");
}

function isAbsoluteForm(slashed: string): boolean {
  return slashed.startsWith("/") || /^[a-zA-Z]:\/?$/.test(slashed) || /^[a-zA-Z]:\//.test(slashed);
}

/**
 * Windows 扩展长度前缀剥除：`\\?\C:\x`、`//?/C:/x` 与 `\\?\UNC\server\share`。
 * 前缀里的 `?` 是命名空间标记而不是通配符，必须在 glob 判定**之前**剥掉
 * （spec R2「`\\?\` 前缀剥掉后按其余规则判」）。
 */
function stripExtendedLengthPrefix(text: string): string {
  if (text.startsWith("\\\\?\\UNC\\")) return `//${text.slice(8)}`;
  if (text.startsWith("\\\\?\\")) return text.slice(4);
  if (text.startsWith("//?/")) return text.slice(4);
  return text;
}

/**
 * 反斜杠→正斜杠、盘符小写、MSYS 挂载形映射、`\\?\` 前缀剥除。
 * 非 win32 平台只对整个 token 呈 Windows 形态（盘符/UNC）时转换反斜杠——POSIX 下
 * 反斜杠是合法文件名字符，不能盲转。
 */
function toSlashForm(raw: string, platform: string | undefined): string {
  let text = stripExtendedLengthPrefix(raw);
  // `\\?\UNC\server\share` 剥前缀后成为 `//server\share`：反斜杠仍要转换，但它已不
  // 呈 `\\` 形态，单独记住这一来源（POSIX 下 `//foo` 的反斜杠是合法文件名字符）。
  const fromUncPrefix = text !== raw && text.startsWith("//");
  const windowsShaped =
    /^[a-zA-Z]:[\\/]/.test(text) ||
    /^[a-zA-Z]:$/.test(text) ||
    text.startsWith("\\\\") ||
    fromUncPrefix;
  if (platform === "win32" || windowsShaped) {
    text = text.replaceAll("\\", "/");
  }
  // win32（Git Bash/MSYS）下 `/c/…` 与 `/c` 就是 `c:/…` 与 `c:/`。
  if (platform === "win32") {
    const msys = text.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msys) {
      text = `${msys[1]!.toLowerCase()}:${msys[2] ?? "/"}`;
    }
  }
  const drive = text.match(/^([a-zA-Z]):([\\/]|$)/);
  if (drive) {
    text = `${drive[1]!.toLowerCase()}:${text.slice(2) || "/"}`;
  }
  // 前导 `//`+ 折叠（对抗复审 HIGH-5，非 win32）：POSIX 规定 ≥3 个前导斜杠等价
  // 单斜杠，恰两个在 Linux/macOS 实现上同样按 `/` 处理——`rm -rf //` 就是 `rm -rf /`。
  // 真 UNC `//server/share` 在 POSIX 上本就是 `/server/share`，折叠不损失保护；
  // `//./`、`//?/` 设备命名空间不折叠（其内容是命名空间标记）。win32 保留 UNC 语义。
  if (platform !== "win32" && /^\/\//.test(text) && !/^\/\/[.?]/.test(text)) {
    text = text.replace(/^\/+/, "/");
  }
  return text;
}

/**
 * 词法消除 `.`/`..`：`/home/u/../..` 被看成 `/`。`..` 无条件弹出栈顶（越界即丢弃），
 * 空结果归约为根——这正是 `$UNKNOWN/..` 判 catastrophic 的机制：变量为空或多段时
 * 它就是根，jcode 同款语义（normalize 空 → "/"）。
 */
function foldComponents(slashed: string): string {
  return foldComponentsDetailed(slashed).text;
}

/**
 * foldComponents 的详细版（对抗复审 HIGH-7）：额外报告「`..` 弹栈消费了未解析段」。
 * 检测必须在弹栈现场做——`$UNKNOWN/../etc` 归约结果是 `etc`，只看最终落点无法
 * 知道「变量为空/多段时它就是根」。
 */
function foldComponentsDetailed(slashed: string): { text: string; poppedUnresolved: boolean } {
  if (slashed.length === 0) return { text: slashed, poppedUnresolved: false };
  // UNC 设备/扩展前缀（//./ 、//?/ ）不做分段消除：它们的 "." 是命名空间而非当前目录。
  if (slashed.startsWith("//./") || slashed.startsWith("//?/") || slashed === "//.") {
    return { text: slashed, poppedUnresolved: false };
  }
  const uncPrefix = slashed.startsWith("//") ? "//" : "";
  const body = uncPrefix ? slashed.slice(2) : slashed;
  const driveMatch = body.match(/^([a-z]):(\/|$)/);
  const drivePrefix = driveMatch ? `${driveMatch[1]}:` : "";
  const absolute =
    uncPrefix.length > 0 ||
    body.startsWith("/") ||
    (drivePrefix.length > 0 && body.startsWith(`${drivePrefix}/`));
  const rest = drivePrefix ? body.slice(drivePrefix.length) : body;

  const out: string[] = [];
  let poppedUnresolved = false;
  for (const part of rest.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      const popped = out.pop();
      // 弹栈消费未解析段（$VAR/`cmd`/%VAR%/~user）→ 变量为空/多段时可达根：
      // 整个目标 catastrophic（spec R3「未解析段绝不 normalize 掉」）。
      if (popped !== undefined && (UNRESOLVED_PART_MARKER_PATTERN.test(popped) || /^~[^/]/.test(popped))) {
        poppedUnresolved = true;
      }
      continue;
    }
    out.push(part);
  }

  if (out.length === 0) {
    if (drivePrefix) return { text: `${drivePrefix}/`, poppedUnresolved };
    if (uncPrefix) return { text: uncPrefix, poppedUnresolved };
    return { text: "/", poppedUnresolved };
  }
  if (drivePrefix) {
    return { text: `${drivePrefix}/${out.join("/")}`, poppedUnresolved };
  }
  if (uncPrefix) {
    return { text: `${uncPrefix}${out.join("/")}`, poppedUnresolved };
  }
  return {
    text: absolute ? `/${out.join("/")}` : out.join("/"),
    poppedUnresolved,
  };
}

/** 段内未解析标记：`$VAR`、`` `cmd` ``、`%VAR%`（`~user` 由调用处单独判断）。 */
const UNRESOLVED_PART_MARKER_PATTERN = /[$`%]/;
