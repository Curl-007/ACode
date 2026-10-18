import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOfficialPluginVersionDirNames,
  parseOfficialPluginVersionDirName,
  selectBestOfficialPluginVersionDirName,
} from "../src/plugin-official-cache-version.js";

/**
 * 官方插件 cache 版本目录判据单点的表驱动测试（specs/plugin-official-cache-authority-m1.md
 * 规则 V3 / specs/official-plugin-cache-cleanup.md §R4）。三处消费方共用同一组样本：
 * M1 回退择优（adapters scanOfficialCache / services scanOfficialPluginCacheRoots）、
 * D2 清理「更旧」判定、以及 adapters version-compare.ts（semver）的一致性钉子。
 */

test("解析：常规版本目录名产出数值三元组（semver.coerce 兼容）", () => {
  const samples: Array<[string, readonly [number, number, number]]> = [
    ["0.2.0", [0, 2, 0]],
    ["0.3.0", [0, 3, 0]],
    ["0.10.0", [0, 10, 0]],
    ["1.2.3", [1, 2, 3]],
    ["v1.2.3", [1, 2, 3]],
    ["1.2", [1, 2, 0]],
    ["1", [1, 0, 0]],
    ["01.02.03", [1, 2, 3]],
  ];
  for (const [dirName, expected] of samples) {
    assert.deepEqual(parseOfficialPluginVersionDirName(dirName), expected, dirName);
  }
});

test("解析：事务过渡目录与非版本形状一律不可解析（形状上即排除，清理永不删）", () => {
  const unparseable = [
    ".backup-0.3.0",
    ".backup",
    ".tmp-12345",
    ".tmp-1.2.3",
    ".seed-lock",
    ".seed-lock.stale-1",
    "0.2.0-beta.1",
    "0.2.0+build.1",
    "1.2.3.4",
    "latest",
    "",
    "v",
    "abc",
  ];
  for (const dirName of unparseable) {
    assert.equal(
      parseOfficialPluginVersionDirName(dirName),
      undefined,
      `${dirName} 必须不可解析`,
    );
  }
});

test("比较：数值序而非字典序（spec 钉子样本）", () => {
  assert.equal(compareOfficialPluginVersionDirNames("0.2.0", "0.3.0"), -1, "0.2.0 < 0.3.0");
  assert.equal(compareOfficialPluginVersionDirNames("0.3.0", "0.2.0"), 1);
  assert.equal(compareOfficialPluginVersionDirNames("0.9.0", "0.10.0"), -1, "0.10.0 > 0.9.0");
  assert.equal(compareOfficialPluginVersionDirNames("0.10.0", "0.9.0"), 1);
  assert.equal(compareOfficialPluginVersionDirNames("1.0.0", "1.0.0"), 0);
  assert.equal(compareOfficialPluginVersionDirNames("1.2", "1.2.0"), 0, "缺段补 0 后相等");
});

test("比较：任一侧不可解析 → undefined（不参与比较，永不删除/不产出候选根）", () => {
  assert.equal(compareOfficialPluginVersionDirNames(".backup-1", "0.3.0"), undefined);
  assert.equal(compareOfficialPluginVersionDirNames("0.3.0", ".tmp-1.2.3"), undefined);
  assert.equal(compareOfficialPluginVersionDirNames("latest", "0.2.0"), undefined);
});

test("择优（规则 V2）：组内取 semver 最高者", () => {
  assert.equal(
    selectBestOfficialPluginVersionDirName(["0.2.0", "0.3.0", "0.10.0"]),
    "0.10.0",
    "0.10.0 > 0.9.0 数值序，多版本取最高",
  );
  assert.equal(selectBestOfficialPluginVersionDirName(["0.2.0", "0.3.0"]), "0.3.0");
  assert.equal(selectBestOfficialPluginVersionDirName(["1.9.0", "1.10.0"]), "1.10.0");
  assert.equal(selectBestOfficialPluginVersionDirName(["0.3.0"]), "0.3.0");
});

test("择优：同版本并列取目录名字典序较大者（两管线对同一磁盘状态输出确定且一致）", () => {
  assert.equal(
    selectBestOfficialPluginVersionDirName(["1.2.3", "v1.2.3"]),
    "v1.2.3",
    "coerce 后同版本，字典序 v1.2.3 > 1.2.3",
  );
  assert.equal(
    selectBestOfficialPluginVersionDirName(["v1.2.3", "1.2.3"]),
    "v1.2.3",
    "输入顺序无关",
  );
  assert.equal(
    selectBestOfficialPluginVersionDirName(["0.2", "0.2.0"]),
    "0.2.0",
    "缺段补 0 并列时取字典序较大者",
  );
});

test("择优：不可解析目录名不产出候选根；全不可解析（含空数组）→ undefined", () => {
  assert.equal(
    selectBestOfficialPluginVersionDirName(["0.2.0", ".backup-0.9.9", ".tmp-1", ".seed-lock"]),
    "0.2.0",
    "干扰项不得当选",
  );
  assert.equal(selectBestOfficialPluginVersionDirName([]), undefined);
  assert.equal(selectBestOfficialPluginVersionDirName([".backup", ".tmp-1"]), undefined);
});
