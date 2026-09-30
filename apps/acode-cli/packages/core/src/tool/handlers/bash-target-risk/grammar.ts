// 目标风险分级的共享词汇表与纯谓词（J1-1）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode)
// crates/jcode-command-risk/src/lib.rs 的命令/旗标分类表，
// 自撰 TypeScript 实现并按三平台扩展。本文件只有数据表与无状态谓词，
// 不做任何分级决策——决策在 assess.ts / find-actions.ts / fallback.ts。

import { classifyTarget, isQuotedExpansionShape, isSafeWriteSink } from "./paths.js";
import {
  stricterTargetRiskLevel,
  type TargetRiskAssessment,
  type TargetRiskContext,
  type TargetRiskFinding,
  type TargetRiskLevel,
} from "./types.js";

/** 递归评估深度上限（sh -c 套 sh -c、find -exec 套 eval…）：超限升级而非放行。 */
export const MAX_RECURSION_DEPTH = 4;

/** 以销毁数据为主要目的的命令。出现在这里不代表危险——代表「检查它的目标」。 */
const DESTRUCTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "shred",
  "unlink",
  "truncate",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "wipefs",
  "srm",
  // JS 生态的删除路径（评审 J1-1 修复）：ACode 跑在 JS monorepo 里，`rimraf` 是最常见
  // 的递归删除形态。jcode 上游表内没有它（其宿主是 Rust 项目），照抄上游表范围会在
  // 本仓库留下 `npx rimraf ~` → safe 的缺口，与本层「按 blast radius 分类」的目的冲突。
  // rimraf 天生递归，见 ALWAYS_RECURSIVE_PROGRAMS。
  "rimraf",
]);

/** 语义上永远递归的动词（无旗标也是整树删除）。 */
const ALWAYS_RECURSIVE_PROGRAMS: ReadonlySet<string> = new Set(["rimraf"]);

/** Windows 破坏性动词（cmd/PowerShell 经 Bash 工具透传时同样要检查目标）。 */
const WINDOWS_DESTRUCTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  "del",
  "erase",
  "rd",
  "format",
  "remove-item",
]);

/** 运行另一个命令的 wrapper：真实程序在其参数里，必须解包后再分类。 */
export const WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "ionice",
  "time",
  "timeout",
  "nohup",
  "xargs",
  "command",
  "builtin",
  "exec",
  "setsid",
  "stdbuf",
  "chroot",
  "su",
  "watch",
  // JS 包运行器（评审 J1-1 修复）：`npx rimraf ~`、`bunx rimraf ~/.ssh`、
  // `pnpm exec rimraf dist`、`pnpm dlx …` 的真实动词在运行器参数里。jcode 上游的
  // 18 个 wrapper 面向 Rust/shell 宿主，没有这一族；不解包就等于给 JS monorepo 里
  // 最常见的删除形态留了一条 safe 直通路径。`npm run x`/`deno run x.ts`/`node x.js`
  // 解包后的程序名不在破坏性表内，判定不变。
  "npx",
  "bunx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "node",
  "dlx",
  // busybox/toybox 多合一工具箱（对抗复核 F-4）：真实动词是第一个非旗标参数
  // （applet 名）。`busybox rm -rf ~`、`busybox tee /etc/passwd`、`toybox rm -rf ~`
  // 的类 1 熔断按命令名不中（name=busybox），本层不解包就是 yolo 静默放行路径。
  // 无 applet 形态（`busybox`、`busybox --help`）落 wrapper payload 不可见 → confirm。
  "busybox",
  "toybox",
]);

/** POSIX shell：内联脚本参数递归评估（`sh -c "rm -rf ~"` 不是免死金牌）。 */
export const SHELL_PROGRAMS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
]);

/** 外方言 shell：payload 尽力用同一评估器递归，认不出的形态 confirm 兜底。 */
export const FOREIGN_SHELL_PROGRAMS: ReadonlySet<string> = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

