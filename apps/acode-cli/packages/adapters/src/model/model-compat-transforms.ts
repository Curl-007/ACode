// ============================================================
// compat 请求转换器注册表（omp 价值提取波 2 · WI-12）
// ============================================================
// spec: apps/acode-cli/specs/model-compat-flags.md R4。
// 转换器 = 纯函数 (body, flags) => body；无修改必须返回原引用（管道据此免重序列化，
// 且"标志缺省 = 字节级零变化"可被引用相等断言）。按固定顺序依序应用（见 ORDER 注释）。
// 纪律：转换器只做结构/语义修补，禁止触碰 option-map（CEL patch）的权威字段
// （thinking / reasoning* / enable_thinking / max_* 等值映射）。

import { createHash } from "node:crypto";
import type { JsonObject } from "@acode/model-option-map";
import type { ResolvedModelCompatData } from "@acode/shared/model-config";

/** 请求体工作类型（JsonObject 结构兼容；转换器内部以普通 record 操作，出口保持不可变语义）。 */
type BodyRecord = Record<string, unknown>;

export type CompatBodyTransform = (body: JsonObject, flags: ResolvedModelCompatData) => JsonObject;

// ------------------------------------------------------------
// T1 · requiresStringSystemContent（anthropic wire）
// 迁移自 anthropic-stream-compat.ts 的 request 分支（逐字等价）：AI SDK 会把纯文本
// system 扩成单元素 block 数组，部分 Anthropic-compatible 服务只接受 string content。
// 顶层 system[]、带 cache_control 的 block 和其他 role 均保持原样。
// ------------------------------------------------------------
export function transformStringSystemContent(
  body: JsonObject,
  flags: ResolvedModelCompatData,
): JsonObject {
  if (flags.requiresStringSystemContent !== true) return body;
  const record = body as BodyRecord;
  if (!Array.isArray(record.messages)) return body;

  let changed = false;
  const messages = (record.messages as unknown[]).map((value) => {
    const message = asRecord(value);
    if (message?.role !== "system") return value;
    const text = singlePlainTextBlock(message.content);
    if (text === undefined) return value;
    changed = true;
    return { ...message, content: text };
  });
  return changed ? ({ ...record, messages } as JsonObject) : body;
}

function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = asRecord(value[0]);
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
  return block.text;
}

// ------------------------------------------------------------
// T2 · singleLeadingSystem（chat wire）
// 迁移自 system-message-compat.ts（wire 级等价）：部分旧式 OpenAI-compatible chat
// template 只接受一个开头 system；core 为 cache boundary 有意保留多段，只在序列化
// 边界按原顺序 join("") 合并。openai-compatible serializer 把每条 system 独立发成
// {role:"system",content:string}，因此 body 级合并与 pre-SDK 逻辑合并 wire 等价。
// 末条 leading system 的额外字段（metadata）随合并保留（对应旧实现保留 cacheControl）。
// ------------------------------------------------------------
export function transformSingleLeadingSystem(
  body: JsonObject,
  flags: ResolvedModelCompatData,
): JsonObject {
  if (flags.singleLeadingSystem !== true) return body;
  const record = body as BodyRecord;
  if (!Array.isArray(record.messages)) return body;
  const messages = record.messages as unknown[];

  let leadingSystemCount = 0;
  while (asRecord(messages[leadingSystemCount])?.role === "system") leadingSystemCount += 1;
  if (leadingSystemCount <= 1) return body;

  const leading = messages.slice(0, leadingSystemCount).map(asRecord);
  const texts: string[] = [];
  for (const message of leading) {
    // 防御：wire 上 system content 应为 string；出现未知形状时放弃合并（fail-safe 直通，
    // 交给 provider 显式报错，好过静默改写未知结构）。
    if (typeof message?.content !== "string") return body;
    texts.push(message.content);
  }
  const last = leading[leadingSystemCount - 1]!;
  const { role: _role, content: _content, ...lastExtra } = last;
  const merged: BodyRecord = { role: "system", content: texts.join(""), ...lastExtra };
  return { ...record, messages: [merged, ...messages.slice(leadingSystemCount)] } as JsonObject;
}

// ------------------------------------------------------------
// T3 · requiresToolResultName（chat wire）
// AI SDK openai-compatible 的 tool-role 消息只发 {role,tool_call_id,content} 不发 name；
// Moonshot 系（kimi-k3）要求 tool 消息带 name。回填来源 = 同 body 内配对 assistant
// tool_calls 的 function.name（按 tool_call_id 匹配）；无配对或名字为空则保持原样
// （omp 语义：if (requiresToolResultName && toolName) msg.name = toolName）。
// 与 transform.ts 存量 projectToolNameForProvider（assistant 侧空 function name 占位）
// 是不同字段、不同职责，不互相绕。
// ------------------------------------------------------------
export function transformToolResultName(
  body: JsonObject,
  flags: ResolvedModelCompatData,
): JsonObject {
  if (flags.requiresToolResultName !== true) return body;
  const record = body as BodyRecord;
  if (!Array.isArray(record.messages)) return body;
  const messages = record.messages as unknown[];

  // 一遍收集 assistant tool_calls 的 id → function.name 配对表。
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    const record2 = asRecord(message);
    if (record2?.role !== "assistant" || !Array.isArray(record2.tool_calls)) continue;
    for (const call of record2.tool_calls) {
      const callRecord = asRecord(call);
      const id = callRecord?.id;
      const fn = asRecord(callRecord?.function);
      if (typeof id === "string" && typeof fn?.name === "string" && fn.name.length > 0) {
        nameByCallId.set(id, fn.name);
      }
    }
  }
  if (nameByCallId.size === 0) return body;

  let changed = false;
  const nextMessages = messages.map((message) => {
    const toolMessage = asRecord(message);
    if (toolMessage?.role !== "tool") return message;
    const existing = toolMessage.name;
    if (typeof existing === "string" && existing.length > 0) return message;
    const callId = toolMessage.tool_call_id;
    if (typeof callId !== "string") return message;
    const name = nameByCallId.get(callId);
    if (name === undefined) return message;
    changed = true;
    return { ...toolMessage, name };
  });
  return changed ? ({ ...record, messages: nextMessages } as JsonObject) : body;
}

