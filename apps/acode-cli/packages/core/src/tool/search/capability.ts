// ============================================================
// 后端能力剥离的闭集信号词表（specs/tool-search.md R13）
// ============================================================
// 对照上游 foundry「按后端能力剥离 + 显式信号」机制：能力缺失时请求构造期显式
// 剥离并返回闭集信号（retry:foundry-capability-strip / fail:foundry-purpose-request），
// 降级永不静默。ACode 侧只搬机制语义：信号 = { disposition, reason, toolName? }，
// disposition 闭集两档 retry|fail，由 reason 的穷举 switch 单源推导。
// 本文件是 core 请求构造侧词表的唯一登记处；adapters wire 侧词表在
// adapters/src/model/tool-capability-strip.ts（两包无依赖边，禁止互相复制登记）。
// 波 2 扩集纪律（第二轮教训）：zod enum + 手维护联合 + switch 穷举必须一次全链扩齐。

import type { ResolvedToolSearchMode } from "@acode/contracts";

/**
 * 剥离/失败原因闭集（单源）。新增档位必须同步：
 * 1. 本数组 + 派生联合类型；2. toolSearchStripDisposition 的穷举 switch；
 * 3. ToolSearchDisableReason（如属降级档）；4. spec R13 词表行。
 */
export const TOOL_SEARCH_STRIP_REASONS = [
  /**
   * 波 1 构建事实：native 面未实装（显式 native 与 auto 升 native 分支发送前报错）。
   * 波 2 实装后此档退役，由 native_protocol_unsupported 的协议判定接替。
   */
  "native_not_implemented",
  /**
   * 后端缺 native tool_search 协议（apiType 非 anthropic-messages）。
   * 波 2 档位登记：auto/native 请求面剥离 defer 旗标后重建请求 → retry。
   * 波 1 无产生路径（native 面不存在，先落 native_not_implemented）。
   */
  "native_protocol_unsupported",
  /**
   * 模型不支持普通工具调用：显式 local 发送前报错（fail）；auto 下不抛错，
   * 走 R12 fail-open 降级并以此值入降级原因闭集（与配置 off 分档）。
   */
  "tool_call_unsupported",
] as const;
export type ToolSearchStripReason = (typeof TOOL_SEARCH_STRIP_REASONS)[number];

/** 失败语义闭集两档：retry = 剥离后重建请求可继续；fail = 请求目的不可达。 */
export const TOOL_SEARCH_STRIP_DISPOSITIONS = ["retry", "fail"] as const;
export type ToolSearchStripDisposition = (typeof TOOL_SEARCH_STRIP_DISPOSITIONS)[number];

/**
 * reason → disposition 的唯一映射（穷举 switch，无 default 逃逸：新增 reason
 * 未同步本函数时 TS 编译失败——闭集一致性的编译期守卫）。
 */
export function toolSearchStripDisposition(
  reason: ToolSearchStripReason,
): ToolSearchStripDisposition {
  switch (reason) {
    case "native_protocol_unsupported":
      // 对照上游 retry:foundry-capability-strip：剥离 defer 面后同一请求可重建重发。
      return "retry";
    case "native_not_implemented":
      // 构建事实：重试不改变结果，调用方必须换模式（local/auto）重规划。
      return "fail";
    case "tool_call_unsupported":
      // 普通工具调用是请求面能力下限：换模型前重试无意义。auto 的 fail-open
      // 降级（不抛错）已承担「剥离后继续」语义，走到报错的是显式 local → fail。
      return "fail";
  }
}

/** 闭集信号：模式级失败省略 toolName；工具级剥离（波 2 defer 面）携带目标名。 */
export interface ToolSearchStripSignal {
  readonly disposition: ToolSearchStripDisposition;
  readonly reason: ToolSearchStripReason;
  readonly toolName?: string;
}

/**
 * 能力不符的发送前报错（R1/R13）：携带闭集信号，消费方按 signal 字段区分
 * retry/fail 与原因档位，不解析 message。message 保持波 1 文案（测试与用户
 * 可见指引兼容）。extends Error 而非自定义基类：core 错误链无统一基类约束。
 */
export class ToolSearchCapabilityError extends Error {
  readonly signal: ToolSearchStripSignal;

  constructor(reason: ToolSearchStripReason, message: string, toolName?: string) {
    super(message);
    this.name = "ToolSearchCapabilityError";
    this.signal = {
      disposition: toolSearchStripDisposition(reason),
      reason,
      ...(toolName !== undefined ? { toolName } : {}),
    };
  }
}

/**
 * R12 降级原因闭集（启用判定失败时的 debug 分档）。既有三档之上按 R13 增两个
 * 能力档：「配置关闭」与「能力不可得」在信号层可辨识（对照上游 tool_deferred vs
 * tool_deferred_unavailable 的回合原因分档思想）。
 */
export type ToolSearchDisableReason =
  /** 配置/请求即 off（用户意图，非能力事实）。 */
  | "provider_disabled"
  /** 目录中无任何 deferred 工具。 */
  | "no_deferred_tools"
  /** ToolSearch/DeferredToolCall 控制工具被作用域禁用。 */
  | "tool_unavailable"
  /** auto 下模型不支持普通工具调用（能力降级，与 provider_disabled 分档）。 */
  | "tool_call_unsupported"
  /** 波 2 档位登记：后端缺 native 协议导致 auto 无法升 native。波 1 无产生路径。 */
  | "native_protocol_unsupported";

/** exposure.reason 的全取值域：启用时 = 实际模式；未启用时 = 降级原因档。 */
export type ToolSearchExposureReason = ResolvedToolSearchMode | ToolSearchDisableReason;