/** 只有这些旗标出现时才有破坏性的命令 → 判定递归的旗标集。 */
export const CONDITIONALLY_DESTRUCTIVE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  chmod: new Set(["-R", "--recursive"]),
  chown: new Set(["-R", "--recursive"]),
};

/** 总是截断目标文件的重定向操作符（`>&` 另按操作数判定，见 isTruncatingRedirect）。 */
const TRUNCATING_REDIRECT_OPERATORS: ReadonlySet<string> = new Set([">", ">|", "&>"]);

/** `>&` 的操作数是 fd 号（或 `-` 关闭描述符）时不写文件。 */
const FD_OPERAND_PATTERN = /^(?:\d+|-)$/;

/**
 * 该重定向是否会截断目标文件（评审 J1-1 修复，spec R4 同步更正）。
 *
 * `>`/`>|`/`&>` 总是截断。`>&` 此前被整体归为「fd dup、不算破坏」，但 bash 的
 * `>&word` 在 word 不是数字时等价于 `>word 2>&1`——`echo x >& /etc/passwd` 与
 * `echo x > /etc/passwd` 同样毁掉文件，而后者是 catastrophic。只有 `>&2`、`>&-`
 * 这类纯 fd 操作才豁免。
 */
export function isTruncatingRedirect(redirect: {
  readonly operator: string;
  readonly target?: string;
}): boolean {
  if (TRUNCATING_REDIRECT_OPERATORS.has(redirect.operator)) return true;
  if (redirect.operator !== ">&") return false;
  const target = redirect.target?.trim() ?? "";
  return target.length > 0 && !FD_OPERAND_PATTERN.test(target);
}

/** find 的谓词类 action：消费字面数据，其值不是另一个 action（`-name '-delete'`）。 */
export const FIND_VALUE_PREDICATES: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-lname",
  "-ilname",
  "-printf",
]);

export const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
export const FIND_PRINT_ACTIONS: ReadonlySet<string> = new Set(["-fprint", "-fprint0", "-fls"]);

/** 未终止 `-exec` payload 的截断点：这些 action token 不可能属于 payload。 */
export const FIND_PAYLOAD_CUT_TOKENS: ReadonlySet<string> = new Set([
  "-delete",
  "-print",
  "-print0",
  "-printf",
  "-fprint",
  "-fprint0",
  "-fls",
  "-fprintf",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-quit",
  "-exit",
]);

/** shell 语法控制词：fallback 词法扫描时不是动词也不是目标。 */
export const SHELL_CONTROL_WORDS: ReadonlySet<string> = new Set([
  "then",
  "do",
  "done",
  "else",
  "elif",
  "esac",
  "fi",
  "in",
  "select",
  "case",
  "if",
  "while",
  "until",
  "!",
  "{",
  "}",
]);

export const HOME_ASSIGNMENT_PATTERN = /^HOME=/;
/** 任意 shell 变量赋值词元（用来在扫描里跳过它们，不把赋值词元当命令名）。 */
const VARIABLE_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * 赋值型内建：只有它们的参数位上出现 `HOME=` 才是一次真实的 HOME 重赋值
 * （评审 J1-1 修复）。此前实现按「argv 里任一 token 以 HOME= 开头」判定，于是
 * `grep HOME= f`、`rg "HOME=" src`、`git log -S HOME=` 这类只读命令也被升级成
 * confirm（build 模式下 readonly 快径丢失、直接 deny 一轮）——恰恰是 spec R4
 * 声称已经避免的 jcode 裸 contains 形态。收窄到赋值位后 recall 不减：
 * 前导赋值（`HOME=/tmp rm -rf ~`）由 AST 的 envAssignments 覆盖，
 * `env/export/declare/local/typeset/readonly/set HOME=…` 由本表覆盖。
 */
