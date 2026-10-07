import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * specs/host-startup-storage-cwd.md 验收（2026-10-05，dev/0.0.3 debug 冒烟实证）：
 * warmup 已删除 workspace + fallback conversation 目录缺失曾把整个 host 存储启动
 * 拖成 transport_closed 硬阻断。R1/R3/R4 的降级裁决在叶子模块内做行为断言；
 * R2 的兜底补建与 warn 接线在宿主/入口源码钉桩（Worker/进程机制不可注入，
 * 沿用 desktop 测试既有的源码审读纪律）。
 */

// pathname 手切首斜杠是 Windows 假设（POSIX 上丢开头的 "/"，CI ubuntu 实测 ENOENT）。
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const { resolveSessionStorageStartupDirectories } = await import(
  "../src/host/sessionStorageStartupDirectories.ts"
);

/** 按「候选目录是否存在 + fallback 是否可用」模拟 services resolver 的契约。 */
function fakeResolver({ alive, fallbackUsable, fallbackCwd }) {
  return async (candidate) => {
    if (alive.has(candidate))
      return { cwd: candidate, usedFallback: false, cwdExists: true };
    if (fallbackUsable) return { cwd: fallbackCwd, usedFallback: true, cwdExists: true };
    return { cwd: candidate, usedFallback: false, cwdExists: false };
  };
}

test("(场景1/R1+R3) 已删除候选被跳过留痕，存活候选照常准备，不硬阻断", async () => {
  const result = await resolveSessionStorageStartupDirectories({
    candidates: ["C:/gone/project", "C:/alive/project"],
    fallbackCwd: "C:/missing-fallback",
    resolveCwd: fakeResolver({
      alive: new Set(["C:/alive/project"]),
      fallbackUsable: false,
      fallbackCwd: "C:/missing-fallback",
    }),
  });
  assert.deepEqual(result.directories, ["C:/alive/project"]);
  assert.deepEqual(result.skipped, ["C:/gone/project"]);
});

test("(场景2) 候选全删除但 fallback 可用 → resolver 回退，与真实域实测行为一致", async () => {
  const result = await resolveSessionStorageStartupDirectories({
    candidates: ["C:/gone/project"],
    fallbackCwd: "C:/home/.acode/workspace/default",
    resolveCwd: fakeResolver({
      alive: new Set(),
      fallbackUsable: true,
      fallbackCwd: "C:/home/.acode/workspace/default",
    }),
  });
  assert.deepEqual(result.directories, ["C:/home/.acode/workspace/default"]);
  assert.deepEqual(result.skipped, []);
});

test("(场景3/R4) 候选与 fallback 全失效 → 仍以 fallback 进入一次准备，保持 fail-loud", async () => {
  const result = await resolveSessionStorageStartupDirectories({
    candidates: ["C:/gone/a", "C:/gone/b"],
    fallbackCwd: "C:/also-gone",
    resolveCwd: fakeResolver({
      alive: new Set(),
      fallbackUsable: false,
      fallbackCwd: "C:/also-gone",
    }),
  });
  // 不得返回空列表静默跳过准备；显式 transport_closed 好过会话库未迁移就服务。
  assert.deepEqual(result.directories, ["C:/also-gone"]);
  assert.deepEqual(result.skipped, ["C:/gone/a", "C:/gone/b"]);
});

test("(场景4) 多候选解析到同一 cwd → 去重后只准备一次", async () => {
  const result = await resolveSessionStorageStartupDirectories({
    candidates: ["C:/gone/a", "C:/gone/b"],
    fallbackCwd: "C:/fallback",
    resolveCwd: fakeResolver({ alive: new Set(), fallbackUsable: true, fallbackCwd: "C:/fallback" }),
  });
  assert.deepEqual(result.directories, ["C:/fallback"]);
  assert.deepEqual(result.skipped, []);
});

test("(场景5/R2) host 存储启动前幂等补建 fallback cwd，失败仅 warn 不中断", () => {
  const source = readFileSync(`${DESKTOP_ROOT}src/host/hostDatabaseStartup.ts`, "utf-8");
  assert.match(source, /await mkdir\(options\.cwd, \{ recursive: true \}\)/);
  // 补建失败走 warn 留痕，随后仍按 R3/R4 裁决，不得直接抛出。
  assert.match(source, /mkdir\(options\.cwd[\s\S]{0,240}\.catch\(/);
  assert.match(source, /skipping inaccessible workspace directories for session storage/);
});

test("(R2 接线) host 入口把降级 warn 接入宿主 logger", () => {
  const source = readFileSync(`${DESKTOP_ROOT}src/host/index.ts`, "utf-8");
  assert.match(source, /warn: \(message, details\) => logger\.warn\(message, details\)/);
});
