// U11：从 node_repl 工具调用里抽出 **ref 形态**的图片（spec: packages/ui/specs/tool-media-on-demand.md）。
//
// 为什么是新文件而不是改 `nodeReplToolDisplay.ts` 的 `extractImages`：那个函数按
// 「有 base64/data 键」判定图片，ref 形态（只有 ref/mimeType/bytes）会被它**自然跳过**——两条
// 抽取路径因此天然不重叠，同一张图不会被读两次。inline 抽取继续归原文件（唯一所有者不变），
// ref 抽取归这里；grid 同时消费两者。
//
// 扫描纪律逐字照 `nodeReplToolDisplay.findCuaApp`：递归找 `kind === "node_repl_images"` 的记录。
// 实时 tool.updated 把 display 放在 `raw.result` 内，终态 snapshot 则把 completed part 的
// metadata 直接当作 `raw`（v4 适配器落在 `raw.display`）——只扫一个固定位置会让图片在
// 对话结束/冷恢复后消失。
import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { inspectToolMediaRef, type ToolMediaRefImage } from "@acode/shared/acode-protocol-v4";

/** image MIME 形态（与协议 schema 的正则一致；这里只做展示侧过滤，授权在 gateway）。 */
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  // 必须是 `value !== null`：写成 `typeof value !== null` 恒为真（typeof 只返回字符串），
  // 于是 `typeof null === "object"` 会让 isRecord(null) 误判为 true。
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 单个候选对象 → ref 形态图片；形态非法/字段缺失返回 undefined（降级为不显示，不崩溃）。 */
function toRefImage(value: Record<string, unknown>): ToolMediaRefImage | undefined {
  const ref = value.ref;
  if (typeof ref !== "string" || inspectToolMediaRef(ref) !== null) return undefined;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim() : "";
  if (!IMAGE_MIME_PATTERN.test(mimeType)) return undefined;
  const bytes = readPositiveInt(value.bytes);
  if (bytes === undefined) return undefined;
  const width = readPositiveInt(value.width);
  const height = readPositiveInt(value.height);
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : undefined;
  return {
    ref,
    mimeType,
    bytes,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

/**
 * 递归收集 display 里的 ref 形态图片，按 ref 去重、保持出现顺序，最多 `maxImages` 张。
 *
 * 纯函数：不读 store、不发请求——「字节按需读取」的节流判据在
 * `lib/toolMediaOnDemand.ts`，本文件只负责把**元数据**从投影里取出来。
 */
export function extractToolMediaRefImages(
  toolCall: ChatToolCall,
  maxImages = 2,
): ToolMediaRefImage[] {
  const images: ToolMediaRefImage[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();

  const collect = (display: Record<string, unknown>): void => {
    const raw = display.images;
    if (!Array.isArray(raw)) return;
    for (const candidate of raw) {
      if (images.length >= maxImages) return;
      if (!isRecord(candidate)) continue;
      const image = toRefImage(candidate);
      if (!image || seen.has(image.ref)) continue;
      seen.add(image.ref);
      images.push(image);
    }
  };

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "node_repl_images") collect(value);
    if (images.length >= maxImages) return;
    for (const child of Object.values(value)) visit(child);
  };

  // 与 inline 抽取同一组候选：output、raw.rawOutput/raw.result、以及 raw 本身（终态 snapshot
  // 把 metadata 当作 raw；v4 适配器把 display 放在 raw.display）。
  visit(toolCall.output);
  visit(toolCall.raw);
  return images;
}
