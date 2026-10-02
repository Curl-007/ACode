// ============================================================
// Provider Doctor 输出渲染（J3-1 / spec R1 + R6 + R7）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 渲染层只消费报告与覆盖汇总，不做判定、不生成建议文案（建议的唯一所有者是
// checkpoints.ts）。颜色开关由 CLI 的 supportsColor 决定；`--json` 与文本输出同源，
// 都只用白名单字段——不额外拼字段，也就不会多出一条泄密路径。

import { PROVIDER_DOCTOR_TIER_DESCRIPTIONS } from "./checkpoints.js";
import { formatCoverageBlocker, formatCoverageStatusToken } from "./ledger.js";
import { formatProviderDoctorSpend } from "./spend.js";
import type {
  ProviderDoctorCheckResult,
  ProviderDoctorCheckStatus,
  ProviderDoctorCoverageRow,
  ProviderDoctorCoverageSummary,
  ProviderDoctorReport,
  ProviderDoctorRunResult,
} from "./types.js";

export interface ProviderDoctorFormatOptions {
  readonly colors?: boolean;
  readonly verbose?: boolean;
  readonly now?: Date;
}

const STATUS_TOKENS: Readonly<Record<ProviderDoctorCheckStatus, string>> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  blocked: "阻塞",
};

const STATUS_COLUMN_WIDTH = 8;
const LABEL_COLUMN_WIDTH = 24;

export function formatProviderDoctorRun(
  result: ProviderDoctorRunResult,
  options: ProviderDoctorFormatOptions = {},
): string {
  const colors = options.colors === true;
  const lines: string[] = [];
  if (result.reports.length === 0) {
    lines.push(
      "Registry 快照里没有任何可诊断的 provider：确认 ACode Built-in / Personal Provider 配置已就位。",
    );
    lines.push("");
  }
  for (const report of result.reports) {
    lines.push(...formatReportLines(report, colors));
    lines.push("");
  }
  if (result.coverage) {
    lines.push(...formatCoverageLines(result.coverage, result.ledgerPath, options));
  } else if (result.ledgerPath) {
    lines.push(`覆盖账本: ${result.ledgerPath}（仅本地，绝不上传）`);
  }
  if (result.blockedNetworkCalls > 0) {
    lines.push(
      `警告: offline 档拦截到 ${result.blockedNetworkCalls} 次网络尝试（接线违背零网络承诺）`,
    );
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function formatReportLines(report: ProviderDoctorReport, colors: boolean): string[] {
  const title = `${report.providerLabel ?? report.providerId}${
    report.modelId ? ` / ${report.modelId}` : ""
  }`;
  const lines: string[] = [
    paint(`Provider doctor: ${title}`, colors, "bold"),
    `Tier: ${report.tier}（${PROVIDER_DOCTOR_TIER_DESCRIPTIONS[report.tier]}）`,
  ];
  if (report.endpointHost) lines.push(`Endpoint: ${report.endpointHost}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(formatCheckLine(check, colors));
  }
  lines.push("");
  lines.push(`本次花费: ${formatProviderDoctorSpend(report.spend)}`);
  lines.push(`结论: ${formatVerdict(report, colors)}`);
  if (report.nextSteps.length > 0) {
    lines.push("下一步:");
    report.nextSteps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step}`);
    });
  }
  return lines;
}

function formatCheckLine(check: ProviderDoctorCheckResult, colors: boolean): string {
  const token = pad(STATUS_TOKENS[check.status], STATUS_COLUMN_WIDTH);
  const label = pad(check.label, LABEL_COLUMN_WIDTH);
  return `  ${paintToken(check.status, `[${token}]`, colors)} ${label} ${check.detail}`;
}

function formatVerdict(report: ProviderDoctorReport, colors: boolean): string {
  if (report.ready) {
    return paint(`${report.tier} 档全部检查点通过（READY）`, colors, "green");
  }
  const firstFailure = report.checks.find(
    (check) => check.status === "failed" || check.status === "blocked",
  );
  if (!firstFailure) {
    return paint(`${report.tier} 档通过。升档才能确认完整可用性（见下一步）。`, colors, "green");
  }
  const reason = firstFailure.status === "blocked" ? "无法证明" : "失败";
  return paint(
    `${report.tier} 档未通过：首个阻塞点「${firstFailure.label}」（${reason}）`,
    colors,
    "red",
  );
}

