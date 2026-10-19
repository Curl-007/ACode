import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

/**
 * skill:// 读协议验收（specs/skill-uri-read.md S1-S17）：
 * Read 工具 scheme 分支 = 裸名读 SKILL.md 全文、子路径读技能目录内资产；
 * 四类越界（`..`/绝对路径/symlink 逃逸/控制字符）各带对抗断言；
 * 未知技能/缺失资产/目录目标给模型可操作错误（含资产清单）；
 * 同名冲突赢家与既有 loadSkill 语义一致；普通路径读取零回归。
 */

const { readToolEntry } = await import("../packages/core/src/tool/handlers/read.ts");
const { createNodeSkillAdapter } = await import("../packages/adapters/src/skills/index.ts");
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");

const base = mkdtempSync(join(tmpdir(), "acode-skill-uri-"));
const home = join(base, "home");
const ws = join(base, "ws");
const outsideDir = join(base, "outside");
const pluginRoot = join(base, "plugin");
const demoDir = join(ws, ".agents", "skills", "demo");

after(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function skillFile(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    // Windows 无开发者模式时文件 symlink 需要特权；调用方按能力跳过。
    return false;
  }
}

let skillPort;
let haveFileSymlink = false;
let haveDirLink = false;
let haveInnerLink = false;
let haveRootJunction = false;

