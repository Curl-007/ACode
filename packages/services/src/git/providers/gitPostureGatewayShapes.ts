/**
 * git posture 意图网关：档位闭集 + argv 精确形状白名单（纯函数判定器）。
 *
 * 机制来源：Claude Desktop 2.37337 `src/beautified/main/index.chunk-CHbrg8it.js`
 * :76-77（档位集）、:166-195（形状常量）、:196-205（子命令位扫描）、:254-256
 * （EGITPOSTURE 错误）、:292-322（旗标缩写/merge 形状匹配）、:323-363（merge 档）、
 * :364-687（网关主体）；接线形态见 index.chunk-B4Dgt0a4.js:881-893（漏斗缺省
 * posture ?? "read"）。规则表、ACode 面裁决与偏差登记见
 * specs/git-posture-gateway.md（R1-R5）——修改任何形状前先改 spec。
 *
 * 判定器是纯函数：通过时返回可能被重写的 argv 新数组（注入防御旗标/重建 fetch），
 * 拒绝时抛 GitPostureError（code=EGITPOSTURE），零副作用。
 */

/** 档位闭集（spec R1）：9 值，类型层封闭；pushProbe 与 push 同形（证据 :391）。 */
export const GIT_POSTURES = [
  "read",
  "push",
  "pushProbe",
  "fetch",
  "scrub",
  "populate",
  "hydrate",
  "merge",
  "infra",
] as const;

export type GitPosture = (typeof GIT_POSTURES)[number];

/** 未声明档位的缺省值（证据 B4Dgt0a4:884 `posture ?? "read"` 同款，spec R2）。 */
export const DEFAULT_GIT_POSTURE: GitPosture = "read";

export const GIT_POSTURE_ERROR_CODE = "EGITPOSTURE";

/** 档位拒绝 = 调用点编程错误（声明档位与 argv 形状不符），fail-closed 冒泡（spec R5）。 */
export class GitPostureError extends Error {
  readonly code = GIT_POSTURE_ERROR_CODE;
  readonly posture: GitPosture;
  readonly detail: string;

  constructor(posture: GitPosture, detail: string) {
    super(`git ${detail} is not permitted under the "${posture}" posture`);
    this.name = "GitPostureError";
    this.posture = posture;
    this.detail = detail;
  }
}

/** 形状白名单强制面（证据 :76 `ae` 集）；infra 单独走位置劫持守卫分支（:365-372）。 */
export const ENFORCED_POSTURES: ReadonlySet<string> = new Set<GitPosture>([
  "read",
  "push",
  "pushProbe",
  "fetch",
  "scrub",
  "populate",
  "hydrate",
  "merge",
]);

