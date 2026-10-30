/* off-peak 仓库的 sqlite 打开点：createRequire("node:sqlite") 集中在本叶子，
   其余 off-peak 叶子与本体只经这里取句柄类型与打开函数，Node-only 边不扩散。
   与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
export type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 打开（必要时先建目录）tasks-index 库文件并套用与 automation 一致的 PRAGMA。 */
export async function openOffPeakTasksDatabase(
  path: string,
  startupBusyTimeoutMs: number,
): Promise<DatabaseSyncInstance> {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${startupBusyTimeoutMs}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}
