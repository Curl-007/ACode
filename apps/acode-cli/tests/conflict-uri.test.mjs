// conflict:// 合并冲突解决面（specs/conflict-uri-resolution.md）验收测试。
// 覆盖：R1 检测矩阵（含伪标记不误判/窗口截断/CRLF）、R2 id 稳定与失效、
// R3 尾注、R4 读形态、R5 token/字面量/批量/stale 拒绝/all-or-nothing、
// 解决后失效面。集成用假 FileSystemPort（core 不依赖 adapters，纪律同
// skill-uri-read 测试）。
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

const {
  scanConflictLines,
  annotateReadConflicts,
  registerConflicts,
  getConflictEntry,
  listSessionConflicts,
  invalidateFileEntries,
  clearAllConflictHistories,
  expandConflictToken,
  spliceConflicts,
  splitLinesLf,
  revalidateRegion,
  isConflictUri,
  parseConflictUri,
  parseBulkDirectives,
  buildConflictFooter,
  readConflictRegion,
  resolveConflictWrite,
  ConflictUriError,
} = await import("../packages/core/src/tool/conflict/index.ts");

const SESSION = "sess-conflict-test";
beforeEach(() => clearAllConflictHistories());

const STD_BLOCK = [
  "int main() {",
  "<<<<<<< HEAD",
  "  return 1;",
  "=======",
  "  return 2;",
  ">>>>>>> feature",
  "}",
];

// ── R1 检测矩阵 ──────────────────────────────────────────────

test("R1: 标准块检出——行号/两侧内容/标签", () => {
  const blocks = scanConflictLines(STD_BLOCK, 1);
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.startLine, 2);
  assert.equal(block.endLine, 6);
  assert.equal(block.oursLabel, "HEAD");
  assert.equal(block.theirsLabel, "feature");
  assert.deepEqual(block.oursLines, ["  return 1;"]);
  assert.deepEqual(block.theirsLines, ["  return 2;"]);
  assert.equal(block.hasBase, false);
});

test("R1: diff3 base 段检出", () => {
  const lines = [
    "<<<<<<< HEAD",
    "ours",
    "||||||| base",
    "common",
    "=======",
    "theirs",
    ">>>>>>> branch",
  ];
  const blocks = scanConflictLines(lines, 10);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].hasBase, true);
  assert.deepEqual(blocks[0].baseLines, ["common"]);
  assert.equal(blocks[0].startLine, 10);
  assert.equal(blocks[0].endLine, 16);
});

test("R1: CRLF 行剥 \\r 后检出，存储 LF 归一", () => {
  const lines = STD_BLOCK.map((line) => `${line}\r`);
  const blocks = scanConflictLines(lines, 1);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].oursLines, ["  return 1;"]);
  assert.ok(!blocks[0].lines.some((line) => line.includes("\r")));
});

test("R1: 伪标记不误判——JSX/装饰线/缩进 marker/无空格粘连", () => {
  const lines = [
    "<div className='x'>",
    "========",
    "  <<<<<<< HEAD",
    "<<<<<<<x",
    "======",
    "a = b >>>>>>> c",
  ];
  assert.deepEqual(scanConflictLines(lines, 1), []);
});

test("R1: 窗口截断块丢弃（closer 不在窗口内）；多块按序全检出", () => {
  const window = ["<<<<<<< HEAD", "a", "=======", "b"];
  assert.deepEqual(scanConflictLines(window, 1), []);
  const two = [
    "<<<<<<< A",
    "1",
    "===".concat("===="),
    "2",
    ">>>>>>> B",
    "middle",
    "<<<<<<< C",
    "3",
    "=======",
    "4",
    ">>>>>>> D",
  ];
  const blocks = scanConflictLines(two, 5);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].startLine, 5);
  assert.equal(blocks[1].startLine, 11);
});

// ── R2 注册与 id ─────────────────────────────────────────────

