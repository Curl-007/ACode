// 多条目 zip 构造器（测试专用）：stored/deflate 两种 method、可指定 unix mode，
// 生成含合法 CRC32 与 central directory 的最小 zip，供 yauzl 消费。
// 仅供 apps/acode-cli/tests/*.test.mjs 使用（test 脚本只挑 *.test.mjs，本文件不会
// 被当成用例执行）。
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = new Int32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value;
}

function crc32(data) {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

const REGULAR_FILE_MODE = 0o100644;
const DIRECTORY_MODE = 0o40755;

/**
 * @param {Array<{name: string, data?: Buffer, method?: 0|8, unixMode?: number, declaredUncompressedSize?: number}>} entries
 * @returns {Buffer} zip 字节
 */
export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith("/");
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const unixMode = entry.unixMode ?? (isDirectory ? DIRECTORY_MODE : REGULAR_FILE_MODE);
    const crc = crc32(data);
    // 声明尺寸可与实际数据不符（单文件上限闸的"谎报 manifest"用例）；
    // 这类条目必须在读取数据流之前被策略闸拒绝。
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by：unix host（mode 经高 16 位传递）
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // JS 位运算产出有符号 int32：0o100644 << 16 会变负数，>>> 0 归一回无符号。
    central.writeUInt32LE(((unixMode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + stored.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(0, 4);
  endOfCentral.writeUInt16LE(0, 6);
  endOfCentral.writeUInt16LE(entries.length, 8);
  endOfCentral.writeUInt16LE(entries.length, 10);
  endOfCentral.writeUInt32LE(centralDirectory.length, 12);
  endOfCentral.writeUInt32LE(offset, 16);
  endOfCentral.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endOfCentral]);
}
