/**
 * 启动卫生件 + 打包态 boot env 清洗单一漏斗
 * （specs/desktop-startup-hardening.md §0/§1/§2/§5）。
 *
 * 本模块被设计为 index.ts 的第一行 import（接线需求见 spec）：
 * - import 副作用即执行「一行卫生件 + env 清洗 + 拒启表」三件套；
 * - 只允许依赖 electron(app) 与 node:* 及同批 boot 模块，绝不 import
 *   @acode/services——services 的 paths.ts 在模块加载期缓存 env，漏斗必须先于它执行，
 *   ACODE_DATA_BASE_DIR 等键的删除才真正生效；
 * - 未接第一行时，漏斗仍会经 desktopRuntimeEnv.ts 的 import 触发（生效但时序较晚）。
 */
import { app } from "electron";
import {
  enforceBootSwitchDenylist,
  resolveBootSwitchDenylistDecision,
  type BootSwitchDenylistAction,
} from "./bootSwitchDenylist.js";
import {
  getBootDebugTokenDecision,
  type DebugTokenRejectionReason,
} from "./debugTokenGate.js";

/**
 * 打包态 + 无有效签名令牌时从 process.env 删除的键（闭集，spec §2）：
 * TLS 会话密钥外泄面、运行时「自称测试」键（E2E/test hook 门控升级）、
 * 身份/数据目录覆写键，以及 CUA dev 覆盖旗标（specs/cua-enablement-authority.md R2：
 * ACODE_CUA_DEV_MODE / ACODE_CUA_PRODUCT_HELPER 是 dev 链覆盖旋钮，绝不能在 signed
 * release 上把「电脑操控」从设置页开关手里夺走；本模块是 main 第一行 import，删除
 * 先于任何 CUA 消费点装配）。键名可入诊断日志，值绝不入。
 */
export const PACKAGED_BOOT_ENV_DROP_KEYS: readonly string[] = [
  "SSLKEYLOGFILE",
  "sslkeylogfile",
  "ACODE_ENV",
  "ACODE_E2E_RUN_ID",
  "ACODE_E2E_COVERAGE",
  "ACODE_E2E_ARTIFACT_DIR",
  "ACODE_E2E_RUNTIME_LOG_DIR",
  "ACODE_DESKTOP_USER_DATA_DIR",
  "ACODE_DESKTOP_HOME_DIR",
  "ACODE_DESKTOP_SESSION_DATA_DIR",
  "ACODE_DESKTOP_APPLICATION_NAME",
  "ACODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
  "ACODE_DATA_BASE_DIR",
  "ACODE_CUA_DEV_MODE",
  "ACODE_CUA_PRODUCT_HELPER",
];

export interface BootEnvironmentDecision {
  isPackaged: boolean;
  tokenPresent: boolean;
  tokenValid: boolean;
  tokenRejectionReason?: DebugTokenRejectionReason;
  /** 打包态被忽略（删除）的 env 键名——只记键名，绝不记值。 */
  ignoredEnvKeys: string[];
  bootSwitchAction: BootSwitchDenylistAction;
  deniedBootSwitches: string[];
}

let earlyProcessHygieneApplied = false;

/**
 * 一行卫生件（spec §5，幂等）：
 * 1. NoDefaultCurrentDirectoryInExePath=1 —— Windows DLL 搜索序去掉「当前目录」，
 *    缓解 DLL 劫持；主要经子进程继承生效，必须设在最早入口模块。
 * 2. Error.stackTraceLimit=20 —— main↔host↔agent 异步链默认 10 帧经常截不到调用方。
 * EPIPE 吞掉已由 logger.ts 双层实现，本模块不重复处理。
 */
export function applyEarlyProcessHygiene(): void {
  if (earlyProcessHygieneApplied) {
    return;
  }
  earlyProcessHygieneApplied = true;
  process.env.NoDefaultCurrentDirectoryInExePath ??= "1";
  Error.stackTraceLimit = 20;
}

export interface SanitizePackagedBootEnvironmentOptions {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  tokenValid: boolean;
}

/**
 * env 清洗纯函数：仅「打包 + 无有效令牌」态删除闭集键；返回被删键名（诊断用）。
 * dev/未打包与持令牌形态一律原样保留——现有 ACODE_ENV=test 门控与 e2e 脚本零影响。
 */
export function sanitizePackagedBootEnvironment(
  options: SanitizePackagedBootEnvironmentOptions,
): string[] {
  if (!options.isPackaged || options.tokenValid) {
    return [];
  }
  const dropped: string[] = [];
  for (const key of PACKAGED_BOOT_ENV_DROP_KEYS) {
    if (options.env[key] !== undefined) {
      delete options.env[key];
      dropped.push(key);
    }
  }
  return dropped;
}

function isPackagedRuntime(): boolean {
  // 不经 desktopElectronApp/services：保持本模块的 boot 早期零重依赖（spec §0 时序约束）。
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

let bootEnvironmentDecision: BootEnvironmentDecision | undefined;

/**
 * 启动期一次性 boot 门（memoized）：令牌决策 → env 清洗 → 拒启表执行。
 * 三件套共享同一份令牌决策，避免多处各自读 env 造成决策漂移。
 */
export function runBootEnvironmentGate(): BootEnvironmentDecision {
  if (bootEnvironmentDecision) {
    return bootEnvironmentDecision;
  }

  const isPackaged = isPackagedRuntime();
  const tokenDecision = getBootDebugTokenDecision();
  const ignoredEnvKeys = sanitizePackagedBootEnvironment({
    env: process.env,
    isPackaged,
    tokenValid: tokenDecision.tokenValid,
  });
  if (ignoredEnvKeys.length > 0) {
    try {
      // 只输出键名（「已忽略」诊断），值绝不落任何输出面。
      console.warn(`[startup-sanitation] packaged boot ignored env keys: ${ignoredEnvKeys.join(",")}`);
    } catch {
      // EPIPE：诊断失败不影响清洗结果。
    }
  }

  const denylistDecision = resolveBootSwitchDenylistDecision({
    argv: process.argv,
    isPackaged,
    tokenValid: tokenDecision.tokenValid,
  });
  enforceBootSwitchDenylist({ decision: denylistDecision });

  bootEnvironmentDecision = {
    isPackaged,
    tokenPresent: tokenDecision.tokenPresent,
    tokenValid: tokenDecision.tokenValid,
    ...(tokenDecision.rejectionReason
      ? { tokenRejectionReason: tokenDecision.rejectionReason }
      : {}),
    ignoredEnvKeys,
    bootSwitchAction: denylistDecision.action,
    deniedBootSwitches: denylistDecision.deniedSwitches,
  };
  return bootEnvironmentDecision;
}

/** 读取启动期 boot 决策（供 index.ts 落 logger、诊断出口消费）。 */
export function getBootEnvironmentDecision(): BootEnvironmentDecision {
  return runBootEnvironmentGate();
}

export function resetBootEnvironmentGateForTest(): void {
  bootEnvironmentDecision = undefined;
}

// import 副作用：最早入口即执行（幂等，重复 import 无副作用叠加）。
applyEarlyProcessHygiene();
runBootEnvironmentGate();
