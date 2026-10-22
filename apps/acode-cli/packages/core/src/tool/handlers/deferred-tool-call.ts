// ============================================================
// DeferredToolCall Handler（specs/tool-search.md R6）
// ============================================================
// 控制工具二：deferred 工具的包装调用入口。本 entry 的 handler 永不执行——
// executor 在调度前经 resolveDeferredToolCallTarget 解包并换绑目标工具，
// 之后复用普通调用的全部调度链（校验/权限/Hook/超时/取消/结果格式）。

import {
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputJsonSchema,
  DeferredToolCallInputSchema,
  type DeferredToolCallInput,
} from "@acode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

const MAX_CONTROL_RESULT_BYTES = 100_000;

/** 准入结果：ok 携带解包后的目标名与内层参数；拒绝只带原因（普通工具错误链展示）。 */
export type DeferredToolCallAdmission =
  | { ok: true; name: string; input: unknown }
  | { ok: false; reason: string };

/**
 * DeferredToolCall 准入（R6）：只接受**当前请求允许的 client-executed deferred
 * 工具**。常驻、alwaysLoad、控制工具与 provider 原生工具在目录里 deferred=false，
 * 一律拒绝并提示直接调用；未启用搜索同样拒绝（context.toolSearch 缺席 = 未启用）。
 * 纯函数：executor 换绑与单测共用同一判定，不建第二份准入逻辑。
 */
export function resolveDeferredToolCallTarget(
  input: unknown,
  context: Pick<ToolExecutionContext, "toolSearch">,
): DeferredToolCallAdmission {
  const search = context.toolSearch;
  if (!search?.enabled || search.mode !== "local") {
    return {
      ok: false,
      reason: "DeferredToolCall is not enabled for this request.",
    };
  }
  const parsed = DeferredToolCallInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid DeferredToolCall input: expected {name, input}. ${parsed.error.message}`,
    };
  }
  const payload = parsed.data as DeferredToolCallInput;
  const target = search.catalog.find(
    (tool) => tool.name === payload.name || tool.aliases?.includes(payload.name),
  );
  if (!target || !target.deferred) {
    // 常驻/控制/原生工具不可转发：提示直接调用，不执行目标 Hook/审批/handler。
    // 防伪纪律（specs/permission-auto-deny-reasons.md R3 同口径）：拒绝文案不回显
    // payload.name——外部可控字符串原样回流进模型回执与持久轨迹属文案卫生缺口。
    return {
      ok: false,
      reason:
        "The requested tool is not a deferred tool in this request. Call resident tools directly using their normal tool calls.",
    };
  }
  return { ok: true, name: target.name, input: payload.input };
}

export const deferredToolCallToolEntry: ToolEntry = {
  capability: "Call a deferred tool using its loaded definition",
  metadata: {
    name: DEFERRED_TOOL_CALL_NAME,
    description:
      "Immediately call one deferred tool and return its result. Use ToolSearch to load its complete definition first, then pass its exact name and input object. Only deferred tools can be called here; call resident tools directly using their normal tool calls.",
    // 调度前解包并使用目标属性；控制入口本身不声明只读或并发安全（目标决定）。
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
    // 控制工具常驻请求（R4 名单），永不 defer。
    alwaysLoad: true,
  },
  handler: async () => {
    // 正常链路不会走到这里：executor 在调度前解包换绑目标工具（call-runner）。
    throw new Error("DeferredToolCall must be resolved before tool execution.");
  },
  inputSchema: DeferredToolCallInputJsonSchema,
  outputSchema: {},
  runtimeInputSchema: DeferredToolCallInputSchema,
  runtimeOutputSchema: z.unknown(),
  permission: {
    permission: "tool.deferred_call",
    reason: "Call a deferred tool",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_CONTROL_RESULT_BYTES,
    maxModelBytes: MAX_CONTROL_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_CONTROL_RESULT_BYTES, direction: "head" },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Deferred tool call was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
