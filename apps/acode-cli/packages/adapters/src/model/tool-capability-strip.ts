// ============================================================
// wire 侧能力剥离的闭集信号（specs/tool-search.md R13）
// ============================================================
// 对照上游 foundry「降级永不静默」机制：provider-native 工具是目的工具（对照
// 上游 web_search_tool → fail:foundry-purpose-request 的目的判定），后端编码能力
// 缺失时 fail-closed 闭集报错——不静默丢弃工具（修复 toAiSdkTools 旧
// `providerTool ? [[…]] : []` 的静默空数组洞）、不发坏请求。
// core↔adapters 无依赖边、contracts 桶面本轮不在作用域：本文件与
// core/src/tool/search/capability.ts 各自是所属侧词表的唯一登记处，两侧档位以
// spec R13 对照表互认，禁止复制成第二份登记。波 2 如需协议/持久化面再上提 contracts。

import { ModelErrorCode } from "@acode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

/**
 * wire 侧剥离/失败原因闭集（单源）。新增档位必须同步：派生联合类型、
 * wireToolStripDisposition 穷举 switch、spec R13 词表行（第二轮教训：全链一次扩齐）。
 */
const WIRE_TOOL_STRIP_REASONS = [
  /** supportsNativeWebSearch=false 仍收到 provider-native WebSearch 编码请求（handler 门禁后的第二道防线）。 */
  "native_web_search_model_unsupported",
  /** 后端 API 面（providerKind）不编码 provider-native web search（openai 兼容后端必然缺 native 搜索）。 */
  "native_web_search_provider_unencodable",
  /** providerNative.logicalName 无已注册编码器（注册表/构建事实，非运行时能力）。 */
  "provider_native_tool_unregistered",
] as const;
export type WireToolStripReason = (typeof WIRE_TOOL_STRIP_REASONS)[number];

/** 失败语义闭集两档（与 core 侧词表同形）：波 1 wire 侧产生路径全部为 fail。 */
const WIRE_TOOL_STRIP_DISPOSITIONS = ["retry", "fail"] as const;
export type WireToolStripDisposition = (typeof WIRE_TOOL_STRIP_DISPOSITIONS)[number];

/**
 * reason → disposition 的唯一映射（穷举 switch，无 default 逃逸：新增 reason 未
 * 同步本函数时 TS 编译失败）。retry 档为波 2「请求面能力剥离后重建重发」登记
 * （对照上游 retry:foundry-capability-strip），波 1 无产生路径。
 */
export function wireToolStripDisposition(
  reason: WireToolStripReason,
): WireToolStripDisposition {
  switch (reason) {
    case "native_web_search_model_unsupported":
    case "native_web_search_provider_unencodable":
    case "provider_native_tool_unregistered":
      // 目的工具能力缺失：请求目的不可达，同请求重试无意义；调用方（WebSearch
      // handler 的多引擎链/错误链）换引擎或换模型重规划。
      return "fail";
  }
}

/** 闭集信号：wire 侧剥离都是工具级，必携带目标工具名。 */
export interface WireToolStripSignal {
  readonly disposition: WireToolStripDisposition;
  readonly reason: WireToolStripReason;
  readonly toolName: string;
}

/**
 * 能力剥离的闭集报错：code 保持 InvalidModelRequest——failure-classifier 既有
 * 归档（retryable:false）不变，本错误只增加可辨识性；类型化 strip 字段同步写入
 * error context，消费方按闭集字段区分档位，不解析 message。
 */
export class ToolCapabilityStripError extends AiSdkModelAdapterError {
  readonly strip: WireToolStripSignal;

  constructor(reason: WireToolStripReason, toolName: string, message: string) {
    super(ModelErrorCode.InvalidModelRequest, message, {
      context: {
        stripReason: reason,
        stripDisposition: wireToolStripDisposition(reason),
        toolName,
      },
    });
    this.name = "ToolCapabilityStripError";
    this.strip = {
      disposition: wireToolStripDisposition(reason),
      reason,
      toolName,
    };
  }
}
