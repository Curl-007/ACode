// 机制参照 jcode (MIT)：crates/jcode-overnight-core（四种 poke prompt / TaskCard 字段 /
// 运营契约），自撰 TypeScript 实现（apps/acode-cli/specs/overnight-execution.md §K3 R3/R5）。
import type { OvernightPokeKind, OvernightPokeSelection } from "./manifest.js";
import { formatOvernightDuration } from "./duration.js";

/** 任务卡片 frontmatter 字段约定（R5：jcode TaskCard 字段的 markdown 化）。 */
export const TASK_CARD_FRONTMATTER_FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "whySelected",
  "verifiability",
  "risk",
  "outcome",
  "followups",
] as const;
export type TaskCardFrontmatterField = (typeof TASK_CARD_FRONTMATTER_FIELDS)[number];

/** 晨报必备小节（R5：汇总卡片 + 时间线 + 花费 + 未尽事项）。 */
export const MORNING_REPORT_REQUIRED_SECTIONS = [
  "cards-summary",
  "timeline",
  "spend",
  "open-items",
] as const;
export type MorningReportRequiredSection = (typeof MORNING_REPORT_REQUIRED_SECTIONS)[number];

/** 任务卡片目录（workspace 相对路径；coordinator 经 Write 工具落盘，非引擎特权写）。 */
export function overnightCardsDir(runId: string): string {
  return `.acode/overnight/${runId}/cards`;
}

/** 晨报产物路径（完成标志 = 文件存在，R5）。 */
export function overnightMorningReportPath(runId: string): string {
  return `.acode/overnight/${runId}/morning-report.md`;
}

/**
 * 运营契约（R5：jcode 语义移植）。作为提示词约束而非新的权限层——
 * overnight 会话沿用 J1 分级与既有 permission 管线，红线是不放宽权限语义。
 */
export const OVERNIGHT_OPERATING_CONTRACT = [
  "优先做可验证、低风险的工作：可复现 bug、回归测试、日志排查；",
  "禁止：品味类重构、支付、发邮件、推送远端（git push）、删除数据、改动凭据；",
  "需要派生 helper 或子代理时，只在期望收益明显超过成本时使用；",
  "不要等用户：全程自主推进，拿不准就选风险更低的工作项；",
  "卡片先于代码：动手前先落任务卡片记录 whySelected 与 risk，再实现。",
].join("\n");

/**
 * 五种 poke 模板（R3 表格逐条对齐）。模板常量集中本文件，改模板即改行为
 * （prompt 变更走 spec 修订）。占位符：{{cardsDir}} / {{morningReportPath}}。
 */
export const OVERNIGHT_POKE_PROMPTS: Record<OvernightPokeKind, string> = {
  continuation: [
    "继续当前工作。",
    "遵守运营契约（优先可验证低风险工作；禁止品味类重构/支付/发邮件/推远端/删除数据/改动凭据；不要等用户）。",
    "每完成一个任务卡片就更新落盘到 {{cardsDir}}/，再开始下一项。",
  ].join("\n"),
  "handoff-ready": [
    "距离目标时刻还有约 30 分钟，进入收尾窗口。",
    "不要丢弃已经完成的有用工作，但要让整个 run 容易交接：",
    "收尾进行中的任务；不再开启大的新工作线；把 {{cardsDir}}/ 下全部任务卡片的 status/outcome/followups 更新到位。",
  ].join("\n"),
  "morning-report": [
    "已到目标时刻，产出晨报：用 Write 工具把晨报写到 {{morningReportPath}}。",
    "晨报必须包含四个小节：任务卡片汇总（逐卡 id/status/outcome）、时间线（关键事件与时刻）、花费（token 与时长，可得时）、未尽事项（followups 汇总与建议）。",
    "写完晨报后本轮结束，等待后续指令。",
  ].join("\n"),
  "post-wake-continuation": [
    "晨报已发，当前处于醒后宽限期。",
    "只做有界、安全、可验证的小工作（补测试、修文档、核对卡片结论）；不要开启新的大的工作线；每项工作仍先落任务卡片到 {{cardsDir}}/。",
  ].join("\n"),
  "final-wrapup": [
    "醒后宽限期已结束，进行最终收尾。",
    "更新 {{cardsDir}}/ 下全部任务卡片与整体总结（status/outcome/followups 必须终态化），此后不再执行任何新的工作。",
  ].join("\n"),
};

