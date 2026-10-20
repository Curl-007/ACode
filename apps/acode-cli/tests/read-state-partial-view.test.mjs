import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * specs/post-compact-read-state.md 验收场景 3：partial view（token 上限截断的 Read）
 * 拒绝文案必须与「从未读过」区分——错误码维持 FILE_NOT_READ 不变，文案含截断事实与
 * 可执行恢复动作；未读路径原文案不变（既有语义零回归）。
 */

const { editToolEntry } = await import("../packages/core/src/tool/handlers/edit.ts");
const { writeToolEntry } = await import("../packages/core/src/tool/handlers/write.ts");
const { applyPatchToolEntry } = await import("../packages/core/src/tool/handlers/apply-patch.ts");
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { createReadFileStateKey } = await import("../packages/core/src/tool/read-file-state.ts");
const { EditErrorCode } = await import("../packages/contracts/src/tools/edit.ts");
const { ApplyPatchErrorCode } = await import("../packages/contracts/src/tools/apply-patch.ts");

const workspace = mkdtempSync(join(tmpdir(), "acode-partial-view-"));
after(() => {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeContext(readFileState = new Map()) {
  return {
    toolCallId: "tc-partial-view-test",
    traceId: "trace-partial-view-test",
    abortSignal: new AbortController().signal,
    fileSystemPort: createNodeFileSystemAdapter(),
    workingDirectory: workspace,
    workspaceRoot: workspace,
    readFileState,
  };
}

function seedRead(readFileState, path, content, overrides = {}) {
  readFileState.set(createReadFileStateKey(path, 1, undefined), {
    path,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Read",
    ...overrides,
  });
}

function writeWorkspaceFile(relativePath, content) {
  const full = join(workspace, relativePath);
  writeFileSync(full, content, "utf8");
  return full;
}

// ── Edit ──────────────────────────────────────────────────────────────

test("edit: partial view 拒绝文案与未读区分，文件不被修改", async () => {
  const full = writeWorkspaceFile("edit-partial.txt", "alpha\nbeta\n");
  const context = makeContext();
  seedRead(context.readFileState, full, "alpha\n…truncated…\n", { isPartialView: true });

  const result = await editToolEntry.handler(
    { file_path: full, old_string: "alpha", new_string: "ALPHA" },
    context,
  );
  assert.equal(result.result, false);
  assert.equal(result.errorCode, EditErrorCode.FILE_NOT_READ, "错误码维持 FILE_NOT_READ 契约");
  assert.match(result.message, /truncated view/, "文案必须说明视图被截断");
  assert.match(result.message, /offset\/limit/, "文案必须给出范围重读的恢复动作");
  assert.doesNotMatch(result.message, /has not been read yet/, "不得复用未读文案");
  assert.equal(readFileSync(full, "utf8"), "alpha\nbeta\n");
});

test("edit: 未读文案原样保留（零回归钉）", async () => {
  const full = writeWorkspaceFile("edit-unread.txt", "content\n");
  const result = await editToolEntry.handler(
    { file_path: full, old_string: "content", new_string: "new" },
    makeContext(),
  );
  assert.equal(result.errorCode, EditErrorCode.FILE_NOT_READ);
  assert.equal(result.message, "File has not been read yet. Read it first before writing to it.");
});

// ── ApplyPatch ────────────────────────────────────────────────────────

function patch(...lines) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

test("apply-patch: partial view 拒绝文案与未读区分", async () => {
  const full = writeWorkspaceFile("patch-partial.txt", "alpha\nbeta\n");
  const context = makeContext();
  seedRead(context.readFileState, full, "alpha\n…truncated…\n", { isPartialView: true });

  const result = await applyPatchToolEntry.handler(
    { patch_text: patch("*** Update File: patch-partial.txt", "-alpha", "+ALPHA") },
    context,
  );
  assert.equal(result.errorCode, ApplyPatchErrorCode.FILE_NOT_READ, "错误码维持 FILE_NOT_READ 契约");
  assert.match(result.message, /truncated view/);
  assert.match(result.message, /offset\/limit/);
  assert.equal(readFileSync(full, "utf8"), "alpha\nbeta\n");

  const notRead = await applyPatchToolEntry.handler(
    { patch_text: patch("*** Update File: patch-partial.txt", "-alpha", "+ALPHA") },
    makeContext(),
  );
  assert.equal(notRead.errorCode, ApplyPatchErrorCode.FILE_NOT_READ);
  assert.equal(notRead.message, "File has not been read yet. Read it first before patching it.");
});

// ── Write ─────────────────────────────────────────────────────────────

test("write: partial view 抛错文案要求完整重读", async () => {
  const full = writeWorkspaceFile("write-partial.txt", "original\n");
  const context = makeContext();
  seedRead(context.readFileState, full, "orig…truncated…\n", { isPartialView: true });

  await assert.rejects(
    writeToolEntry.handler({ file_path: full, content: "replacement\n" }, context),
    (error) => {
      assert.match(error.message, /truncated view/, "文案必须说明视图被截断");
      assert.match(error.message, /full file/, "Write 整文件覆盖，恢复动作是完整重读");
      assert.equal(error.context?.code, "write_partial_read", "接线契约预留码 PARTIAL_READ");
      return true;
    },
  );
  assert.equal(readFileSync(full, "utf8"), "original\n");
});

test("write: 未读已存在文件文案原样保留（零回归钉）", async () => {
  const full = writeWorkspaceFile("write-unread.txt", "original\n");
  await assert.rejects(
    writeToolEntry.handler({ file_path: full, content: "replacement\n" }, makeContext()),
    (error) => {
      assert.equal(error.message, "File has not been read yet. Read it first before writing to it.");
      assert.equal(error.context?.code, "write_file_not_read");
      return true;
    },
  );
});
