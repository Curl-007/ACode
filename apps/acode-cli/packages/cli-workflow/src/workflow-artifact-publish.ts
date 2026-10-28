// ============================================================
// 用户面产物的发布（Boundary B 的 artifact.* 侧）
// ============================================================
// ⚠ 术语：本文件及 import 到的东西里的 artifact 一律指**用户面产物**——脚本经 `artifact.file` /
// `artifact.markdown` 交付给用户看的字节——不是引擎内部给模型看的 tool result。
//
// `executeArtifactPublish`（原 `DynamicWorkflowRunServiceDeps` 的 `artifactPublishDeps` 子集）实现引擎的 `executeArtifactPublish?`，把脚本的
// `artifact.file(id, path, opts)` / `artifact.markdown(id, content, opts)` 落成
// **一份持久产物**：读字节 → 写 store → 返回版本记录。
//
// 四个阶段，一次发布：
//
//   1. **形状校验**。`id` 走字符集与长度的运行期护栏（编译期字面量诊断是正门，这里是兜底）；
//      `opts` 逐键验类型与上限，**绝不强转**。
//   2. **取字节**。`file` 一支：路径解析 + 越界判定（含符号链接的 realpath 复核）+ cap+1
//      探测读字节；`markdown` 一支：正文按 UTF-8 计字节。
//   3. **定 contentType**。`file` 有 `opts.contentType` 覆盖（裸 MIME），否则按扩展名查表，
//      表外一律 `application/octet-stream`——不做内容嗅探。`markdown` 恒 `text/markdown`。
//   4. **写 store**。落点 = `artifactStore` + 会话作用域（driver 的 `parentSessionId`）。store 的写入
//      API 一次调用就产出一个版本号并给出完整记录（含 `acode-artifact://` 链接），**没有**
//      「先写内容、再注册元数据」的两步——也就不存在版本行与字节不一致的中间态。
//
// 行数拆分（原 550 行超过 400 行门禁）：按阶段拆成三个叶子——
//   - artifact-validate.ts：形状校验与 store 落点探测（第 1 件事）；
//   - artifact-file.ts：文件取字节（第 2/3 件事的文件一支，含 `ArtifactPublishDeps`）；
//   - artifact-markdown.ts：markdown 取字节与写 store（第 2 件事的 markdown 一支 + 第 4 件事）。
// 本文件降为 orchestration（第 1→4 步的串联）+ 桶：只导出 `executeArtifactPublish`，与拆分前完全一致。
// 叶子只向前依赖（validate ← file ← markdown ← 本文件），不反向 import 本文件。
//
// 失败一律以命名的 `WorkflowError` 抛出，引擎负责映射成 `failure_json`：
// `ArtifactSourceMissing` / `ArtifactPathOutsideWorkspace` / `ArtifactStoreUnavailable` /
// `ArtifactTooLarge` / `DriverError`。

import type { ToolArtifactWriteResult } from "@acode/contracts";
import type { ArtifactPublishRequest, ArtifactVersionRecord } from "@acode/dynamic-workflow";
import type { ArtifactPublishDeps } from "./artifact-file.js";
import { readFilePayload } from "./artifact-file.js";
import { markdownPayload, writePayload } from "./artifact-markdown.js";
import { artifactPublishOptions, assertArtifactId, requireArtifactStore } from "./artifact-validate.js";

/**
 * 一次用户面产物的发布。引擎已在 dispatch 前保证：payload 是非空字符串、id 已校验、
 * version 来自 journal 里的当前条目、同一 (run, 站点, ordinal) 在会话里串行。
 * 本函数负责余下的四步（见文件头）。
 */
export async function executeArtifactPublish(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): Promise<ArtifactVersionRecord> {
  assertArtifactId(request);
  const opts = artifactPublishOptions(request);

  // 先确认有落点：没有 store 时，任何一条发布都必须失败，而不是读完了字节才在最后一步炸。
  const target = requireArtifactStore(deps, request);

  const payload =
    request.op === "file"
      ? await readFilePayload(deps, request, opts)
      : markdownPayload(request);

  const written: ToolArtifactWriteResult = await writePayload(target, request, payload);

  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    // contentType 取**本地算出的**那一个而不是 store 的回执：扩展名表 + `opts.contentType`
    // 覆盖共同决定内容类型，UI 在这个字符串上做 switch 分派；让 store 的归一化（它按
    // 落盘文件名回推类型）成为权威，会让一次分派结果取决于 store 实现。
    contentType: payload.contentType,
    // bytes / uri 取 store 的回执：那是**真正落进 store 的那一份**，也是日后读回来的那一份。
    bytes: written.bytes,
    uri: written.uri,
    ...(payload.kind === "binary" ? { sourcePath: payload.sourcePath } : {}),
    // 引擎没有时钟（纯核心，可重放），所以发布时刻由这一侧填。发布时刻为必填字段。
    publishedAt: Date.now(),
  };
}
