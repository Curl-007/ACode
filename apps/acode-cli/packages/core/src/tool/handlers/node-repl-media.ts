// U11：node-repl 工具图片的 **artifact 持久化**与 **ref 侧信道**
// （spec: apps/acode-cli/specs/tool-media-attachment-ref.md §6 R7/R8/R9）。
//
// 职责边界：本模块是**唯一**把工具图片字节写进 artifact store 的写入面，也是同步 display
// 构造器取回 ref 的唯一入口。写入是异步 IO，而 `createToolResultDisplay` 是同步纯函数、位于
// 所有工具的热路径（spec R7.1）——两侧靠一个 **WeakMap 侧信道**衔接，逐字照
// `handlers/read-url.ts` 的 `readUrlDisplayMetas` 先例：
//
//   handler（async，有 context/artifactStore）
//        └─ 写入成功 ──▶ WeakMap.set(output, refs)
//                                   │ 同一个 output 对象身份
//                                   ▼
//   createNodeReplDisplay（sync）── readNodeReplImageRefs(output) ──▶ 发 ref 形态
//
// 为什么用侧信道而不是给 `JsOutputSchema` 加字段：那个 schema 是 `.strict()` 且经
// `registry.toContracts()` **声明给模型**的对外契约，加字段等于改模型可见面，还会给
// `validateOutput` 多一条拒绝路径。WeakMap 键身份则保证只有本模块产出的 output 能命中
// ——别的工具的输出对象、伪造对象一律取不到 ref，ref 也不可能被模型回写（spec R7.2）。
//
// 失败语义（spec R9）：写失败**不改写**已成功的工具运行，该张图不进侧信道 → display 自然
// 回落 inline base64；但 abortSignal 已取消时**必须重抛**，取消不是「持久化失败」。
import type { JsOutput, ToolArtifactStorePort } from "@acode/contracts";
import {
  inspectToolMediaRef,
  toolMediaRefImageSchema,
  type ToolMediaRefImage,
} from "@acode/shared/acode-protocol-v4";
import { isAbsolute, resolve } from "node:path";
import type { NodeReplSession } from "../../repl/node-repl-session.js";
import type { ToolExecutionContext } from "../types.js";
import {
  extensionForImageMimeType,
  MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES,
  shouldEmitToolMediaRefs,
} from "../executor/tool-media-limits.js";

/**
 * 一张已持久化图片的 ref 记录。`index` 是它在 `JsOutput.images` 里的下标——
 * display 构造器按下标把 inline 图换成 ref 图，因此「一张图最多持久化一次」是可证明的
 * （spec R7.3）。
 */
export interface NodeReplImageRef {
  index: number;
  ref: string;
  mimeType: string;
  bytes: number;
}

const nodeReplImageRefChannel = new WeakMap<JsOutput, readonly NodeReplImageRef[]>();

/**
 * 取回本次工具输出已持久化的图片 ref（同步、无 IO）。
 *
 * 返回 undefined = 本次没有产 ref（门关闭 / store 缺席 / 全部写失败 / 非本模块产出的输出对象）。
 * display 构造器据此逐字保持 inline 行为。
 */
export function readNodeReplImageRefs(output: unknown): readonly NodeReplImageRef[] | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  return nodeReplImageRefChannel.get(output as JsOutput);
}

/** 写入侧信道（handler 在持久化成功后调用；空数组不写，读取方一律按 undefined 处理）。 */
export function noteNodeReplImageRefs(output: JsOutput, refs: readonly NodeReplImageRef[]): void {
  if (refs.length > 0) nodeReplImageRefChannel.set(output, refs);
}

/**
 * 把 node-repl 图片写成 artifact，返回可发布的 ref 记录。
 *
 * **写入形态是 data URL 文本，不是裸二进制**（spec R8.1，已实测）：读取链末端
 * `decodePromptAttachmentDataUrl`（bootstrap/app/create-app.ts）要求正文形如
 * `data:<mime>;base64,<payload>`，而 `writeToolResultBinaryArtifact` 落的是裸字节、
 * 读回是无 `data:` 头的 base64 串 → 必然 `previewArtifactInvalid`。因此这里用
 * `writeToolResultArtifact({ contentType: "text/plain" })`，与 `writePromptAttachment`、
 * `runtime/helpers/attachment-artifacts.ts` 同一形态。
 *
 * 生产上限不提高（spec R7.4）：超过 200 KiB base64 字符的图**不持久化**，
 * 于是它走 inline 分支被 display 侧按既有规则丢弃并标 `truncated`。
 *
 * `sha256` / `width` / `height` **刻意不发**：schema 里它们可选，但当前没有任何消费方读取
 * （renderer 只承载元数据，校验接线是 spec 未落地项）。发没人读的字段只是白加 wire 与计算。
 */
