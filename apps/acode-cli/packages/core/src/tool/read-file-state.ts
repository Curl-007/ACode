// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeReadStatePathKey } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  // 用 read-state 专用归一化（win32 折叠大小写）：Windows FS 大小写不敏感，
  // 同一文件的不同拼写必须落到同一条键，否则 Read 记录与 Edit 查找分裂 →
  // 误报 FILE_NOT_READ（见 path-normalization.ts normalizeReadStatePathKey 注释）。
  return normalizeReadStatePathKey(filePath, platform);
}

export function createReadFileStateKey(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return [
    createReadFileStatePathKey(filePath, platform),
    String(offset ?? 1),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

export function findEditableReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return findLatestReadFileState(readFileState, filePath, platform);
}

export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  // 优先返回 full Read 会让 Bash/formatter 改完文件后即使模型按提示重新
  // range Read，Edit/Write 仍拿旧 full Read 做 mtime 校验并持续误报 stale。这里按
  // 单文件最新 read-state 语义选择基准；真正的 partial view 由消费者单独拒绝。
  return findLatestReadFileStateByPath(readFileState, filePath, platform, () => true);
}

export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}

function findLatestReadFileStateByPath(
  readFileState: ReadFileStateMap,
  filePath: string,
  platform: ReadFileStatePlatform,
  accepts: (entry: ReadFileStateEntry) => boolean,
): ReadFileStateEntry | undefined {
  const pathKey = createReadFileStatePathKey(filePath, platform);
  let latest: ReadFileStateEntry | undefined;
  let latestReadAt = Number.NEGATIVE_INFINITY;
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (!accepts(entry)) continue;
    const readAt = entry.readAt.getTime();
    if (readAt < latestReadAt) continue;
    latest = entry;
    latestReadAt = readAt;
  }
  return latest;
}
