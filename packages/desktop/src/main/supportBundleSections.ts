/**
 * 分节支持包：节注册表与上下文（specs/log-privacy-redaction.md desktop R8/R14）。
 *
 * 节注册表形态 {id, group, label, defaultChecked, appliesIn(ctx), collect(ctx)}；
 * label 即隐私承诺文案——向用户明说这一节收了什么、脱敏了什么，
 * 勾选界面直接展示（UI 接线与 locale 键需求见报告）。
 *
 * 凭据类节只收 {status, providers, count}：读 credentials.json 的键名做
 * 提供商派生与计数，绝不读取、绝不解密任何值。
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAppConfigDir } from "@acode/services/node";
import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "./about.js";
import { getMainLogRedactor } from "./logPrivacyIdentity.js";
import { collectRedactedLogSection, listRecentFiles } from "./supportBundleLogs.js";

/** 凭据状态（仅元数据，无值）。 */
export interface SupportBundleCredentialsStatus {
  status: "not-configured" | "corrupt" | "ok";
  /** 由键名（oauth:<provider>:<field> 等）派生的提供商去重列表。 */
  providers: string[];
  count: number;
}

export interface SupportBundleContext {
  logsDir: string;
  cliLogDir: string;
  cuaHelperRunDir: string;
  aboutContent: string;
  credentials: SupportBundleCredentialsStatus;
}

export interface SupportBundleSection {
  id: string;
  group: "metadata" | "logs";
  /** 隐私承诺文案（自撰）：勾选界面直接展示。 */
  label: string;
  defaultChecked: boolean;
  appliesIn?: (context: SupportBundleContext) => boolean | Promise<boolean>;
  collect: (context: SupportBundleContext) => string | Promise<string>;
}

function getSupportBundleLogsDir(): string {
  return join(getAppConfigDir(), "logs");
}

function getSupportBundleCliLogDir(): string {
  return join(homedir(), ".acode", "cli", "log");
}

function getSupportBundleCuaHelperRunDir(): string {
  return join(homedir(), ".acode", "computer-use", "run");
}

/** 凭据键名 → 提供商派生：`oauth:<provider>:<field>` 取中段，其余取首段。 */
export function deriveCredentialProviders(keys: readonly string[]): string[] {
  const providers = new Set<string>();
  for (const key of keys) {
    const segments = key.split(":");
    if (segments.length === 0) {
      continue;
    }
    if (segments[0] === "oauth" && segments.length >= 2 && segments[1]) {
      providers.add(segments[1]!);
      continue;
    }
    if (segments[0]) {
      providers.add(segments[0]!);
    }
  }
  return [...providers].sort();
}

/**
 * 凭据状态收集：只解析 JSON 键名。文件缺失 → not-configured；
 * 解析失败 → corrupt（损坏本身就是排障信息）；任何异常不外抛。
 */
export async function collectCredentialsStatus(
  credentialsFile = join(getAppConfigDir(), "credentials.json"),
): Promise<SupportBundleCredentialsStatus> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      return { status: "not-configured", providers: [], count: 0 };
    }
    return { status: "corrupt", providers: [], count: 0 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "corrupt", providers: [], count: 0 };
    }
    const keys = Object.keys(parsed as Record<string, unknown>);
    return {
      status: "ok",
      providers: deriveCredentialProviders(keys),
      count: keys.length,
    };
  } catch {
    return { status: "corrupt", providers: [], count: 0 };
  }
}

export async function buildSupportBundleContext(): Promise<SupportBundleContext> {
  const aboutContent = formatAboutDetail(
    createAboutSnapshot({ buildMetadata: readBuildMetadata() }),
  );
  return {
    logsDir: getSupportBundleLogsDir(),
    cliLogDir: getSupportBundleCliLogDir(),
    cuaHelperRunDir: getSupportBundleCuaHelperRunDir(),
    aboutContent,
    credentials: await collectCredentialsStatus(),
  };
}

