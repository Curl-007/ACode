import { writeFile } from "node:fs/promises";
import { arch as osArch, platform as osPlatform } from "node:os";
import { ACODE_COMMIT, ACODE_VERSION, LOCAL_DIAGNOSTIC_MAX_BYTES } from "@acode/shared";
import type { LocalDiagnosticFacts, SaveDiagnosticReportResult } from "@acode/shared";

/**
 * Desktop 端本地诊断事实采集与报告保存（U12）。
 * 契约真源：packages/shared/specs/local-diagnostic-report.md；Desktop 本地不变量见
 * packages/desktop/specs/local-diagnostic-report-desktop.md。
 *
 * 为什么在 main：build/env 事实的所有者是 Desktop main —— `process.platform`/`process.arch`
 * 是 Node 运行时事实（renderer 与 Web 都无法可靠得知），`ACODE_VERSION`/`ACODE_COMMIT` 是
 * bundler 注入的构建常量（与 about.ts 同源，不新开第二真源）。
 *
 * 两条承重不变量：
 * 1. **白名单 + 结构性排除**：只产出 schema 允许的字段。用户名/主机名/原始 workspacePath/
 *    内部 endpoint 不进任何字段——注意 about.ts 的 AboutSnapshot 含 `hostname`，本模块**不复用**
 *    该快照，正是为了不把它带进用户可分发的报告。
 * 2. **零副作用**：只读进程内既有事实，不 fetch、不 spawn、不触发 provider probe、不重连采集。
 */

/** 采集所需的最小依赖面（全部注入，测试无需 Electron）。 */
export interface DesktopDiagnosticDeps {
  /** 应用语言偏好；权威源是 main 的 currentApplicationLocale()，不读 navigator。 */
  locale: () => string;
  /**
   * 构建事实来源（默认 shared 的 bundler 注入常量）。抽成可注入是为了让测试能覆盖
   * 「真实版本在场」与「回退值须省略」两条路径——测试环境无 define 注入，常量恒为回退值。
   */
  buildVersion?: () => string | undefined;
  buildCommit?: () => string | undefined;
  /** OS/架构来源（默认 Node 运行时事实）；可注入以便断言字段确实来自这里而非猜测。 */
  os?: () => string;
  arch?: () => string;
}

/**
 * 构建常量的非事实回退值（shared/version.ts:8-12 在未注入 define 的环境返回它们）。
 * 回退值不是事实，省略而非上报——否则报告会声称一个假版本（契约产品规则 2）。
 */
const NON_FACT_VERSION_VALUES = new Set(["0.0.0-dev", "unknown", ""]);

function realBuildValue(value: string | undefined): string | undefined {
  if (!value || NON_FACT_VERSION_VALUES.has(value)) {
    return undefined;
  }
  return value;
}

/**
 * 采集 Desktop 拥有的事实 DTO。connection 组标 unavailable 并省略：
 * Desktop 的交付档位/重连事实属于 renderer 与 Host 的连接层，main 不持有其状态，
 * 按「只报自己拥有的事实、不新建状态副本」（AGENTS.md）不在此猜测——UI 侧可从 renderer
 * 连接层补充该组。
 */
export function collectDesktopDiagnosticFacts(deps: DesktopDiagnosticDeps): LocalDiagnosticFacts {
  const appVersion = realBuildValue((deps.buildVersion ?? (() => ACODE_VERSION))());
  const commit = realBuildValue((deps.buildCommit ?? (() => ACODE_COMMIT))());
  const build = {
    ...(appVersion ? { appVersion } : {}),
    ...(commit ? { commit } : {}),
    os: (deps.os ?? osPlatform)(),
    arch: (deps.arch ?? osArch)(),
    locale: deps.locale(),
    // 只列 Desktop 真实具备的通道：重型 zip 日志导出、分节支持包、系统保存框。
    // 供维护者判断用户可用哪条取证路径；不含任何敏感值。
    capabilities: ["exportLogs", "exportSupportBundle", "saveDialog"],
  };
  return {
    platformType: "desktop",
    build,
    buildAvailability: "collected",
    connectionAvailability: "unavailable",
  };
}

/** 保存结果的稳定错误码（不回传原始 err.message，避免泄漏用户路径——同 R2-04 纪律）。 */
export const DIAGNOSTIC_SAVE_TOO_LARGE = "diagnostic-report-too-large" as const;
export const DIAGNOSTIC_SAVE_WRITE_FAILED = "diagnostic-report-write-failed" as const;
export const DIAGNOSTIC_SAVE_INVALID_INPUT = "diagnostic-report-invalid-input" as const;

/** 保存对话框的最小面（生产传 Electron dialog，测试传假实现）。 */
export interface SaveDialogDeps {
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  /** 失败细节走 main 日志，不回传调用方（避免路径泄漏）。 */
  logger: { warn: (...args: unknown[]) => void };
}

/**
 * 保存诊断报告 JSON。main 是**哑 sink**：不 re-parse、不改写字节（UI 已保证 schema 合法且脱敏），
 * 只做大小上限校验与落盘。用户取消 → `{saved:false,cancelled:true}`（不是错误）；
 * 写失败 → 稳定错误码，原始异常只进 main 日志。
 */
export async function saveDiagnosticReport(
  json: string,
  suggestedName: string,
  deps: SaveDialogDeps,
): Promise<SaveDiagnosticReportResult> {
  if (typeof json !== "string") {
    return { saved: false, error: DIAGNOSTIC_SAVE_INVALID_INPUT };
  }
  // 大小门槛（契约量化门槛：轻量 JSON ≤1 MiB）。用字节长度而非字符数——中文报告字符数会低估。
  if (Buffer.byteLength(json, "utf-8") > LOCAL_DIAGNOSTIC_MAX_BYTES) {
    deps.logger.warn(
      "[diagnostics] report exceeds size cap, refusing to save",
      // 只记数值，不记内容（内容可能含用户数据）。
      { bytes: Buffer.byteLength(json, "utf-8"), cap: LOCAL_DIAGNOSTIC_MAX_BYTES },
    );
    return { saved: false, error: DIAGNOSTIC_SAVE_TOO_LARGE };
  }

  let filePath: string | undefined;
  try {
    const result = await deps.showSaveDialog({
      title: suggestedName,
      defaultPath: suggestedName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return { saved: false, cancelled: true };
    }
    filePath = result.filePath;
    await writeFile(filePath, json, "utf-8");
    return { saved: true, path: filePath };
  } catch (error) {
    // 原始 err.message 可能含用户目录路径 → 只进 main 日志，对外给稳定码。
    // path 也**不回传**：写失败即无产物，回传路径既无价值，又会把用户选择的目录路径
    // 带回 renderer（测试 local-diagnostics.test.mjs 的「不泄漏用户路径」用例钉住此点）。
    deps.logger.warn("[diagnostics] save failed", error);
    return { saved: false, error: DIAGNOSTIC_SAVE_WRITE_FAILED };
  }
}
