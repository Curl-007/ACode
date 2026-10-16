/**
 * 深链 argv 字节预算 + 防循环 relaunch（specs/desktop-startup-hardening.md §4a）。
 *
 * 外部应用/协议处理器构造的深链 argv 可能超出 OS 命令行上限（Windows
 * CreateProcess 32767 字符），一旦超限，任何需要带 argv 重启自身的路径
 * （app.relaunch、更新器重启）都会静默失败或截断出畸形参数。这里在启动早期
 * 对深链类参数做预算内截断后主动 relaunch，并用防循环标志保证只做一次。
 */
import { DEEP_LINK_SCHEME } from "./desktopDeepLinkUrl.js";

/** argv 总字节预算（与还原证据同值；Windows 上限内留安全余量）。 */
export const DEEP_LINK_ARGV_BYTE_BUDGET = 26624;
/** 防循环 relaunch 标志：第二次启动带着它即不再 relaunch。 */
export const DEEP_LINK_ARGV_RELAUNCH_FLAG = "--acode-relaunched-after-deep-link-cap";

/** 可截断参数前缀：只有深链 URL 可以截断，路径/开关值截断会改变语义。 */
const TRUNCATABLE_DEEP_LINK_PREFIXES: readonly string[] = [`${DEEP_LINK_SCHEME}:`];

export function isTruncatableDeepLinkArg(arg: string): boolean {
  const lowered = arg.toLowerCase();
  return TRUNCATABLE_DEEP_LINK_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/** 单个 argv 的字节成本：UTF-8 字节数 + 1（NUL 分隔符）。 */
export function argvByteCost(arg: string): number {
  return Buffer.byteLength(arg, "utf8") + 1;
}

export function totalArgvByteCost(argv: readonly string[]): number {
  return argv.reduce((total, arg) => total + argvByteCost(arg), 0);
}

/**
 * UTF-8 续字节感知截断：截断点若落在多字节字符中间，回退跳过全部续字节
 * （0b10xxxxxx），绝不产出半个字符；再剥除尾部残缺 percent-escape
 * （截断可能留下 `%4` 这类半个转义，会让下游 decodeURIComponent 抛错）。
 */
export function truncateUtf8Arg(arg: string, maxBytes: number): string {
  const bytes = Buffer.from(arg, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return bytes.toString("utf8", 0, end).replace(/%[0-9a-fA-F]?$/, "");
}

/**
 * 预算收口：argv 总成本 ≤ 预算 → null（无需处理）。否则非深链参数原样保留，
 * 深链参数在剩余预算内截断；截断后不再是深链形态（截没了）则整参丢弃。
 * 收口后仍超预算（非深链参数自身就超限）→ null（uncappable，调用方照常启动）。
 */
export function capDeepLinkArgv(argv: readonly string[]): string[] | null {
  if (totalArgvByteCost(argv) <= DEEP_LINK_ARGV_BYTE_BUDGET) {
    return null;
  }

  let remainingBudget =
    DEEP_LINK_ARGV_BYTE_BUDGET -
    totalArgvByteCost(argv.filter((arg) => !isTruncatableDeepLinkArg(arg)));
  const capped: string[] = [];
  for (const arg of argv) {
    if (!isTruncatableDeepLinkArg(arg)) {
      capped.push(arg);
      continue;
    }
    const candidate =
      argvByteCost(arg) <= remainingBudget ? arg : truncateUtf8Arg(arg, remainingBudget - 1);
    if (isTruncatableDeepLinkArg(candidate)) {
      remainingBudget -= argvByteCost(candidate);
      capped.push(candidate);
    }
  }

  return totalArgvByteCost(capped) > DEEP_LINK_ARGV_BYTE_BUDGET ? null : capped;
}

export type DeepLinkArgvCapOutcome =
  | "within-budget"
  | "already-relaunched"
  | "uncappable"
  | "relaunched";

export interface MaybeRelaunchWithCappedDeepLinkArgvOptions {
  /** 完整 process.argv（含 argv[0] 可执行路径）。 */
  argv: readonly string[];
  relaunch: (options: { args: string[] }) => void;
  exit: (code: number) => void;
  warn?: (message: string) => void;
}

/**
 * 启动早期调用（必须早于一切 process.argv 消费点与 requestSingleInstanceLock，
 * 接线位点见 spec）。返回 relaunched=true 时本进程已请求 exit(0)，调用方必须
 * 立即阻断后续启动逻辑。
 */
export function maybeRelaunchWithCappedDeepLinkArgv(
  options: MaybeRelaunchWithCappedDeepLinkArgvOptions,
): { relaunched: boolean; outcome: DeepLinkArgvCapOutcome } {
  const warn = options.warn ?? (() => {});
  const launchArgv = options.argv.slice(1);

  if (options.argv.includes(DEEP_LINK_ARGV_RELAUNCH_FLAG)) {
    // 防循环：带标志的第二次启动即使仍超预算也不再 relaunch，照常启动。
    if (totalArgvByteCost(launchArgv) > DEEP_LINK_ARGV_BYTE_BUDGET) {
      warn("relaunch 后 argv 仍超预算，按防循环标志照常启动");
    }
    return { relaunched: false, outcome: "already-relaunched" };
  }

  const capped = capDeepLinkArgv(launchArgv);
  if (capped === null) {
    const uncappable = totalArgvByteCost(launchArgv) > DEEP_LINK_ARGV_BYTE_BUDGET;
    if (uncappable) {
      warn("深链 argv 超预算且非深链参数自身超限，无法截断，照常启动");
    }
    return { relaunched: false, outcome: uncappable ? "uncappable" : "within-budget" };
  }

  warn("启动 argv 中的深链参数超出字节预算，截断后 relaunch");
  options.relaunch({ args: [...capped, DEEP_LINK_ARGV_RELAUNCH_FLAG] });
  options.exit(0);
  return { relaunched: true, outcome: "relaunched" };
}
