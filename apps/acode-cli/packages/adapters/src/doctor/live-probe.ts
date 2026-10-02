// ============================================================
// Provider Doctor live 档探针（J3-1 / spec R3 #10-#12）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 真实调用一律经既有模型客户端（`ProviderDoctorModelPort` → `AiSdkModelAdapter`），
// 诊断不自己拼 provider 报文。三个探针刻意最小化：单轮 user 消息、64 token 上限、
// 最低合法推理档位——够判定「能聊 / 能流 / 能解析工具调用」即可，花费压到最低。
//
// 详情文本只含长度、finishReason、错误码等元事实，**不回显模型正文**：正文既不是证据，
// 也可能夹带用户数据或凭据回显。

import {
  runWithModelInvocationContext,
  type ModelInputMessage,
  type ModelInvocationContext,
  type ModelToolContract,
  type ModelUsage,
} from "@acode/contracts";
import { getErrorCode, getStatusCode, unwrapRetryError } from "../model/failure-inspection.js";
import {
  PROVIDER_DOCTOR_PROBE_MAX_OUTPUT_TOKENS,
  type ProviderDoctorModelFacts,
  type ProviderDoctorModelPort,
} from "./types.js";

export const PROVIDER_DOCTOR_PROBE_TOOL_NAME = "acode_doctor_probe";

const PROBE_PROMPT = "Reply with exactly: ok";
const TOOL_PROBE_PROMPT = `Call the ${PROVIDER_DOCTOR_PROBE_TOOL_NAME} tool with acknowledged set to true. Do not answer with text.`;

const PROBE_TOOL_CONTRACT: ModelToolContract = Object.freeze({
  name: PROVIDER_DOCTOR_PROBE_TOOL_NAME,
  description: "Provider doctor connectivity probe. Call this tool once to prove tool calling works.",
  capability: "low",
  readOnly: true,
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["acknowledged"],
    properties: Object.freeze({
      acknowledged: Object.freeze({ type: "boolean" }),
    }),
  }),
});

export interface ProviderDoctorProbeOutcome {
  readonly status: "passed" | "failed" | "skipped";
  readonly detail: string;
  /** 是否真的发出了请求：只有 true 才计入可计费调用（spec R6）。 */
  readonly attempted: boolean;
  readonly usage?: ModelUsage;
}

export interface ProviderDoctorLiveProbeInput {
  readonly models: ProviderDoctorModelPort;
  readonly providerId: string;
  readonly modelId: string;
  readonly model: ProviderDoctorModelFacts;
  readonly invocationContext?: ModelInvocationContext;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export async function probeNonStreamingCompletion(
  input: ProviderDoctorLiveProbeInput,
): Promise<ProviderDoctorProbeOutcome> {
  const options = resolveProbeOptions(input.model);
  if (!options) return missingOptionOutcome(input.model);

  // 对抗复核 F8：模型客户端构造发生在任何请求发出之前——构造失败（如 provider/模型不在
  // 快照内、配置事实不齐）不得计可计费调用（spec R6「只有真的发出了请求才计费」，即
  // live-checks.runProbe 消费 attempted 的既有语义）。构造与请求分开 catch：只有请求
  // 路径的异常才记 attempted=true。
  let model: ReturnType<ProviderDoctorModelPort["createModel"]>;
  try {
    model = input.models.createModel({
      providerId: input.providerId,
      modelId: input.modelId,
    });
  } catch (error) {
    return { status: "failed", attempted: false, detail: describeProbeFailure(error) };
  }

  try {
    const result = await withInvocationContext(input.invocationContext, () =>
      model.generateText({
        messages: [userMessage(PROBE_PROMPT)],
        options,
        abortSignal: probeSignal(input),
      }),
    );
    const textLength = result.text?.trim().length ?? 0;
    const toolCalls = result.toolCalls?.length ?? 0;
    if (textLength === 0 && toolCalls === 0) {
      return {
        status: "failed",
        attempted: true,
        detail: `补全返回空内容（finishReason=${result.finishReason}）`,
        usage: result.usage,
      };
    }
    return {
      status: "passed",
      attempted: true,
      detail: `非流式补全成功：finishReason=${result.finishReason}，文本 ${textLength} 字符，工具调用 ${toolCalls} 个`,
      usage: result.usage,
    };
  } catch (error) {
    return { status: "failed", attempted: true, detail: describeProbeFailure(error) };
  }
}

export async function probeStreamingCompletion(
  input: ProviderDoctorLiveProbeInput,
): Promise<ProviderDoctorProbeOutcome> {
  const options = resolveProbeOptions(input.model);
  if (!options) return missingOptionOutcome(input.model);

  // 对抗复核 F8：与非流式探针同一理由——构造失败不计可计费调用。
  let model: ReturnType<ProviderDoctorModelPort["createModel"]>;
  try {
    model = input.models.createModel({
      providerId: input.providerId,
      modelId: input.modelId,
    });
  } catch (error) {
    return { status: "failed", attempted: false, detail: describeProbeFailure(error) };
  }

  try {
    const stream = withInvocationContext(input.invocationContext, () =>
      model.streamText({
        messages: [userMessage(PROBE_PROMPT)],
        options,
        abortSignal: probeSignal(input),
      }),
    );

    let textLength = 0;
    let toolEvents = 0;
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let streamError: unknown;
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          textLength += event.text?.length ?? 0;
          break;
        case "tool_call":
        case "tool_input_start":
          toolEvents += 1;
          break;
        case "finish":
          finishReason = event.finishReason;
          usage = event.usage;
          break;
        case "error":
          streamError = event.error;
          break;
        default:
          break;
      }
    }

