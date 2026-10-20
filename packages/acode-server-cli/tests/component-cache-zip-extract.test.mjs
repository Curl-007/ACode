import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extractArchiveSafely } = await import("../src/runtime/componentCache.ts");

// 最小 zip 构造器：本地头 + raw deflate/stored 数据 + 中央目录 + EOCD。
// 不可压缩随机数据的 deflate 条目是 yauzl fd 流式路径挂起的最小复现形
// （上游 ZCodium #29；本仓改 fromBuffer 内存解压，见 specs/component-archive-extraction.md）。
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

async function extractZip(entries) {
  const dir = await mkdtemp(join(tmpdir(), "component-zip-"));
  try {
    const zipPath = join(dir, "component.zip");
    await writeFile(zipPath, buildZip(entries));
    const dest = join(dir, "out");
    await mkdir(dest, { recursive: true });
    await extractArchiveSafely(zipPath, dest);
    return { dir, dest };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test(
  "不可压缩随机数据的 deflate 条目在时限内完整解出（yauzl fd 挂起回归）",
  { timeout: 20_000 },
  async () => {
    const data = randomBytes(512 * 1024);
    const { dest } = await extractZip([{ name: "payload.bin", data }]);
    const extracted = await readFile(join(dest, "payload.bin"));
    assert.ok(extracted.equals(data), "解出字节必须与原始数据一致");
  },
);

test("多条目、嵌套目录与 stored 条目解包，普通文件 mode 0600", async () => {
  const nested = Buffer.from("nested-content", "utf8");
  const stored = Buffer.from("stored-content", "utf8");
  const { dest } = await extractZip([
    { name: "dir/", data: Buffer.alloc(0), method: 0 },
    { name: "dir/nested.txt", data: nested },
    { name: "stored.txt", data: stored, method: 0 },
  ]);
  assert.equal(await readFile(join(dest, "dir/nested.txt"), "utf8"), nested.toString("utf8"));
  assert.equal(await readFile(join(dest, "stored.txt"), "utf8"), stored.toString("utf8"));
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises");
    const mode = (await stat(join(dest, "stored.txt"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("重复条目拒绝", async () => {
  const data = Buffer.from("x", "utf8");
  await assert.rejects(
    extractZip([
      { name: "dup.txt", data },
      { name: "dup.txt", data },
    ]),
    /duplicate entry/iu,
  );
});

test("符号链接条目拒绝", async () => {
  await assert.rejects(
    extractZip([
      { name: "link.txt", data: Buffer.from("target", "utf8"), unixMode: 0o120777 },
    ]),
    /symbolic link/iu,
  );
});

test("路径穿越条目拒绝", async () => {
  await assert.rejects(
    extractZip([{ name: "../evil.txt", data: Buffer.from("evil", "utf8") }]),
    /unsafe component path|invalid|\.\./iu,
  );
});
