// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// locate 层（R2 三层结构的 IO 层）：只做 IO —— 给出各来源的候选路径，并把原始内容
// （文本 / 数据库行）读出来。文件不存在返回空（没装这个工具不是问题）；其它读错误向上抛，
// 由 scan 记成该来源的 warning。**绝不打开活库**：cc-switch 一律复制 db + -wal 到临时目录后
// 以只读方式打开副本（-shm 不复制），finally 关库并删临时目录。
import { mkdtemp, readFile, rm, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderImportSource } from "./providerImportTypes.js";
import { MAX_DB_COPY_BYTES, MAX_FILE_TEXT_BYTES } from "./providerImportTypes.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

export interface ProviderImportSourceLocation {
  readonly source: ProviderImportSource;
  /** 候选路径（按来源顺序）；UI 只展示静态 `~` 形式标签，实际路径由本层定位。 */
  readonly paths: readonly string[];
}

export interface ProviderImportTextRead {
  readonly text: string | null;
  /** 超过 maxBytes 时为 true（调用方记 file-too-large 并跳过该文件）。 */
  readonly tooLarge: boolean;
}

export interface ProviderImportDbRead {
  readonly rows: readonly Record<string, unknown>[];
  readonly tooLarge: boolean;
}

/** scan 的 IO 端口；可注入以便测试零读取断言（未勾选来源不得触发任何 readTextFile）。 */
export interface ProviderImportScanIo {
  readTextFile(path: string, maxBytes: number): Promise<ProviderImportTextRead>;
  readCcSwitchRows(
    dbPath: string,
    maxBytes: number,
    tempRoot?: string,
  ): Promise<ProviderImportDbRead>;
}

/** 三家来源的候选路径（home 可注入；顺序即指纹去重优先级）。 */
export function locateProviderImportSources(home: string): readonly ProviderImportSourceLocation[] {
  const root = home.trim() || ".";
  return [
    { source: "claude-code", paths: [join(root, ".claude", "settings.json")] },
    {
      source: "codex",
      paths: [join(root, ".codex", "config.toml"), join(root, ".codex", "auth.json")],
    },
    { source: "cc-switch", paths: [join(root, ".cc-switch", "cc-switch.db")] },
  ];
}

/** 默认 IO 实现（真实文件系统 + node:sqlite 只读副本）。 */
export function createProviderImportScanIo(): ProviderImportScanIo {
  return { readTextFile: readTextIfExists, readCcSwitchRows };
}

/** 读文本（去 BOM）；文件不存在/不是普通文件返回 {text:null}；超限返回 tooLarge。 */
export async function readTextIfExists(
  filePath: string,
  maxBytes: number = MAX_FILE_TEXT_BYTES,
): Promise<ProviderImportTextRead> {
  const info = await statIfExists(filePath);
  if (!info || !info.isFile()) return { text: null, tooLarge: false };
  if (Number(info.size) > maxBytes) return { text: null, tooLarge: true };
  const raw = await readFile(filePath, "utf8");
  return { text: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw, tooLarge: false };
}

/**
 * 复制 `cc-switch.db`（存在时连 `-wal`）到临时目录后只读打开副本，读指定表全表。
 * - **绝不打开活库**：副本是唯一被打开的文件；
 * - 不复制 `-shm`（共享内存索引，复制无意义且可能破坏只读语义）；
 * - `node:sqlite` 动态导入（Node 24+ 内建，不新增依赖）；同步 `DatabaseSync` 只在短时读副本内使用；
 * - `finally` 关库 + 删临时目录（删失败只告警，不影响已读结果）。
 * - `table` 缺省 `providers`（provider 导入）；settings-sync 的 MCP 导入复用本函数读 `mcp_servers`
 *   （R7.1「与 provider 侧同一 readCcSwitchRows 机制」）。表名只接受标识符字面量，拒绝拼接注入。
 */
export async function readCcSwitchRows(
  dbPath: string,
  maxBytes: number = MAX_DB_COPY_BYTES,
  tempRoot?: string,
  table: string = "providers",
): Promise<ProviderImportDbRead> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`非法 cc-switch 表名: ${table}`);
  }
  const info = await statIfExists(dbPath);
  if (!info || !info.isFile()) return { rows: [], tooLarge: false };
  const walPath = `${dbPath}-wal`;
  // stat.size 在 @types/node 里是 number | bigint；统一转 number 再做算数与比较。
  const walSize = Number((await statIfExists(walPath))?.size ?? 0);
  if (Number(info.size) + walSize > maxBytes) return { rows: [], tooLarge: true };

  const workDir = await mkdtemp(join(tempRoot ?? tmpdir(), "acode-provider-import-"));
  const copyPath = join(workDir, "cc-switch.db");
  try {
    await copyFile(dbPath, copyPath);
    if (await statIfExists(walPath)) await copyFile(walPath, `${copyPath}-wal`);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(copyPath, { readOnly: true });
    try {
      if (!hasTable(db, table)) return { rows: [], tooLarge: false };
      return { rows: db.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })), tooLarge: false };
    } finally {
      db.close();
    }
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      // 清理失败不改变已读结果；只告警（spec R2/R9）。
      createServiceLogger("provider-import").warn(undefined, "临时副本清理失败", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined && row !== null;
}

async function statIfExists(filePath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}