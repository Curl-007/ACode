import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * S2（能力提升方案批次 4）验收测试：ApplyPatch 工具落地。
 *
 * 规格 apps/acode-cli/specs/apply-patch-tool.md 验收场景 1–5：解析器、路径提取、
 * handler 集成（真实 NodeFileSystemAdapter + 临时目录）、旁路免疫熔断器的 patch_text
 * 路径逃逸接线、注册不变量。
 */

const { parseApplyPatch, extractApplyPatchTargetPaths } = await import(
  "../packages/core/src/tool/apply-patch-format.ts"
);
const { applyPatchToolEntry } = await import(
  "../packages/core/src/tool/handlers/apply-patch.ts"
);
const { builtInTools } = await import("../packages/core/src/tool/handlers/index.ts");
const { evaluateBypassImmuneBreakers } = await import(
  "../packages/core/src/permission/bypass-immune-breakers.ts"
);
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { createReadFileStateKey } = await import("../packages/core/src/tool/read-file-state.ts");
const { ApplyPatchErrorCode } = await import("../packages/contracts/src/tools/apply-patch.ts");

const workspace = mkdtempSync(join(tmpdir(), "acode-apply-patch-"));
after(() => {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function patch(...lines) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function makeContext(readFileState = new Map()) {
  return {
    toolCallId: "tc-apply-patch-test",
    traceId: "trace-apply-patch-test",
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
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

async function runHandler(patchText, context = makeContext()) {
  return applyPatchToolEntry.handler({ patch_text: patchText }, context);
}

// ── 场景 1：解析器 ────────────────────────────────────────────────────

test("parser: valid add/update/delete patch yields structured sections", () => {
  const result = parseApplyPatch(
    patch(
      "*** Add File: new.txt",
      "+first",
      "+second",
      "*** Update File: old.txt",
      "@@ hint ignored",
      " keep",
      "-gone",
      "+added",
      "*** Delete File: bye.txt",
    ),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sections.map((section) => section.kind),
    ["add", "update", "delete"],
  );
  assert.deepEqual(result.sections[0].lines, ["first", "second"]);
  assert.deepEqual(result.sections[1].hunks, [
    [
      { type: "context", text: "keep" },
      { type: "remove", text: "gone" },
      { type: "add", text: "added" },
    ],
  ]);
});

test("parser: missing Begin/End, trailing content, unknown directive, stray body are invalid", () => {
  assert.equal(parseApplyPatch("*** Add File: a\n+x\n*** End Patch").ok, false);
  assert.equal(parseApplyPatch("*** Begin Patch\n*** Add File: a\n+x").ok, false);
  for (const bad of [
    patch("*** Add File: a", "+x", "junk after end"),
    patch("*** Frobnicate File: a"),
    patch("orphan body line", "*** Add File: a", "+x"),
    patch("*** Add File: a", "no plus prefix"),
    patch("*** Delete File: a", "body not allowed"),
    patch("*** Update File: a", "x malformed hunk line"),
    patch("*** Update File: a"),
    patch("*** Move to: b"),
    patch("*** Move File: a", "+content after move"),
  ]) {
    const result = parseApplyPatch(bad);
    assert.equal(result.ok, false, `expected invalid: ${JSON.stringify(bad)}`);
    assert.equal(result.code, "invalid");
  }
});

test("parser: empty patch is code=empty; duplicate file sections rejected", () => {
  const empty = parseApplyPatch(patch());
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "empty");

  const dup = parseApplyPatch(patch("*** Add File: a.txt", "+x", "*** Update File: a.txt", " y"));
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /multiple sections/);
});

test("parser: CRLF patch text normalized; bare empty line tolerated as empty context", () => {
  const crlf = parseApplyPatch(patch("*** Add File: a.txt", "+x").replaceAll("\n", "\r\n"));
  assert.equal(crlf.ok, true);
  assert.deepEqual(crlf.sections[0].lines, ["x"]);

  const bare = parseApplyPatch(patch("*** Update File: a.txt", "", "-old", "+new"));
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.sections[0].hunks[0][0], { type: "context", text: "" });
});

test("parser: move section parsed with from/to", () => {
  const result = parseApplyPatch(patch("*** Move File: a.txt", "*** Move to: b.txt"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections[0], { kind: "move", from: "a.txt", to: "b.txt" });
});

// ── 场景 2：breaker 用宽松路径提取 ────────────────────────────────────

test("extractApplyPatchTargetPaths: all section headers plus Move to; malformed input safe", () => {
  const paths = extractApplyPatchTargetPaths(
    [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+x",
      "*** Update File: b/c.txt",
      "*** Delete File: d.txt",
      "*** Move File: e.txt",
      "*** Move to: f.txt",
      "*** End Patch",
    ].join("\n"),
  );
  assert.deepEqual(paths, ["a.txt", "b/c.txt", "d.txt", "e.txt", "f.txt"]);

  assert.deepEqual(extractApplyPatchTargetPaths("total garbage"), []);
  assert.deepEqual(extractApplyPatchTargetPaths("*** Add File:"), []);
});

// ── 场景 3：handler 集成（真实端口 + 临时目录）────────────────────────

test("handler: add creates file, updates readFileState, reports counts", async () => {
  const context = makeContext();
  const result = await runHandler(patch("*** Add File: add-basic.txt", "+one", "+two"), context);
  assert.equal(result.summary !== undefined, true, JSON.stringify(result));
  assert.equal(readFileSync(join(workspace, "add-basic.txt"), "utf8"), "one\ntwo\n");
  assert.deepEqual(
    result.files.map((file) => [file.filePath, file.type, file.additions, file.deletions]),
    [["add-basic.txt", "add", 2, 0]],
  );
  const entry = context.readFileState.get(
    createReadFileStateKey(join(workspace, "add-basic.txt"), 1, undefined),
  );
  assert.equal(entry?.sourceTool, "ApplyPatch");
});

test("handler: add onto existing file fails FILE_EXISTS without touching it", async () => {
  const full = writeWorkspaceFile("add-exists.txt", "original\n");
  const result = await runHandler(patch("*** Add File: add-exists.txt", "+x"));
  assert.equal(result.result, false);
  assert.equal(result.errorCode, ApplyPatchErrorCode.FILE_EXISTS);
  assert.equal(readFileSync(full, "utf8"), "original\n");
});

test("handler: update applies multiple hunks sequentially with exact unique match", async () => {
  const full = writeWorkspaceFile("update-multi.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n");
  const context = makeContext();
  seedRead(context.readFileState, full, readFileSync(full, "utf8"));
  const result = await runHandler(
    patch(
      "*** Update File: update-multi.txt",
      " alpha",
      "-beta",
      "+BETA",
      "@@ second hunk",
      "-epsilon",
      "+EPSILON",
    ),
    context,
  );
  assert.equal(result.summary !== undefined, true, JSON.stringify(result));
  assert.equal(
    readFileSync(full, "utf8"),
    "alpha\nBETA\ngamma\ndelta\nEPSILON\nzeta\n",
  );
  assert.deepEqual(result.files[0].structuredPatch.length > 0, true);
});

test("handler: unmatched hunk fails HUNK_NOT_FOUND; ambiguous hunk fails AMBIGUOUS_HUNK", async () => {
  const full = writeWorkspaceFile("update-match.txt", "dup\ndup\n");
  const context = makeContext();
  seedRead(context.readFileState, full, readFileSync(full, "utf8"));

  const notFound = await runHandler(
    patch("*** Update File: update-match.txt", " absent context", "-dup", "+x"),
    context,
  );
  assert.equal(notFound.errorCode, ApplyPatchErrorCode.HUNK_NOT_FOUND);

  const ambiguous = await runHandler(patch("*** Update File: update-match.txt", "-dup", "+x"), context);
  assert.equal(ambiguous.errorCode, ApplyPatchErrorCode.AMBIGUOUS_HUNK);
  assert.equal(readFileSync(full, "utf8"), "dup\ndup\n");
});

test("handler: unread target fails FILE_NOT_READ; stale target fails STALE_FILE", async () => {
  const full = writeWorkspaceFile("update-readstate.txt", "content\n");

  const notRead = await runHandler(
    patch("*** Update File: update-readstate.txt", "-content", "+new"),
    makeContext(),
  );
  assert.equal(notRead.errorCode, ApplyPatchErrorCode.FILE_NOT_READ);

  const staleContext = makeContext();
  seedRead(staleContext.readFileState, full, "something else entirely", { sizeBytes: 1 });
  const stale = await runHandler(
    patch("*** Update File: update-readstate.txt", "-content", "+new"),
    staleContext,
  );
  assert.equal(stale.errorCode, ApplyPatchErrorCode.STALE_FILE);
  assert.equal(readFileSync(full, "utf8"), "content\n");
});

test("handler: delete removes file and clears its readFileState entry", async () => {
  const full = writeWorkspaceFile("delete-me.txt", "bye\n");
  const context = makeContext();
  seedRead(context.readFileState, full, "bye\n");
  const result = await runHandler(patch("*** Delete File: delete-me.txt"), context);
  assert.equal(result.summary !== undefined, true, JSON.stringify(result));
  assert.equal(existsSync(full), false);
  assert.equal(
    context.readFileState.get(createReadFileStateKey(full, 1, undefined)),
    undefined,
  );
  assert.deepEqual(result.files[0].type, "delete");
});

test("handler: delete of missing file fails FILE_NOT_EXIST", async () => {
  const result = await runHandler(patch("*** Delete File: never-existed.txt"));
  assert.equal(result.errorCode, ApplyPatchErrorCode.FILE_NOT_EXIST);
});

test("handler: move section rejected with Bash guidance", async () => {
  writeWorkspaceFile("move-src.txt", "x\n");
  const result = await runHandler(patch("*** Move File: move-src.txt", "*** Move to: move-dst.txt"));
  assert.equal(result.result, false);
  assert.equal(result.errorCode, ApplyPatchErrorCode.INVALID_PATCH);
  assert.match(result.message, /git mv/);
});

test("handler: validation is atomic — later bad section prevents earlier writes", async () => {
  const full = writeWorkspaceFile("atomic-old.txt", "old\n");
  // 先满足 read-before-patch（否则 FILE_NOT_READ 先于 hunk 匹配触发——本身就是校验序
  // 的正确行为），让校验段走到 hunk 匹配才失败，从而验证「失败前零写入」。
  const context = makeContext();
  seedRead(context.readFileState, full, "old\n");
  const result = await runHandler(
    patch(
      "*** Add File: atomic-new.txt",
      "+should not land",
      "*** Update File: atomic-old.txt",
      " this context does not exist",
    ),
    context,
  );
  assert.equal(result.errorCode, ApplyPatchErrorCode.HUNK_NOT_FOUND);
  assert.equal(existsSync(join(workspace, "atomic-new.txt")), false);
  assert.equal(readFileSync(full, "utf8"), "old\n");
});

test("handler: multi-file add+update+delete in one patch all applied", async () => {
  const keep = writeWorkspaceFile("combo-update.txt", "one\ntwo\nthree\n");
  const gone = writeWorkspaceFile("combo-delete.txt", "x\n");
  const context = makeContext();
  seedRead(context.readFileState, keep, readFileSync(keep, "utf8"));
  seedRead(context.readFileState, gone, "x\n");
  const result = await runHandler(
    patch(
      "*** Add File: combo-add.txt",
      "+fresh",
      "*** Update File: combo-update.txt",
      " one",
      "-two",
      "+TWO",
      " three",
      "*** Delete File: combo-delete.txt",
    ),
    context,
  );
  assert.equal(result.summary !== undefined, true, JSON.stringify(result));
  assert.equal(readFileSync(join(workspace, "combo-add.txt"), "utf8"), "fresh\n");
  assert.equal(readFileSync(keep, "utf8"), "one\nTWO\nthree\n");
  assert.equal(existsSync(gone), false);
  assert.equal(result.files.length, 3);
});

test("handler: .ipynb update rejected with real-tool guidance (F7-consistent)", async () => {
  const full = writeWorkspaceFile("notebook.ipynb", '{"cells":[]}\n');
  const context = makeContext();
  seedRead(context.readFileState, full, '{"cells":[]}\n');
  const result = await runHandler(
    patch('*** Update File: notebook.ipynb', '-{"cells":[]}', '+{"cells":[1]}'),
    context,
  );
  assert.equal(result.errorCode, ApplyPatchErrorCode.NOTEBOOK_FILE);
  assert.match(result.message, /Write|Bash/);
});

// ── 场景 4：熔断器接线（spec R4 修复：patch_text 路径提取）────────────

test("breaker: ApplyPatch path escaping workspace fires pathEscapeWrite", () => {
  const escaping = evaluateBypassImmuneBreakers({
    toolName: "ApplyPatch",
    input: { patch_text: patch("*** Add File: ../../escaped.txt", "+x") },
    workspaceRoot: workspace,
    workingDirectory: workspace,
  });
  assert.equal(escaping?.ruleId, "breaker.pathEscapeWrite");
});

test("breaker: ApplyPatch with inside paths does not fire; malformed patch_text safe", () => {
  assert.equal(
    evaluateBypassImmuneBreakers({
      toolName: "ApplyPatch",
      input: { patch_text: patch("*** Add File: inside.txt", "+x") },
      workspaceRoot: workspace,
      workingDirectory: workspace,
    }),
    undefined,
  );
  assert.equal(
    evaluateBypassImmuneBreakers({
      toolName: "ApplyPatch",
      input: { patch_text: "not a patch at all" },
      workspaceRoot: workspace,
      workingDirectory: workspace,
    }),
    undefined,
  );
});

test("breaker: existing Write file_path escape behavior unchanged after refactor", () => {
  const hit = evaluateBypassImmuneBreakers({
    toolName: "Write",
    input: { file_path: join(workspace, "..", "outside.txt"), content: "x" },
    workspaceRoot: workspace,
    workingDirectory: workspace,
  });
  assert.equal(hit?.ruleId, "breaker.pathEscapeWrite");
  assert.equal(
    evaluateBypassImmuneBreakers({
      toolName: "Write",
      input: { file_path: "inside.txt", content: "x" },
      workspaceRoot: workspace,
      workingDirectory: workspace,
    }),
    undefined,
  );
});

// ── 场景 5：注册不变量 ────────────────────────────────────────────────

test("registration: ApplyPatch entry registered with Write/Edit-class metadata", () => {
  const registered = builtInTools.some((entry) => entry.metadata.name === "ApplyPatch");
  assert.equal(registered, true);
  assert.equal(applyPatchToolEntry.metadata.riskLevel, "medium");
  assert.equal(applyPatchToolEntry.metadata.sideEffectScope, "workspace");
  assert.equal(applyPatchToolEntry.metadata.needsApproval, true);
  assert.equal(applyPatchToolEntry.permission.permission, "edit");
  assert.deepEqual(applyPatchToolEntry.permission.patternSources, ["path"]);
  // 描述纪律（prompt-corpus-audit F7 教训）：模型可见文本不得引用不存在的工具。
  const described = applyPatchToolEntry.metadata.description;
  for (const deadName of ["NotebookEdit", "ScheduleWakeup", "EnterWorktree", "MultiEdit"]) {
    assert.equal(described.includes(deadName), false);
  }
});
