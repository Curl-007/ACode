// AgentTeams 队长验收面的命令执行基座（R1.2 / R1.3）。
//
// 与 worktree/git.ts 同一惯例：execFile 无 shell 拼接、windowsHide、错误不抛给调用方而按
// 结果分类（exitCode / timedOut / truncated）。Windows 下 `.cmd`/`.bat` 无法被 execFile
// 直接启动，这里是唯一允许的 `cmd.exe /d /s /c` hop（argv 作为独立元素交给 Node 引号规则，
// 不做字符串拼接）。git 是 `.exe`，所以 git.ts 无需该分支；pnpm/npm 则是 `.cmd` shim。
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** run_checks 硬上限（冻结，R1.2）：与宿主 .mcp.json timeoutMs=600000 同刻会被传输层中断。 */
export const CHECK_TIMEOUT_LIMIT_MS = 600_000;
/** run_checks 实跑超时（8 分钟）：对齐成员等活 WAIT_MAX_MS 先例（OQ-5）。 */
export const CHECK_TIMEOUT_MS = 480_000;
/** run_checks 单流（stdout / stderr）输出上限；超限整段丢弃（EI-97）。 */
export const MAX_CHECK_OUTPUT_BYTES = 256 * 1024;

/** 机器声明行前缀：`$` + 一个空格；其余行是散文（OQ-4）。 */
const DECLARATION_PREFIX = "$ ";

/** win32 PATH 解析时追加的扩展名候选（按序）。 */
const WIN_EXTENSIONS: readonly string[] = [".exe", ".cmd", ".bat"];

/**
 * 规范化命令文本为 token 序列（声明行与 command 同一函数，纯函数，R1.2）：
 * trim → 连续空格/制表符折叠为单个空格 → 切分；**不做引号解析**。
 */
export function normalizeArgv(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/[ \t]+/u);
}

/**
 * 抽出 `verify` 中的机器声明行：只取以 `$ ` 开头的行，其余是散文（结果叙述）。
 * 返回每行规范化后的 token 序列；`verify` 非该语法 / 无 `$ ` 行 → 空声明集。
 */
export function parseVerifyDeclarations(verify: string | undefined): string[][] {
  if (!verify) return [];
  const declarations: string[][] = [];
  for (const rawLine of verify.replace(/\r\n/gu, "\n").split("\n")) {
    if (!rawLine.startsWith(DECLARATION_PREFIX)) continue;
    const tokens = normalizeArgv(rawLine.slice(DECLARATION_PREFIX.length));
    if (tokens.length > 0) declarations.push(tokens);
  }
  return declarations;
}

/** token 禁字符集（R1.2 fail-closed）：shell 元字符 / 通配 / 引号 / 控制空白一律拒绝。 */
const FORBIDDEN_TOKEN_CHARS = /["'`$&|<>^%*?()[\]{};!~\n\r\t]/u;

/** 任一 token 含禁字符 → true（该命令/声明不可执行）。 */
export function hasForbiddenTokenChars(tokens: readonly string[]): boolean {
  return tokens.some((token) => FORBIDDEN_TOKEN_CHARS.test(token));
}

/** 两条 token 序列逐项精确相等（大小写敏感，v1 无通配）。 */
export function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((token, index) => token === right[index]);
}

export interface ResolvedCommand {
  /** execFile 的可执行文件；Windows `.cmd`/`.bat` 时为 cmd.exe。 */
  readonly file: string;
  /** 传给 execFile 的参数（`.cmd`/`.bat` hop 时为 ["/d","/s","/c", <abs>, ...rest]）。 */
  readonly args: string[];
  /** true = 走了唯一允许的 cmd.exe hop（Windows 脚本 shim）。 */
  readonly viaShellHop: boolean;
  /** 解析出的命令绝对路径（诊断 / 测试断言用）。 */
  readonly resolvedPath: string;
}

export interface ResolveCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly pathEnv?: string;
  readonly extensions?: readonly string[];
  readonly comspec?: string;
  readonly exists?: (path: string) => boolean;
  readonly isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 含路径分隔符：按给定路径解析（win32 无扩展名时补扩展名候选），必须存在。 */
function resolveGivenPath(
  name: string,
  win: boolean,
  options: ResolveCommandOptions,
  exists: (path: string) => boolean,
): string | undefined {
  const candidates = [name];
  if (win && !WIN_EXTENSIONS.includes(extname(name).toLowerCase())) {
    for (const ext of options.extensions ?? WIN_EXTENSIONS) candidates.push(`${name}${ext}`);
  }
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (exists(absolute)) return absolute;
  }
  return undefined;
}

