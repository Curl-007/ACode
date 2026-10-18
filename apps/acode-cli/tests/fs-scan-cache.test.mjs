import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// specs/fs-hotpath-mechanisms.md R1：目录项扫描缓存——命中/TTL/前缀失效/
// generation 防在途回填/容量淘汰/空结果重检/写入即失效。

const { FsScanCache, shouldRecheckEmptyResult, invalidateFsScanCache } = await import(
  "../packages/adapters/src/fs/scan-cache.ts"
);
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");

function knobs(overrides = {}) {
  return {
    ttlMs: 60_000,
    maxEntries: 16,
    maxBytes: 64 * 1024 * 1024,
    emptyRecheckMs: 200,
    ...overrides,
  };
}

test("scan cache: hit returns stored list with age; TTL expiry forces rescan", async () => {
  let clock = 1_000;
  const cache = new FsScanCache({ knobs: knobs({ ttlMs: 500 }), now: () => clock });
  const key = { root: "C:/tmp/root", respectGitignore: true };
  let scans = 0;

  const first = await cache.getOrScan(key, async () => {
    scans += 1;
    return ["C:/tmp/root/a.ts"];
  });
  assert.equal(scans, 1);
  assert.equal(first.cacheAgeMs, 0);
  assert.deepEqual(first.files, ["C:/tmp/root/a.ts"]);

  clock += 100;
  const hit = cache.get(key);
  assert.ok(hit, "TTL 内必须命中");
  assert.equal(hit.cacheAgeMs, 100);
  assert.deepEqual(hit.files, ["C:/tmp/root/a.ts"]);

  clock += 1_000;
  const second = await cache.getOrScan(key, async () => {
    scans += 1;
    return ["C:/tmp/root/a.ts", "C:/tmp/root/b.ts"];
  });
  assert.equal(scans, 2, "TTL 过期后必须重扫");
  assert.equal(second.cacheAgeMs, 0);
  assert.deepEqual(second.files, ["C:/tmp/root/a.ts", "C:/tmp/root/b.ts"]);
});

test("scan cache: prefix invalidation drops covering roots and keeps unrelated ones", async () => {
  let clock = 1_000;
  const cache = new FsScanCache({ knobs: knobs(), now: () => clock });
  const root = { root: "C:/tmp/root", respectGitignore: true };
  const other = { root: "C:/tmp/other", respectGitignore: true };

  await cache.getOrScan(root, async () => ["C:/tmp/root/a.ts"]);
  await cache.getOrScan(other, async () => ["C:/tmp/other/b.ts"]);
  assert.equal(cache.debugSize().count, 2);

  // 写 C:/tmp/root/sub/file → 失效 root 命中该前缀；other 必须幸存。
  cache.invalidatePath("C:/tmp/root/sub/file");
  assert.equal(cache.get(root), undefined, "覆盖目标路径的 root 必须被失效");
  assert.ok(cache.get(other), "无关 root 必须保留");

  // invalidateAll 清空全部。
  cache.invalidateAll();
  assert.equal(cache.get(other), undefined);
});

test("scan cache: generation guard rejects in-flight scan after invalidation", async () => {
  const cache = new FsScanCache({ knobs: knobs() });
  const key = { root: "C:/tmp/root", respectGitignore: true };
  let releaseScan;
  const gate = new Promise((resolve) => {
    releaseScan = resolve;
  });

  const inFlight = cache.getOrScan(key, async () => {
    await gate;
    return ["C:/tmp/root/stale.ts"];
  });

  // 扫描在途时发生写失效 → generation bump → 在途结果不得回填缓存。
  cache.invalidatePath("C:/tmp/root/new-file.ts");
  releaseScan();
  const settled = await inFlight;
  assert.deepEqual(settled.files, ["C:/tmp/root/stale.ts"], "调用方仍拿到本次扫描结果");
  assert.equal(cache.get(key), undefined, "被失效的在途扫描不得回填缓存");

  // 失效之后的新扫描正常缓存。
  const fresh = await cache.getOrScan(key, async () => ["C:/tmp/root/fresh.ts"]);
  assert.equal(fresh.cacheAgeMs, 0);
  assert.ok(cache.get(key), "失效后的新扫描必须重新入缓存");
});

test("scan cache: count and byte budget eviction drops oldest entries; oversized scans stay uncached", async () => {
  let clock = 1_000;
  const cache = new FsScanCache({ knobs: knobs({ maxEntries: 2, maxBytes: 4096 }), now: () => clock });
  const scan = (files) => async () => files;

  await cache.getOrScan({ root: "C:/r/a", respectGitignore: true }, scan(["C:/r/a/1.ts"]));
  clock += 1;
  await cache.getOrScan({ root: "C:/r/b", respectGitignore: true }, scan(["C:/r/b/2.ts"]));
  clock += 1;
  await cache.getOrScan({ root: "C:/r/c", respectGitignore: true }, scan(["C:/r/c/3.ts"]));

  assert.equal(cache.get({ root: "C:/r/a", respectGitignore: true }), undefined, "最老条目被条数上限淘汰");
  assert.ok(cache.get({ root: "C:/r/b", respectGitignore: true }));
  assert.ok(cache.get({ root: "C:/r/c", respectGitignore: true }));

  // 字节预算淘汰：3MiB 条目塞不进 4096B 预算 → 不缓存但照常返回。
  clock += 1;
  const bigFiles = [`C:/r/big/${"x".repeat(4_000_000)}.ts`];
  const big = await cache.getOrScan({ root: "C:/r/big", respectGitignore: true }, scan(bigFiles));
  assert.deepEqual(big.files, bigFiles);
  assert.equal(cache.get({ root: "C:/r/big", respectGitignore: true }), undefined, "超预算扫描不得入缓存");
});

