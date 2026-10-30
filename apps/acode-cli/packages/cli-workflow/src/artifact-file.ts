// ============================================================
// 产物发布的取字节半身：文件读盘（自 workflow-artifact-publish.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 550 行超过 400 行门禁。本叶承载发布的第 2/3 件事中「文件」这一支：
// 路径解析与越界判定（含 realpath 复核）、cap+1 探测读字节、扩展名定 MIME。依赖方向：
// artifact-validate ← artifact-file ← artifact-markdown ← 原文件。叶子不反向 import 桶，
// 故发布所需的端口集合 `ArtifactPublishDeps` 由本叶声明，原文件 re-import 供 orchestration 使用。
// ⚠ 术语同本族：这里的 artifact 是**用户面产物**，不是给模型看的返回值。

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type SessionId,
  type ToolArtifactStorePort,
} from "@acode/contracts";
import {
  ARTIFACT_CAPS,
  WorkflowError,
  type ArtifactPublishRequest,
} from "@acode/dynamic-workflow";
import { resolveWithinWorkspace, toWorkspaceRelative } from "./workflow-world-read.js";
import { describeArg, errorText } from "./artifact-validate.js";

/** 产物发布需要的端口与基准目录（driver deps 的一个子集，同 `WorldReadDeps`）。 */
export interface ArtifactPublishDeps {
  /** 读取被发布文件的字节所用的文件系统端口。 */
  readonly fileSystemPort: FileSystemPort;
  /** 路径解析与相对化的基准目录（workspace 根）。 */
  readonly cwd: string;
  /**
   * 字节的落点。**可选**：纯 replay / fake 装配没有 store。
   * 缺席时内容成员以 `ArtifactStoreUnavailable` 大声拒绝——不是静默降级成
   * 「发布了一个空产物」，也不是退回写工作区。
   */
  readonly artifactStore?: ToolArtifactStorePort;
  /**
   * store 写入的会话作用域 = 本 run 的**父会话**。与 `artifactStore`
   * 成对出现：store 的每次写入都按会话记账（`acode-artifact://<session>/<id>`），没有会话 id
   * 就写不出一条日后读得回来的记录。两者都在场才算装配了发布能力，缺一即
   * `ArtifactStoreUnavailable`（缺 store 是「这个装配没有存储」，缺 id 是接线错误——两者对
   * 脚本是同一件事：这次发布做不了，且必须大声）。
   */
  readonly parentSessionId?: SessionId;
}

/** 待写入 store 的一份内容。`file` 走二进制写，`markdown` 走文本写。 */
export type ArtifactPayload =
  | {
      readonly kind: "binary";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /** 落盘文件名的扩展名（store 读回时按文件名回推类型，所以要保真）。 */
      readonly extension?: string;
      /** 工作区相对的原路径（出处 + 「在工作区显示」）。 */
      readonly sourcePath: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly contentType: "text/markdown" };

/**
 * `artifact.file(id, path, opts)`：解析路径 → 读字节（cap+1 探测）→ 定 contentType。
 */
export async function readFilePayload(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
  opts: { contentType?: string },
): Promise<ArtifactPayload> {
  const given = request.path;
  if (typeof given !== "string" || given === "") {
    // 引擎已验过 payload 是字符串；空串只可能来自接线错误。
    throw new WorkflowError(
      "DriverError",
      `artifact.file: path must be a non-empty string, got ${describeArg(given)}. Pass the ` +
        `workspace-relative path the subagent wrote.`,
    );
  }
  const { real, relative } = await resolveWorkspaceFile(deps, given);
  const bytes = await readCappedBytes(deps, given, real);
  const extension = fileExtension(real);
  return {
    kind: "binary",
    bytes,
    contentType:
      opts.contentType ??
      (extension === undefined ? undefined : EXTENSION_CONTENT_TYPES[extension]) ??
      // 未列入扩展名表 = 不猜（不做 magic bytes 嗅探）。UI 据此给「下载 / 在工作区
      // 显示」卡而不是渲染一份它读不懂的东西。
      "application/octet-stream",
    ...(extension === undefined ? {} : { extension }),
    sourcePath: relative,
  };
}

