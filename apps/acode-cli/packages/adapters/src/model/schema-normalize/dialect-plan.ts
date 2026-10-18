// ============================================================
// 模型请求工具定义的方言分发计划（spec R2.2）
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md。
// 纪律：方言路由**禁止按模型 id 字符串分支**——只消费结构化信号：
//   1. properties.requiresMfjsToolSchema（配置驱动标志，GLM/Kimi 系 MFJS 子集）；
//   2. providerKind → wire apiType 的一一映射（波 2 spec R6 已论证：
//      openai→openai-responses、anthropic→anthropic-messages、
//      openai-compatible→openai-chat-completions）；
//   3. classifyModel 的分类结果（modelClass 结构化暴露，供证据注释与未来
//      class 级规则消费；本波不做无运行时证据的 class 级隐式赋值——
//      「kimi class 一律 MFJS」这类默认会静默剥关键字，等配置证据再立项）。
// 纯函数：plan 在 toAiSdkTools 入口每请求计算一次，工具级应用零字符串匹配。

import { classifyModel, type ModelClass, type ModelWireApiType } from "../model-compat-identity.js";

/** 工具定义发送面的 wire 词汇；gateway/custom 等未知形态归 unknown（不归一，fail-safe）。 */
export type ToolSchemaWire = ModelWireApiType | "unknown";

export interface ModelToolSchemaPlan {
  readonly wire: ToolSchemaWire;
  /** classifyModel 结构化身份（wire 未知或身份输入缺席时为 "unknown"）。 */
  readonly modelClass: ModelClass;
  /** MFJS 方言（Moonshot Flavored JSON Schema）：requiresMfjsToolSchema 标志。 */
  readonly mfjs: boolean;
  /** OpenAI Responses sanitize 方言（oneOf→anyOf、object 补 properties、lookaround 剥离）。 */
  readonly responsesSanitize: boolean;
  /** Responses strict 管线资格（wire 级；工具级还要 contract.strict === true）。 */
  readonly responsesStrictEligible: boolean;
}

export interface ModelToolSchemaPlanInput {
  readonly providerKind?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly requiresMfjsToolSchema?: boolean;
}

/** providerKind → wire apiType（model-execution.ts toAiSdkProviderConfig 的逆映射）。 */
export function toolSchemaWireOfProviderKind(providerKind: string | undefined): ToolSchemaWire {
  switch (providerKind) {
    case "openai":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
    case "openai-compatible":
      return "openai-chat-completions";
    default:
      // gateway/custom/缺席：wire 未知 → 不做任何方言归一（fail-safe，spec R2.2）。
      return "unknown";
  }
}

export function resolveModelToolSchemaPlan(input: ModelToolSchemaPlanInput): ModelToolSchemaPlan {
  const wire = toolSchemaWireOfProviderKind(input.providerKind);
  // 身份分类只在 wire 与身份输入齐备时进行；bindModel 已用同一组
  // (providerId, modelId, apiType) 成功分类过（resolveModelCompat 前置），
  // 此处再分类必然一致；若真抛出（AmbiguousModelError）说明绑定与发送面
  // 输入漂移，按 fail-closed 纪律向上传播、拒绝发送。
  const modelClass: ModelClass =
    wire !== "unknown" && input.providerId !== undefined && input.modelId !== undefined
      ? classifyModel({ providerId: input.providerId, modelId: input.modelId, apiType: wire }).modelClass
      : "unknown";
  const mfjs = input.requiresMfjsToolSchema === true;
  const responses = wire === "openai-responses";
  return Object.freeze({
    wire,
    modelClass,
    mfjs,
    responsesSanitize: responses,
    responsesStrictEligible: responses,
  });
}

/** plan 是否会改动 schema（全否 = 原引用直通，可用引用相等断言零变化）。 */
export function planHasDialectWork(plan: ModelToolSchemaPlan): boolean {
  return plan.mfjs || plan.responsesSanitize;
}
