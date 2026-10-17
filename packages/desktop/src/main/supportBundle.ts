/**
 * 分节支持包导出编排（specs/log-privacy-redaction.md desktop R8-R14）。
 *
 * 流程：前置清扫陈旧 tmp → 构建上下文 → 按 appliesIn/defaultChecked/用户勾选
 * 过滤节 → 逐节 collect（失败隔离为 <section failed>）→ staging 组装 →
 * zip 写 `<outputRoot>/acode-support-<ts>.zip.tmp` → Windows rename 指数退避
 * （200ms×2，总预算 5s）→ 后置清扫陈旧 tmp（10 分钟）。
 *
 * IPC/菜单/设置页接线不在本模块所有权内（见报告接线需求）。
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

import {
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
} from "@acode/services/node";
import { logger } from "./logger.js";
import {
  buildSupportBundleContext,
  formatSectionFailure,
  SUPPORT_BUNDLE_SECTIONS,
  type SupportBundleContext,
  type SupportBundleSection,
} from "./supportBundleSections.js";

/** Windows rename 指数退避：首次 200ms，每次 ×2，总预算封顶 5s。 */
const RENAME_BACKOFF_BASE_MS = 200;
const RENAME_BACKOFF_BUDGET_MS = 5000;
/** 陈旧导出 tmp 文件清扫阈值：10 分钟。 */
const STALE_TMP_MAX_AGE_MS = 10 * 60 * 1000;
/** 支持包 tmp 文件后缀（清扫按此识别）。 */
const SUPPORT_BUNDLE_TMP_SUFFIX = ".zip.tmp";

interface SupportBundleSectionResult {
  id: string;
  group: string;
  label: string;
  status: "ok" | "failed";
  bytes: number;
}

interface ExportSupportBundleOptions {
  /** 用户勾选的节 id；缺省取 appliesIn 通过且 defaultChecked 的全部节。 */
  sections?: readonly string[];
  outputRootDir?: string;
  stageRootDir?: string;
  now?: () => Date;
  onStep?: (label: string) => void;
  /** 测试注入：睡眠。 */
  sleep?: (milliseconds: number) => Promise<void>;
  /** 测试注入：rename 实现。 */
  renameImpl?: (from: string, to: string) => Promise<void>;
  /** 测试注入：上下文（跳过真实收集）。 */
  context?: SupportBundleContext;
  /** 测试注入：节注册表。 */
  registry?: readonly SupportBundleSection[];
  showItemInFolder?: (path: string) => Promise<void> | void;
}

interface ExportSupportBundleResult {
  success: boolean;
  path?: string;
  error?: string;
  sections?: SupportBundleSectionResult[];
}

function formatBundleTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** AV/索引器短暂占用导致的 rename 失败可重试；其余错误立即上抛。 */
function isRetryableRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * Windows rename 指数退避（R12）：200ms×2^n，总预算 5s；
 * 预算耗尽按失败上抛（tmp 保留给陈旧清扫兜底）。
 */
export async function renameWithBackoff(
  from: string,
  to: string,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    renameImpl?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const renameImpl = options.renameImpl ?? rename;
  const deadline = now() + RENAME_BACKOFF_BUDGET_MS;
  let delay = RENAME_BACKOFF_BASE_MS;
  for (;;) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const remaining = deadline - now();
      if (!isRetryableRenameError(error) || remaining <= 0) {
        throw error;
      }
      await sleep(Math.min(delay, remaining));
      delay *= 2;
    }
  }
}

/** 陈旧 tmp 清扫（R13）：mtime 超过 10 分钟的 `*.zip.tmp`；失败只 warn 一次。 */
export async function sweepStaleSupportBundleTmpFiles(
  outputRootDir: string,
  options: { now?: () => number } = {},
): Promise<number> {
  const now = options.now?.() ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(outputRootDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(SUPPORT_BUNDLE_TMP_SUFFIX)) {
      continue;
    }
    const filePath = join(outputRootDir, entry);
    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile() || now - stats.mtimeMs < STALE_TMP_MAX_AGE_MS) {
      continue;
    }
    const deleted = await rm(filePath, { force: true })
      .then(() => true)
      .catch(() => false);
    if (deleted) {
      removed += 1;
    }
  }
  if (removed > 0) {
    logger.info("[support-bundle] 已清扫陈旧导出临时文件", { removed });
  }
  return removed;
}