test("scan cache: zero limits bypass the cache entirely", async () => {
  const cache = new FsScanCache({ knobs: knobs({ ttlMs: 0, maxEntries: 0, maxBytes: 0 }) });
  const key = { root: "C:/tmp/root", respectGitignore: true };
  let scans = 0;
  await cache.getOrScan(key, async () => {
    scans += 1;
    return [];
  });
  await cache.getOrScan(key, async () => {
    scans += 1;
    return [];
  });
  assert.equal(scans, 2, "上限为 0 时完全旁路缓存");
  assert.equal(shouldRecheckEmptyResult(1_000), true, "默认 200ms 重检年龄");
});

test("scan cache: in-flight dedupe shares one traversal for concurrent misses", async () => {
  const cache = new FsScanCache({ knobs: knobs() });
  const key = { root: "C:/tmp/root", respectGitignore: true };
  let scans = 0;
  const [a, b] = await Promise.all([
    cache.getOrScan(key, async () => {
      scans += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ["C:/tmp/root/a.ts"];
    }),
    cache.getOrScan(key, async () => {
      scans += 1;
      return ["C:/tmp/root/b.ts"];
    }),
  ]);
  assert.equal(scans, 1, "并发同键只允许一次遍历");
  assert.deepEqual(a.files, b.files);
});

test("adapter: empty-result recheck rescans once for stale snapshots without polluting the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acode-fs-recheck-"));
  try {
    invalidateFsScanCache();
    const adapter = createNodeFileSystemAdapter();
    await writeFile(join(dir, "seed.txt"), "seed", "utf8");
    // 预热：模式只匹配 external*，缓存进一张空快照。
    await adapter.searchFiles({ path: dir, pattern: "external*.txt" });

    // 外部进程直写（不走适配器写路径 → 不触发失效钩子）。
    await writeFile(join(dir, "external.txt"), "ext", "utf8");
    const immediate = await adapter.searchFiles({ path: dir, pattern: "external*.txt" });
    assert.ok(
      !immediate.files.includes(join(dir, "external.txt")),
      "缓存新鲜（<200ms）时不得触发重检",
    );

    // 快照老化越过重检阈值后：过滤为空 + 老快照触发一次旁路重扫，看到外部新文件。
    await new Promise((resolve) => setTimeout(resolve, 260));
    const rechecked = await adapter.searchFiles({ path: dir, pattern: "external*.txt" });
    assert.ok(
      rechecked.files.includes(join(dir, "external.txt")),
      "空结果 + 老快照必须触发重检",
    );

    // 重检不回填：缓存里仍是旧空快照。非空结果的查询不触发重检，
    // 因此 external.txt 在宽匹配下不可见——证明缓存未被重扫结果污染。
    const probe = await adapter.searchFiles({ path: dir, pattern: "**/*.txt" });
    assert.deepEqual(
      probe.files.filter((file) => file.endsWith("external.txt")),
      [],
      "重检结果不得回填缓存",
    );
  } finally {
    invalidateFsScanCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter: writeTextFile invalidates immediately so glob sees the new file without TTL wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acode-fs-scan-cache-"));
  try {
    invalidateFsScanCache();
    const adapter = createNodeFileSystemAdapter();
    await writeFile(join(dir, "seed.txt"), "seed", "utf8");

    const first = await adapter.searchFiles({ path: dir, pattern: "**/*.txt" });
    assert.deepEqual([...first.files].sort(), [join(dir, "seed.txt")], "首轮扫描填充缓存");

    // 不等待 TTL（默认 1000ms）立即写入并再查：写后失效必须立刻可见。
    await adapter.writeTextFile({ path: join(dir, "added.txt"), content: "added" });
    const second = await adapter.searchFiles({ path: dir, pattern: "**/*.txt" });
    assert.ok(
      second.files.includes(join(dir, "added.txt")),
      `写后立即失效失败：${JSON.stringify(second.files)}`,
    );

    await adapter.removeFile({ path: join(dir, "added.txt") });
    const third = await adapter.searchFiles({ path: dir, pattern: "**/*.txt" });
    assert.ok(!third.files.includes(join(dir, "added.txt")), "删除后必须立刻不可见");
  } finally {
    invalidateFsScanCache();
    await rm(dir, { recursive: true, force: true });
  }
});