/** 40/64 位 hex sha（证据 :302 `Q`）。 */
export const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** 非全零 sha（证据 scrub 段 :512 `d`）。 */
export const NON_ZERO_SHA_PATTERN = /^(?!0+$)(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** 合法分支 ref（证据 :257 `ve`）。 */
export const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
/** push refspec：必须显式 `src:dst`，dst 落 refs/ 命名空间（证据 :412）。 */
export const PUSH_REFSPEC_PATTERN = /^\+?(?:refs\/[^:*\s]+|[^:*\s/+][^:*\s]*):refs\/[^:*\s]+$/;
/** fetch refspec：dst 必须落 refs/remotes/ 命名空间（证据 :461）。 */
export const FETCH_REFSPEC_PATTERN = /^\+?refs\/[^:*\s]+:refs\/remotes\/[^:*\s]+$/;
/** 远端 HEAD ref 非法字符集（证据 scrub symbolic-ref 段 :616-625）。 */
// eslint-disable-next-line no-control-regex -- 有意匹配控制字符：ref 名含 C0 控制符即拒绝（证据同款防御）。
export const BAD_REMOTE_REF_PATTERN = /[\u0000-\u0020\u007f~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock$/;
/** update-ref 消息禁控制字符（证据 :553/:566）。 */
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;
/** 远端 HEAD 指向解析（证据 :610）。 */
export const REMOTE_HEAD_PATTERN = /^refs\/remotes\/([^/\s]+)\/HEAD$/;
/** refs/remotes/<r>/<name> 前缀校验（证据 :598）。 */
export const REMOTE_REF_PREFIX_PATTERN = /^refs\/remotes\/[^/]+\/./;

/** 位置劫持旗标：infra 档在子命令位拒绝（证据 :194 `ue`，spec 威胁 3）。 */
export const POSITION_HIJACK_FLAGS = [
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
];

/** 子命令位扫描时跳过的全局透传旗标（证据 :195 `de`）。 */
const GLOBAL_PASSTHROUGH_FLAGS = new Set([
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
]);

/** read 档子命令白名单（证据 :175-193 `W` 集）。 */
export const EVIDENCE_READ_SUBCOMMANDS = new Set([
  "branch",
  "cat-file",
  "check-attr",
  "check-ignore",
  "diff",
  "for-each-ref",
  "hash-object",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "remote",
  "rev-list",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
]);

/**
 * ACode read 档登记增补（spec R4-2）：config 只读形、check-ref-format 语法校验、
 * remote 无参列表。全部只读、无网络、精确形状；证据 W 集按 Claude 面裁剪没有它们。
 */
export const ACODE_READ_SUBCOMMAND_ADDITIONS = new Set(["config", "check-ref-format"]);

/** config 只读形旗标闭集（spec R4-2）：写形（set/unset/-f/--add…）一律拒。 */
export const CONFIG_READ_FLAGS = new Set(["--get", "--show-scope", "--show-origin"]);

/** recurse-submodules 守卫覆盖的子命令（证据 :278-289 `be`，spec 威胁 5）。 */
export const SUBMODULE_RECURSE_GUARDED_SUBCOMMANDS = new Set([
  "checkout",
  "fetch",
  "grep",
  "ls-files",
  "pull",
  "push",
  "read-tree",
  "reset",
  "restore",
  "switch",
]);

/** populate checkout 允许旗标（证据 :290 `xe`）。 */
export const POPULATE_CHECKOUT_FLAGS = new Set([
  "--quiet",
  "-q",
  "--no-track",
  "-B",
  "--no-recurse-submodules",
]);

/** read symbolic-ref 允许旗标（证据 :291 `Se`）。 */
export const READ_SYMBOLIC_REF_FLAGS = new Set([
  "--short",
  "--no-short",
  "--quiet",
  "-q",
  "--no-recurse",
]);

/** read branch 列表形允许旗标（证据 :258-277 `X`）。 */
export const READ_BRANCH_FLAGS = new Set([
  "--show-current",
  "--list",
  "-l",
  "--remotes",
  "-r",
  "--all",
  "-a",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

/** hydrate lfs ls-files 允许旗标（证据 :166 `F`）。 */
export const LFS_LS_FILES_FLAGS = new Set(["--json", "-n", "--name-only"]);

/** scrub update-index 的 skip-worktree 旗标集（证据 :258-263 `ye`）。 */
export const SKIP_WORKTREE_FLAGS = new Set([
  "--no-skip-worktree",
  "--no-assume-unchanged",
  "--skip-worktree",
  "--assume-unchanged",
]);

/** push 档禁用旗标名（缩写也捕获；证据 :400-411）。 */
export const PUSH_BANNED_FLAG_NAMES = [
  "all",
  "mirror",
  "tags",
  "prune",
  "delete",
  "branches",
  "follow-tags",
  "receive-pack",
  "exec",
  "push-option",
  "repo",
];

/** fetch 档 shallow 系禁用旗标名（证据 :424-432）。 */
export const FETCH_SHALLOW_FLAG_NAMES = [
  "depth",
  "deepen",
  "unshallow",
  "update-shallow",
  "shallow-since",
  "shallow-exclude",
  "refetch",
];

/** fetch 档禁用旗标名（证据 :448-459 + ACode 增补 mirror，spec R4-7）。 */
export const FETCH_BANNED_FLAG_NAMES = [
  "tags",
  "prune",
  "prune-tags",
  "refmap",
  "multiple",
  "all",
  "upload-pack",
  "exec",
  // ACode 增补（对蓝本的收紧偏差，spec R4-7）：CLI `--mirror` 隐含全量 refmap
  // (+refs/*:refs/*) 与 prune，会压过重建注入的 `-c remote.<r>.mirror=false`/
  // `--refmap=` 钉死项——台账 A1 点名 mirror 属必须钉死的武器化面，证据禁用名单
  // 未含它是蓝本缺口（其 fetch 调用点全为 app 构造）。ACode fetch 面零消费点，
  // 无合法 mirror 需求，直接拒绝。
  "mirror",
];

/** fetch 档允许的精确旗标值（证据 :447 `l`；重建时归一为注入形态）。 */
export const FETCH_ALLOWED_EXACT_FLAGS = new Set([
  "--refmap=",
  "--no-prune",
  "--no-tags",
  "--no-prune-tags",
]);

/** ls-remote 禁用旗标名（证据 :485-487）。 */
export const LS_REMOTE_BANNED_FLAG_NAMES = ["upload-pack", "exec"];

/**
 * 子命令位扫描（证据 :196-205 `G`）：跳过 `-c <key> <value>` 成对参数与全局透传
 * 旗标后返回第一个 token 下标；全被消耗时返回 -1。
 */
export function findSubcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "-c") {
      index += 2;
    } else if (GLOBAL_PASSTHROUGH_FLAGS.has(token)) {
      index += 1;
    } else {
      return index;
    }
  }
  return -1;
}

/**
 * 旗标缩写捕获（证据 :292-302 `Z`）：`--x`/`--no-x`/`--x=v` 去掉 `no-` 前缀与
 * `=值` 后，若名字是禁用名的前缀即命中（`--mir` 捕获 `mirror`）。
 */
export function isFlagAbbrevOf(flag: string, name: string): boolean {
  if (!flag.startsWith("--") || flag.length < 3) {
    return false;
  }
  let stripped = flag.slice(2);
  const eqIndex = stripped.indexOf("=");
  if (eqIndex !== -1) {
    stripped = stripped.slice(0, eqIndex);
  }
  if (stripped.startsWith("no-")) {
    stripped = stripped.slice(3);
  }
  return stripped.length > 0 && name.startsWith(stripped);
}

export function hasControlChar(value: string): boolean {
  return CONTROL_CHAR_PATTERN.test(value);
}

/**
 * merge 档 sha 形状匹配（证据 :303-322 `$`）：必含 requiredFlags、其余旗标 ⊆
 * optionalFlags、无重复旗标、禁 `--`、恰 1 个 sha 位置参；allowMessage 决定
 * `-m <msg>`（msg 非旗标、恰一个 -m）是必含还是必不含。
 */
export function matchesMergeShaShape(
  args: readonly string[],
  requiredFlags: readonly string[],
  optionalFlags: readonly string[],
  allowMessage: boolean,
): boolean {
  const messageIndex = args.indexOf("-m");
  if ((messageIndex !== -1) !== allowMessage) {
    return false;
  }
  let withoutMessage = [...args];
  if (messageIndex !== -1) {
    const message = args[messageIndex + 1];
    if (
      message === undefined ||
      message.startsWith("-") ||
      args.indexOf("-m", messageIndex + 1) !== -1
    ) {
      return false;
    }
    withoutMessage = [...args.slice(0, messageIndex), ...args.slice(messageIndex + 2)];
  }
  const flags = withoutMessage.filter((token) => token.startsWith("-"));
  const positionals = withoutMessage.filter((token) => !token.startsWith("-"));
  return (
    !withoutMessage.includes("--") &&
    positionals.length === 1 &&
    SHA_PATTERN.test(positionals[0] ?? "") &&
    new Set(flags).size === flags.length &&
    requiredFlags.every((flag) => flags.includes(flag)) &&
    flags.every((flag) => requiredFlags.includes(flag) || optionalFlags.includes(flag))
  );
}

export interface ParsedGitArgs {
  /** 完整 argv 副本。 */
  argv: string[];
  /** 子命令位下标（-1 = 无子命令）。 */
  subcommandIndex: number;
  /** 子命令 token。 */
  subcommand: string | undefined;
  /** 子命令后的全部 token。 */
  rest: string[];
  /** rest 中的非旗标 token（含 `--` 之后）。 */
  positionals: string[];
  /** rest 中 `--` 的下标（-1 = 无）。 */
  dashIndex: number;
  /** `--` 之前的 rest 段（无 `--` 时 = 全部 rest）。 */
  preDash: string[];
  /** 在子命令位后注入旗标重建 argv。 */
  splice: (...extra: string[]) => string[];
  /** 抛档位拒绝错误。 */
  fail: (detail: string) => never;
}

export function parseGitArgs(posture: GitPosture, args: readonly string[]): ParsedGitArgs {
  const argv = [...args];
  const subcommandIndex = findSubcommandIndex(argv);
  const subcommand = subcommandIndex === -1 ? undefined : argv[subcommandIndex];
  const rest = subcommandIndex === -1 ? [] : argv.slice(subcommandIndex + 1);
  const dashIndex = rest.indexOf("--");
  return {
    argv,
    subcommandIndex,
    subcommand,
    rest,
    positionals: rest.filter((token) => !token.startsWith("-")),
    dashIndex,
    preDash: dashIndex === -1 ? rest : rest.slice(0, dashIndex),
    splice: (...extra: string[]) => [...argv.slice(0, subcommandIndex + 1), ...extra, ...rest],
    fail: (detail: string): never => {
      throw new GitPostureError(posture, detail);
    },
  };
}

/** infra 档：argv 透传 + 位置劫持守卫（证据 :365-372，spec R3 表 infra 行）。 */
