// U11：`node_repl_images` display 的**同步构造器**
// （spec: apps/acode-cli/specs/tool-media-attachment-ref.md §6 R7/R10）。
//
// 从 `result-display.ts` 抽出的叶子：那个文件已贴住 max-lines(400)，而 node_repl 的 display
// 装配是本项唯一需要改动的分支。抽出后原文件**变小**，且本叶子能独立单测。
//
// 数据流（spec R7.1）：本函数是**同步纯函数**、位于所有工具的热路径，因此绝不做 IO。
// 字节持久化在 node-repl handler（async，有 artifactStore 与全部标识）完成，ref 经
// `handlers/node-repl-media.ts` 的 WeakMap 侧信道传进来；这里只按 `images[]` 下标把
// inline 图换成 ref 图。没有 ref 的图（门关闭 / store 缺席 / 写失败）逐字保持 inline——
// 这就是「悬空 ref 绝不发布」（spec R9.3）在投影侧的体现：ref 缺席即 inline，不存在
// 「发了 ref 但字节不在」的中间态。
import {
  ACODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  nodeReplCuaAppDisplaySchema,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@acode/contracts";
import type { ToolMediaImage } from "@acode/shared/acode-protocol-v4";
import { isRecord } from "./utils.js";
import { readNodeReplImageRefs, type NodeReplImageRef } from "../handlers/node-repl-media.js";
import {
  MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES,
  MAX_NODE_REPL_DISPLAY_IMAGES,
} from "./tool-media-limits.js";

/** image MIME 形态（与协议 schema 的正则一致）。 */
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/iu;

/**
 * 读取宿主写入的 CUA 目标应用身份。
 *
 * 只认 `acode/nodeReplCuaApp`：producer 自己的 `acode.cua/app-associations-v1` 也可能出现在
 * `_meta` 里，但那个键经模型可写的 `nodeRepl.setResponseMeta` /
 * `nodeRepl.emitStructuredResult` 同样能到达，宿主已在 toMcpRunResult 里把它删掉。这里不做
 * 第二次兜底解析，避免把已经判定为不可信的来源重新接回展示面。
 */
function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[ACODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

/** data URL 前缀剥离（与持久化侧同一规则，两路对同一张图判定必须一致）。 */
function stripDataUrlPrefix(encoded: string): string {
  return encoded.startsWith("data:")
    ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
    : encoded;
}

/**
 * 构造 `node_repl_images` display。
 *
 * 与 U11 之前的唯一差别：`images[]` 成员可以是 **ref 形态**（当侧信道里有该下标的 ref）。
 * inline 分支的判定、上限与 `truncated` 语义**逐字不变**，因此门关闭时输出与旧行为完全一致
 * （spec U11-P4/A4）。
 *
 * `output.content`（MCP 包装形态）里的图片**不产 ref**：侧信道的下标只对 `output.images`
 * 有意义，content 派生的图一律 inline。这是刻意的——ref 的归属证明依赖下标一一对应。
 */
export function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const outputImages = Array.isArray(output.images) ? output.images : [];
  const candidates = [...outputImages, ...(Array.isArray(output.content) ? output.content : [])];
  // 侧信道：handler 已持久化的图片 ref，按 output.images 下标索引（无则全 inline）。
  const refs = readNodeReplImageRefs(output);
  const refByIndex = new Map<number, NodeReplImageRef>();
  for (const entry of refs ?? []) refByIndex.set(entry.index, entry);

  const images: ToolMediaImage[] = [];
  let truncated = false;

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !IMAGE_MIME_PATTERN.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = stripDataUrlPrefix(encoded);
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    // ref 形态优先：candidateIndex < outputImages.length 才可能命中侧信道
    // （content 派生的图刻意不产 ref，见函数注释）。
    const persisted =
      candidateIndex < outputImages.length ? refByIndex.get(candidateIndex) : undefined;
    if (persisted) {
      images.push({ ref: persisted.ref, mimeType: persisted.mimeType, bytes: persisted.bytes });
    } else {
      images.push({ base64, mimeType });
    }
  }

  // 纯动作 cell（点击、输入）没有截图，但仍要把 App 身份投影给工具卡的 leading icon；
  // 因此不能再以「有图」作为产出 display 的唯一条件。
  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}
