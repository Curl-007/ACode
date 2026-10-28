// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。制品下载传输层（多候选回退、
// 响应体落盘、节流进度日志）独立成叶；进度常量随 types 叶保留。
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  REMOTE_ASSET_PROGRESS_INTERVAL_MS,
  REMOTE_ASSET_PROGRESS_PERCENT_STEP,
  type RemoteAssetCacheLoggers,
} from "@acode/server/remote/remoteAssetCacheTypes.js";

export async function fetchFirstAvailableUrl(
  candidates: string[],
  fileLabel: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ response: Response; url: string }> {
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate);
      if (response.ok) {
        return { response, url: candidate };
      }
      errors.push(`${candidate} -> HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  throw new Error(`[remote-assets] failed to fetch ${fileLabel}: ${errors.join("; ")}`);
}

export async function writeResponseBodyToFile(
  response: Response,
  targetPath: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  if (!response.body) {
    throw new Error("response body is empty");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath, { flags: "w" });
  const reportProgress = createRemoteAssetProgressReporter(
    parseContentLength(response.headers.get("content-length")),
    loggers,
  );
  let transferredBytes = 0;

  const byteMeter = new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      reportProgress(transferredBytes, false);
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream), byteMeter, output);
  reportProgress(transferredBytes, true);
}

function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }

  const parsed = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function createRemoteAssetProgressReporter(
  totalBytes: number | null,
  loggers: RemoteAssetCacheLoggers | undefined,
): (transferredBytes: number, force: boolean) => void {
  const startedAt = Date.now();
  let lastLoggedAt = 0;
  let lastLoggedPercent = 0;
  let lastLoggedTransferredBytes = -1;

  return (transferredBytes: number, force: boolean) => {
    if (!loggers) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001);
    const speedMBPerSecond = bytesToMB(transferredBytes) / elapsedSeconds;
    const transferredMB = bytesToMB(transferredBytes);
    const totalMB = totalBytes ? bytesToMB(totalBytes) : null;
    const percent = totalBytes ? Math.min((transferredBytes / totalBytes) * 100, 100) : null;

    const byInterval = now - lastLoggedAt >= REMOTE_ASSET_PROGRESS_INTERVAL_MS;
    const byPercent =
      percent != null && percent - lastLoggedPercent >= REMOTE_ASSET_PROGRESS_PERCENT_STEP;
    const reachedEnd = percent != null && percent >= 100;

    if (!force && !byInterval && !byPercent && !reachedEnd) {
      return;
    }
    if (
      force &&
      transferredBytes === lastLoggedTransferredBytes &&
      (percent == null || percent <= lastLoggedPercent)
    ) {
      return;
    }

    // 之前生产态下载阶段只打印 "downloading URL"，慢网用户无法判断是否卡死。
    // 这里改成输出节流后的进度快照（百分比/MB/速度），让 SSH 连接日志可观测下载进展。
    if (totalMB != null && percent != null) {
      loggers.log(
        `[remote-assets] download progress: ${percent.toFixed(1)}% (${transferredMB.toFixed(1)}/${totalMB.toFixed(1)} MB, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    } else {
      loggers.log(
        `[remote-assets] download progress: ${transferredMB.toFixed(1)} MB (total unknown, ${speedMBPerSecond.toFixed(2)} MB/s)`,
      );
    }

    lastLoggedAt = now;
    lastLoggedTransferredBytes = transferredBytes;
    if (percent != null) {
      lastLoggedPercent = percent;
    }
  };
}

function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}
