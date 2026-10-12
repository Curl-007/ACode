import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearFrameworkDetectionCache,
  detectFrameworks,
  mapDependencyNamesToFrameworks,
} from "../../src/snippets/frameworkDetection.js";

test("命中 next 依赖", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["next", "react"])), ["next", "react"]);
});

test("命中 @nestjs/core", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["@nestjs/core"])), ["nestjs"]);
});

test("命中 svelte 与 @sveltejs/kit 任一", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["svelte"])), ["svelte"]);
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["@sveltejs/kit"])), ["svelte"]);
});

test("命中 @tauri-apps/api", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["@tauri-apps/api"])), ["tauri"]);
});

test("不因 react-dom 误判", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["react-dom"])), []);
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["vue-router"])), []);
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["@nestjs/common"])), []);
});

test("无白名单依赖返回空数组", () => {
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set(["lodash"])), []);
  assert.deepEqual(mapDependencyNamesToFrameworks(new Set()), []);
});

test("package.json 非法 JSON 返回空数组", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-framework-"));
  try {
    clearFrameworkDetectionCache();
    await writeFile(join(dir, "package.json"), "{ not json", "utf-8");
    const result = await detectFrameworks({ workspacePath: dir, workspaceKey: `bad-${dir}` });
    assert.deepEqual(result.frameworks, []);
    assert.equal(result.cached, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无 package.json 返回空数组", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-framework-"));
  try {
    clearFrameworkDetectionCache();
    const result = await detectFrameworks({ workspacePath: dir, workspaceKey: `missing-${dir}` });
    assert.deepEqual(result.frameworks, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("远程工作区不探测", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-framework-"));
  try {
    clearFrameworkDetectionCache();
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "1" } }));
    const result = await detectFrameworks({
      workspacePath: dir,
      workspaceKey: `remote-${dir}`,
      isRemote: true,
    });
    assert.deepEqual(result.frameworks, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("60s 内重复调用走缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-framework-"));
  try {
    clearFrameworkDetectionCache();
    const workspaceKey = `cache-${dir}`;
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { vue: "3" } }));
    const first = await detectFrameworks({ workspacePath: dir, workspaceKey });
    assert.deepEqual(first.frameworks, ["vue"]);
    assert.equal(first.cached, false);

    // 缓存命中后即使磁盘内容变化也返回上次结果，证明没有重新读盘。
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "1" } }));
    const second = await detectFrameworks({ workspacePath: dir, workspaceKey });
    assert.deepEqual(second.frameworks, ["vue"]);
    assert.equal(second.cached, true);

    // 时间越过 TTL 后重新探测。
    const third = await detectFrameworks({
      workspacePath: dir,
      workspaceKey,
      now: Date.now() + 61_000,
    });
    assert.deepEqual(third.frameworks, ["next"]);
    assert.equal(third.cached, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
