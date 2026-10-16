/**
 * argv 开关拒启表（specs/desktop-startup-hardening.md §1）。
 *
 * 打包态命令行上出现调试/网络覆写类 Chromium 开关即拒绝启动——这些开关能把
 * CDP 调试面、证书校验、DNS/hosts 覆写、子进程替换等能力从外部塞进应用进程，
 * 绕过壳层全部加固。dev 态放行但 warn（e2e-smoke 依赖 --remote-debugging-port=0）；
 * 打包态持有有效签名调试令牌（debugTokenGate）时受控放行。
 */
import { writeSync } from "node:fs";

/**
 * 16 个调试/网络覆写类开关（闭集）。命名以还原证据中的真实 Chromium 开关名为准：
 * 需求转述里的 `ppapi-loader-cmd-prefix` 在 Chromium 中不存在，对应真实开关是
 * `ppapi-plugin-launcher`（偏离已在 spec §1 与交付报告中注明）。
 */
export const DENIED_BOOT_SWITCHES: readonly string[] = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "ignore-certificate-errors",
  "host-resolver-rules",
  "host-rules",
  "disable-web-security",
  "log-net-log",
  "net-log-capture-mode",
  "ssl-key-log-file",
  "renderer-cmd-prefix",
  "utility-cmd-prefix",
  "gpu-launcher",
  "zygote-cmd-prefix",
  "ppapi-plugin-launcher",
  "nacl-loader-cmd-prefix",
  "browser-subprocess-path",
];

/**
 * 匹配前归一化：去掉一个前导 `--` / `-` / `/` 前缀 → 小写 → 截断第一个 `=` 起的内容。
 * 三种前缀形态分别覆盖 POSIX 长/短开关与 Windows 服务侧 `/switch` 习惯写法。
 */
export function normalizeBootSwitchArg(arg: string): string {
  return arg
    .replace(/^(?:--|-|\/)/, "")
    .toLowerCase()
    .split("=", 1)[0]!;
}

/** 返回命中的归一化开关名（去重、保序）；开关值一律不进结果（值可能含路径/规则详情）。 */
export function findDeniedBootSwitches(argv: readonly string[]): string[] {
  const hits: string[] = [];
  for (const arg of argv) {
    const normalized = normalizeBootSwitchArg(arg);
    for (const denied of DENIED_BOOT_SWITCHES) {
      // startsWith 语义与证据一致：命中后不再对该 argv 匹配其余表项。
      if (normalized.startsWith(denied) && !hits.includes(denied)) {
        hits.push(denied);
        break;
      }
    }
  }
  return hits;
}

export type BootSwitchDenylistAction = "allow" | "allow-with-warning" | "refuse";

export interface BootSwitchDenylistDecision {
  action: BootSwitchDenylistAction;
  /** 命中的归一化开关名（action=allow 时为空）。 */
  deniedSwitches: string[];
}

export interface ResolveBootSwitchDenylistDecisionOptions {
  argv: readonly string[];
  isPackaged: boolean;
  /** 签名调试令牌是否有效（debugTokenGate 的启动期决策）。 */
  tokenValid: boolean;
}

export function resolveBootSwitchDenylistDecision(
  options: ResolveBootSwitchDenylistDecisionOptions,
): BootSwitchDenylistDecision {
  const deniedSwitches = findDeniedBootSwitches(options.argv);
  if (deniedSwitches.length === 0) {
    return { action: "allow", deniedSwitches };
  }
  if (!options.isPackaged || options.tokenValid) {
    // dev 态放行（e2e/开发调试依赖）；打包态仅在持有有效签名令牌时受控放行。
    return { action: "allow-with-warning", deniedSwitches };
  }
  return { action: "refuse", deniedSwitches };
}

/** 拒绝原因文案（自撰；stderr 直写，不经 logger——此时 logger 可能尚未就绪）。 */
export function formatBootRefusalMessage(deniedSwitches: readonly string[]): string {
  return `ACode: 检测到调试或网络覆写开关，拒绝启动（refusing to start: debugging/network-override switches present: ${deniedSwitches.join(", ")}）。\n`;
}

export interface EnforceBootSwitchDenylistOptions {
  decision: BootSwitchDenylistDecision;
  /** 注入点（测试用）；缺省 fd 2 直写 + process.exit。 */
  writeStderr?: (message: string) => void;
  exit?: (code: number) => void;
  warn?: (message: string) => void;
}

/**
 * 执行拒启决策。refuse → stderr 写拒绝原因 + exit(1)（writeSync 包 try/catch：
 * stderr 不可写不能吞掉「拒绝启动」本身）。allow-with-warning → warn 一条键名级日志。
 */
export function enforceBootSwitchDenylist(options: EnforceBootSwitchDenylistOptions): void {
  const { decision } = options;
  if (decision.action === "allow") {
    return;
  }

  if (decision.action === "allow-with-warning") {
    const warn =
      options.warn ??
      ((message: string) => {
        try {
          console.warn(message);
        } catch {
          // EPIPE：诊断输出失败不影响放行结果。
        }
      });
    warn(
      `[boot-denylist] 命令行携带调试/网络覆写开关，当前形态放行: ${decision.deniedSwitches.join(", ")}`,
    );
    return;
  }

  const message = formatBootRefusalMessage(decision.deniedSwitches);
  const writeStderr =
    options.writeStderr ??
    ((text: string) => {
      try {
        writeSync(2, text);
      } catch {
        // stderr 不可写也要继续 exit(1)：拒绝启动优先于诊断可达。
      }
    });
  writeStderr(message);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  exit(1);
}
