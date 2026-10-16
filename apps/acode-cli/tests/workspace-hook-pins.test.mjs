// hook-pins 三态钉扎守护（specs/plugin-hook-middleware.md 三，验收场景 4）。
// 三态 schema/原子写/读时校验 fail-closed/分类矩阵/等价判定（unpinnable 永不等价）/
// 展示投影。文件面用真实临时目录驱动（默认 node fs 实现），解析面直接单测。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, link, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const {
  WORKSPACE_HOOK_PINS_VERSION,
  describeWorkspaceHookPin,
  parseWorkspaceHookPinsDocument,
  readWorkspaceHookPins,
  workspaceHookPinEquals,
  workspaceHookPinsDirPath,
  workspaceHookPinsFileName,
  writeWorkspaceHookPins,
} = await import("../packages/core/src/hooks/workspace-hook-pins.ts");
const { classifyWorkspaceHookPin, tokenizeShellWords } = await import(
  "../packages/core/src/hooks/workspace-hook-pins-classify.ts"
);

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SHA_A = "c".repeat(64);

let root;
let pinsDir;
let projectDir;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "acode-hook-pins-"));
  pinsDir = workspaceHookPinsDirPath(join(root, "data"));
  projectDir = join(root, "project");
  await mkdir(join(projectDir, ".acode", "hooks"), { recursive: true });
  await writeFile(join(projectDir, ".acode", "hooks", "guard.mjs"), "console.log('guard');\n");
  await writeFile(join(projectDir, ".acode", "hooks", "check.sh"), "#!/bin/sh\nexit 0\n");
});

after(async () => {
  if (root) await rm(root, { force: true, recursive: true });
});

function scriptPin(path, sha256) {
  return { kind: "script", path, sha256 };
}

test("文件名：sha256(projectKey) 前 32 hex + .jsonl；不同 project 不同名", () => {
  const name = workspaceHookPinsFileName("/repo/a");
  const expected = createHash("sha256").update("/repo/a", "utf8").digest("hex").slice(0, 32);
  assert.equal(name, `hook-pins-${expected}.jsonl`);
  assert.notEqual(name, workspaceHookPinsFileName("/repo/b"));
  assert.equal(workspaceHookPinsDirPath("/data"), join("/data", "cli", "hook-pins"));
});

test("写读往返：三态 pin 全量保真；状态 ok", async () => {
  const pins = new Map([
    [DIGEST_A, scriptPin(join(projectDir, ".acode/hooks/guard.mjs"), SHA_A)],
    [DIGEST_B, { kind: "inline" }],
  ]);
  await writeWorkspaceHookPins({ pins, pinsDir, projectKey: "/repo/roundtrip" });
  const read = await readWorkspaceHookPins({ pinsDir, projectKey: "/repo/roundtrip" });
  assert.equal(read.status, "ok");
  assert.equal(read.pins.size, 2);
  assert.deepEqual(read.pins.get(DIGEST_A), scriptPin(join(projectDir, ".acode/hooks/guard.mjs"), SHA_A));
  assert.deepEqual(read.pins.get(DIGEST_B), { kind: "inline" });
  // 原子写收尾干净：目录里只有正式文件，无 .tmp 残留。
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(pinsDir);
  assert.ok(entries.every((entry) => !entry.endsWith(".tmp")));
});

