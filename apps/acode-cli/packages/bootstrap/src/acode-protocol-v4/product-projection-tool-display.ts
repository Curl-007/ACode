// D4 tool-call / D5 permission-interaction 域的纯展示 helper（product-projection.ts
// 拆分批次 1，specs/product-projection-structure.md §2 D4/D5 / §4）。纯函数叶子：
// tool display 白名单收窄、deferred 定稿、ask-user-question/exit-plan-mode payload 归一。
// 无 this 依赖。抽出不改任何语义（白名单成员、归一分支逐条保留）。
import { DEFERRED_TOOL_CALL_NAME, SessionEventType } from "@acode/contracts";
import type {
  SessionEvent,
  ToolCallResultPayload,
  ToolResultDisplayPayload,
} from "@acode/contracts";
import type {
  ToolCallDisplay,
  ToolCallRow,
  UserInputQuestionPayload,
} from "@acode/shared/acode-protocol-v4";
import { isPlainRecord, nonEmptyString } from "./product-projection-primitives.js";

// toolCall 行的终态集合（状态栏工具计数用）。中间态
// （inputStreaming / pendingApproval / running）不是收口，不计数。
export const TOOL_TERMINAL_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * 工具终态事件上的执行耗时（ms）。取消/被拒的终态事件不带 duration，
 * 此时返回 null：让状态栏省略该列，而不是报一个假的「0ms」。
 */
export function readToolCallDurationMs(event: SessionEvent | undefined): number | null {
  if (!event || event.type !== SessionEventType.ToolCallResult) return null;
  const payload = event.payload as ToolCallResultPayload;
  const duration = payload.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : null;
}

export function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

/**
 * 把 core 的 tool display 收窄成 v4 协议能承载的那几种 kind。
 *
 * 这份白名单原先在每个投影点各写一份内联判断，引入
 * create_workflow display 时漏改了其中一份，实时投影把图整个丢掉、而 hydration 路径没过滤，
 * 于是桌面端只有重载之后才看得到。收成一个谓词后，所有投影点共用同一份名单。
 */
export function toProtocolToolCallDisplay(
  display: ToolResultDisplayPayload | undefined,
): ToolCallDisplay | undefined {
  if (!display) return undefined;
  switch (display.kind) {
    case "node_repl_images":
    case "task_output":
    case "respond_to_coordinator":
    case "mcp_tool":
    case "create_workflow":
    // 观察类工作流工具的五个 display kind——shared 侧 toolCallDisplaySchema 已同步加
    // 成员，这里放行后 UI 才能在 row.display 上拿到结构化载荷。
    case "get_workflow_run":
    case "list_workflow_runs":
    case "eval_workflow_snippet":
    case "saved_workflow_list":
    case "list_models":
    // ResumeWorkflowRun 的恢复卡。
    case "resume_workflow_run":
      return display;
    default:
      return undefined;
  }
}

export function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * DeferredToolCall 包装定稿（specs/tool-search.md R6「V4/UI 以目标事件定稿工具行」）。
 * scheduled / 流式阶段留下的是包装身份：toolName=DeferredToolCall、input={name, input}。
 * startedName 取自 ToolCallStarted（准入通过后由 canonicalToolCall 发出的**目标工具名**，
 * 唯一权威）；缺席或仍是包装名时不动行——准入失败不发 Started，包装失败记录原样保留。
 * 返回新对象=已定稿、返回原引用=无需改动，调用方据引用相等决定是否补算 plan 投影。
 */
export function finalizeDeferredToolCallRow(
  row: ToolCallRow,
  startedName: string | undefined,
): ToolCallRow {
  if (row.toolName !== DEFERRED_TOOL_CALL_NAME) return row;
  const targetName =
    typeof startedName === "string" && startedName.trim().length > 0 ? startedName : undefined;
  if (targetName === undefined || targetName === DEFERRED_TOOL_CALL_NAME) return row;
  // 包装入参 {name, input} 的内层 input 才是目标工具真实参数（DeferredToolCallInputSchema
  // 保证形状）；非记录或缺 input 键时保留原值（防御性回退，不损坏已投影数据）。
  const wrapped = isPlainRecord(row.input) ? row.input : undefined;
  const unwrappedInput = wrapped !== undefined && "input" in wrapped ? wrapped.input : row.input;
  return {
    ...row,
    toolName: targetName,
    input: unwrappedInput,
    // inputText 必须与 input 同源刷新：continuous 档与调试面直接读 inputText，
    // 只改结构化 input 会让两面对不上（replayable 档过滤 row.delta(inputText)，定稿
    // upsert 携带完整 inputText 与既有 scheduled/result 分支一致）。
    inputText: stringifyToolInput(unwrappedInput),
  };
}

export function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

export function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

export function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function normalizeAskUserQuestionPayloadQuestion(value: unknown): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}