export function formatCoverageLines(
  coverage: ProviderDoctorCoverageSummary,
  ledgerPath: string | undefined,
  options: ProviderDoctorFormatOptions = {},
): string[] {
  const now = options.now ?? new Date();
  const lines: string[] = [paint("覆盖账本（本地）", options.colors === true, "bold")];
  if (ledgerPath) lines.push(`路径: ${ledgerPath}（仅本地，绝不上传）`);
  if (coverage.rows.length === 0) {
    lines.push("  还没有任何诊断证据：运行 acode doctor --provider --tier=offline 记录第一条。");
  }
  for (const row of coverage.rows) {
    lines.push(`  ${formatCoverageLine(row, now)}`);
  }
  lines.push(`累计 recorded spend: ${formatProviderDoctorSpend(coverage.recordedSpend)}`);
  if (coverage.corruptLines > 0) {
    lines.push(`警告: 账本有 ${coverage.corruptLines} 行无法解析，已跳过（历史证据未整体失效）`);
  }
  return lines;
}

function formatCoverageLine(row: ProviderDoctorCoverageRow, now: Date): string {
  const pair = `${row.providerLabel ?? row.providerId} / ${row.modelId ?? "(未指定模型)"}`;
  const blocker = formatCoverageBlocker(row);
  return `${pad(formatCoverageStatusToken(row), 7)}${pair}；${formatEvidenceFreshness(row, now)}${
    blocker ? `；${blocker}` : ""
  }`;
}

/** 证据新鲜度：多久前 + 绝对日期 + 谁跑的 + 构建档（「谁、多久前、什么 build」）。 */
export function formatEvidenceFreshness(row: ProviderDoctorCoverageRow, now: Date): string {
  const recordedAt = Date.parse(row.recordedAt);
  const when = Number.isNaN(recordedAt)
    ? "时间未知"
    : `${formatRelativeTime(now.getTime() - recordedAt)}（${row.recordedAt.slice(0, 10)}）`;
  const actor = row.runner
    ? row.runner.actor === "user"
      ? `用户 / release 构建 / cli ${row.runner.cliVersion}`
      : `开发者 / dev 构建 / cli ${row.runner.cliVersion}`
    : "运行者未知";
  return `最近测试 ${when} by ${actor}${row.stale ? "；证据已过期，建议重跑" : ""}`;
}

export function formatRelativeTime(deltaMs: number): string {
  if (deltaMs < 60_000) return "刚刚";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/** `--json` 载荷：与文本输出同源，只含白名单字段（无凭据、无请求头、无模型正文）。 */
export function providerDoctorJsonPayload(
  result: ProviderDoctorRunResult,
): Record<string, unknown> {
  return {
    status: result.reports.length > 0 && result.reports.every((report) => report.tierPassed)
      ? "ok"
      : "failed",
    tier: result.tier,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    blockedNetworkCalls: result.blockedNetworkCalls,
    ...(result.ledgerPath ? { ledgerPath: result.ledgerPath } : {}),
    reports: result.reports.map((report) => ({
      providerId: report.providerId,
      ...(report.providerLabel ? { providerLabel: report.providerLabel } : {}),
      ...(report.modelId ? { modelId: report.modelId } : {}),
      ...(report.endpointHost ? { endpointHost: report.endpointHost } : {}),
      tier: report.tier,
      verdict: report.verdict,
      tierPassed: report.tierPassed,
      ready: report.ready,
      spend: report.spend,
      checks: report.checks.map((check) => ({
        id: check.id,
        label: check.label,
        status: check.status,
        detail: check.detail,
        ...(check.durationMs !== undefined ? { durationMs: check.durationMs } : {}),
      })),
      nextSteps: report.nextSteps,
    })),
    ...(result.coverage
      ? {
          coverage: {
            recordedSpend: result.coverage.recordedSpend,
            corruptLines: result.coverage.corruptLines,
            rows: result.coverage.rows,
          },
        }
      : {}),
  };
}

/** 中文在终端占两列：按显示宽度补齐，否则状态列会歪。 */
function pad(value: string, width: number): string {
  const displayWidth = [...value].reduce(
    (total, char) => total + (char.charCodeAt(0) > 0x2e7f ? 2 : 1),
    0,
  );
  if (displayWidth >= width) return `${value} `;
  return value + " ".repeat(width - displayWidth);
}

type PaintStyle = "bold" | "green" | "red" | "yellow";

const ANSI_CODES: Readonly<Record<PaintStyle, string>> = {
  bold: "1",
  green: "32",
  red: "31",
  yellow: "33",
};

function paint(text: string, enabled: boolean, style: PaintStyle): string {
  if (!enabled) return text;
  return `\u001b[${ANSI_CODES[style]}m${text}\u001b[0m`;
}

function paintToken(status: ProviderDoctorCheckStatus, text: string, enabled: boolean): string {
  switch (status) {
    case "passed":
      return paint(text, enabled, "green");
    case "failed":
      return paint(text, enabled, "red");
    case "blocked":
      return paint(text, enabled, "red");
    case "skipped":
      return paint(text, enabled, "yellow");
    default:
      return text;
  }
}
