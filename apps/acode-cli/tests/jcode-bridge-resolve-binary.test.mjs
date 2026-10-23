import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

/**
 * jcode 二进制自动发现验收（agent-engine-jcode-slot.md R5，2026-10-24 扩展）。
 *
 * 背景：桌面 GUI 继承的 PATH 不含安装脚本写进 shell rc 的条目，PATH 查找在打包桌面
 * 不可靠；而 jcode 官方安装脚本的默认落点是确定性的（install.ps1:5 →
 * %LOCALAPPDATA%\jcode\bin；install.sh:148 → $HOME/.local/bin），故 shim 直接按落点
 * 探测，Settings.jcodeBinaryPath 降级为**可选覆盖项**。
 *
 * resolve-binary.ts 是纯函数（无 fs/env I/O），候选拼装与 probe 都注入，故本文件
 * 全用假 probe/which，CI 常绿、不依赖真机 jcode。
 */

const { jcodeWellKnownCandidates, resolveJcodeBinary } =
  await import("../packages/cli/src/jcode-bridge/resolve-binary.ts");

const WIN_ENV = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", HOME: undefined };
const UNIX_ENV = { HOME: "/home/u", LOCALAPPDATA: undefined };

test("候选拼装：win32 → %LOCALAPPDATA%\\jcode\\bin\\jcode.exe（安装脚本默认落点）", () => {
  assert.deepEqual(jcodeWellKnownCandidates("win32", WIN_ENV), [
    join("C:\\Users\\u\\AppData\\Local", "jcode", "bin", "jcode.exe"),
  ]);
});

test("候选拼装：unix → ~/.local/bin/jcode + /usr/local/bin/jcode", () => {
  // 期望值用 join 拼（node:path 平台相关：Windows 上产出反斜杠），断言平台无关。
  const expected = [join("/home/u", ".local", "bin", "jcode"), join("/usr/local/bin", "jcode")];
  assert.deepEqual(jcodeWellKnownCandidates("linux", UNIX_ENV), expected);
  assert.deepEqual(jcodeWellKnownCandidates("darwin", UNIX_ENV), expected);
});

test("候选拼装：env 缺失不拼空根路径（win 无 LOCALAPPDATA / unix 无 HOME 仍给 fallback）", () => {
  assert.deepEqual(jcodeWellKnownCandidates("win32", {}), []);
  assert.deepEqual(jcodeWellKnownCandidates("linux", {}), [join("/usr/local/bin", "jcode")]);
});

test("优先级：CLI > env > 常见位置 > PATH（逐层短路）", async () => {
  const probeHits = new Set(["/opt/jcode/bin/jcode"]);
  const probe = async (candidate) => probeHits.has(candidate);
  const which = (name) => (name === "jcode" ? "/usr/bin/jcode" : null);
  const wellKnown = ["/opt/jcode/bin/jcode"];

  // CLI 赢过一切。
  assert.equal(
    await resolveJcodeBinary("/cli/jcode", "/env/jcode", "linux", which, probe, wellKnown),
    "/cli/jcode",
  );
  // env 赢过常见位置与 PATH。
  assert.equal(
    await resolveJcodeBinary(undefined, "/env/jcode", "linux", which, probe, wellKnown),
    "/env/jcode",
  );
  // 常见位置赢过 PATH。
  assert.equal(
    await resolveJcodeBinary(undefined, undefined, "linux", which, probe, wellKnown),
    "/opt/jcode/bin/jcode",
  );
  // 常见位置全 miss → 落 PATH。
  assert.equal(
    await resolveJcodeBinary(undefined, undefined, "linux", which, probe, ["/nope/jcode"]),
    "/usr/bin/jcode",
  );
});

test("probe 按候选顺序短路：第一个命中即返回，不继续探测", async () => {
  const visited = [];
  const probe = async (candidate) => {
    visited.push(candidate);
    return candidate === "/a/jcode";
  };
  const found = await resolveJcodeBinary(undefined, undefined, "linux", () => null, probe, [
    "/a/jcode",
    "/b/jcode",
  ]);
  assert.equal(found, "/a/jcode");
  assert.deepEqual(visited, ["/a/jcode"], "命中后不应继续探测后续候选");
});

test("旧调用方形态（不传 probe/wellKnown）退化为 CLI > env > PATH", async () => {
  assert.equal(
    await resolveJcodeBinary(undefined, undefined, "win32", (n) =>
      n === "jcode.exe" ? "C:\\bin\\jcode.exe" : null,
    ),
    "C:\\bin\\jcode.exe",
  );
});

test("四层全落空抛错，文案含全部查找位置与 Settings 指引", async () => {
  await assert.rejects(
    resolveJcodeBinary(
      undefined,
      undefined,
      "linux",
      () => null,
      async () => false,
      ["/x/jcode"],
    ),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /jcode binary not found/);
      assert.match(message, /--jcode-binary/);
      assert.match(message, /ACODE_JCODE_BINARY_PATH/);
      assert.match(message, /\/x\/jcode/, "错误应列出探测过的常见位置");
      assert.match(message, /Settings/, "错误应指引 Settings 覆盖项");
      return true;
    },
  );
});

test("空白串不算有效输入（trim 后判空，逐层 fallthrough）", async () => {
  assert.equal(
    await resolveJcodeBinary(
      "   ",
      "  ",
      "linux",
      (n) => (n === "jcode" ? "/usr/bin/jcode" : null),
      async () => false,
      [],
    ),
    "/usr/bin/jcode",
    "空白 CLI/env 必须 fallthrough 到后续层",
  );
});
