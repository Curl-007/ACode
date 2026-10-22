import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * ACode builtin release 编解码 + 配置物化守护（review 测试专项 P2：provider-node 覆盖偏薄，
 * 「builtin 配置物化」几乎裸奔）。
 *
 * 覆盖：
 * - decodeACodeBuiltinRelease / serializeACodeBuiltinRelease 往返一致；schemaVersion、
 *   revision 校验；已退出的 ZAPI provider 拒绝（防止旧 Release 复活下线供应商）。
 * - materializeACodeBuiltinProviderConfig：真临时目录落盘到 runtime/provider/bundled/，
 *   幂等（同内容不重写文件，mtime 稳定），内容为规范化 release。
 *
 * 用真文件系统 + mkdtemp（仓内既有范式，见 byo-apikey-credential-ref.test.mjs），t.after 清理。
 */
const release = await import("../src/acode-builtin-release.ts");
const { materializeACodeBuiltinProviderConfig } = await import(
  "../src/acode-builtin-provider-config-materializer.ts"
);
const { ModelConfigRules, ProviderConfigMap, ProviderTemplateMap } = await import(
  "../../provider/src/index.ts"
);

/** 用空领域规则构造一份合法 wire-form release（避免手搓 schema 漂移）。 */
function emptyReleaseWire(revision) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        templateRules: ProviderTemplateMap.empty().toJSON(),
        providerRules: new ProviderConfigMap([]).toJSON(),
      },
      modelConfigRules: ModelConfigRules.empty().toACodeBuiltinJSON(),
    },
  };
}

test("decode/serialize 往返一致，revision 保留", () => {
  const decoded = release.decodeACodeBuiltinRelease(emptyReleaseWire(9));
  assert.equal(decoded.revision, 9);
  assert.equal(decoded.schemaVersion, release.ACODE_BUILTIN_RELEASE_SCHEMA_VERSION);
  const round = JSON.parse(release.serializeACodeBuiltinRelease(decoded));
  assert.equal(round.revision, 9);
  assert.equal(round.schemaVersion, 1);
  // 再解码序列化产物必须与原对象等价（幂等编解码）。
  const redecoded = release.decodeACodeBuiltinRelease(round);
  assert.equal(redecoded.revision, decoded.revision);
  assert.equal(
    release.serializeACodeBuiltinRelease(redecoded),
    release.serializeACodeBuiltinRelease(decoded),
    "往返序列化必须逐字节一致",
  );
});

test("schema 校验：错误 schemaVersion / 负 revision / 缺失字段被拒", () => {
  assert.throws(
    () => release.decodeACodeBuiltinRelease({ ...emptyReleaseWire(1), schemaVersion: 2 }),
    /schemaVersion|invalid/i,
    "错误 schemaVersion 必须拒绝",
  );
  assert.throws(
    () => release.decodeACodeBuiltinRelease({ ...emptyReleaseWire(-1) }),
    /revision|Number|int/i,
    "负 revision 必须拒绝",
  );
  assert.throws(
    () => release.decodeACodeBuiltinRelease({ schemaVersion: 1, revision: 1 }),
    /config|required|invalid/i,
    "缺失 config 必须拒绝",
  );
});

test("materializeACodeBuiltinProviderConfig 落盘到 runtime/provider/bundled 且幂等", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-materialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = release.serializeACodeBuiltinRelease(release.decodeACodeBuiltinRelease(emptyReleaseWire(42)));
  const filePath = await materializeACodeBuiltinProviderConfig({
    environmentConfigRoot: root,
    content,
  });
  // 路径形状：<root>/runtime/provider/bundled/acode-builtin.json（分隔符跨平台，用 endsWith 判尾）。
  assert.ok(filePath.endsWith(join("runtime", "provider", "bundled", "acode-builtin.json")), filePath);
  assert.ok(filePath.startsWith(root), "必须落在环境根目录内");

  const onDisk = await readFile(filePath, "utf8");
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.revision, 42, "落盘内容必须是规范化 release");
  assert.ok(onDisk.endsWith("\n"), "物化文件以换行结尾（与 materializer 约定一致）");

  const mtimeBefore = (await stat(filePath)).mtimeMs;
  // 幂等：同内容再物化不得重写文件（否则每次启动都触发磁盘写，制造 mtime 抖动与写放大）。
  await materializeACodeBuiltinProviderConfig({ environmentConfigRoot: root, content });
  const mtimeAfter = (await stat(filePath)).mtimeMs;
  assert.equal(mtimeAfter, mtimeBefore, "同内容重复物化必须跳过写入（mtime 稳定）");
});

test("materialize 内容变化时覆盖写入（幂等只对相同内容成立）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-materialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = release.serializeACodeBuiltinRelease(release.decodeACodeBuiltinRelease(emptyReleaseWire(1)));
  const second = release.serializeACodeBuiltinRelease(release.decodeACodeBuiltinRelease(emptyReleaseWire(2)));
  const filePath = await materializeACodeBuiltinProviderConfig({ environmentConfigRoot: root, content: first });
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).revision, 1);
  await materializeACodeBuiltinProviderConfig({ environmentConfigRoot: root, content: second });
  assert.equal(
    JSON.parse(await readFile(filePath, "utf8")).revision,
    2,
    "内容变化必须覆盖旧 release",
  );
});