/**
 * 把脚本给的**工作区相对**路径解析成一个可读的真实路径，并两次判定越界。
 *
 * 第一次是词法的（{@link resolveWithinWorkspace}，与 `files.read` 同一个判据）；第二次在
 * realpath 之后——**符号链接按解析后的真实路径判越界**。世界读取
 * 那一侧刻意只做词法检查（读出来的字节就是脚本自己看到的值，越界与否脚本自己负责），
 * 这一侧不能照抄：发布把字节**拷进一个持久 store 并摆到用户面前**，一条软链就能让
 * `~/.ssh/id_rsa` 变成一张卡片。这道复核就是那条不变式在写入端的落点。
 *
 * `cwd` 自己也要 realpath：macOS 上 `/tmp` 就是 `/private/tmp` 的软链，不归一的话工作区内的
 * 每一个文件都会被判成越界。
 */
async function resolveWorkspaceFile(
  deps: ArtifactPublishDeps,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWithinWorkspace(deps.cwd, given);
  if (resolved === undefined) throw outsideWorkspace(given);
  // 出处用的是**脚本给的那个路径**（归一后），不是 realpath：卡片上的「在工作区显示」要
  // 指回用户认得的那个位置，而不是软链的落点。
  const relative = toWorkspaceRelative(deps.cwd, resolved);

  let realCwd: string;
  let real: string;
  try {
    realCwd = await realpath(deps.cwd);
  } catch (cause) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: cannot resolve the workspace root '${deps.cwd}': ${errorText(cause)}`,
      { cause },
    );
  }
  try {
    real = await realpath(resolved);
  } catch (cause) {
    // ENOENT（含中途某一段不存在）走这里：路径不存在与"指向一个不存在的软链目标"是同一件事。
    throw sourceMissing(given, cause);
  }
  if (resolveWithinWorkspace(realCwd, real) === undefined) throw outsideWorkspace(given);
  return { real, relative };
}

/**
 * 读字节，**cap+1 探测**：端口的 `maxBytes` 是"超了就 `too_large`，不截断"，所以取 cap+1
 * 时，"恰好 cap 字节"（放行）与"超过 cap"（拒绝）可区分，且最坏也只多读一个字节。
 * 与 `files.grep` / `git.diff` 的同一惯用法。
 */
async function readCappedBytes(
  deps: ArtifactPublishDeps,
  given: string,
  path: string,
): Promise<Uint8Array> {
  const cap = ARTIFACT_CAPS.maxFileBytes;
  let result: FileSystemReadBytesResult;
  try {
    result = await deps.fileSystemPort.readBinaryFile({ path, maxBytes: cap + 1 });
  } catch (cause) {
    if (isFileSystemPortError(cause)) {
      if (cause.code === "too_large") throw tooLarge(given, cap);
      // not_found / is_directory / not_file 都是"这里没有一个可发布的普通文件"。
      if (cause.code === "not_found" || cause.code === "is_directory" || cause.code === "not_file") {
        throw sourceMissing(given, cause);
      }
    }
    throw new WorkflowError(
      "DriverError",
      `artifact.file: failed to read '${given}': ${errorText(cause)}`,
      { cause },
    );
  }
  if (result.content.byteLength > cap) throw tooLarge(given, cap);
  return result.content;
}

/**
 * 扩展名 → MIME。表外的一律 `application/octet-stream`：
 * **不做内容嗅探**（magic bytes 会引入第二个判据，而两个判据迟早会给出两个答案）。
 *
 * 为什么不复用 core 的 `inferAttachmentMimeFromPath`：那张表服务的是**模型输入附件**，
 * 兜底是 `text/plain`（把一切像文本的东西喂给模型是它想要的行为）。这里的消费者是 UI 的
 * 分派，兜底必须是"我不认识它，给下载卡"——同一个兜底在两处的正确值恰好相反。
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * 文件名的扩展名（小写，不含点）。只认 `[a-z0-9]+`：`archive.tar.gz` 取 `gz`，
 * `Makefile`、`.gitignore`（点开头无后缀）与 `report.v2 final` 一律无扩展名。
 */
function fileExtension(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function outsideWorkspace(given: string): WorkflowError {
  return new WorkflowError(
    "ArtifactPathOutsideWorkspace",
    `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by ` +
      `their real path). Only files inside the workspace can be published.`,
  );
}

function sourceMissing(given: string, cause: unknown): WorkflowError {
  return new WorkflowError(
    "ArtifactSourceMissing",
    `artifact.file: '${given}' does not exist or is not a regular file. Confirm the subagent ` +
      `actually wrote it before publishing.`,
    { cause },
  );
}

function tooLarge(given: string, cap: number): WorkflowError {
  return new WorkflowError(
    "ArtifactTooLarge",
    `artifact.file: '${given}' is over the cap of ${cap} bytes. Publish a smaller artifact ` +
      `(a summary, a slice, or a compressed version).`,
  );
}
