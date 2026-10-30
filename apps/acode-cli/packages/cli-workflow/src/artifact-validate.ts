// ============================================================
// 产物发布的形状校验与 store 探测（自 workflow-artifact-publish.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 550 行超过 400 行门禁。本叶承载发布的第 1/4 件事：实参与 opts 的形状校验，
// 以及 store 落点探测（requireArtifactStore）。依赖方向：artifact-validate ← artifact-file ←
// artifact-markdown ← 原文件（桶只再导出，叶子不反向 import 桶）。
// ⚠ 术语：本族文件里的 artifact 一律指**用户面产物**（脚本经 `artifact.file` /
// `artifact.markdown` 交付给用户看的字节），不是引擎内部给模型看的返回值。

import {
  type SessionId,
  type ToolArtifactStorePort,
} from "@acode/contracts";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  WorkflowError,
  type ArtifactPublishRequest,
} from "@acode/dynamic-workflow";

/** 校验过的 `opts`（facade 的 `ArtifactOptions` / `ArtifactFileOptions`）。 */
export interface ArtifactPublishOptions {
  title?: string;
  description?: string;
  /** 只有 `file` 读它：markdown 恒 `text/markdown`。 */
  contentType?: string;
}

/** 已确认可用的发布落点：store 本体 + 会话作用域（见原文件的 `ArtifactPublishDeps`）。 */
export interface ArtifactStoreTarget {
  readonly store: ToolArtifactStorePort;
  readonly sessionId: SessionId;
}

/**
 * 产物 id 的运行期护栏。编译期的字面量诊断（分析器）是正门，引擎又挡了一次「必须是非空
 * 字符串」——这里再验字符集与长度，是因为**只有这一侧把 id 当键用**：它进 store 的
 * `toolCallId`，最终成为落盘文件名的一段。走到这里的非法 id 只可能是有东西绕过了编译，
 * 用 `DriverError` 而不是某个 `Artifact*` 码，让那些码只表示它们各自的那件事。
 */
export function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

/**
 * 取出并校验脚本给的 `opts`。三条规则与 `worldRunArgs` 同源：
 *   1. 缺席合法（`opts?`），在场必须是选项对象（不是数组、不是 null）。
 *   2. 认识的键逐个验类型与上限，**绝不强转**——一个被 `String(undefined)` 变成
 *      `"undefined"` 的标题，会在卡片上显示成一个查不明白的字符串而不是一条能改的错误。
 *   3. 不认识的键静默忽略（facade 的类型签名在编译期就拦住了它们；运行期为它们报错只会
 *      把一个编译期问题搬到运行期）。`markdown` 一族因此根本不读 `contentType`。
 */
export function artifactPublishOptions(request: ArtifactPublishRequest): ArtifactPublishOptions {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object, got ${describeArg(raw)}. ` +
        `Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = optionalText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = optionalText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType = request.op === "file" ? optionalContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/**
 * 确认这次发布有落点，否则 `ArtifactStoreUnavailable`。**按 op 分别探测**：文件要二进制写
 * （`writeToolResultBinaryArtifact` 在端口上是可选方法），markdown 只要文本写。一个只有文本
 * 写的 store 因此能发 markdown、发不了文件——而"发不了"是一条命名的拒绝，不是把 PDF 当
 * UTF-8 塞进文本通道（那会静默毁掉字节）。
 */
export function requireArtifactStore(
  deps: {
    readonly artifactStore?: ToolArtifactStorePort;
    readonly parentSessionId?: SessionId;
  },
  request: ArtifactPublishRequest,
): ArtifactStoreTarget {
  const store = deps.artifactStore;
  if (store === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no ` +
        `artifact store.`,
    );
  }
  if (request.op === "file" && store.writeToolResultBinaryArtifact === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
        `does not support binary writes.`,
    );
  }
  const sessionId = deps.parentSessionId;
  if (sessionId === undefined || sessionId === "") {
    // store 在场而会话 id 缺席只可能是接线错误（两者在生产装配里同进同出）。仍然报同一个
    // 码：对脚本而言这是同一件事——这次发布没有落点。
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because the artifact store has ` +
        `no session scope (parent session id not wired).`,
    );
  }
  return { store, sessionId };
}

/** 一个可选的有界文本选项（title / description）。长度按字符数（UTF-16 码元）计。 */
function optionalText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string, got ${describeArg(value)}.`,
    );
  }
  if (value.length > max) {
    // 拒绝而不是截断：一个被砍掉后半句的标题是一件**看起来正常**的坏交付物，而卡片上
    // 没有任何地方能显示"这里被截过"。
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ` +
        `${max}. Shorten it.`,
    );
  }
  return value;
}

/**
 * `opts.contentType` 的覆盖值。要求是**不带参数的**裸 MIME（`type/subtype`）：这个字符串的
 * 消费者是 UI 的一个精确分派（`text/markdown` 走 markdown 卡、`application/pdf` 走 pdf 卡），
 * 一条 `text/markdown; charset=utf-8` 会整条错过那个分支，表现是「明明写了类型却掉进下载卡」。
 */
function optionalContentType(request: ArtifactPublishRequest, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType must be a string, got ${describeArg(value)}.`,
    );
  }
  if (!CONTENT_TYPE_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as ` +
        `'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on ` +
        `the exact string.`,
    );
  }
  return value;
}

/** 裸 MIME（`type/subtype`，不带参数）。见 `optionalContentType` 的理由。 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/** 实参形状的简短描述（只用于错误消息，不回显完整内容）。 */
export function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** 任意抛出物的单行文本（错误消息用）。 */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