before(() => {
  // 用户层 dup-skill（home/.acode，priority 靠前）与项目层 dup-skill（ws/.agents）。
  write(
    join(home, ".acode", "skills", "dup-skill", "SKILL.md"),
    skillFile("dup-skill", "d", "HOME-LAYER"),
  );
  write(
    join(ws, ".agents", "skills", "dup-skill", "SKILL.md"),
    skillFile("dup-skill", "d", "PROJECT-LAYER"),
  );
  // 主 fixture 技能：多行正文 + references/templates 资产 + 带空格文件名。
  write(join(demoDir, "SKILL.md"), skillFile("demo", "demo skill", "# Demo\nbody-a\nbody-b"));
  write(join(demoDir, "references", "guide.md"), "line-1\nline-2\nline-3\n");
  write(join(demoDir, "references", "my notes.md"), "SPACE-NAME\n");
  write(join(demoDir, "templates", "plan.txt"), "PLAN\n");
  // 越界目标与三种链接形态（能力探测，失败按平台跳过对应用例）。
  write(join(outsideDir, "secret.txt"), "SECRET-OUTSIDE\n");
  haveFileSymlink = trySymlink(join(outsideDir, "secret.txt"), join(demoDir, "leak.md"), "file");
  haveDirLink = trySymlink(
    outsideDir,
    join(demoDir, "jdir"),
    process.platform === "win32" ? "junction" : "dir",
  );
  haveInnerLink = trySymlink(
    join(demoDir, "references", "guide.md"),
    join(demoDir, "inner-link.md"),
    "file",
  );
  // 技能根自身是链接（用户级 symlink/junction 导入的受支持形态）：两侧同取
  // realpath 后仍包含 → 必须放行，不误伤。
  const linkedSrc = join(base, "linked-src");
  write(join(linkedSrc, "SKILL.md"), skillFile("linked-skill", "l", "LINKED-ROOT"));
  mkdirSync(join(ws, ".acode", "skills"), { recursive: true });
  haveRootJunction = trySymlink(
    linkedSrc,
    join(ws, ".acode", "skills", "linked-skill"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // plugin 层技能：manifest 提供 pluginName → qualifiedName = testplug:pskill。
  write(join(pluginRoot, ".acode-plugin", "plugin.json"), JSON.stringify({ name: "testplug" }));
  write(join(pluginRoot, "skills", "pskill", "SKILL.md"), skillFile("pskill", "p", "PLUGIN-SKILL"));

  skillPort = createNodeSkillAdapter({
    homeDirectory: home,
    extraResolvedRoots: [
      {
        path: join(pluginRoot, "skills"),
        scope: "system",
        source: "plugin",
        priority: 90,
        pluginId: "plug-test",
      },
    ],
  });
});

function makeContext(overrides = {}) {
  return {
    toolCallId: "tc-skill-uri-read",
    traceId: "trace-skill-uri-read",
    sessionId: "sess_skill_uri_read",
    abortSignal: new AbortController().signal,
    fileSystemPort: createNodeFileSystemAdapter(),
    workingDirectory: ws,
    workspaceRoot: ws,
    skillPort,
    readFileState: new Map(),
    ...overrides,
  };
}

async function callRead(input, contextOverrides = {}) {
  return await readToolEntry.handler(input, makeContext(contextOverrides));
}

/** 断言 handler 抛错并把错误交给 check；未抛错则用例失败。 */
async function expectError(input, check, contextOverrides = {}) {
  let threw = false;
  try {
    await callRead(input, contextOverrides);
  } catch (error) {
    threw = true;
    check(error);
  }
  if (!threw) assert.fail(`expected an error for input ${JSON.stringify(input)}`);
}

function assertCode(error, code) {
  assert.equal(error.context?.code, code, `unexpected error message: ${error.message}`);
}

// ------------------------------------------------------------
// S1/S2/S3/S4 · 正常读取面
// ------------------------------------------------------------

describe("skill:// read protocol", () => {
  test("S1 bare name reads the raw SKILL.md including frontmatter", async () => {
    const output = await callRead({ file_path: "skill://demo" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("name: demo"), "frontmatter must stay raw");
    assert.ok(output.content.includes("# Demo"));
    assert.equal(output.filePath, join(demoDir, "SKILL.md"));
  });

  test("S1 trailing slash form is equivalent to the bare name", async () => {
    const output = await callRead({ file_path: "skill://demo/" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("name: demo"));
  });

  test("S2 asset read reuses the range pipeline (offset/limit/startLine)", async () => {
    const output = await callRead({
      file_path: "skill://demo/references/guide.md",
      offset: 2,
      limit: 1,
    });
    assert.equal(output.type, "text");
    assert.equal(output.content, "line-2");
    assert.equal(output.startLine, 2);
    assert.equal(output.numLines, 1);
    assert.equal(output.filePath, join(demoDir, "references", "guide.md"));
  });

  test("S3 percent-encoded relative path hits a file name with a space", async () => {
    const output = await callRead({ file_path: "skill://demo/references/my%20notes.md" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("SPACE-NAME"));
  });

  test("S4 scheme prefix is case-insensitive", async () => {
    const output = await callRead({ file_path: "SKILL://demo" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("# Demo"));
  });

  test("S5 plugin qualifiedName form resolves", async () => {
    const output = await callRead({ file_path: "skill://testplug:pskill" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("PLUGIN-SKILL"));
  });

  // ------------------------------------------------------------
  // S6/S7 · 发现与赢家（复用既有优先级，不重建）
  // ------------------------------------------------------------

  test("S6 unknown skill lists available ids including qualified names", async () => {
    await expectError({ file_path: "skill://nope" }, (error) => {
      assertCode(error, "skill_uri_unknown_skill");
      assert.ok(error.message.includes('Unknown skill: "nope"'));
      assert.ok(error.message.includes("Available skills:"));
      assert.ok(error.message.includes("demo"));
      assert.ok(error.message.includes("testplug:pskill"));
    });
  });

  test("S7 same-name conflict winner equals the existing loadSkill winner", async () => {
    const output = await callRead({ file_path: "skill://dup-skill" });
    const loaded = await skillPort.loadSkill({
      name: "dup-skill",
      workingDirectory: ws,
      maxBytes: 100_000,
    });
    assert.equal(output.filePath, loaded.metadata.path);
    // 现状优先级：用户层 home/.acode（priority 靠前）赢项目层 ws/.agents。
    assert.ok(output.content.includes("HOME-LAYER"), output.content);
    assert.ok(loaded.metadata.path.startsWith(join(home, ".acode")));
  });

  // ------------------------------------------------------------
  // S8-S11 · 沙箱对抗面
  // ------------------------------------------------------------

  test("S8 .. traversal rejected in slash, backslash and encoded forms", async () => {
    const forms = [
      "skill://demo/../../outside/secret.txt",
      "skill://demo/..\\..\\outside\\secret.txt",
      "skill://demo/%2e%2e%2f%2e%2e%2foutside/secret.txt",
      "skill://demo/references/../../dup-skill/SKILL.md",
    ];
    for (const file_path of forms) {
      await expectError({ file_path }, (error) => {
        assertCode(error, "skill_uri_sandbox_rejected");
        assert.equal(error.context?.rule, "path-traversal");
        assert.ok(error.message.includes('".." segments are not allowed'), file_path);
        // R4：拒绝必须附该技能根一层资产清单。
        assert.ok(error.message.includes("SKILL.md"), file_path);
        assert.ok(error.message.includes("references/"), file_path);
      });
    }
  });

  test("S9 absolute path forms rejected (drive letters in both cases, root-relative, UNC)", async () => {
    const forms = [
      "skill://demo/C:/Windows/win.ini",
      "skill://demo/c:\\windows\\win.ini",
      "skill://demo//etc/passwd",
      "skill://demo/\\etc\\passwd",
      "skill://demo//server/share/secret.txt",
      "skill://demo/c:win.ini",
    ];
    for (const file_path of forms) {
      await expectError({ file_path }, (error) => {
        assertCode(error, "skill_uri_sandbox_rejected");
        assert.equal(error.context?.rule, "absolute-path");
        assert.ok(error.message.includes("absolute paths are not allowed"), file_path);
      });
    }
  });

  test("S10 windows drive letter as skill name is an unknown skill, never a disk read", async () => {
    await expectError({ file_path: "skill://C:/Users/secret.txt" }, (error) => {
      assertCode(error, "skill_uri_unknown_skill");
      assert.ok(error.message.includes('Unknown skill: "C:"'));
    });
  });

  test("S11 NUL byte in the relative path is rejected", async () => {
    await expectError({ file_path: "skill://demo/references%00.txt" }, (error) => {
      assertCode(error, "skill_uri_sandbox_rejected");
      assert.equal(error.context?.rule, "control-character");
      assert.ok(error.message.includes("control characters are not allowed"));
    });
  });

  test("S12a file symlink escape is rejected (realpath containment)", async (t) => {
    if (!haveFileSymlink) return t.skip("file symlinks unavailable on this platform (privilege)");
    await expectError({ file_path: "skill://demo/leak.md" }, (error) => {
      assertCode(error, "skill_uri_sandbox_rejected");
      assert.equal(error.context?.rule, "root-escape");
      assert.ok(error.message.includes("symlink escape"));
      assert.ok(!error.message.includes("SECRET-OUTSIDE"));
    });
  });

  test("S12b directory link (junction/symlink) escape is rejected", async (t) => {
    if (!haveDirLink) return t.skip("directory links unavailable on this platform");
    await expectError({ file_path: "skill://demo/jdir/secret.txt" }, (error) => {
      assertCode(error, "skill_uri_sandbox_rejected");
      assert.equal(error.context?.rule, "root-escape");
      assert.ok(error.message.includes("symlink escape"));
    });
  });

  test("S12c symlink pointing inside the skill directory is allowed", async (t) => {
    if (!haveInnerLink) return t.skip("file symlinks unavailable on this platform (privilege)");
    const output = await callRead({ file_path: "skill://demo/inner-link.md" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("line-1"));
  });

  test("S12d skill root that is itself a link (supported import form) stays readable", async (t) => {
    if (!haveRootJunction) return t.skip("directory links unavailable on this platform");
    const output = await callRead({ file_path: "skill://linked-skill/SKILL.md" });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("LINKED-ROOT"));
  });

  // ------------------------------------------------------------
  // S13/S14/S15/S17 · 模型可操作错误面
  // ------------------------------------------------------------

  test("S13 missing asset reports not-found with the skill asset listing", async () => {
    await expectError({ file_path: "skill://demo/missing.md" }, (error) => {
      assertCode(error, "skill_uri_not_found");
      assert.ok(error.message.includes("File not found: skill://demo/missing.md"));
      assert.ok(error.message.includes("SKILL.md"));
      assert.ok(error.message.includes("references/"));
      assert.ok(error.message.includes("templates/"));
    });
  });

  test("S14 directory targets report a one-level listing of that directory", async () => {
    await expectError({ file_path: "skill://demo/references" }, (error) => {
      assertCode(error, "skill_uri_is_directory");
      assert.ok(error.message.includes("is a directory"));
      assert.ok(error.message.includes("guide.md"));
      assert.ok(error.message.includes("e.g. skill://demo/references/guide.md"));
    });
    await expectError({ file_path: "skill://demo//" }, (error) => {
      assertCode(error, "skill_uri_is_directory");
      assert.ok(error.message.includes("Entries:"));
      assert.ok(error.message.includes("SKILL.md"));
    });
  });

  test("S15 missing skill registry reports unavailable with a fallback hint", async () => {
    await expectError(
      { file_path: "skill://demo" },
      (error) => {
        assertCode(error, "skill_uri_unavailable");
        assert.ok(error.message.includes("no skill registry is configured"));
      },
      { skillPort: undefined },
    );
  });

  test("S17 malformed URIs report the expected form", async () => {
    await expectError({ file_path: "skill://" }, (error) => {
      assertCode(error, "skill_uri_malformed");
      assert.ok(error.message.includes("Expected skill://<name>"));
    });
    await expectError({ file_path: "skill://demo/%zz" }, (error) => {
      assertCode(error, "skill_uri_malformed");
      assert.ok(error.message.includes("Invalid percent-encoding"));
    });
  });

  // ------------------------------------------------------------
  // S16 · 零回归（普通路径/URL 纪律/readFileState 缓存）
  // ------------------------------------------------------------

  test("S16 plain absolute path reads unchanged; URL reads route to the WebFetch pipeline", async () => {
    const normal = join(ws, "normal.txt");
    write(normal, "NORMAL\n");
    const output = await callRead({ file_path: normal });
    assert.equal(output.type, "text");
    assert.ok(output.content.includes("NORMAL"));

    // URL 纪律已按 specs/read-url-direct.md（UX 波 A2）刻意变更：https:// 不再落
    // 文件管线（旧断言 "File does not exist"）。裸测试上下文无 sessionStore（溯源
    // 闸门 fail-open 既有语义）且无 HttpClientPort——配置错误即「已过闸门、进入
    // WebFetch 管道」的证据（read-url-direct.test.mjs 同款判定）。
    await expectError({ file_path: "https://example.com/page.html" }, (error) => {
      assert.ok(error.message.includes("HttpClientPort is not configured"), error.message);
    });
  });

  test("S16 second skill:// read of the same file hits the readFileState cache", async () => {
    const context = makeContext();
    const first = await readToolEntry.handler({ file_path: "skill://demo" }, context);
    assert.equal(first.type, "text");
    const second = await readToolEntry.handler({ file_path: "skill://demo" }, context);
    assert.equal(second.type, "file_unchanged");
    assert.equal(second.filePath, join(demoDir, "SKILL.md"));
  });
});