test("R2: sessionId 缺席零行为（annotate 返回空，零回归面）", () => {
  const result = annotateReadConflicts({
    sessionId: undefined,
    absolutePath: "/x/y.ts",
    displayPath: "y.ts",
    lines: STD_BLOCK,
    firstLineNumber: 1,
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.footer, "");
});

test("R2: 同内容重复注册复用 id；内容变化发新 id；文件失效清空", () => {
  const first = annotateReadConflicts({
    sessionId: SESSION,
    absolutePath: "/repo/a.ts",
    displayPath: "a.ts",
    lines: STD_BLOCK,
    firstLineNumber: 1,
  });
  assert.equal(first.entries.length, 1);
  const id = first.entries[0].id;
  const again = registerConflicts(SESSION, "/repo/a.ts", scanConflictLines(STD_BLOCK, 1));
  assert.equal(again[0].id, id, "同指纹必须复用 id");
  const changed = STD_BLOCK.map((line) => (line === "  return 1;" ? "  return 99;" : line));
  const fresh = registerConflicts(SESSION, "/repo/a.ts", scanConflictLines(changed, 1));
  assert.notEqual(fresh[0].id, id, "内容变化=新指纹=新 id");
  invalidateFileEntries(SESSION, "/repo/a.ts");
  assert.equal(getConflictEntry(SESSION, id), undefined);
  assert.equal(listSessionConflicts(SESSION).length, 0);
});

// ── R3 尾注 ──────────────────────────────────────────────────

test("R3: 尾注含 id/路径/行号/ sides 与用法提示；51 块截断", () => {
  const footer = buildConflictFooter([
    { id: 1, path: "src/a.ts", startLine: 12, hasBase: true },
    { id: 2, path: "src/a.ts", startLine: 40, hasBase: false },
  ]);
  assert.match(footer, /conflict:\/\/1 src\/a\.ts:12 \(sides: ours\/base\/theirs\)/);
  assert.match(footer, /conflict:\/\/2 src\/a\.ts:40 \(sides: ours\/theirs\)/);
  assert.match(footer, /2 merge conflict block\(s\) registered/);
  assert.match(footer, /conflict:\/\/\*/);
  const many = Array.from({ length: 51 }, (_, index) => ({
    id: index + 1,
    path: "f.ts",
    startLine: index + 1,
    hasBase: false,
  }));
  const big = buildConflictFooter(many);
  assert.match(big, /\.\.\. and 1 more conflict block\(s\)/);
  assert.ok(!big.includes("conflict://51 "), "截断后第 51 条不进清单");
});

test("R3: annotate 经 read 行产物注册并产尾注（窗口 firstLineNumber 折算）", () => {
  const result = annotateReadConflicts({
    sessionId: SESSION,
    absolutePath: "/repo/b.ts",
    displayPath: "b.ts",
    lines: STD_BLOCK.slice(1), // 窗口从块行开始
    firstLineNumber: 2,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].block.startLine, 2);
  assert.match(result.footer, /conflict:\/\/1 b\.ts:2/);
});

// ── R4 URI 解析与读形态 ──────────────────────────────────────

test("R4: URI 解析——单 id/带侧/批量/畸形拒绝", () => {
  assert.deepEqual(parseConflictUri("conflict://3"), { kind: "single", id: 3 });
  assert.deepEqual(parseConflictUri("conflict://3/theirs"), { kind: "single", id: 3, side: "theirs" });
  assert.deepEqual(parseConflictUri("conflict://*"), { kind: "bulk" });
  assert.equal(isConflictUri("conflict://1"), true);
  assert.equal(isConflictUri("Conflict://1"), true);
  assert.equal(isConflictUri("src/a.ts"), false);
  for (const bad of ["conflict://abc", "conflict://0", "conflict://3/side", "conflict://"]) {
    assert.ok("error" in parseConflictUri(bad), `${bad} 必须拒绝`);
  }
});

test("R4: readConflictRegion 整块/单侧/base 缺席报错/未注册 id 可操作错误", () => {
  registerConflicts(SESSION, "/repo/c.ts", scanConflictLines(STD_BLOCK, 1));
  const whole = readConflictRegion({ sessionId: SESSION, rawUri: "conflict://1" });
  assert.equal(whole.content, STD_BLOCK.slice(1, 6).join("\n"));
  assert.equal(whole.sourcePath, "/repo/c.ts");
  assert.equal(whole.startLine, 2);
  const theirs = readConflictRegion({ sessionId: SESSION, rawUri: "conflict://1/theirs" });
  assert.equal(theirs.content, "  return 2;");
  assert.throws(
    () => readConflictRegion({ sessionId: SESSION, rawUri: "conflict://1/base" }),
    (error) => error instanceof ConflictUriError && /no base section/.test(error.message),
  );
  assert.throws(
    () => readConflictRegion({ sessionId: SESSION, rawUri: "conflict://9" }),
    (error) => error instanceof ConflictUriError && /Registered ids: conflict:\/\/1/.test(error.message),
  );
});

// ── R5 拼接语义 ──────────────────────────────────────────────

test("R5: token 展开四侧 + @base 无 base 段报错", () => {
  const [block] = scanConflictLines(STD_BLOCK, 1);
  assert.deepEqual(expandConflictToken("@ours", block), { lines: ["  return 1;"] });
  assert.deepEqual(expandConflictToken("@theirs", block), { lines: ["  return 2;"] });
  assert.deepEqual(expandConflictToken("@both", block), { lines: ["  return 1;", "  return 2;"] });
  const baseResult = expandConflictToken("@base", block);
  assert.ok("error" in baseResult);
});

test("R5: splice 单块替换保留前后行与末尾换行；CRLF 由 port 层恢复不在本层", () => {
  const text = `${STD_BLOCK.join("\n")}\n`;
  const entry = {
    id: 1,
    absolutePath: "/repo/a.ts",
    fingerprint: "fp",
    block: scanConflictLines(STD_BLOCK, 1)[0],
  };
  const outcome = spliceConflicts(text, [entry], new Map([[1, ["  return 2;"]]]));
  assert.ok(!("error" in outcome));
  assert.equal(outcome.text, "int main() {\n  return 2;\n}\n");
  assert.deepEqual(outcome.splicedIds, [1]);
});

test("R5: stale 区域拒绝且零改动；越界拒绝", () => {
  const original = `${STD_BLOCK.join("\n")}\n`;
  const entry = {
    id: 1,
    absolutePath: "/repo/a.ts",
    fingerprint: "fp",
    block: scanConflictLines(STD_BLOCK, 1)[0],
  };
  const edited = original.replace("  return 1;", "  return 777;");
  const stale = spliceConflicts(edited, [entry], new Map([[1, ["x"]]]));
  assert.ok("error" in stale);
  assert.match(stale.error, /changed on disk/);
  assert.match(stale.error, /re-read/);
  const outOfRange = revalidateRegion(["only one line"], { ...entry, block: { ...entry.block } });
  assert.equal(outOfRange.ok, false);
});

test("R5: 同文件双块自底向上，行号锚全部有效", () => {
  const lines = [
    "head",
    "<<<<<<< A",
    "o1",
    "=======",
    "t1",
    ">>>>>>> A",
    "middle",
    "<<<<<<< B",
    "o2",
    "=======",
    "t2",
    ">>>>>>> B",
    "tail",
  ];
  const text = `${lines.join("\n")}\n`;
  const blocks = scanConflictLines(lines, 1);
  assert.equal(blocks.length, 2);
  const entries = blocks.map((block, index) => ({
    id: index + 1,
    absolutePath: "/repo/multi.ts",
    fingerprint: `fp${index}`,
    block,
  }));
  const outcome = spliceConflicts(
    text,
    entries,
    new Map([
      [1, ["O1"]],
      [2, ["T2"]],
    ]),
  );
  assert.ok(!("error" in outcome));
  assert.equal(outcome.text, "head\nO1\nmiddle\nT2\ntail\n");
  // 自底向上：先拼 id2（行号大）再 id1。
  assert.deepEqual(outcome.splicedIds, [2, 1]);
});

test("R5: 批量指派解析——# 前缀与 = 分隔容错、混合形态 fail-loud、重复 id 拒绝", () => {
  const ok = parseBulkDirectives("1: @ours\n#2 = @theirs\n3:@both\n");
  assert.ok(!("error" in ok));
  assert.deepEqual(ok, [
    { id: 1, token: "@ours" },
    { id: 2, token: "@theirs" },
    { id: 3, token: "@both" },
  ]);
  const mixed = parseBulkDirectives("1: @ours\nsome merged content");
  assert.ok("error" in mixed);
  assert.match(mixed.error, /pure per-id directives/);
  const dup = parseBulkDirectives("1: @ours\n1: @theirs");
  assert.ok("error" in dup);
  assert.match(dup.error, /Duplicate id 1/);
  assert.ok("error" in parseBulkDirectives("   \n"));
});

// ── 集成：resolveConflictWrite（假 port） ─────────────────────

function fakePort(files) {
  const writes = [];
  return {
    writes,
    readTextFile: async ({ path }) => {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT ${path}`);
        error.code = "not_found";
        throw error;
      }
      return {
        path,
        content,
        encoding: "utf8",
        lineEndings: content.includes("\r\n") ? "CRLF" : "LF",
        revision: { id: `rev-${content.length}`, mtimeMs: 1, sizeBytes: content.length },
      };
    },
    writeTextFile: async ({ path, content, lineEndings, expectedRevision }) => {
      writes.push({ path, content, lineEndings, expectedRevision });
      files.set(path, content);
      return { path, revision: { id: `rev-${content.length}`, mtimeMs: 2, sizeBytes: content.length } };
    },
  };
}

function conflictContext(files) {
  const port = fakePort(files);
  const afterWrites = [];
  return {
    port,
    afterWrites,
    request: (rawUri, content) => ({
      sessionId: SESSION,
      rawUri,
      content,
      fileSystemPort: port,
      abortSignal: undefined,
      createTrace: () => ({}),
      afterWrite: (path, text) => afterWrites.push({ path, text }),
    }),
  };
}

test("集成: 单块 @theirs 解决——写回/失效/readFileState 回调/模型摘要", async () => {
  const path = "/repo/x.ts";
  const files = new Map([[path, `${STD_BLOCK.join("\n")}\n`]]);
  registerConflicts(SESSION, path, scanConflictLines(STD_BLOCK, 1));
  const ctx = conflictContext(files);
  const outcome = await resolveConflictWrite(ctx.request("conflict://1", "@theirs"));
  assert.equal(files.get(path), "int main() {\n  return 2;\n}\n");
  assert.deepEqual(outcome.resolvedPaths, [path]);
  assert.equal(outcome.files.length, 1);
  assert.deepEqual(outcome.files[0].splicedIds, [1]);
  assert.match(outcome.modelContent, /Resolved 1 conflict block\(s\) \(conflict:\/\/1\)/);
  assert.match(outcome.modelContent, /No conflict blocks remain/);
  assert.equal(ctx.afterWrites.length, 1);
  assert.equal(ctx.port.writes[0].lineEndings, "LF");
  assert.ok(ctx.port.writes[0].expectedRevision, "写回必须带 expectedRevision（乐观并发）");
  assert.equal(getConflictEntry(SESSION, 1), undefined, "解决后条目失效");
});

test("集成: 字面量替换内容（模型自撰合并结果）", async () => {
  const path = "/repo/lit.ts";
  const files = new Map([[path, `${STD_BLOCK.join("\n")}\n`]]);
  registerConflicts(SESSION, path, scanConflictLines(STD_BLOCK, 1));
  const ctx = conflictContext(files);
  await resolveConflictWrite(ctx.request("conflict://1", "  return 1 + 2;\n"));
  assert.equal(files.get(path), "int main() {\n  return 1 + 2;\n}\n");
});

test("集成: 批量 conflict://* 跨块指派 + 解决后同文件其余注册块全失效", async () => {
  const path = "/repo/multi.ts";
  const lines = [
    "<<<<<<< A",
    "o1",
    "===".concat("===="),
    "t1",
    ">>>>>>> A",
    "<<<<<<< B",
    "o2",
    "=======",
    "t2",
    ">>>>>>> B",
  ];
  const files = new Map([[path, `${lines.join("\n")}\n`]]);
  registerConflicts(SESSION, path, scanConflictLines(lines, 1));
  assert.equal(listSessionConflicts(SESSION).length, 2);
  const ctx = conflictContext(files);
  const outcome = await resolveConflictWrite(ctx.request("conflict://*", "1: @ours\n2: @theirs"));
  assert.equal(files.get(path), "o1\nt2\n");
  assert.deepEqual(outcome.files[0].splicedIds.sort(), [1, 2]);
  assert.equal(listSessionConflicts(SESSION).length, 0);
});

test("集成: 磁盘外部编辑后 stale 拒绝——ConflictUriError 且文件零写入", async () => {
  const path = "/repo/stale.ts";
  const files = new Map([[path, `${STD_BLOCK.join("\n")}\n`]]);
  registerConflicts(SESSION, path, scanConflictLines(STD_BLOCK, 1));
  files.set(path, files.get(path).replace("  return 2;", "  return 555;")); // out-of-band
  const ctx = conflictContext(files);
  await assert.rejects(
    resolveConflictWrite(ctx.request("conflict://1", "@ours")),
    (error) => error instanceof ConflictUriError && /re-read/.test(error.message),
  );
  assert.equal(ctx.port.writes.length, 0, "stale 拒绝必须零写入");
});

test("集成: 未注册 id 与无会话 fail-loud；LF 归一 splitLines 语义", () => {
  assert.throws(
    () => readConflictRegion({ sessionId: SESSION, rawUri: "conflict://42" }),
    (error) => error instanceof ConflictUriError && /not registered/.test(error.message),
  );
  assert.throws(
    () => readConflictRegion({ sessionId: undefined, rawUri: "conflict://1" }),
    (error) => error instanceof ConflictUriError && /active session/.test(error.message),
  );
  assert.deepEqual(splitLinesLf("a\r\nb\r\n"), ["a", "b", ""]);
});
