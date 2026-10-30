// ============================================================
// world-read git 执行叶：git.* 与 world.run 的端口执行侧
// ============================================================
// 拆分自 workflow-world-read.ts（649 行，超出 400 行文件级门禁）。本叶承载 world-read 的
// "命令执行面"：git.* 的 spawn 与姿态网关（argv 构造仍在纯叶 workflow-git-world-read.ts）、
// world.run 的 journal 化命令执行及其位置实参形状校验。
//
// 依赖方向：只依赖基础叶 world-read-files.ts（WorldReadDeps、校验器与共享原语），
// 不反向依赖桶。

import { applyGitPostureGateway } from "@acode/shared";
import { getCliGitInvocationEnvOverlay } from "@acode/shared/node";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@acode/dynamic-workflow";
import {
  GIT_SHOW_PREFIX_ARGV,
  GIT_STATUS_ARGV,
  gitChangedFilesPlan,
  gitDiffArgv,
  gitLogArgv,
  parseGitLog,
  parseGitPathList,
  parseGitShowPrefix,
  parseGitStatusPorcelainV2,
  type GitCommitResult,
  type GitStatusResult,
} from "./workflow-git-world-read.js";
import {
  capExceeded,
  describeArg,
  firstLine,
  requireStringArg,
  type WorldReadDeps,
} from "./world-read-files.js";

// ——————————————————————————————— 内部：git.* world-read ———————————————————————————————

/**
 * 跑一条 git 命令并返回 stdout。argv 由 workflow-git-world-read.ts **构造**（固定数组，
 * 永不 shell 字符串），本方法只负责交给端口并把失败归一成 node 级 `DriverError`。
 *
 * `maxInlineBytes` 由调用方给：git.diff 要用它做上限探测（同 grep 的 cap+1 手法），
 * 其余 op 用一个够大的缺省值。
 */
async function runGit(
  deps: WorldReadDeps,
  op: WorldReadOp,
  argv: readonly string[],
  maxInlineBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const result = await deps.executionPort.run({
    // argv posture 网关 read 档（apps/acode-cli/specs/git-invocation-hardening.md R6
    // 消费点 #7）：git.* 全部是只读形状；网关可能注入 --ignore-submodules=dirty
    // 等确定性旗标（子模块脏内容条目不再出现——输出确定化，与硬化矩阵方向一致）。
    // 拒绝 = 构造层 bug（workflow-git-world-read.ts 的 argv 越出 read 形状），
    // EGITPOSTURE fail-closed 冒泡为节点失败。
    command: { mode: "argv", file: "git", args: [...applyGitPostureGateway("read", argv)] },
    cwd: deps.cwd,
    // git 调用硬化漏斗 overlay 形态（specs/git-invocation-hardening.md 消费点 #7）：
    // 只读 git.* 面防弹窗挂死/hooks 停用/防串仓。world.run 的任意命令面不叠加
    // （不是 git 漏斗消费方，spec R2）。
    env: getCliGitInvocationEnvOverlay(),
    outputLimit: { maxInlineBytes },
  }, deps.signal === undefined ? undefined : { signal: deps.signal });
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    // git 缺失、非仓库、坏 ref 都走这里。归一成**可 catch 的** DriverError 而不是 run 级
    // 失败，使脚本可以通过 try/catch 改用 files.glob。
    const detail = firstLine(result.stderr.text) || firstLine(result.stdout.text) || result.status;
    throw new WorkflowError(
      "DriverError",
      `git ${argv.join(" ")} failed (${result.status}, exit=${result.exitCode ?? "n/a"}): ${detail}`,
    );
  }
  return {
    text: result.stdout.text,
    bytes: result.stdout.bytes,
    truncated: result.stdout.truncated,
  };
}

/**
 * 工作区相对仓库根的前缀（仓库根时为空串）。线上的路径一律是仓库根相对的，剥掉这个前缀
 * 才是 facade 承诺的工作区相对路径（见 workflow-git-world-read.ts 顶部的输出契约 2）。
 *
 * 每次读取都问一次而不做缓存：一次 `rev-parse` 是毫秒级的，而世界读取按 site×ordinal
 * 只发生一次并落 journal，不在任何热路径上。换来的是这一侧完全无状态。
 */