async function collectSectionContent(
  section: SupportBundleSection,
  context: SupportBundleContext,
): Promise<{ content: string; status: "ok" | "failed" }> {
  try {
    const content = await section.collect(context);
    return { content: typeof content === "string" ? content : String(content), status: "ok" };
  } catch (error) {
    // 单节失败不中断整包（R11）：占位内容本身已脱敏。
    return { content: formatSectionFailure(error), status: "failed" };
  }
}

async function writeSupportBundleZip(
  zipPath: string,
  stagedFiles: ReadonlyArray<{ absolutePath: string; archivePath: string }>,
): Promise<void> {
  const zipFile = new ZipFile();
  const outputStream = createWriteStream(zipPath);
  zipFile.once("error", (error) => {
    outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  for (const file of stagedFiles) {
    zipFile.addFile(file.absolutePath, file.archivePath);
  }
  const writePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();
  await writePromise;
}

/**
 * 导出分节支持包。返回最终 zip 路径与逐节状态；任何失败都不抛给调用方，
 * 以 {success:false,error} 形态返回（与 exportLogs 一致）。
 */
export async function exportSupportBundle(
  options: ExportSupportBundleOptions = {},
): Promise<ExportSupportBundleResult> {
  const now = options.now ?? (() => new Date());
  const outputRootDir = options.outputRootDir ?? getDefaultExportLogDir();
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  const registry = options.registry ?? SUPPORT_BUNDLE_SECTIONS;
  try {
    await mkdir(outputRootDir, { recursive: true });
    await sweepStaleSupportBundleTmpFiles(outputRootDir, { now: () => now().getTime() });

    const context = options.context ?? (await buildSupportBundleContext());
    const applicable: SupportBundleSection[] = [];
    for (const section of registry) {
      const applies = section.appliesIn ? await section.appliesIn(context) : true;
      if (applies) {
        applicable.push(section);
      }
    }
    const requested = options.sections
      ? new Set(options.sections)
      : new Set(
          applicable.filter((section) => section.defaultChecked).map((section) => section.id),
        );
    const selected = applicable.filter((section) => requested.has(section.id));
    if (selected.length === 0) {
      return { success: false, error: "没有适用的支持包分节" };
    }

    await mkdir(stageRootDir, { recursive: true });
    const stagingDir = await mkdtemp(join(stageRootDir, "support-"));
    const sectionResults: SupportBundleSectionResult[] = [];
    const stagedFiles: Array<{ absolutePath: string; archivePath: string }> = [];
    try {
      for (const section of selected) {
        options.onStep?.(section.label);
        const { content, status } = await collectSectionContent(section, context);
        const fileName = `${section.group}--${section.id}.txt`;
        const absolutePath = join(stagingDir, fileName);
        await writeFile(absolutePath, `${content}\n`, "utf-8");
        stagedFiles.push({ absolutePath, archivePath: `sections/${fileName}` });
        sectionResults.push({
          id: section.id,
          group: section.group,
          label: section.label,
          status,
          bytes: Buffer.byteLength(content, "utf-8"),
        });
      }
      const manifest = {
        generatedAt: now().toISOString(),
        sectionCount: sectionResults.length,
        sections: sectionResults,
      };
      const manifestPath = join(stagingDir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
      stagedFiles.push({ absolutePath: manifestPath, archivePath: "manifest.json" });

      const timestamp = formatBundleTimestamp(now());
      const finalPath = join(outputRootDir, `acode-support-${timestamp}.zip`);
      const tmpPath = `${finalPath}.tmp`;
      await writeSupportBundleZip(tmpPath, stagedFiles);
      try {
        await renameWithBackoff(tmpPath, finalPath, {
          now: () => now().getTime(),
          sleep: options.sleep,
          renameImpl: options.renameImpl,
        });
      } catch (renameError) {
        // 退避预算耗尽：保留 tmp（陈旧清扫兜底），按失败返回。
        logger.warn("[support-bundle] rename 退避预算耗尽，保留 tmp 待清扫", {
          tmpPath,
          error: renameError instanceof Error ? renameError.message : String(renameError),
        });
        throw renameError;
      }
      const showItemInFolder =
        options.showItemInFolder ??
        (async (path: string) => {
          const { shell } = await import("electron");
          shell.showItemInFolder(path);
        });
      await showItemInFolder(finalPath);
      logger.info("[support-bundle] 支持包导出完成", {
        path: finalPath,
        sections: sectionResults.map((section) => section.id),
      });
      return { success: true, path: finalPath, sections: sectionResults };
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      await sweepStaleSupportBundleTmpFiles(outputRootDir, { now: () => now().getTime() }).catch(
        () => {},
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[support-bundle] 支持包导出失败", { error: message });
    return { success: false, error: message };
  }
}
