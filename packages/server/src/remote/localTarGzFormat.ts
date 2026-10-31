// 拆分依据：localTarGz.ts 超 400 行架构上限。tar 二进制格式编解码（头构造/校验和/八进制字段/块对齐）
// 是纯格式逻辑，与归档的解包/打包流程无关，独立成叶子便于单测与复用。

export const TAR_BLOCK_SIZE = 512;
export const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

export function createTarHeader(options: {
  entryPath: string;
  linkName?: string;
  mode: number;
  mtimeSeconds: number;
  size: number;
  typeFlag: "0" | "2" | "5";
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarEntryPath(options.entryPath);

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode & 0o777, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.size, 124, 12);
  writeTarOctal(header, options.mtimeSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  writeTarString(header, options.typeFlag, 156, 1);
  if (options.linkName) {
    if (Buffer.byteLength(options.linkName) > 100) {
      throw new Error(`[remote-assets] tar symlink target is too long: ${options.linkName}`);
    }
    writeTarString(header, options.linkName, 157, 100);
  }
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "acode", 265, 32);
  writeTarString(header, "acode", 297, 32);
  writeTarString(header, prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarChecksum(header, checksum);
  return header;
}

function splitTarEntryPath(entryPath: string): { name: string; prefix: string } {
  const encodedLength = Buffer.byteLength(entryPath);
  if (encodedLength <= 100) {
    return { name: entryPath, prefix: "" };
  }

  const segments = entryPath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`[remote-assets] tar entry path is too long: ${entryPath}`);
}

export function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

export function readTarTypeFlag(header: Buffer): string {
  const value = header[156] ?? 0;
  return value === 0 ? "0" : String.fromCharCode(value);
}

export function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, length, "utf8");
}

export function parseTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0");
  writeTarString(buffer, encoded.slice(-(length - 1)), offset, length - 1);
}

function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, "0").slice(-6);
  writeTarString(buffer, encoded, 148, 6);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

export function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

export function roundUpToTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}