/** 主进程日志行过滤：`[ts] [level] [pid:x] [source]` 形态的 warn|error。 */
const MAIN_LOG_LINE_FILTER = /\[(?:warn|error)\]/;
/** 优先类：error 级与网络/协议/流错误关键词（排障价值最高，先保）。 */
const MAIN_LOG_PRIORITY_PATTERN =
  /\[error\]|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE)\b|api|stream|handshake|protocol|crash/i;
/** CLI jsonl 行过滤：结构化 level 字段。 */
const CLI_LOG_LINE_FILTER = /"level":"(?:warn|error)"/;
const CLI_LOG_PRIORITY_PATTERN = /"level":"error"|api|stream|transport|protocol/i;

async function hasCuaHelperExitLogs(context: SupportBundleContext): Promise<boolean> {
  try {
    const entries = await readdir(context.cuaHelperRunDir);
    return entries.some((name) => name.endsWith(".exit.log"));
  } catch {
    return false;
  }
}

/**
 * 节注册表（首批）。日志节全部走 collectRedactedLogSection：
 * tail ~1MB → warn|error 过滤 → 预算采样 → 逐行脱敏 → 尾部截断标记。
 */
export const SUPPORT_BUNDLE_SECTIONS: readonly SupportBundleSection[] = [
  {
    id: "system-info",
    group: "metadata",
    label: "应用与系统信息——版本、平台、架构与构建元数据；不含用户文件内容",
    defaultChecked: true,
    collect: (context) => context.aboutContent,
  },
  {
    id: "credentials-status",
    group: "metadata",
    label: "凭据状态——仅提供商、状态与条目计数；不读取、不包含任何密钥值",
    defaultChecked: true,
    collect: (context) =>
      [
        `status: ${context.credentials.status}`,
        `providers: ${context.credentials.providers.join(", ") || "(无)"}`,
        `count: ${context.credentials.count}`,
      ].join("\n"),
  },
  {
    id: "main-log",
    group: "logs",
    label: "主进程日志（近期警告与错误行）——机密、用户路径、主机名与内部地址已按占位符脱敏",
    defaultChecked: true,
    collect: async (context) => {
      const files = await listRecentFiles(context.logsDir, /\.log$/i, 2);
      return collectRedactedLogSection({
        files,
        lineFilter: MAIN_LOG_LINE_FILTER,
        priorityPattern: MAIN_LOG_PRIORITY_PATTERN,
        emptyNotice: "(主进程日志不存在，或近期没有警告/错误行)",
      });
    },
  },
  {
    id: "cli-log",
    group: "logs",
    label: "CLI 运行日志（近期警告与错误行）——同上脱敏；仅取文件尾部约 1MB",
    defaultChecked: true,
    collect: async (context) => {
      const files = await listRecentFiles(context.cliLogDir, /\.jsonl$/i, 2);
      return collectRedactedLogSection({
        files,
        lineFilter: CLI_LOG_LINE_FILTER,
        priorityPattern: CLI_LOG_PRIORITY_PATTERN,
        emptyNotice: "(CLI 日志不存在，或近期没有警告/错误行)",
      });
    },
  },
  {
    id: "cua-helper-log",
    group: "logs",
    label: "Computer Use Helper 诊断（退出日志）——同上脱敏；仅收 *.exit.log，不触碰同目录凭据文件",
    defaultChecked: true,
    appliesIn: (context) => hasCuaHelperExitLogs(context),
    collect: async (context) => {
      const files = await listRecentFiles(context.cuaHelperRunDir, /\.exit\.log$/i, 4);
      return collectRedactedLogSection({
        files,
        // Helper 退出日志是非结构化文本：warn|error 关键词过滤会漏掉崩溃现场，
        // 全行保留（仍走逐行脱敏 + 预算采样）。
        lineFilter: /^/,
        emptyNotice: "(无 Computer Use Helper 退出日志)",
      });
    },
  },
];

/** 节收集失败的占位内容（错误摘要本身过脱敏管线，防错误消息带出路径/机密）。 */
export function formatSectionFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `<section failed: ${getMainLogRedactor().redactLine(message)}>`;
}