    if (streamError !== undefined) {
      return {
        status: "failed",
        attempted: true,
        detail: describeProbeFailure(streamError),
        ...(usage ? { usage } : {}),
      };
    }
    if (!finishReason) {
      return {
        status: "failed",
        attempted: true,
        detail: `流式响应没有 finish 事件（文本 ${textLength} 字符，工具事件 ${toolEvents} 个）`,
        ...(usage ? { usage } : {}),
      };
    }
    if (textLength === 0 && toolEvents === 0) {
      return {
        status: "failed",
        attempted: true,
        detail: `流式响应没有内容（finishReason=${finishReason}）`,
        usage,
      };
    }
    return {
      status: "passed",
      attempted: true,
      detail: `流式补全成功：finishReason=${finishReason}，文本 ${textLength} 字符，工具事件 ${toolEvents} 个`,
      usage,
    };
  } catch (error) {
    return { status: "failed", attempted: true, detail: describeProbeFailure(error) };
  }
}

export async function probeToolCallParse(
  input: ProviderDoctorLiveProbeInput,
): Promise<ProviderDoctorProbeOutcome> {
  if (!input.model.supportsToolCall) {
    return {
      status: "skipped",
      attempted: false,
      detail: "该模型的 properties.supportsToolCall=false，跳过工具调用解析",
    };
  }
  const options = resolveProbeOptions(input.model);
  if (!options) return missingOptionOutcome(input.model);

  // 对抗复核 F8：与非流式探针同一理由——构造失败不计可计费调用。
  let model: ReturnType<ProviderDoctorModelPort["createModel"]>;
  try {
    model = input.models.createModel({
      providerId: input.providerId,
      modelId: input.modelId,
    });
  } catch (error) {
    return { status: "failed", attempted: false, detail: describeProbeFailure(error) };
  }

  try {
    const result = await withInvocationContext(input.invocationContext, () =>
      model.generateText({
        messages: [userMessage(TOOL_PROBE_PROMPT)],
        tools: [PROBE_TOOL_CONTRACT],
        options,
        abortSignal: probeSignal(input),
      }),
    );
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return {
        status: "failed",
        attempted: true,
        detail: `模型没有产出工具调用（finishReason=${result.finishReason}，文本 ${(result.text ?? "").trim().length} 字符）`,
        usage: result.usage,
      };
    }
    const call = toolCalls[0];
    if (!call || call.name !== PROVIDER_DOCTOR_PROBE_TOOL_NAME) {
      return {
        status: "failed",
        attempted: true,
        detail: `工具调用名称不匹配：期望 ${PROVIDER_DOCTOR_PROBE_TOOL_NAME}，收到 ${call?.name ?? "无"}`,
        usage: result.usage,
      };
    }
    if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) {
      return {
        status: "failed",
        attempted: true,
        detail: "工具调用参数不是对象，解析不成立",
        usage: result.usage,
      };
    }
    return {
      status: "passed",
      attempted: true,
      detail: `工具调用解析成功：${call.name}，参数 ${Object.keys(call.input as object).length} 个字段`,
      usage: result.usage,
    };
  } catch (error) {
    return { status: "failed", attempted: true, detail: describeProbeFailure(error) };
  }
}

function resolveProbeOptions(
  model: ProviderDoctorModelFacts,
): { maxOutputTokens: number; reasoningLevel: string } | undefined {
  const reasoningLevel = model.reasoningLevels[0];
  if (!reasoningLevel) return undefined;
  const specMax = Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : 0;
  const maxOutputTokens =
    specMax > 0
      ? Math.max(1, Math.min(PROVIDER_DOCTOR_PROBE_MAX_OUTPUT_TOKENS, Math.trunc(specMax)))
      : PROVIDER_DOCTOR_PROBE_MAX_OUTPUT_TOKENS;
  return { maxOutputTokens, reasoningLevel };
}

function missingOptionOutcome(model: ProviderDoctorModelFacts): ProviderDoctorProbeOutcome {
  return {
    status: "failed",
    attempted: false,
    detail: model.reasoningLevels.length === 0
      ? "模型没有声明合法推理档位，无法构造最小请求（先修 model_route_resolved）"
      : "模型档位事实不完整，无法构造最小请求",
  };
}

function userMessage(text: string): ModelInputMessage {
  return { role: "user", content: text };
}

function probeSignal(input: ProviderDoctorLiveProbeInput): AbortSignal {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}

function withInvocationContext<T>(context: ModelInvocationContext | undefined, run: () => T): T {
  // 账号型 provider 的请求级鉴权走 invocation context（runner.ts 的既有路径）；
  // 诊断没有 session/turn 事实，只借用 context 传递 header 刷新回调。
  // 对 AsyncIterable 返回值，contracts 的实现会逐次 next() 重入同一 context。
  if (!context) return run();
  return runWithModelInvocationContext(context, run);
}

function describeProbeFailure(error: unknown): string {
  const unwrapped = unwrapRetryError(error);
  const status = getStatusCode(unwrapped) ?? getHttpStatus(unwrapped);
  const code = getErrorCode(unwrapped);
  const message =
    unwrapped instanceof Error
      ? unwrapped.message.replace(/\s+/g, " ").trim().slice(0, 140)
      : String(unwrapped).slice(0, 140);
  const prefix = [status ? `HTTP ${status}` : undefined, code].filter(Boolean).join(" ");
  return prefix ? `${prefix}: ${message}` : message;
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidates = [
    (error as { statusCode?: unknown }).statusCode,
    (error as { responseStatus?: unknown }).responseStatus,
    (error as { status?: unknown }).status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}
