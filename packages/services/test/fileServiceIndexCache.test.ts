import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createFileService } from "../src/file/fileService.js";
import type {
  WorkspaceGitFileListingOutcome,
  WorkspaceGitFileListingSource,
} from "../src/file/workspaceGitFileListing.js";

/**
 * 文件索引单一写入路径守护（specs/file-index-degradation.md R1/R4）。
 * 注入 fake git 主源（无真实 git 依赖），验证：成本比例 TTL（贵清单缓存 /
 * 便宜清单每次重建）、singleflight、refresh 旁路、.acodeignore 指纹失效、
 * identity 隔离、超限/失败降级到全量扫描。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface FakeListingHandle {
  source: WorkspaceGitFileListingSource;
  state: { calls: number };
}

function createFakeListing(options: {
  paths?: string[];
  outcome?: WorkspaceGitFileListingOutcome;
  delayMs?: number;
}): FakeListingHandle {
  const state = { calls: 0 };
  const source: WorkspaceGitFileListingSource = {
    async collect() {
      state.calls += 1;
      if (options.delayMs) {
        await sleep(options.delayMs);
      }
      if (options.outcome) {
        return options.outcome;
      }
      return { kind: "listing", paths: options.paths ?? [], droppedNewlinePaths: 0 };
    },
  };
  return { source, state };
}

/** 达到缓存门槛（≥5 万条）的平坦清单；构建耗时由 delayMs 垫到 ≥250ms。 */
function createExpensivePaths(count = 50_000): string[] {
  return Array.from({ length: count }, (_, index) => `f${index}.txt`);
}

const cleanupRoots: string[] = [];

async function createWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acode-file-index-cache-"));
  cleanupRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

afterEach(async () => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("file service index cache (single write path)", () => {
  test("贵清单（≥250ms 且 ≥5 万条）进缓存：第二次请求不再 collect（R4）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: createExpensivePaths(), delayMs: 300 });
    const service = createFileService({ gitFileListing: fake.source });
    const first = await service.searchWorkspaceFiles({ rootPath: root, query: "f123" });
    assert.ok(first.length > 0);
    const second = await service.searchWorkspaceFiles({ rootPath: root, query: "f456" });
    assert.ok(second.length > 0);
    assert.equal(fake.state.calls, 1, "TTL 内第二次请求必须命中缓存");
  });

  test("便宜清单不进缓存：每次请求重建（R4）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: ["a.txt", "b.txt"] });
    const service = createFileService({ gitFileListing: fake.source });
    await service.searchWorkspaceFiles({ rootPath: root, query: "a" });
    await service.searchWorkspaceFiles({ rootPath: root, query: "b" });
    assert.equal(fake.state.calls, 2, "未达成本门槛的清单不应缓存");
  });

  test("oversized/失败/冷却 → 静默降级全量扫描，磁盘文件仍可搜到（R1）", async () => {
    const root = await createWorkspace({ "hello-scan.txt": "x" });
    for (const outcome of [
      { kind: "oversized", reason: "output", collectedPaths: 10 },
      { kind: "cooling-down", retryAfterMs: 1000 },
      { kind: "failed", detail: "exit=128" },
      { kind: "not-a-repository" },
      { kind: "git-unavailable" },
    ] satisfies WorkspaceGitFileListingOutcome[]) {
      const fake = createFakeListing({ outcome });
      const service = createFileService({ gitFileListing: fake.source });
      const results = await service.searchWorkspaceFiles({ rootPath: root, query: "hello-scan" });
      assert.ok(
        results.some((entry) => entry.relativePath === "hello-scan.txt"),
        `降级路径必须找到磁盘文件（outcome=${outcome.kind}）`,
      );
    }
  });

  test("singleflight：并发同作用域请求只 collect 一次（R4 既有语义保留）", async () => {
    // 预置 .acodeignore：并发首调若依赖自动创建，两路 build 的指纹可能各自
    // 观察到不同的创建结果（mtime 竞争），singleflight 判定会失配（既有语义）。
    const root = await createWorkspace({ ".acodeignore": "# fixed rules\n" });
    const fake = createFakeListing({ paths: ["a.txt"], delayMs: 200 });
    const service = createFileService({ gitFileListing: fake.source });
    const [left, right] = await Promise.all([
      service.searchWorkspaceFiles({ rootPath: root, query: "a" }),
      service.searchWorkspaceFiles({ rootPath: root, query: "a" }),
    ]);
    assert.deepEqual(left, right);
    assert.equal(fake.state.calls, 1);
  });

  test("refresh=true 旁路缓存强制重建（既有语义保留）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: createExpensivePaths(), delayMs: 300 });
    const service = createFileService({ gitFileListing: fake.source });
    await service.searchWorkspaceFiles({ rootPath: root, query: "f1" });
    await service.searchWorkspaceFiles({ rootPath: root, query: "f1", refresh: true });
    assert.equal(fake.state.calls, 2);
  });

  test(".acodeignore 指纹失配 → 缓存失效重建（既有契约：编辑规则后下次使用生效）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: createExpensivePaths(), delayMs: 300 });
    const service = createFileService({ gitFileListing: fake.source });
    await service.searchWorkspaceFiles({ rootPath: root, query: "f1" });
    assert.equal(fake.state.calls, 1);
    // 首次 ensure 已自动创建 .acodeignore（模板）；改写内容 → mtime/size 指纹变化。
    await writeFile(join(root, ".acodeignore"), "f1.txt\n# edited\n");
    await service.searchWorkspaceFiles({ rootPath: root, query: "f2" });
    assert.equal(fake.state.calls, 2, "规则文件变化必须触发重建");
  });

  test("workspaceIdentity 隔离：同 rootPath 不同 identity 各自构建（既有语义保留）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: ["a.txt"] });
    const service = createFileService({ gitFileListing: fake.source });
    await service.searchWorkspaceFiles({ rootPath: root, query: "a", workspaceIdentity: "id-a" });
    await service.searchWorkspaceFiles({ rootPath: root, query: "a", workspaceIdentity: "id-b" });
    assert.equal(fake.state.calls, 2);
  });

  test("git 主源清单参与搜索：目录合成与文件命中（R5 端到端）", async () => {
    const root = await createWorkspace();
    const fake = createFakeListing({ paths: ["src/deep/mod.ts", "src/top.ts", "README.md"] });
    const service = createFileService({ gitFileListing: fake.source });
    const results = await service.searchWorkspaceFiles({ rootPath: root, query: "mod", limit: 20 });
    assert.ok(results.some((entry) => entry.relativePath === "src/deep/mod.ts"));
    const length = await service.listWorkspaceFilesLength({ rootPath: root });
    assert.ok(length > 0);
  });
});
