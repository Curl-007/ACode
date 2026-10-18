// specs/skills-bundled-visibility-and-official-cache-authority.md §四 M1-2 / §七 S8：
// bundled-marketplace.json 分片权威解析 helper 的表驱动测试（M1-2 规则 1-6 逐条）。
// 与 adapters 侧 loadBundledOfficialPluginRootsSync（official-marketplace.ts:35-61）逐语义等价，
// undefined vs [] 语义必须区分（R3）。V3 比较函数表驱动测试与 D2 清理测试共用样本（规则 V3），
// 归 plugin-release-fixer 的 shared 版本判据文件（t-7），不在本文件。
import assert from "node:assert/strict";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import {
  resolveBundledOfficialPluginCachePaths,
  type OfficialMarketplacePartitionPathOps,
} from "../src/plugin-official-marketplace-partition.js";

const pathOps: OfficialMarketplacePartitionPathOps = { isAbsolute, relative, resolve, sep };

const OFFICIAL_CACHE_ROOT = resolve("/data/cli/plugins/cache/acode-plugins-official");

function partitionOf(plugins: unknown, version: unknown = 1): unknown {
  return {
    version,
    manifest: {
      name: "acode-plugins-official",
      plugins,
    },
  };
}

describe("resolveBundledOfficialPluginCachePaths（M1 分片权威解析）", () => {
  it("规则 1：partition 非对象（null/数组/字符串）→ undefined", () => {
    assert.equal(resolveBundledOfficialPluginCachePaths({ partition: null, officialCacheRoot: OFFICIAL_CACHE_ROOT, path: pathOps }), undefined);
    assert.equal(
      resolveBundledOfficialPluginCachePaths({ partition: [1, 2], officialCacheRoot: OFFICIAL_CACHE_ROOT, path: pathOps }),
      undefined,
    );
    assert.equal(
      resolveBundledOfficialPluginCachePaths({ partition: "v1", officialCacheRoot: OFFICIAL_CACHE_ROOT, path: pathOps }),
      undefined,
    );
  });

  it("规则 1：version 缺失或 !== 1 → undefined", () => {
    assert.equal(
      resolveBundledOfficialPluginCachePaths({ partition: {}, officialCacheRoot: OFFICIAL_CACHE_ROOT, path: pathOps }),
      undefined,
    );
    assert.equal(
      resolveBundledOfficialPluginCachePaths({
        partition: partitionOf([], 2),
        officialCacheRoot: OFFICIAL_CACHE_ROOT,
        path: pathOps,
      }),
      undefined,
    );
  });

  it("规则 2：manifest 非对象 → undefined", () => {
    assert.equal(
      resolveBundledOfficialPluginCachePaths({
        partition: { version: 1, manifest: "nope" },
        officialCacheRoot: OFFICIAL_CACHE_ROOT,
        path: pathOps,
      }),
      undefined,
    );
    assert.equal(
      resolveBundledOfficialPluginCachePaths({
        partition: { version: 1 },
        officialCacheRoot: OFFICIAL_CACHE_ROOT,
        path: pathOps,
      }),
      undefined,
    );
  });

  it("规则 2：manifest.plugins 非数组 → 空权威集 []（有效分片 + 空条目集，不回退）", () => {
    assert.deepEqual(
      resolveBundledOfficialPluginCachePaths({
        partition: { version: 1, manifest: { name: "acode-plugins-official", plugins: "all" } },
        officialCacheRoot: OFFICIAL_CACHE_ROOT,
        path: pathOps,
      }),
      [],
    );
    assert.deepEqual(
      resolveBundledOfficialPluginCachePaths({
        partition: { version: 1, manifest: { name: "acode-plugins-official" } },
        officialCacheRoot: OFFICIAL_CACHE_ROOT,
        path: pathOps,
      }),
      [],
    );
  });

  it("规则 3/4/6：合法分片 → 保持分片内顺序的 resolvedCachePath 数组", () => {
    // cachePath 允许相对形式（resolve 以调用方 cwd 为基准，M1-2 规则 4）；解析结果
    // 落在双重后代校验之外时由规则 5 丢弃（见越界用例）——相对语义由此共同覆盖。
    const first = joinPath(OFFICIAL_CACHE_ROOT, "p1", "0.1.0");
    const second = joinPath(OFFICIAL_CACHE_ROOT, "p2", "0.2.0");
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([
        { name: "p1", version: "0.1.0", cachePath: first },
        { name: "p2", version: "0.2.0", cachePath: second },
      ]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    assert.deepEqual(result, [first, second]);
  });

  it("规则 3：name 或 cachePath 非串/空串/缺失 → 丢弃该条，不影响其余条目", () => {
    const good = { name: "keep", cachePath: joinPath(OFFICIAL_CACHE_ROOT, "keep", "0.1.0") };
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([
        { cachePath: joinPath(OFFICIAL_CACHE_ROOT, "a", "0.1.0") },
        { name: "", cachePath: joinPath(OFFICIAL_CACHE_ROOT, "b", "0.1.0") },
        { name: 42, cachePath: joinPath(OFFICIAL_CACHE_ROOT, "c", "0.1.0") },
        { name: "d" },
        { name: "e", cachePath: "" },
        { name: "f", cachePath: null },
        "not-a-record",
        good,
      ]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    assert.deepEqual(result, [good.cachePath]);
  });

  it("规则 5：cachePath 以 ../ 越出 pluginCacheRoot 或 officialCacheRoot → 丢弃该条", () => {
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([
        { name: "escape", cachePath: joinPath("..", "..", "somewhere-else") },
        { name: "sibling", cachePath: joinPath(OFFICIAL_CACHE_ROOT, "other-plugin", "0.1.0") },
      ]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    // 第一条越出 officialCacheRoot；第二条在 officialCacheRoot 内但不在 name 对应的
    // pluginCacheRoot（officialCacheRoot/sibling）下——双重严格后代校验第二层拦截。
    assert.deepEqual(result, []);
  });

  it("规则 5：cachePath 等于 pluginCacheRoot 本身（非严格后代）→ 丢弃该条", () => {
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([{ name: "p1", cachePath: joinPath(OFFICIAL_CACHE_ROOT, "p1") }]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    assert.deepEqual(result, []);
  });

  it("规则 5：cachePath 指向 officialCacheRoot 本身或其上层 → 丢弃该条", () => {
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([
        { name: "p1", cachePath: OFFICIAL_CACHE_ROOT },
        { name: "p2", cachePath: joinPath(OFFICIAL_CACHE_ROOT, "..") },
      ]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    assert.deepEqual(result, []);
  });

  it("R3 语义区分：plugins: [] → 权威空数组 []（不是 undefined）", () => {
    const result = resolveBundledOfficialPluginCachePaths({
      partition: partitionOf([]),
      officialCacheRoot: OFFICIAL_CACHE_ROOT,
      path: pathOps,
    });
    assert.deepEqual(result, []);
    assert.notEqual(result, undefined);
  });
});

function joinPath(...segments: string[]): string {
  return resolve(...segments);
}