/** 在 PATH 内按序解析；win32 每目录追加扩展名候选（扩展名比对大小写不敏感）。 */
function searchPath(
  name: string,
  win: boolean,
  options: ResolveCommandOptions,
  exists: (path: string) => boolean,
): string | undefined {
  const rawPath = options.pathEnv ?? process.env.PATH ?? "";
  const dirs = rawPath.split(win ? delimiter : ":").filter((dir) => dir.length > 0);
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  for (const dir of dirs) {
    if (win) {
      for (const ext of options.extensions ?? WIN_EXTENSIONS) {
        const candidate = join(dir, `${name}${ext}`);
        if (exists(candidate)) return candidate;
      }
      continue;
    }
    const candidate = join(dir, name);
    if (exists(candidate) && isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 解析命令为可直接 execFile 的形态（R1.3）：
 * 1. `argv[0]` 含分隔符 → 按给定路径；否则在 PATH 内按序尝试（win32 追加扩展名候选）。
 * 2. 解析到 `.exe`（或 posix 可执行文件）→ 直跑。
 * 3. 解析到 `.cmd`/`.bat` → 唯一允许的 shell hop：`cmd.exe /d /s /c <abs> ...rest`。
 * 4. 解析不到 → undefined（上层报 `invalid_input`，不执行）。
 */
export function resolveCommand(
  argv: readonly string[],
  options: ResolveCommandOptions = {},
): ResolvedCommand | undefined {
  const name = argv[0];
  if (!name) return undefined;
  const platform = options.platform ?? process.platform;
  const win = platform === "win32";
  const exists = options.exists ?? existsSync;
  const rest = argv.slice(1);
  const found =
    name.includes("/") || name.includes("\\")
      ? resolveGivenPath(name, win, options, exists)
      : searchPath(name, win, options, exists);
  if (!found) return undefined;
  const lower = found.toLowerCase();
  if (win && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = options.comspec ?? process.env.ComSpec ?? "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/s", "/c", found, ...rest],
      viaShellHop: true,
      resolvedPath: found,
    };
  }
  return { file: found, args: rest, viaShellHop: false, resolvedPath: found };
}

export interface BoundedCommandResult {
  /** 退出码：正常为 0；失败取数值 code（非数值如被杀 / 溢出按 1，与 git.ts 惯例一致）。 */
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** null = 该流超限被整段丢弃（不返回被截断的部分）。 */
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly truncated: boolean;
  readonly desync: boolean;
  readonly durationMs: number;
}

interface ExecFailure {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

function classifyFailure(error: unknown, durationMs: number): BoundedCommandResult {
  const typed = error as ExecFailure;
  const stdoutText = typeof typed.stdout === "string" ? typed.stdout : "";
  const stderrText = typeof typed.stderr === "string" ? typed.stderr : "";
  const message = typeof typed.message === "string" ? typed.message : "";
  const exitCode = typeof typed.code === "number" ? typed.code : 1;
  const maxBufferHit = typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  if (maxBufferHit) {
    // 哪个流溢出就以消息为准整段丢弃；两个都识别不出时按都丢弃（fail-closed）。
    const stdoutOverflow = /stdout maxBuffer/iu.test(message);
    const stderrOverflow = /stderr maxBuffer/iu.test(message);
    const discardBoth = !stdoutOverflow && !stderrOverflow;
    return {
      exitCode,
      timedOut: false,
      stdout: stdoutOverflow || discardBoth ? null : stdoutText,
      stderr: stderrOverflow || discardBoth ? null : stderrText,
      truncated: true,
      desync: true,
      durationMs,
    };
  }
  return {
    exitCode,
    timedOut: typed.killed === true,
    stdout: stdoutText,
    stderr: stderrText,
    truncated: false,
    desync: false,
    durationMs,
  };
}

/** 单流 `maxBuffer` + `timeout` 的有界执行；错误不抛给调用方，按结果分类。 */
export async function runBoundedCommand(params: {
  command: ResolvedCommand;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<BoundedCommandResult> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(params.command.file, params.command.args, {
      cwd: params.cwd,
      maxBuffer: params.maxOutputBytes,
      timeout: params.timeoutMs,
      killSignal: "SIGTERM",
      windowsHide: true,
    });
    return {
      exitCode: 0,
      timedOut: false,
      stdout,
      stderr,
      truncated: false,
      desync: false,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return classifyFailure(error, Date.now() - started);
  }
}