/** 晨报重发时的前置提醒（R5：文件未确认 → 下轮重发前先提醒补文件）。 */
export const OVERNIGHT_MORNING_REPORT_RESEND_REMINDER =
  "提醒：上一轮已要求产出晨报，但 {{morningReportPath}} 尚未确认存在；本轮必须先补写晨报文件再做其他事。";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder: string, key: string): string => {
    const value = vars[key];
    // 模板变量缺失是编程错误（模板与调用点同仓维护），抛出以便尽早暴露而非发出坏 prompt
    if (value === undefined) throw new Error(`overnight prompt 模板变量缺失: ${placeholder}`);
    return value;
  });
}

/** 渲染一次 poke 的追加指令 prompt（supervisor 每轮消费）。 */
export function renderOvernightPokePrompt(
  poke: OvernightPokeSelection,
  ctx: { runId: string },
): string {
  const vars = {
    cardsDir: overnightCardsDir(ctx.runId),
    morningReportPath: overnightMorningReportPath(ctx.runId),
  };
  const body = renderTemplate(OVERNIGHT_POKE_PROMPTS[poke.kind], vars);
  // 晨报是唯一可能重发的 poke（R5 文件确认语义），重发时前置提醒
  if (poke.kind === "morning-report" && poke.resend) {
    return `${renderTemplate(OVERNIGHT_MORNING_REPORT_RESEND_REMINDER, vars)}\n\n${body}`;
  }
  return body;
}

export interface OvernightInitialPromptContext {
  runId: string;
  durationMs: number;
  targetWakeAtMs: number;
  /** preflight.md 内容（R5）；未采集时传 undefined，prompt 会明确标注。 */
  preflightReport?: string;
}

/**
 * 组装首条 coordinator prompt（fork 后的第一轮输入）：角色与目标时刻、运营契约、
 * 任务卡片/晨报产物约定、preflight 注入位。poke prompt 是后续轮次的追加指令，
 * 与首条 prompt 共处同一会话，因此契约只需在此处完整声明一次。
 */
export function buildInitialCoordinatorPrompt(ctx: OvernightInitialPromptContext): string {
  const cardsDir = overnightCardsDir(ctx.runId);
  const morningReportPath = overnightMorningReportPath(ctx.runId);
  // preflight 注入位：有则原样注入，无则显式标注缺失（可观测优于静默）
  const preflightBlock = ctx.preflightReport?.trim()
    ? `<preflight>\n${ctx.preflightReport.trim()}\n</preflight>`
    : "（本次运行未采集 preflight 快照）";
  return [
    `你是挂机运行（overnight run）${ctx.runId} 的 coordinator。用户已离开，本次运行时长 ${formatOvernightDuration(ctx.durationMs)}，目标时刻 ${new Date(ctx.targetWakeAtMs).toISOString()}（墙钟）。在收到收尾/晨报/最终收尾指令前持续自主工作。`,
    `## 运营契约（全程有效）\n${OVERNIGHT_OPERATING_CONTRACT}`,
    `## 任务卡片\n- 路径：${cardsDir}/<n>-<slug>.md（经 Write 工具落盘）\n- frontmatter 字段（全部必填）：${TASK_CARD_FRONTMATTER_FIELDS.join("/")}\n- 每完成一项工作就更新对应卡片。`,
    `## 晨报\n到点会收到晨报指令，产物路径：${morningReportPath}。`,
    `## Preflight 快照\n${preflightBlock}`,
  ].join("\n\n");
}