const ASSIGNMENT_CAPABLE_PROGRAMS: ReadonlySet<string> = new Set([
  "env",
  "export",
  "declare",
  "local",
  "typeset",
  "readonly",
  "set",
]);

/**
 * 顺序扫描一段 token，判断其中出现的 `HOME=` 词元是否处于赋值位。
 * AST 路径（assess.ts）与词法 fallback（fallback.ts）共用同一口径；fallback 在段边界
 * 调用 reset()，避免上一段的命令名泄漏到下一段。
 * 返回类型内联而不导出接口：消费方只调用方法，导出类型会成为 knip 的未消费导出。
 */
export function createHomeAssignmentScanner(): {
  /** 该 token 是否是一次真实的 HOME 重赋值。 */
  isReassignment(token: string): boolean;
  /** 段边界（`;`、`&&`、`|`、子 shell 起始）：命令名归属重新开始。 */
  reset(): void;
} {
  // 当前段的命令名：wrapper 与其后的赋值词元都不改变它归属的「最近一个程序词」。
  let governingProgram: string | undefined;
  return {
    isReassignment(token: string): boolean {
      if (VARIABLE_ASSIGNMENT_PATTERN.test(token)) {
        // 赋值词元自身不会成为命令名；前导赋值（还没有命令名）就是重赋值。
        return (
          HOME_ASSIGNMENT_PATTERN.test(token) &&
          (governingProgram === undefined || ASSIGNMENT_CAPABLE_PROGRAMS.has(governingProgram))
        );
      }
      if (!isFlagToken(token)) governingProgram = programBasename(token);
      return false;
    },
    reset(): void {
      governingProgram = undefined;
    },
  };
}

export const BARE_DURATION_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/i;
const DD_WRITE_TARGET_PATTERN = /^of=(.+)$/;
const DD_NON_TARGET_KEY_PATTERN =
  /^(?:if|seek|conv|status|bs|count|skip|ibs|obs|cbs|iflag|oflag)=/;
export const BASE64_LIKE_PATTERN = /^[A-Za-z0-9+/=]{16,}$/;

/** 一段 token 序列的评估语境（管道喂入、原始文本补判）。 */
export interface TokenRunMeta {
  /** 该段程序的操作数来自上游管道输出，静态不可枚举（#604 review 教训）。 */
  readonly receivesPipe: boolean;
  /** 原始命令文本：find `-exec … \;` 的终止符会被 AST 吃掉，用它补判。 */
  readonly commandText?: string;
}

/** 段级评估回调：find-actions 经它递归 payload，避免模块间循环依赖。 */
export type SegmentAssessor = (
  tokens: readonly string[],
  meta: TokenRunMeta,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
) => void;

/** 脚本文本评估回调：外方言 shell payload 经它递归，避免循环依赖。 */
export type ScriptAssessor = (
  text: string,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
) => void;

// ── 无状态谓词 ───────────────────────────────────────────────────────

