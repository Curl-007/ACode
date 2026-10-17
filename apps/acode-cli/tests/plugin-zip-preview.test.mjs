// 预览不解包守护测试（价值提取第二轮 T1-m3 增量层）。
// 规格：apps/acode-cli/specs/file-containment-trust-tiers.md R2。
import assert from "node:assert/strict";
import test from "node:test";
import { buildZip } from "./helpers/build-zip.mjs";

const {
  readZipPluginArchivePreview,
  ZIP_PREVIEW_ICON_MAX_BYTES,
} = await import("../packages/adapters/src/plugins/zip-preview.ts");

const MANIFEST_NAME = "manifest.json";

test("预览：只取 manifest 与档内 icon，其余条目不解包", async () => {
  const iconBytes = Buffer.from("fake-png-bytes");
  const zipBuffer = buildZip([
    { data: Buffer.from(JSON.stringify({ icon: "assets/icon.png", name: "demo" })), name: MANIFEST_NAME },
    { data: iconBytes, name: "assets/icon.png" },
    { data: Buffer.alloc(2 * 1024 * 1024, 7), name: "payload/big.bin" },
  ]);
  const preview = await readZipPluginArchivePreview(zipBuffer);
  assert.ok(preview.manifestBytes !== null);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(preview.manifestBytes)), {
    icon: "assets/icon.png",
    name: "demo",
  });
  assert.ok(preview.iconBytes !== null);
  assert.deepEqual(Buffer.from(preview.iconBytes), iconBytes);
});

test("预览：icon 为远程 URL 时置 null（不发网络请求）", async () => {
  const zipBuffer = buildZip([
    { data: Buffer.from(JSON.stringify({ icon: "https://evil.example/x.png" })), name: MANIFEST_NAME },
  ]);
  const preview = await readZipPluginArchivePreview(zipBuffer);
  assert.ok(preview.manifestBytes !== null);
  assert.equal(preview.iconBytes, null);
});

test("预览：无 manifest / manifest 解析失败 → 双 null（尽力而为面不抛错）", async () => {
  const noManifest = await readZipPluginArchivePreview(
    buildZip([{ data: Buffer.from("x"), name: "other.txt" }]),
  );
  assert.equal(noManifest.manifestBytes, null);
  assert.equal(noManifest.iconBytes, null);

  const brokenManifest = await readZipPluginArchivePreview(
    buildZip([{ data: Buffer.from("not-json{{"), name: MANIFEST_NAME }]),
  );
  assert.ok(brokenManifest.manifestBytes !== null, "manifest 字节仍返回，解析失败只影响 icon");
  assert.equal(brokenManifest.iconBytes, null);
});

test("预览：icon 超 1MB 上限或指向目录 → null", async () => {
  const oversized = buildZip([
    { data: Buffer.from(JSON.stringify({ icon: "assets/huge.png" })), name: MANIFEST_NAME },
    { data: Buffer.alloc(ZIP_PREVIEW_ICON_MAX_BYTES + 1, 1), name: "assets/huge.png" },
  ]);
  const preview = await readZipPluginArchivePreview(oversized);
  assert.ok(preview.manifestBytes !== null);
  assert.equal(preview.iconBytes, null);

  const directoryIcon = buildZip([
    { data: Buffer.from(JSON.stringify({ icon: "assets/" })), name: MANIFEST_NAME },
    { name: "assets/" },
  ]);
  const directoryPreview = await readZipPluginArchivePreview(directoryIcon);
  assert.equal(directoryPreview.iconBytes, null);
});

test("预览：条目名策略违规（段内冒号 ADS 形）fail-closed 抛错", async () => {
  // ".." 与反斜杠形态会被 yauzl 解码层先处理（拒绝/归一）；段内冒号是解码层放行、
  // 会话拒绝的形态：win32 词法闸命中 unsafe_path，POSIX 由碰撞预检命中
  // name_collision（":" 一律拒）——两平台都以 ArchivePolicyViolationError 失败。
  const zipBuffer = buildZip([
    { data: Buffer.from("{}"), name: MANIFEST_NAME },
    { data: Buffer.from("x"), name: "ads/stream:x" },
  ]);
  await assert.rejects(
    () => readZipPluginArchivePreview(zipBuffer),
    (error) => {
      assert.equal(error.name, "ArchivePolicyViolationError");
      assert.ok(
        error.reason === "unsafe_path" || error.reason === "name_collision",
        `意外 reason: ${error.reason}`,
      );
      return true;
    },
  );
});