test("读时校验 fail-closed：missing/损坏/schema 偏差/project 不匹配一律空集", async () => {
  const missing = await readWorkspaceHookPins({ pinsDir, projectKey: "/repo/never-written" });
  assert.equal(missing.status, "missing");
  assert.equal(missing.pins.size, 0);

  await writeWorkspaceHookPins({
    pins: new Map([[DIGEST_A, { kind: "unpinnable" }]]),
    pinsDir,
    projectKey: "/repo/guarded",
  });
  // project 不匹配 ⇒ 空集：文件名由 projectKey 派生，不匹配只发生在「同一文件被
  // 挪用/手改 project 字段」——篡改内容后按原 key 读，必须 invalid 空集。
  const guardedPath = join(pinsDir, workspaceHookPinsFileName("/repo/guarded"));
  const guardedRaw = await readFile(guardedPath, "utf8");
  await writeFile(guardedPath, guardedRaw.replace('"/repo/guarded"', '"/repo/other"'));
  const mismatch = await readWorkspaceHookPins({ pinsDir, projectKey: "/repo/guarded" });
  assert.equal(mismatch.status, "invalid");
  assert.equal(mismatch.pins.size, 0);
  // 纯文档层：project 字段不匹配同样 invalid。
  assert.equal(
    parseWorkspaceHookPinsDocument(guardedRaw, "/repo/other").status,
    "invalid",
  );

  // 文档级解析：损坏 JSON / 版本漂移 / pins 非对象 / digest 非 64hex / pin 形状偏差。
  assert.equal(parseWorkspaceHookPinsDocument("not-json", "/p").status, "invalid");
  assert.equal(
    parseWorkspaceHookPinsDocument(
      JSON.stringify({ version: 99, project: "/p", pins: {} }),
      "/p",
    ).status,
    "invalid",
  );
  assert.equal(
    parseWorkspaceHookPinsDocument(
      JSON.stringify({ version: WORKSPACE_HOOK_PINS_VERSION, project: "/p", pins: [] }),
      "/p",
    ).status,
    "invalid",
  );
  assert.equal(
    parseWorkspaceHookPinsDocument(
      JSON.stringify({ version: WORKSPACE_HOOK_PINS_VERSION, project: "/p", pins: { short: { kind: "inline" } } }),
      "/p",
    ).status,
    "invalid",
  );
  assert.equal(
    parseWorkspaceHookPinsDocument(
      JSON.stringify({
        version: WORKSPACE_HOOK_PINS_VERSION,
        project: "/p",
        pins: { [DIGEST_A]: { kind: "script", path: "/x", sha256: "nothex" } },
      }),
      "/p",
    ).status,
    "invalid",
  );
  // strict：多余字段即形状偏差 ⇒ invalid。
  assert.equal(
    parseWorkspaceHookPinsDocument(
      JSON.stringify({
        version: WORKSPACE_HOOK_PINS_VERSION,
        project: "/p",
        pins: { [DIGEST_A]: { kind: "inline", extra: 1 } },
      }),
      "/p",
    ).status,
    "invalid",
  );
});

test("写前校验：非法 digest/pin 形状直接抛错，不落盘半合法记录", async () => {
  await assert.rejects(
    writeWorkspaceHookPins({
      pins: new Map([["short-digest", { kind: "inline" }]]),
      pinsDir,
      projectKey: "/repo/reject-invalid",
    }),
  );
  const read = await readWorkspaceHookPins({ pinsDir, projectKey: "/repo/reject-invalid" });
  assert.equal(read.status, "missing");
});