export function programBasename(token: string): string {
  const normalized = token.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

export function isFlagToken(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

export function isDestructiveProgramName(name: string): boolean {
  return (
    DESTRUCTIVE_PROGRAMS.has(name) ||
    WINDOWS_DESTRUCTIVE_PROGRAMS.has(name) ||
    name.startsWith("mkfs.")
  );
}

/** 语义上永远递归的动词（rimraf）：无旗标也按递归删除分级。 */
export function isAlwaysRecursiveProgram(name: string): boolean {
  return ALWAYS_RECURSIVE_PROGRAMS.has(name);
}

/**
 * 是否递归旗标：`--recursive`、短旗标簇里含 r/R（-rf、-Rf、-fr…），
 * Windows 动词另认 /s 与 -Recurse。只读命令的旗标不是删除旗标——
 * `find -printf` 里的 r 不能把重定向变成递归删除。
 */
export function isRecursiveFlag(token: string, programName: string): boolean {
  if (!isFlagToken(token)) {
    return WINDOWS_DESTRUCTIVE_PROGRAMS.has(programName) && /^\/s$/i.test(token);
  }
  if (token.startsWith("--")) {
    return token === "--recursive" || token === "--recurse";
  }
  if (/^-recurse$/i.test(token)) return true;
  const cluster = token.slice(1);
  return cluster.includes("r") || cluster.includes("R");
}

export function hasUnresolvedMarker(token: string): boolean {
  return /[$`%]/.test(token) || /^~[^/\s]/.test(token);
}

/** wrapper 选项是否消费下一个词。选项拼写是 wrapper 特定的（jcode 同款规则表）。 */
export function wrapperFlagTakesValue(wrapper: string, flag: string): boolean {
  switch (wrapper) {
    case "sudo":
      return [
        "-u", "--user", "-g", "--group", "-C", "-c", "-D", "-R", "-T", "-a",
        "-h", "-p", "-r", "-t", "--askpass", "--chdir", "--chroot",
        "--close-from", "--host", "--prompt", "--role", "--type",
      ].includes(flag);
    case "doas":
      return ["-u", "-a", "-C", "-t"].includes(flag);
    case "env":
      return ["-u", "--unset", "-C", "--chdir", "--argv0"].includes(flag);
    case "nice":
      return ["-n", "--adjustment"].includes(flag);
    case "ionice":
      return ["-c", "--class", "-n", "--classdata", "-p", "--pid"].includes(flag);
    case "timeout":
      return ["-s", "--signal", "-k", "--kill-after"].includes(flag);
    case "time":
      return ["-f", "-o", "--format", "--output"].includes(flag);
    case "watch":
      return ["-n", "--interval"].includes(flag);
    case "stdbuf":
      return ["-i", "--input", "-o", "--output", "-e", "--error"].includes(flag);
    case "chroot":
      return ["--userspec", "--groups"].includes(flag);
    case "su":
      return ["-s", "--shell"].includes(flag);
    case "xargs":
      return [
        "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars",
        "-I", "--replace", "-J", "-d", "--delimiter", "-E", "--eof",
        "-L", "--max-lines",
      ].includes(flag);
    default:
      return false;
  }
}

export function isCommandNameLookup(tokens: readonly string[], startIndex: number): boolean {
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--" || !isFlagToken(token)) return false;
    if (!token.startsWith("--") && /[vV]/.test(token.slice(1))) return true;
  }
  return false;
}

export function isEnvSplitStringFlag(token: string): boolean {
  if (token.startsWith("--split-string")) return true;
  return token.startsWith("-") && !token.startsWith("--") && token.includes("S");
}

// ── 目标操作数提取 ───────────────────────────────────────────────────

/**
 * 一个破坏性目标操作数：value 是（去引号后的）路径 token，fullyQuoted 标记该
 * token 在源码里是否被完整引号包裹（LOW-16 全引号 tilde/brace 降级判定的依据）。
 */
export interface DestructiveTarget {
  readonly value: string;
  readonly fullyQuoted: boolean;
}

/**
 * 提取破坏性动词的目标操作数：去旗标；dd 的 key=value 操作数里只有 `of=` 是写目标
 * （`if=` 是读源、`seek=/conv=` 等不是路径，不参与破坏分级），of= 保留原始 kv 形态，
 * 由 destructiveTargetValue 提取值并豁免安全汇（`dd if=x of=/dev/null` 是常规操作）。
 * argQuoted 与 args 平行（AST 路径由 parser 提供引号包裹信息；fallback 无此信息，
 * 全部按未包裹处理——LOW-16）。
 */
export function extractDestructiveTargets(
  programName: string,
  args: readonly string[],
  argQuoted?: readonly boolean[],
): DestructiveTarget[] {
  const targets: DestructiveTarget[] = [];
  const windowsVerb = WINDOWS_DESTRUCTIVE_PROGRAMS.has(programName);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const quoted = argQuoted?.[index] === true;
    if (arg === "--") continue;
    if (isFlagToken(arg)) continue;
    // Windows 动词的 /s /q 是开关不是路径（对 rd/del/format 等成立；POSIX 动词
    // 不受影响，避免把 `rm /some/path` 误当开关）。
    if (windowsVerb && /^\/[a-zA-Z]/.test(arg)) continue;
    if (programName === "dd") {
      if (DD_WRITE_TARGET_PATTERN.test(arg)) {
        targets.push({ value: arg, fullyQuoted: quoted });
        continue;
      }
      if (DD_NON_TARGET_KEY_PATTERN.test(arg)) continue;
    }
    targets.push({ value: arg, fullyQuoted: quoted });
  }
  return targets;
}

/** dd 的 `of=` 值提取 + 安全汇豁免；其余动词原样返回。 */
export function destructiveTargetValue(
  programName: string,
  target: string,
): string | undefined {
  if (programName !== "dd") return target;
  const writeTarget = target.match(DD_WRITE_TARGET_PATTERN);
  if (!writeTarget) return target;
  return isSafeWriteSink(writeTarget[1]!) ? undefined : writeTarget[1]!;
}

// ── finding 组装 ─────────────────────────────────────────────────────

/**
 * 破坏性目标的统一分级入口（对抗复审 LOW-16）：AST/fallback 已剥掉引号，只有
 * parser 提供的 fullyQuoted 标记能证明「整个 token 在源码里被完整引号包裹」。
 * 此时 `~`/`{a,b}` 是字面字符（bash 引号内不展开），catastrophic 会变成无申诉的
 * 永久拒绝——降 confirm（保留 recall，不静默放行）；其余情况照常分级。
 */
export function classifyDestructiveTargetToken(
  value: string,
  fullyQuoted: boolean,
  context: TargetRiskContext,
  options: { readonly recursive: boolean },
): TargetRiskFinding | undefined {
  if (fullyQuoted && isQuotedExpansionShape(value)) {
    return {
      level: "confirm",
      reason:
        "target is fully quoted, so the shell treats ~ and brace forms as literal path characters; the real target cannot be graded absolutely",
      target: value,
    };
  }
  return classifyTarget(value, context, options);
}

export function pushFinding(
  findings: TargetRiskFinding[],
  candidate: TargetRiskFinding | undefined,
): void {
  if (candidate) findings.push(candidate);
}

export function wrapperPayloadUnknown(wrapper: string): TargetRiskFinding {
  return {
    level: "confirm",
    reason: `\`${wrapper}\` runs another command that could not be identified statically`,
  };
}

export const HOME_REASSIGN_REASON =
  "command reassigns HOME, so runtime resolution of ~ and $HOME targets can diverge from the statically assessed paths";

export const PIPE_FED_REASON_SUFFIX =
  "deletes paths supplied by a pipe, so the set of affected files cannot be checked before it runs";

export const UNKNOWN_BLAST_RADIUS_REASON_SUFFIX =
  "is destructive but its target could not be determined statically, so its blast radius is unknown";

export function buildAssessment(findings: readonly TargetRiskFinding[]): TargetRiskAssessment {
  const deduped = dedupeFindings(findings);
  const level = deduped.reduce<TargetRiskLevel>(
    (current, item) => stricterTargetRiskLevel(current, item.level),
    "safe",
  );
  const targets = [
    ...new Set(
      deduped
        .map((item) => item.target)
        .filter((target): target is string => target !== undefined && target.length > 0),
    ),
  ];
  return { level, findings: deduped, targets };
}

function dedupeFindings(findings: readonly TargetRiskFinding[]): TargetRiskFinding[] {
  const seen = new Set<string>();
  const out: TargetRiskFinding[] = [];
  for (const item of findings) {
    const key = `${item.level}\u0000${item.reason}\u0000${item.target ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