async function gitWorkspacePrefix(deps: WorldReadDeps, op: WorldReadOp): Promise<string> {
  const out = await runGit(deps, op, GIT_SHOW_PREFIX_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitShowPrefix(out.text);
}

export async function gitChangedFiles(deps: WorldReadDeps, base: string | undefined): Promise<string[]> {
  // 先构造 argv：base 不合法时应当在**跑任何 git 之前**就拒绝。
  const plans = gitChangedFilesPlan(base);
  const prefix = await gitWorkspacePrefix(deps, "git-changed-files");
  const paths: string[] = [];
  for (const plan of plans) {
    const out = await runGit(deps, "git-changed-files", plan.argv, GIT_TEXT_OUTPUT_BYTES);
    paths.push(...parseGitPathList(out.text, prefix));
  }
  // 并集去重并排序：两条命令可以报出同一个路径，且 journal 存的是这个值，所以它必须只
  // 依赖内容、不依赖两条命令谁先返回。
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function gitDiff(
  deps: WorldReadDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  // cap + 1：同 grep 的理由——"正好 cap 字节"与"被截断"必须可区分。
  const out = await runGit(deps, "git-diff", gitDiffArgv(base, path), cap + 1);
  if (out.bytes > cap || out.truncated) {
    throw capExceeded(
      `git.diff: output is ${out.bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return out.text;
}

export async function gitStatus(deps: WorldReadDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps, "git-status");
  const out = await runGit(deps, "git-status", GIT_STATUS_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitStatusPorcelainV2(out.text, prefix);
}

export async function gitLog(deps: WorldReadDeps, count: number): Promise<GitCommitResult[]> {
  const out = await runGit(deps, "git-log", gitLogArgv(count), GIT_TEXT_OUTPUT_BYTES);
  return parseGitLog(out.text);
}

// ——————————————————————————————— 内部：world.run ———————————————————————————————

/** `world.run` 的返回值。权威声明是 FACADE_DTS 里的 `declare interface WorldRunResult`。 */
export interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `world.run(cmd, args?, opts?)`：journal 化命令执行。
 *
 * 与 `git.*` 的三个刻意差异，每个都是契约而非疏忽：
 *   1. **非零退出是值**。执行适配器把非零退出映射成 `status:"failed"` 且 `error` 缺席
 *      （node-execution-adapter-results.ts 的 statusFromExit/statusFailure），据此与
 *      spawn 失败 / 超时可靠区分。门控循环的常态路径不该走异常控制流。
 *   2. **cmd 复验**。授权发生在编译期字面量 + 提交确认；这里对 declaredRunCommands 的
 *      比对只防接线错误（lowering / 线协议把别的字符串送了进来），且 fail-closed——
 *      集合缺席与命令不在集合里同样拒绝。
 *   3. **超时无上限**。缺省 300s，脚本可任意加大（为真正长跑的测试设计）；
 *      cancel 仍是最后的控制。
 *
 * stdout/stderr 各 256KB，cap+1 探测（`maxInlineBytes` 按两 cap 之大者 +1，随后逐流判定），
 * 超限拒绝不截断——message 给出可操作的下一步，与 grep/diff 同一 house policy。
 */
export async function worldRun(deps: WorldReadDeps, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = worldRunArgs(args);

  const declared = deps.declaredRunCommands;
  if (declared === undefined || !declared.has(cmd)) {
    // fail-closed 的接线防御：能到这里的 cmd 理应经过编译期字面量收集与确认。
    throw new WorkflowError(
      "DriverError",
      `world.run: command '${cmd}' is not in the declared set of commands (a wiring error).`,
    );
  }

  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const result = await deps.executionPort.run(
    {
      command: { mode: "argv", file: cmd, args: argv },
      cwd: deps.cwd,
      timeoutMs,
      outputLimit: { maxInlineBytes: Math.max(stdoutCap, stderrCap) + 1 },
    },
    deps.signal === undefined ? undefined : { signal: deps.signal },
  );

  if (result.status === "timed_out") {
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the work.`,
    );
  }
  // completed（exit 0）与 failed-无-error（非零退出）都是**跑完了的观察**，交出值；
  // 其余（spawn_error / cancelled / 带 error 的 failed，如 output_limit）是观察本身没成立。
  const ranToExit =
    result.status === "completed" ||
    (result.status === "failed" &&
      result.error === undefined &&
      typeof result.exitCode === "number");
  if (!ranToExit) {
    const detail = result.error?.message ?? (firstLine(result.stderr.text) || result.status);
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' did not run to completion (${result.status}): ${detail}`,
    );
  }

  if (result.stdout.bytes > stdoutCap || result.stdout.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stdout is ${result.stdout.bytes} bytes, over the ${stdoutCap}-byte cap. ` +
        `Quiet the output (e.g. --quiet), or write a file and files.read a summary.`,
    );
  }
  if (result.stderr.bytes > stderrCap || result.stderr.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stderr is ${result.stderr.bytes} bytes, over the ${stderrCap}-byte cap. ` +
        `Reduce the diagnostics, or write a file and files.read a summary.`,
    );
  }

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * `world.run` 的实参形状：`[cmd: string, args?: string[], opts?: { timeoutMs?: number }]`。
 * 与 {@link worldReadStringArgs} 同一纪律（大声失败、绝不强转），但形状（数组 + 选项袋）
 * 超出了 string 序列助手的表达面，所以单列。
 */
function worldRunArgs(args: unknown[]): { cmd: string; argv: string[]; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw new WorkflowError(
      "DriverError",
      `world.run takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireStringArg("run", args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: argument 2 (args) must be an array of strings, got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw new WorkflowError(
          "DriverError",
          `world.run: args[${index}] must be a string, got ${describeArg(item)}. Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  let timeoutMs: number = WORLD_READ_CAPS.runDefaultTimeoutMs;
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: arg 3 (opts) must be an options object or omitted, got ${describeArg(rawOpts)}.`,
      );
    }
    const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
    if (rawTimeout !== undefined) {
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
        throw new WorkflowError(
          "DriverError",
          `world.run: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
        );
      }
      // 刻意无上限钳制：为真正长跑的测试设计；cancel 是最后的控制。
      timeoutMs = rawTimeout;
    }
  }

  return { argv, cmd, timeoutMs };
}

/**
 * git 文本输出（路径列表 / status / log）的 inline 上限。这些 op 没有 spec 级上限，但一个
 * 无界 buffer 不是选项——100 个 commit 与一棵工作树的路径列表离 4MB 有几个数量级。
 * git.diff **不**用这个值：它有自己的 512KB 上限，且要靠 cap+1 做溢出探测。
 */
const GIT_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;