// ------------------------------------------------------------
// T4 · toolCallIdProfile（chat + responses wire）
// "openai-40"：tool-call id 必须满足 ^[A-Za-z0-9_-]{1,40}$。违规 id 确定性重写为
// "ac-" + sha256(原id).hex 前 32 位（35 字符）：单请求内单射、跨请求稳定（同一原 id
// 永远映射同一新 id，重放历史字节稳定，prompt cache 友好），assistant 调用与 tool
// 结果经同一映射保持配对。合规 id 一律不动（provider 原生 id 零变化）。
// 只重写已知位置：chat 的 messages[].tool_calls[].id / tool.tool_call_id；
// Responses 的 input[]/output[] 中 function_call(.output)/custom_tool_call(.output)
// 的 call_id。不做任意深度盲扫，避免误改非 tool-call 字段。
// ------------------------------------------------------------
const OPENAI_40_TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function transformToolCallIdProfile(
  body: JsonObject,
  flags: ResolvedModelCompatData,
): JsonObject {
  if (flags.toolCallIdProfile !== "openai-40") return body;
  const rewrites = new Map<string, string>();
  const rewritten = rewriteBodyToolCallIds(body as BodyRecord, rewrites);
  return rewritten as JsonObject;
}

function mappedToolCallId(id: string, rewrites: Map<string, string>): string {
  const existing = rewrites.get(id);
  if (existing !== undefined) return existing;
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
  const mapped = `ac-${digest}`;
  rewrites.set(id, mapped);
  return mapped;
}

function fixToolCallId(value: unknown, rewrites: Map<string, string>): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (OPENAI_40_TOOL_CALL_ID.test(value)) return value;
  return mappedToolCallId(value, rewrites);
}

function rewriteBodyToolCallIds(body: BodyRecord, rewrites: Map<string, string>): BodyRecord {
  let changed = false;
  const next: BodyRecord = { ...body };

  // chat wire：messages[]
  if (Array.isArray(body.messages)) {
    const messages = body.messages as unknown[];
    const nextMessages = messages.map((message) => {
      const record = asRecord(message);
      if (!record) return message;
      let messageChanged = false;
      const nextMessage: BodyRecord = { ...record };

      if (Array.isArray(record.tool_calls)) {
        const calls = record.tool_calls as unknown[];
        const nextCalls = calls.map((call) => {
          const callRecord = asRecord(call);
          if (!callRecord || typeof callRecord.id !== "string") return call;
          const id = fixToolCallId(callRecord.id, rewrites);
          if (id === callRecord.id) return call;
          messageChanged = true;
          return { ...callRecord, id };
        });
        if (messageChanged) nextMessage.tool_calls = nextCalls;
      }
      if (typeof record.tool_call_id === "string") {
        const id = fixToolCallId(record.tool_call_id, rewrites);
        if (id !== record.tool_call_id) {
          nextMessage.tool_call_id = id;
          messageChanged = true;
        }
      }
      if (!messageChanged) return message;
      changed = true;
      return nextMessage;
    });
    if (changed) next.messages = nextMessages;
  }

  // responses wire：input[]（历史回放）与 output[]（本轮 echo 场景防御性覆盖）
  for (const key of ["input", "output"] as const) {
    if (!Array.isArray(body[key])) continue;
    const items = body[key] as unknown[];
    let itemsChanged = false;
    const nextItems = items.map((item) => {
      const record = asRecord(item);
      if (!record || typeof record.call_id !== "string") return item;
      const id = fixToolCallId(record.call_id, rewrites);
      if (id === record.call_id) return item;
      itemsChanged = true;
      return { ...record, call_id: id };
    });
    if (itemsChanged) {
      next[key] = nextItems;
      changed = true;
    }
  }

  return changed ? next : body;
}

// ------------------------------------------------------------
// 注册表与固定顺序
// ------------------------------------------------------------
interface OrderedTransform {
  readonly flag: keyof ResolvedModelCompatData;
  readonly transform: CompatBodyTransform;
}

/**
 * 固定应用顺序（spec R4）：system 形状还原（T1）先于 system 合并（T2）；name 回填（T3）
 * 依赖原始 id 配对，必须在 id 重写（T4）之前；id 重写最后，一致性映射覆盖全部出现点。
 */
const ORDERED_TRANSFORMS: readonly OrderedTransform[] = Object.freeze([
  { flag: "requiresStringSystemContent", transform: transformStringSystemContent },
  { flag: "singleLeadingSystem", transform: transformSingleLeadingSystem },
  { flag: "requiresToolResultName", transform: transformToolResultName },
  { flag: "toolCallIdProfile", transform: transformToolCallIdProfile },
]);

/** 依序应用全部已启用转换器；全程 no-op 时返回原引用。 */
export function applyCompatTransforms(
  body: JsonObject,
  flags: ResolvedModelCompatData,
): JsonObject {
  let current = body;
  for (const { flag, transform } of ORDERED_TRANSFORMS) {
    const value = flags[flag];
    if (value === undefined || value === null) continue;
    current = transform(current, flags);
  }
  return current;
}

function asRecord(value: unknown): BodyRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as BodyRecord)
    : undefined;
}