test("分类：process/command 脚本 ⇒ script pin（path=realpath，sha256=内容哈希）", async () => {
  const expectedSha = createHash("sha256")
    .update("console.log('guard');\n", "utf8")
    .digest("hex");
  const processPin = await classifyWorkspaceHookPin({
    declaration: { command: join(projectDir, ".acode", "hooks", "guard.mjs"), type: "process" },
    projectDir,
  });
  assert.equal(processPin.kind, "script");
  assert.equal(processPin.sha256, expectedSha);

  const commandPin = await classifyWorkspaceHookPin({
    declaration: { command: "node .acode/hooks/guard.mjs", type: "command" },
    projectDir,
  });
  assert.equal(commandPin.kind, "script");
  assert.equal(commandPin.sha256, expectedSha);

  // 前缀剥离：VAR=v 赋值与 env [-u X] 前缀不影响脚本定位。
  const envPin = await classifyWorkspaceHookPin({
    declaration: { command: "FOO=bar env -u BAZ node .acode/hooks/guard.mjs --flag x", type: "command" },
    projectDir,
  });
  assert.equal(envPin.kind, "script");
  assert.equal(envPin.sha256, expectedSha);

  // 变量展开钩子点：expandVariable 解析后可钉；未展开残留 ⇒ unpinnable。
  const expanded = await classifyWorkspaceHookPin({
    declaration: { command: "bash ${PROJECT_DIR}/.acode/hooks/check.sh", type: "command" },
    expandVariable: (text) => text.replaceAll("${PROJECT_DIR}", projectDir),
    projectDir,
  });
  assert.equal(expanded.kind, "script");
  const unexpanded = await classifyWorkspaceHookPin({
    declaration: { command: "bash ${PROJECT_DIR}/.acode/hooks/check.sh", type: "command" },
    projectDir,
  });
  assert.equal(unexpanded.kind, "unpinnable");
});

test("分类：inline 与 unpinnable 的边界情形（信任粒度分界）", async () => {
  // 复合命令/管道：文本即行为 ⇒ inline。
  const pipe = await classifyWorkspaceHookPin({
    declaration: { command: "cat x.txt | grep secret", type: "command" },
    projectDir,
  });
  assert.equal(pipe.kind, "inline");
  // 内联代码旗标：代码在文本里 ⇒ inline（区别于「应可解析但无法验证」）。
  const inlineCode = await classifyWorkspaceHookPin({
    declaration: { command: "node -e \"process.exit(2)\"", type: "command" },
    projectDir,
  });
  assert.equal(inlineCode.kind, "inline");
  // 裸 PATH 程序名：项目可读根外，内容不可钉 ⇒ unpinnable。
  const bare = await classifyWorkspaceHookPin({
    declaration: { command: "acode-hook --strict", type: "command" },
    projectDir,
  });
  assert.equal(bare.kind, "unpinnable");
  // 裸模块名（无路径分隔符）：静态解析不可达 ⇒ unpinnable。
  const bareModule = await classifyWorkspaceHookPin({
    declaration: { command: "node somepackage", type: "command" },
    projectDir,
  });
  assert.equal(bareModule.kind, "unpinnable");
  // 未知旗标面：无法可靠定位脚本实参 ⇒ unpinnable。
  const flagged = await classifyWorkspaceHookPin({
    declaration: { command: "node --experimental-vm-modules .acode/hooks/guard.mjs", type: "command" },
    projectDir,
  });
  assert.equal(flagged.kind, "unpinnable");
  // 文件缺失 / 目录 / 出项目根 ⇒ unpinnable（fail-closed）。
  const missing = await classifyWorkspaceHookPin({
    declaration: { command: join(projectDir, ".acode", "hooks", "gone.mjs"), type: "process" },
    projectDir,
  });
  assert.equal(missing.kind, "unpinnable");
  const directory = await classifyWorkspaceHookPin({
    declaration: { command: join(projectDir, ".acode", "hooks"), type: "process" },
    projectDir,
  });
  assert.equal(directory.kind, "unpinnable");
  const outside = await classifyWorkspaceHookPin({
    declaration: { command: "../outside.sh", type: "command" },
    projectDir,
  });
  assert.equal(outside.kind, "unpinnable");
  // 分类绝不抛错：畸形声明收敛为 unpinnable。
  const empty = await classifyWorkspaceHookPin({ declaration: { command: "  ", type: "command" }, projectDir });
  assert.equal(empty.kind, "unpinnable");
});

test("分类：硬链接脚本（nlink>1）⇒ unpinnable（内容可在别处被改）", async (t) => {
  const target = join(projectDir, ".acode", "hooks", "linked.sh");
  const twin = join(projectDir, ".acode", "hooks", "twin.sh");
  await writeFile(target, "#!/bin/sh\nexit 0\n");
  try {
    await link(target, twin);
  } catch {
    t.skip("平台不支持硬链接");
    return;
  }
  const pin = await classifyWorkspaceHookPin({
    declaration: { command: target, type: "process" },
    projectDir,
  });
  assert.equal(pin.kind, "unpinnable");
});

