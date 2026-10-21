// read-state 键路径归一化回归（用户实报「edit 前必须先读、Bash 也会报错」）。
//
// 根因：Windows 文件系统大小写不敏感，但 createReadFileStatePathKey 此前只归一化盘符
// 别名/extended-path 前缀/盘符大小写，不折叠其余路径段。同一文件的两种拼写（Read 收到
// canonical `C:\Users\...`，Edit/Bash cat 收到小写 `c:\users\...`）在 read-state 键空间里
// 分裂成两条，Edit 命中不到 Read 记录 → 误报 FILE_NOT_READ。
//
// 用 platform 显式入参把断言钉死在 win32 键空间，与运行主机无关；posix 分支保持大小写敏感
// （POSIX FS 大小写敏感，折叠会造成不同文件误命中，绝不改）。
import assert from "node:assert/strict";
import test from "node:test";
import { createReadFileStateKey, findEditableReadFileState } from "../src/tool/read-file-state.js";
import { normalizeReadStatePathKey } from "../src/tool/path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

function stateEntry(path: string, content: string): ReadFileStateEntry {
  return {
    path,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(1_000),
    sourceTool: "Read",
    revisionId: "rev-1",
    mtimeMs: 5_000,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

test("win32: 同一文件不同大小写拼写归一到同一条 read-state 键", () => {
  const canonical = "C:\\Users\\Administrator\\repo\\sample.ts";
  const lower = "c:\\users\\administrator\\repo\\sample.ts";
  const upper = "C:\\USERS\\ADMINISTRATOR\\REPO\\SAMPLE.TS";

  assert.equal(
    createReadFileStateKey(canonical, 1, undefined, "win32"),
    createReadFileStateKey(lower, 1, undefined, "win32"),
    "canonical 与小写拼写必须落同键",
  );
  assert.equal(
    createReadFileStateKey(canonical, 1, undefined, "win32"),
    createReadFileStateKey(upper, 1, undefined, "win32"),
    "canonical 与大写拼写必须落同键",
  );
});

test("win32: Read 用小写拼写记录，Edit 用 canonical 拼写仍能命中（不误报未读）", () => {
  const canonical = "C:\\Users\\Administrator\\repo\\sample.ts";
  const lower = "c:\\users\\administrator\\repo\\sample.ts";
  const readFileState: ReadFileStateMap = new Map();
  // Read 侧记录在模型给出的小写拼写下（真实场景：Bash cat 回填或模型复述路径）。
  readFileState.set(createReadFileStateKey(lower, 1, undefined, "win32"), stateEntry(lower, "x\n"));

  const found = findEditableReadFileState(readFileState, canonical, "win32");
  assert.notEqual(found, undefined, "Edit 用 canonical 拼写必须命中 Read 记录");
  assert.equal(found?.path, lower, "命中原始记录条目");
});

test("win32: 盘符别名/extended-path 前缀 + 大小写组合归一到同键", () => {
  // 盘符别名（Git Bash /c/…）与 canonical 盘符形经大小写折叠后同键。
  const alias = "/c/Users/Administrator/repo/sample.ts";
  const canonical = "C:\\Users\\Administrator\\repo\\sample.ts";
  assert.equal(
    normalizeReadStatePathKey(alias, "win32"),
    normalizeReadStatePathKey(canonical, "win32"),
    "盘符别名与 canonical 形折叠后必须同键",
  );
});

test("posix: 大小写敏感保持——不同大小写是不同键（零回归）", () => {
  const lower = "/repo/sample.ts";
  const upper = "/repo/SAMPLE.ts";
  assert.notEqual(
    createReadFileStateKey(lower, 1, undefined, "linux"),
    createReadFileStateKey(upper, 1, undefined, "linux"),
    "POSIX FS 大小写敏感，折叠会造成不同文件误命中，绝不折叠",
  );
});
