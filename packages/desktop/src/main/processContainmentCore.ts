// Windows 孤儿进程围堵的纯逻辑核心（specs/shutdown-keepawake-containment.md R15/R16）。
// spawn 台账 + 首 spawn 效果验证 + 命令摘要净化。不 import electron / node:child_process /
// node:diagnostics_channel，频道接线与平台门控在 processContainment.ts（同 stallSampler
// core/wiring 分层惯例），单测用假子进程直接驱动（tests/process-containment.test.mjs）。

export type ProcessContainmentOutcome =
  | "not_windows"
  | "disabled"
  | "no_capability"
  | "joined"
  | "tracked"
  | "failed";

export type ProcessContainmentVerificationOutcome =
  | "covered"
  | "missed_first_spawn"
  | "check_failed"
  | "gave_up";

export interface SpawnLedgerEntry {
  pid: number;
  parentPid: number;
  /** 净化摘要：spawnfile basename + 前 3 个参数（白名单字符、总长 ≤200）。 */
  command: string;
  spawnedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
}

/** 条件触发项注入点：引入 FFI 依赖后由接线提供，实现 OS 级连坐（spec「登记项」）。 */
export interface ProcessContainmentJobObjectPort {
  join(): void;
  isProcessInJob(pid: number): boolean;
}

export interface ProcessContainmentLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** diagnostics_channel 载荷里 ChildProcess 的最小结构面。 */
export interface ChildProcessLike {
  pid?: number;
  spawnfile?: string;
  spawnargs?: string[];
  once(event: string, listener: (...args: never[]) => void): unknown;
}

export const DEFAULT_MAX_LEDGER_ENTRIES = 256;
/** 验证层检查异常上限：3 次后放弃（防止坏掉的 native 查询把每个 spawn 都拖慢）。 */
export const VERIFICATION_FAILURE_LIMIT = 3;
const COMMAND_SEGMENT_MAX_LENGTH = 64;
const COMMAND_TOTAL_MAX_LENGTH = 200;
const COMMAND_MAX_ARGS = 3;
/** 围堵工具自身的 basename：sweep/exit 钩子必须跳过，防止 taskkill 杀到进行中的 taskkill。 */
export const CONTAINMENT_TOOL_BASENAMES: ReadonlySet<string> = new Set([
  "taskkill",
  "taskkill.exe",
  "kill",
]);

