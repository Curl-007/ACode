// ============================================================
// 产物发布的 markdown 半身与写 store（自 workflow-artifact-publish.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 550 行超过 400 行门禁。本叶承载「取字节」的 markdown 一支与「写 store」
// 整段（发布四件事的第 4 件）。依赖方向：artifact-validate ← artifact-file ← artifact-markdown
// ← 原文件。⚠ 术语同本族：这里的 artifact 是**用户面产物**，不是给模型看的返回值。
//
// 写入 store 的四个参数约束（{@link writePayload}）：
//   - `retention: "project"`——产物必须活过会话（中枢跨会话读运行历史里的产物）。
//   - `toolName: "CreateWorkflow"`——发布的归属工具就是启动这个 run 的那一个。
//   - `toolCallId: `${runId}:${siteId}@${ordinal}``——每一版一份字节，而 (run, 站点, 序号)
//     恰好唯一标定一次发布（版本号由引擎在 dispatch 前算好，同一版重跑 = 同一个 ordinal）。
//   - `sessionId` = 父会话。

import type { ToolArtifactWriteResult } from "@acode/contracts";
import {
  ARTIFACT_CAPS,
  WorkflowError,
  type ArtifactPublishRequest,
} from "@acode/dynamic-workflow";
import type { ArtifactPayload } from "./artifact-file.js";
import { describeArg, errorText, type ArtifactStoreTarget } from "./artifact-validate.js";

/** `artifact.markdown(id, content, opts)`：正文按 UTF-8 计字节，超限拒绝。 */
export function markdownPayload(request: ArtifactPublishRequest): ArtifactPayload {
  const content = request.content;
  if (typeof content !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.markdown: content must be a string, got ${describeArg(content)}.`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = ARTIFACT_CAPS.maxMarkdownBytes;
  if (bytes > cap) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.markdown: content is ${bytes} bytes, over the cap of ${cap} bytes. Shorten ` +
        `it, or write the long content to a workspace file and publish it with artifact.file.`,
    );
  }
  return { kind: "text", text: content, contentType: "text/markdown" };
}

/** 产物在 store 里的归属工具名：发布是 `CreateWorkflow` 这次调用的产物。 */
const ARTIFACT_TOOL_NAME = "CreateWorkflow";

/**
 * 写入 store。参数约束见本文件头部。`ArtifactStoreTarget` 已保证 store + 会话 id 都在场，
 * 且 `file` 的二进制写能力在 `requireArtifactStore` 里探测过。
 */
export async function writePayload(
  target: ArtifactStoreTarget,
  request: ArtifactPublishRequest,
  payload: ArtifactPayload,
): Promise<ToolArtifactWriteResult> {
  const common = {
    sessionId: target.sessionId,
    toolCallId: `${request.runId}:${request.siteId}@${request.ordinal}`,
    toolName: ARTIFACT_TOOL_NAME,
    retention: "project" as const,
  };
  try {
    if (payload.kind === "text") {
      return await target.store.writeToolResultArtifact({
        ...common,
        content: payload.text,
        contentType: payload.contentType,
      });
    }
    // 二进制写的存在性已在 requireArtifactStore 里探测过（op === "file" 分支）。
    const writeBinary = target.store.writeToolResultBinaryArtifact;
    if (writeBinary === undefined) {
      throw new WorkflowError(
        "ArtifactStoreUnavailable",
        `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
          `does not support binary writes.`,
      );
    }
    return await writeBinary.call(target.store, {
      ...common,
      content: payload.bytes,
      contentType: payload.contentType,
      // 扩展名随字节一起交给 store：它读回时按落盘文件名回推类型，丢了扩展名就等于把一份
      // .xlsx 读成 application/octet-stream。
      ...(payload.extension === undefined ? {} : { extension: payload.extension }),
    });
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    // 写失败（磁盘满、权限、store 自身的错误）是一次**具体**的失败，与"没有 store"不是
    // 同一件事，所以不复用 ArtifactStoreUnavailable：带上原因文本，让 journal 里的
    // failure_json 说得出为什么。
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: writing "${request.id}" v${request.version} to the artifact ` +
        `store failed: ${errorText(cause)}`,
      { cause },
    );
  }
}