export async function persistNodeReplImageRefs(params: {
  artifactStore: ToolArtifactStorePort;
  context: ToolExecutionContext;
  images: readonly { base64: string; mimeType: string }[];
}): Promise<NodeReplImageRef[]> {
  const { artifactStore, context, images } = params;
  const refs: NodeReplImageRef[] = [];

  for (const [index, image] of images.entries()) {
    if (!image || typeof image.base64 !== "string" || typeof image.mimeType !== "string") {
      continue;
    }
    const base64 = stripDataUrlPrefix(image.base64);
    if (base64.length === 0) continue;
    // 上限：ref 形态改变字节的存放位置，不改变数量（spec R7.4）。
    if (Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES) continue;

    const mimeType = image.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!/^image\/[a-z0-9.+-]+$/iu.test(mimeType)) continue;

    let uri: string;
    let bytes: number;
    try {
      const artifact = await artifactStore.writeToolResultArtifact(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          // 归属工具名与既有 node-repl 截图写入面一致（spec R8：不新造归属）。
          toolName: "js",
          content: `data:${mimeType};base64,${base64}`,
          contentType: "text/plain",
          retention: "session",
          trace: context.traceContext,
        },
        { signal: context.abortSignal },
      );
      uri = artifact.uri;
      // bytes 是**解码后**的字节数：renderer 用它占位，gateway 用它做越界判定（spec R8.4）。
      bytes = Buffer.byteLength(base64, "base64");
    } catch (error) {
      // artifact 故障不能把已成功的工具运行改写成失败；但取消仍必须沿用既有取消语义上抛。
      if (context.abortSignal.aborted) throw error;
      continue;
    }
    if (bytes <= 0) continue;

    const candidate: ToolMediaRefImage = { ref: uri, mimeType, bytes };
    // 发布前的形态门（spec R8.3）：uri 理论上恒合法，但「发布一个 wire schema 会拒的 ref」
    // 等价于发布永久坏图。fail-closed 比信任便宜——不过就回落 inline。
    if (inspectToolMediaRef(candidate.ref) !== null) continue;
    if (!toolMediaRefImageSchema.safeParse(candidate).success) continue;

    refs.push({ index, ref: candidate.ref, mimeType: candidate.mimeType, bytes: candidate.bytes });
  }
  return refs;
}

/** data URL 前缀剥离（与 display 构造侧同一规则，保证两路对同一张图判定一致）。 */
function stripDataUrlPrefix(encoded: string): string {
  return encoded.startsWith("data:")
    ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
    : encoded;
}

/** handler 判定是否具备写入能力（端口上该方法恒在，这里集中判据，不散落 typeof）。 */
export function canWriteToolArtifact(store: ToolArtifactStorePort | undefined): boolean {
  return typeof store?.writeToolResultArtifact === "function";
}

/**
 * U11 的一次性接线点：**门判定 + 持久化 + 写侧信道**。
 *
 * handler 只调这一个函数（把门、store 探测、下标对齐、失败降级全部收在本叶子内），
 * 于是 `node-repl.ts` 不必为 ref 生产长出分支——那个文件已贴住 max-lines。
 *
 * 返回 void：ref 通过 WeakMap 侧信道交给同步 display 构造器（spec R7.2），
 * **不进** `JsOutput`（那是 `.strict()` 且声明给模型的对外契约）。
 *
 * 失败语义（spec R9）：单张写失败只让那张图不进侧信道（display 回落 inline），
 * 不改写已成功的工具运行；`abortSignal` 已取消时由 `persistNodeReplImageRefs` 上抛，
 * 本函数刻意不再包 try/catch——取消不是「持久化失败」，不能被降级吞掉。
 */
export async function persistNodeReplImageRefsForOutput(params: {
  /** 注册期灰度门（`createJsHandler` 闭包捕获），默认 false。 */
  enabled: boolean;
  context: ToolExecutionContext;
  images: readonly { base64: string; mimeType: string }[];
  output: JsOutput;
}): Promise<void> {
  const { context, enabled, images, output } = params;
  if (images.length === 0) return;
  if (
    !shouldEmitToolMediaRefs({
      enabled,
      clientMode: context.clientMode,
      hasArtifactStore: canWriteToolArtifact(context.artifactStore),
    })
  ) {
    return;
  }
  // 上面已探测过写入能力，这里的非空断言与 shouldEmitToolMediaRefs 的判据同源。
  const refs = await persistNodeReplImageRefs({
    artifactStore: context.artifactStore!,
    context,
    images,
  });
  noteNodeReplImageRefs(output, refs);
}

/**
 * 把本次 run 里确认来自显式 `tab.screenshot()` 的截图写成 artifact，返回**模型面**的绝对路径。
 *
 * 从 `node-repl.ts` 原样搬来（本文件是该 handler 的媒体写入面，两条写入链同住一处）：
 * 这条链写的是**裸二进制**（`writeToolResultBinaryArtifact`），消费者是模型正文里的
 * `browserScreenshotPaths`（文件路径），**不经过** `decodePromptAttachmentDataUrl`；
 * 与上面 `persistNodeReplImageRefs` 的 data URL 文本形态因此**刻意不同**（spec R8.1 的对照表）。
 *
 * 失败语义逐字保留：artifact 故障不改写已成功的 Browser 命令，但 abort 仍必须上抛。
 */
export async function persistBrowserScreenshotPaths(
  run: Awaited<ReturnType<NodeReplSession["run"]>>,
  context: ToolExecutionContext,
): Promise<string[]> {
  const indices = run.browserScreenshotImageIndices;
  const writeBinary = context.artifactStore?.writeToolResultBinaryArtifact;
  if (!indices || indices.length === 0 || !writeBinary || !run.images) return [];

  const paths: string[] = [];
  for (const index of indices) {
    const image = run.images[index];
    if (!image) continue;
    try {
      const artifact = await writeBinary.call(
        context.artifactStore,
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          toolName: "js",
          content: Buffer.from(image.base64, "base64"),
          contentType: image.mimeType,
          extension: extensionForImageMimeType(image.mimeType),
          retention: "session",
          trace: context.traceContext,
        },
        { signal: context.abortSignal },
      );
      if (artifact.path)
        paths.push(isAbsolute(artifact.path) ? artifact.path : resolve(artifact.path));
    } catch (error) {
      // 路径是截图的辅助输出，artifact 故障不能把已成功的
      // Browser 命令改写为失败；但请求取消仍必须沿用工具的取消语义。
      if (context.abortSignal.aborted) throw error;
    }
  }
  return paths;
}