function sanitizeCommandSegment(segment: string): string {
  // 白名单收敛：参数可能携带凭据/URL/任意文本，日志面只留可诊断的安全字符。
  const cleaned = segment
    .replace(/[^A-Za-z0-9 _.:/\\@+=,()-]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > COMMAND_SEGMENT_MAX_LENGTH
    ? `${cleaned.slice(0, COMMAND_SEGMENT_MAX_LENGTH)}…`
    : cleaned;
}

export function summarizeSpawnCommand(
  file: string | undefined,
  args: readonly string[] | undefined,
): string {
  const parts: string[] = [];
  if (typeof file === "string" && file.length > 0) {
    const basename = file.replace(/\\/g, "/").split("/").pop() ?? file;
    parts.push(sanitizeCommandSegment(basename));
  }
  const rest = [...(args ?? [])];
  // Node 的 spawnargs[0] 就是可执行文件本身，去掉重复项避免摘要被完整路径噪声占满。
  if (typeof file === "string" && rest.length > 0 && rest[0] === file) {
    rest.shift();
  }
  for (const arg of rest.slice(0, COMMAND_MAX_ARGS)) {
    if (typeof arg === "string") {
      parts.push(sanitizeCommandSegment(arg));
    }
  }
  return parts.join(" ").slice(0, COMMAND_TOTAL_MAX_LENGTH);
}

export function commandBasename(command: string): string {
  return command.split(" ")[0]?.toLowerCase() ?? "";
}

export interface SpawnLedgerDeps {
  logger: ProcessContainmentLogger;
  now: () => number;
  parentPid: number;
  maxEntries?: number;
  /** 提供即 job 形态：验证层改测 isProcessInJob；台账仍记账（辅助 sweep）。 */
  jobObject?: ProcessContainmentJobObjectPort | null;
}

export interface SpawnLedger {
  /** 台账形态下由接线在 once("spawn") 后调用；pid 必须已就绪。 */
  recordSpawn(pid: number, child: ChildProcessLike): void;
  /** 首 spawn 效果验证（一次性）：covered / missed_first_spawn / 3 次异常 gave_up。 */
  verifyFirstSpawn(pid: number): void;
  entries(): readonly SpawnLedgerEntry[];
  liveEntries(): SpawnLedgerEntry[];
  livePids(): number[];
}

export function createSpawnLedger(deps: SpawnLedgerDeps): SpawnLedger {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_LEDGER_ENTRIES;
  const jobForm = deps.jobObject != null;
  const ledger: SpawnLedgerEntry[] = [];
  const liveByPid = new Map<number, SpawnLedgerEntry>();
  let verificationSettled = false;
  let verificationFailures = 0;

  function evictIfNeeded(): void {
    while (ledger.length > maxEntries) {
      const index = ledger.findIndex((entry) => entry.exitedAt !== null);
      const removed = index >= 0 ? ledger.splice(index, 1)[0] : ledger.shift();
      if (removed === undefined) {
        return;
      }
      if (liveByPid.get(removed.pid) === removed) {
        liveByPid.delete(removed.pid);
      }
      if (index < 0) {
        // 全是活项：淘汰最旧活项并留痕（台账溢出说明围堵面异常，需要人工看日志）。
        deps.logger.warn(
          `[process-containment] ledger overflow, evicted live entry pid=${removed.pid}`,
          {
            event: "process_containment_ledger_overflow",
            outcome: "evicted_live",
            pid: removed.pid,
          },
        );
      }
    }
  }

  return {
    recordSpawn(pid, child) {
      const entry: SpawnLedgerEntry = {
        pid,
        parentPid: deps.parentPid,
        command: summarizeSpawnCommand(child.spawnfile, child.spawnargs),
        spawnedAt: deps.now(),
        exitedAt: null,
        exitCode: null,
      };
      const previous = liveByPid.get(pid);
      if (previous !== undefined) {
        // pid 复用撞上未回填退出的旧项：旧项按丢失退出处理，避免 sweep 误杀新进程。
        previous.exitedAt = deps.now();
        previous.exitCode = null;
        deps.logger.warn(
          `[process-containment] pid ${pid} reused while previous entry still live`,
          {
            event: "process_containment_pid_reuse",
            outcome: "replaced",
            pid,
          },
        );
      }
      ledger.push(entry);
      liveByPid.set(pid, entry);
      evictIfNeeded();
      child.once("exit", (code: number | null) => {
        entry.exitedAt = deps.now();
        entry.exitCode = typeof code === "number" ? code : null;
        if (liveByPid.get(pid) === entry) {
          liveByPid.delete(pid);
        }
      });
    },
    verifyFirstSpawn(pid) {
      if (verificationSettled) {
        return;
      }
      let covered: boolean;
      try {
        covered = jobForm
          ? deps.jobObject?.isProcessInJob(pid) === true
          : liveByPid.has(pid) || ledger.some((entry) => entry.pid === pid);
      } catch (error) {
        verificationFailures += 1;
        const gaveUp = verificationFailures >= VERIFICATION_FAILURE_LIMIT;
        if (gaveUp) {
          verificationSettled = true;
        }
        deps.logger.warn(
          `[process-containment] containment verification check failed for pid=${pid} (${verificationFailures}/${VERIFICATION_FAILURE_LIMIT})`,
          {
            event: "process_containment_verification",
            outcome: gaveUp ? "gave_up" : "check_failed",
            pid,
            failures: verificationFailures,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }
      verificationSettled = true;
      if (covered) {
        deps.logger.info(
          `[process-containment] first child process ${pid} is covered by containment`,
          {
            event: "process_containment_verification",
            outcome: "covered",
            pid,
            form: jobForm ? "job" : "ledger",
          },
        );
      } else {
        // error 级点名：安装顺序错了（围堵接线晚于 main 的首个 spawn），台账/Job 覆盖不到它。
        deps.logger.error(
          `[process-containment] containment became effective after the first spawn — first child process ${pid} is NOT covered`,
          {
            event: "process_containment_verification",
            outcome: "missed_first_spawn",
            pid,
            form: jobForm ? "job" : "ledger",
          },
        );
      }
    },
    entries() {
      return [...ledger];
    },
    liveEntries() {
      return [...liveByPid.values()];
    },
    livePids() {
      return [...liveByPid.keys()];
    },
  };
}
