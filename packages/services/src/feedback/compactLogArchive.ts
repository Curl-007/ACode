import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAppConfigDir, getFeedbackLogArchiveDir } from "../paths.js";
import { createFeedbackDiagnosticArchive } from "./feedbackLogArchive.js";
import { confinePath } from "#src/fs/pathConfinement.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const feedbackArchiveLogger = createServiceLogger("feedback");

interface ArchiveProgressEvent {
  processedBytes: number;
  totalBytes: number;
}

export async function prepareCompactLogArchive(options?: {
  full?: boolean;
  createFullArchive?: (
    sourceDir: string,
    options?: { onProgress?: (event: ArchiveProgressEvent) => void },
  ) => Promise<{ path: string; size: number }>;
  onProgress?: (event: ArchiveProgressEvent) => void;
}): Promise<{ path: string; size: number }> {
  const sourceDir = getAppConfigDir();
  if (options?.full && options.createFullArchive) {
    return options.createFullArchive(sourceDir, { onProgress: options.onProgress });
  }
  return createFeedbackDiagnosticArchive({
    sources: [{ directory: join(sourceDir, "logs"), archivePrefix: "logs" }],
    outputRootDir: getFeedbackLogArchiveDir(),
    ...(!options?.full ? { maxTotalBytes: 2 * 1024 * 1024 } : {}),
    onProgress: options?.onProgress,
  });
}

export async function cleanupLogArchive(path: string): Promise<void> {
  // 根因（H3）：path 来自 RPC 裸 string（cleanupPreparedLogArchive 原样透传，rpc 层无
  // schema 校验），原实现直接 rm(join(path,".."),{recursive:true,force:true}) 且吞异常，
  // 被攻破的客户端传 `<任意目录>\x` 即可递归删除任意目录整树。
  // 修复：清理目标（归档文件的父目录）必须严格位于 getFeedbackLogArchiveDir() 受控根内，
  // realpath 规范化后比较（与 skillsService.deleteSkill 的受控根白名单同一纪律）；
  // 越界拒绝并记录 warn（fail-closed）；目标已不存在时保持幂等 no-op（与原 force:true
  // 的 ENOENT-as-success 语义一致）。
  // 依据：packages/services/specs/service-fs-path-confinement.md R1。
  const trimmedPath = path?.trim() ?? "";
  const archiveRoot = getFeedbackLogArchiveDir();
  const confined = await confinePath({
    target: trimmedPath ? resolve(trimmedPath, "..") : "",
    roots: [archiveRoot],
  });
  if (confined.status === "outside") {
    feedbackArchiveLogger.warn(undefined, "拒绝清理越界的反馈日志归档路径", {
      archiveRoot,
      path,
    });
    throw new Error("Feedback log archive path is outside the managed archive directory");
  }
  if (confined.status === "absent") {
    return;
  }
  await rm(confined.path, { recursive: true, force: true }).catch(() => {});
}
