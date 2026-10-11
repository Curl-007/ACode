import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getACodeDataRootDir } from "@acode/services/node";
import { PlatformChannels } from "@acode/shared";
import type { PlatformChannelMap } from "@acode/shared";

/**
 * 物化载荷类型定义在 shared/platform.ts 但未从 @acode/shared 入口再导出；
 * 经由已导出的 PlatformChannelMap 对同名通道索引派生（desktopMainIpcPlatform.ts 先例）。
 */
export type MaterializeWorkflowArtifactFilePayload =
  PlatformChannelMap[(typeof PlatformChannels)["MaterializeWorkflowArtifactFile"]]["request"];

/**
 * workflow artifact 物化（specs/workflow-artifact-materialization.md）。
 *
 * renderer 持字节下沉模型：权威在 journal，renderer 本来就要为预览分块读字节；
 * main 侧无状态、无缓存职责，只负责校验 + 一次性落盘目录 + 原子写 + 幂等。
 *
 * 落盘根：<data root>/tmp/workflow-artifacts（与 tempTextAttachment 的
 * <data root>/tmp/paste-attachments 同一 tmp 约定；spec 字面写 userData，
 * 仓库现实的 tmp 约定在 data root 下，且跟随用户自定义 dataBaseDir，偏差已在交接报告说明）。
 */

/** 单次物化上限 20 MiB（与 PROTOCOL_V4_LIMITS.attachmentMaxBytes 同一量级）。 */
export const WORKFLOW_ARTIFACT_MATERIALIZATION_MAX_BYTES = 20 * 1024 * 1024;

/** 路径段（runId/artifactId）清洗后的长度上限。 */
const WORKFLOW_ARTIFACT_SEGMENT_MAX_LENGTH = 64;

/** 文件名清洗后的长度上限（与 desktopSaveFile 的 suggestedName 同档）。 */
const WORKFLOW_ARTIFACT_FILE_NAME_MAX_LENGTH = 120;

/** Windows 保留设备名（大小写不敏感）；命中加前缀 `_`。 */
const WINDOWS_RESERVED_FILE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/**
 * id 路径段清洗：路径不安全字符替换为 `-`；原 id 含被替换字符时追加短哈希
 * （防碰撞：`a/b` 与 `a-b` 不得落进同一段；防穿越：`..`/分隔符全部被替换）。
 */
export function sanitizeWorkflowArtifactPathSegment(id: string): string {
  const sanitized = id
    .replaceAll("\0", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^\.+/u, "")
    .replace(/[.]+$/u, "");
  const changed = sanitized !== id;
  const fallback = sanitized.length > 0 ? sanitized : "artifact";
  const segment = changed || sanitized.length === 0 ? `${fallback}-${shortHash(id)}` : fallback;
  return segment.slice(0, WORKFLOW_ARTIFACT_SEGMENT_MAX_LENGTH);
}

/** 文件名清洗：去路径分隔符、控制字符、首尾空白点；Windows 保留名加前缀 `_`；空结果回退 `<artifactId>.bin`。 */
export function sanitizeWorkflowArtifactFileName(
  fileName: string,
  fallbackArtifactId: string,
): string {
  const normalized = fileName
    .replaceAll("\0", "-")
    .replace(/[\\/:]/gu, "-")
    // 控制字符（含换行/制表）在文件名里既不可显示也不可移植。
    // eslint-disable-next-line no-control-regex -- 该正则的目的就是剥离控制字符本身。
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    // 首尾空白点一律剥离：Windows 段名以点/空格结尾会静默丢后缀，首部点也只是视觉噪音。
    .replace(/^[.\s]+/u, "")
    .replace(/[.\s]+$/u, "");
  const bounded = normalized
    .slice(0, WORKFLOW_ARTIFACT_FILE_NAME_MAX_LENGTH)
    .replace(/[.\s]+$/u, "");
  if (bounded.length === 0) {
    const stem = sanitizeWorkflowArtifactPathSegment(fallbackArtifactId);
    return `${stem}.bin`;
  }
  // 保留名判定看首个点之前的 stem：`CON.txt`、`Con`、`con.tar.gz` 都命中（大小写不敏感）。
  const stem = bounded.split(".")[0] ?? "";
  return WINDOWS_RESERVED_FILE_NAMES.has(stem.toLowerCase()) ? `_${bounded}` : bounded;
}