test("等价判定：inline≡inline、script≡script(sha+path)；unpinnable 永不等价（含自身）", () => {
  assert.equal(workspaceHookPinEquals({ kind: "inline" }, { kind: "inline" }), true);
  assert.equal(workspaceHookPinEquals(scriptPin("/a", SHA_A), scriptPin("/a", SHA_A)), true);
  assert.equal(workspaceHookPinEquals(scriptPin("/a", SHA_A), scriptPin("/a", DIGEST_B)), false);
  assert.equal(workspaceHookPinEquals(scriptPin("/a", SHA_A), scriptPin("/b", SHA_A)), false);
  assert.equal(workspaceHookPinEquals({ kind: "unpinnable" }, { kind: "unpinnable" }), false);
  assert.equal(workspaceHookPinEquals({ kind: "inline" }, { kind: "unpinnable" }), false);
  assert.equal(workspaceHookPinEquals(undefined, { kind: "inline" }), false);
});

test("展示投影：script→sha 前 12、inline→inline、unpinnable→unknown、缺席→none", () => {
  assert.equal(describeWorkspaceHookPin(scriptPin("/a", SHA_A)), SHA_A.slice(0, 12));
  assert.equal(describeWorkspaceHookPin({ kind: "inline" }), "inline");
  assert.equal(describeWorkspaceHookPin({ kind: "unpinnable" }), "unknown");
  assert.equal(describeWorkspaceHookPin(undefined), "none");
});

test("分词：引号/转义/空白/Windows 路径反斜杠字面保留", () => {
  assert.deepEqual(tokenizeShellWords("node .acode/hooks/guard.mjs --msg 'hello world'"), [
    "node",
    ".acode/hooks/guard.mjs",
    "--msg",
    "hello world",
  ]);
  // 双引号内 \" 与 \\ 收敛为字面；字面引号也可用单引号包裹。
  assert.deepEqual(tokenizeShellWords('bash "quoted path/x.sh" "a\\"b"'), [
    "bash",
    "quoted path/x.sh",
    'a"b',
  ]);
  assert.deepEqual(tokenizeShellWords("  spaced   out  "), ["spaced", "out"]);
  // Windows 路径：引号外反斜杠是字面路径字符，不被 bash 转义语义吞掉。
  assert.deepEqual(tokenizeShellWords("node C:\\hooks\\x.mjs"), ["node", "C:\\hooks\\x.mjs"]);
});

test("读错误（非 ENOENT）⇒ invalid 空集（fail-closed）", async () => {
  const failingFs = {
    readFileText: async () => {
      const error = new Error("EACCES: permission denied");
      error.code = "EACCES";
      throw error;
    },
  };
  const read = await readWorkspaceHookPins({ fs: failingFs, pinsDir, projectKey: "/repo/x" });
  assert.equal(read.status, "invalid");
  assert.equal(read.pins.size, 0);
});

test("落盘内容与文件权限形态：单 JSON 文档 + version/project/pins", async () => {
  await writeWorkspaceHookPins({
    pins: new Map([[DIGEST_A, { kind: "unpinnable" }]]),
    pinsDir,
    projectKey: "/repo/document",
  });
  const filePath = join(pinsDir, workspaceHookPinsFileName("/repo/document"));
  const raw = await readFile(filePath, "utf8");
  const doc = JSON.parse(raw);
  assert.equal(doc.version, WORKSPACE_HOOK_PINS_VERSION);
  assert.equal(doc.project, "/repo/document");
  assert.deepEqual(doc.pins, { [DIGEST_A]: { kind: "unpinnable" } });
});
