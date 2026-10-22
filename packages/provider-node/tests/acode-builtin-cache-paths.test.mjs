import assert from "node:assert/strict";
import test from "node:test";

/**
 * ACode builtin 缓存路径与 endpoint key 归一化守护（review 测试专项 P2：provider-node 覆盖偏薄）。
 *
 * 覆盖 src/acode-builtin-cache-paths.ts 的纯逻辑：平台/架构映射、endpoint origin 归一化、
 * 路径段注入防护（../ 与分隔符拒绝）。路径分隔符用 join 构造，不硬编码，保证 Windows/posix 一致。
 */
const {
  resolveACodeBuiltinClientPlatform,
  resolveACodeBuiltinCachePaths,
  createACodeBuiltinEndpointKey,
  normalizeACodeBuiltinEndpointOrigin,
} = await import("../src/acode-builtin-cache-paths.ts");

test("resolveACodeBuiltinClientPlatform 映射当前平台与架构", () => {
  const platform = resolveACodeBuiltinClientPlatform();
  // win32 → windows；x64 → x86_64；arm64 → aarch64；其余原样。
  const expectedTarget = process.platform === "win32" ? "windows" : process.platform;
  const expectedArch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  assert.equal(platform, `${expectedTarget}-${expectedArch}`);
});

test("resolveACodeBuiltinCachePaths 按平台/版本/endpoint 隔离，Active 与 Control 同目录", () => {
  const paths = resolveACodeBuiltinCachePaths({
    environmentConfigRoot: "/root",
    platform: "windows-x86_64",
    appVersion: "1.0.3",
    acodeEndpointOrigin: "https://api.example.com",
  });
  const endpointKey = createACodeBuiltinEndpointKey("https://api.example.com");
  // 目录结构：<root>/runtime/provider/<platform>/<appVersion>/<endpointKey>/
  assert.ok(paths.activeFilePath.endsWith(`acode-builtin.json`), paths.activeFilePath);
  assert.ok(paths.controlFilePath.endsWith(`acode-builtin-refresh.json`), paths.controlFilePath);
  assert.ok(paths.activeFilePath.includes(endpointKey));
  // Active 与 Control 必须落在同一隔离目录（同平台/版本/endpoint）。
  const activeDir = paths.activeFilePath.slice(0, paths.activeFilePath.lastIndexOf("acode-builtin.json"));
  assert.ok(paths.controlFilePath.startsWith(activeDir), "control 与 active 必须同目录");
  // 不同 appVersion → 不同目录（升级不共享缓存）。
  const other = resolveACodeBuiltinCachePaths({
    environmentConfigRoot: "/root",
    platform: "windows-x86_64",
    appVersion: "1.0.4",
    acodeEndpointOrigin: "https://api.example.com",
  });
  assert.notEqual(other.activeFilePath, paths.activeFilePath);
});

test("createACodeBuiltinEndpointKey 对同一 origin 稳定、对不同 origin 区分", () => {
  const a = createACodeBuiltinEndpointKey("https://api.example.com");
  const b = createACodeBuiltinEndpointKey("https://api.example.com");
  const c = createACodeBuiltinEndpointKey("https://other.example.com");
  assert.equal(a, b, "同一 origin 必须产生同一 key（缓存稳定）");
  assert.notEqual(a, c, "不同 origin 必须产生不同 key（隔离）");
  assert.match(a, /^endpoint-[0-9a-f]{32}$/, "key 形状必须是 endpoint-<sha256 前 32 位>");
  // 路径/大小写归一：同 origin 不同大小写与尾部空白归一到同一 key。
  assert.equal(
    createACodeBuiltinEndpointKey("  https://api.example.com  "),
    a,
    "origin 首尾空白必须归一",
  );
});

test("normalizeACodeBuiltinEndpointOrigin 只接受 HTTP(S)，拒绝空与非 http 协议", () => {
  assert.equal(
    normalizeACodeBuiltinEndpointOrigin("https://api.example.com/some/path?x=1"),
    "https://api.example.com",
    "必须归一到 origin（去路径与 query）",
  );
  assert.throws(() => normalizeACodeBuiltinEndpointOrigin("   "), /不能为空/);
  assert.throws(() => normalizeACodeBuiltinEndpointOrigin("ftp://api.example.com"), /只支持 HTTP\(S\)/);
  assert.throws(() => normalizeACodeBuiltinEndpointOrigin("file:///etc/passwd"), /只支持 HTTP\(S\)/);
});

test("路径段注入防护：platform/appVersion 含分隔符或遍历段被拒", () => {
  const base = {
    environmentConfigRoot: "/root",
    platform: "windows-x86_64",
    appVersion: "1.0.3",
    acodeEndpointOrigin: "https://api.example.com",
  };
  for (const bad of ["../evil", "a/b", "a\\b", ".", "..", "  "]) {
    assert.throws(
      () => resolveACodeBuiltinCachePaths({ ...base, platform: bad }),
      /不是合法路径段/,
      `platform="${bad}" 必须被拒`,
    );
    assert.throws(
      () => resolveACodeBuiltinCachePaths({ ...base, appVersion: bad }),
      /不是合法路径段/,
      `appVersion="${bad}" 必须被拒`,
    );
  }
});
