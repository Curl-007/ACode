// Model Protocol 错误与 id 工厂 —— 协议错误类型、provider/model id 收窄、消息内容文本投影。
// 例外偿还（contracts-onboarding-max-file-lines-model-index）：自 model/index.ts 拆出。
// 原 index.ts 降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：本叶 → protocol-types.js / request-status.js（基础类型叶），无叶子回边。
// ============================================================
// Model Protocol - provider-neutral model contracts（错误与工厂段）
// ============================================================

import { ModelErrorCode } from "./request-status.js";
import type {
  ModelId,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelProviderId,
} from "./protocol-types.js";

export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}

export function createModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelSelection,
      "Model provider id is empty",
    );
  }
  return normalized as ModelProviderId;
}

export function createModelId(modelId: string): ModelId {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(ModelErrorCode.InvalidModelSelection, "Model id is empty");
  }
  return normalized as ModelId;
}

export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
    case "tool_reference":
      // 工具引用块没有独立文本语义（specs/tool-search.md R7）：local 投影在请求
      // 准备时把它展开为定义容器，off 路径按移除规则降级为占位文本；纯文本投影
      //（token 估算/日志）按空处理，不合成名称文本。
      return "";
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}