/** 纯路径解析（单测直接消费）：目录 + 清洗后的最终文件名。 */
export function resolveWorkflowArtifactMaterializationPaths(input: {
  rootDir: string;
  runId: string;
  artifactId: string;
  version: number;
  fileName: string;
}): { directory: string; fileName: string; filePath: string } {
  const fileName = sanitizeWorkflowArtifactFileName(input.fileName, input.artifactId);
  const directory = join(
    input.rootDir,
    sanitizeWorkflowArtifactPathSegment(input.runId),
    sanitizeWorkflowArtifactPathSegment(input.artifactId),
    // version 由调用方校验为正整数，`v<数字>` 天然不含路径不安全字符。
    `v${input.version}`,
  );
  return { directory, fileName, filePath: join(directory, fileName) };
}

export type WorkflowArtifactMaterializationResult =
  | { localPath: string }
  | { error: "invalid_payload" | "too_large" | "write_failed" };

/**
 * 物化落盘：原子写（同目录 `.<uuid>.partial` + rename）；目标已存在且同字节 → 直接返回
 * （幂等），不同字节 → 先删再 rename（同一版本物化两次视为同内容，覆盖语义安全）。
 */
export async function materializeWorkflowArtifactFile(
  payload: MaterializeWorkflowArtifactFilePayload,
  options: { rootDir?: string; fs?: WorkflowArtifactMaterializationFs } = {},
): Promise<WorkflowArtifactMaterializationResult> {
  if (
    !payload ||
    typeof payload.runId !== "string" ||
    payload.runId.trim().length === 0 ||
    typeof payload.artifactId !== "string" ||
    payload.artifactId.trim().length === 0 ||
    typeof payload.fileName !== "string" ||
    !Number.isInteger(payload.version) ||
    payload.version <= 0
  ) {
    return { error: "invalid_payload" };
  }
  // 结构化克隆直传字节：Buffer 是 Uint8Array 子类，两种到达形态都接受。
  if (!(payload.data instanceof Uint8Array)) {
    return { error: "invalid_payload" };
  }
  if (payload.data.byteLength > WORKFLOW_ARTIFACT_MATERIALIZATION_MAX_BYTES) {
    // 超限直接拒绝且不写任何文件（spec 验收 3）。
    return { error: "too_large" };
  }

  const fs = options.fs ?? { mkdir, readFile, writeFile, rename, unlink, rm };
  const rootDir = options.rootDir ?? join(getACodeDataRootDir(), "tmp", "workflow-artifacts");
  const { directory, filePath } = resolveWorkflowArtifactMaterializationPaths({
    rootDir,
    runId: payload.runId,
    artifactId: payload.artifactId,
    version: payload.version,
    fileName: payload.fileName,
  });

  try {
    const data = payload.data;
    try {
      const existing = await fs.readFile(filePath);
      if (existing.byteLength === data.byteLength && existing.equals(data)) {
        // 幂等：同一版本重复物化直接返回同一路径，不再触碰磁盘。
        return { localPath: filePath };
      }
      await fs.rm(filePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(directory, { recursive: true });
    const partialPath = join(directory, `.${randomUUID()}.partial`);
    try {
      // flag "wx"：占位文件名碰撞（同目录并发物化）直接失败而不是互相覆盖。
      await fs.writeFile(partialPath, data, { flag: "wx" });
      await fs.rename(partialPath, filePath);
    } catch (error) {
      await fs.unlink(partialPath).catch(() => undefined);
      throw error;
    }
    return { localPath: filePath };
  } catch {
    // 错误细节只进 registrar 的 warn 日志，不进 renderer 返回值（避免把本地路径语义泄给任意 renderer）。
    return { error: "write_failed" };
  }
}

/** 为单测注入 fs 桩；生产缺省走 node:fs/promises。 */
export interface WorkflowArtifactMaterializationFs {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
  rm: typeof rm;
}

/** registrar：挂 desktopMainIpcPlatform.ts 既有挂载点。 */
export function registerDesktopWorkflowArtifactIpcHandlers(logger: {
  warn: (...args: unknown[]) => void;
}): void {
  ipcMain.handle(
    PlatformChannels.MaterializeWorkflowArtifactFile,
    async (
      _event,
      payload: MaterializeWorkflowArtifactFilePayload,
    ): Promise<WorkflowArtifactMaterializationResult> => {
      const result = await materializeWorkflowArtifactFile(payload);
      if ("error" in result && result.error === "write_failed") {
        logger.warn("[workflow-artifact] materialize failed", {
          runId: payload?.runId,
          artifactId: payload?.artifactId,
          version: payload?.version,
        });
      }
      return result;
    },
  );
}
