import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  createGitEnvironmentProvider,
  type GitEnvironmentProvider,
} from "../git/providers/gitEnvironmentProvider.js";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import { filterGitListingNewlinePaths } from "./workspaceGitListingEntries.js";

/**
 * workspace 文件清单的 git 主源（降级栈第 1 级）：采集与冷却。
 * 机制来源与全部产品规则见 specs/file-index-degradation.md：
 * `git ls-files` 流式采集（软/硬超时 + 输出/单记录限额，超限即中止）→
 * 超限仓库进 64 条 LRU 冷却表（10 分钟）→ 调用方降级既有全量扫描。
 * env 走 getGitCommandEnv() 硬化漏斗（gitEnvironmentProvider），二进制解析
 * 复用 ACODE_GIT_BINARY 覆盖 + Windows 候选链 + --version 探测缓存。
 * entries 组装与成本比例 TTL 见 workspaceGitListingEntries.ts。
 */

export const WORKSPACE_GIT_LISTING_LIMITS = {
  /** 软超时：SIGTERM 杀进程，等待 close 结算。 */
  softTimeoutMs: 10_000,
  /** 硬超时：SIGKILL + 销毁 stdio，直接结算（防管道句柄被拖住）。 */
  hardTimeoutMs: 15_000,
  /** stdout+stderr 合计输出预算，超限即中止。 */
  maxOutputBytes: 64 * 1024 * 1024,
  /** 单条 NUL 分隔记录长度上限（病态长路径即视为超大仓），超限即中止。 */
  maxRecordChars: 64 * 1024,
  /** 超限仓库冷却时长：期间不再尝试 git 主源。 */
  cooldownMs: 10 * 60_000,
  /** 冷却表容量（LRU，满员逐最旧）。 */
  cooldownMaxEntries: 64,
} as const;

export type WorkspaceGitFileListingLimits = typeof WORKSPACE_GIT_LISTING_LIMITS;

/** stderr 只保留尾部一小段用于诊断/警告摘要。 */
const STDERR_TAIL_CHARS = 8_192;
/** 警告里 stderr 摘要的截断长度。 */
const WARNING_DETAIL_CHARS = 400;

export type WorkspaceGitFileListingOutcome =
  | { kind: "listing"; paths: string[]; droppedNewlinePaths: number }
  | { kind: "oversized"; reason: "timeout" | "output" | "record"; collectedPaths: number }
  /** 冷却期内：不 spawn、不重复警告，调用方直接降级扫描。 */
  | { kind: "cooling-down"; retryAfterMs: number }
  | { kind: "not-a-repository" }
  | { kind: "git-unavailable" }
  | { kind: "failed"; detail: string };

export interface WorkspaceGitFileListingSource {
  collect(rootPath: string): Promise<WorkspaceGitFileListingOutcome>;
}

type GitListingRunResult =
  | { status: "ok"; records: string[] }
  | { status: "oversized"; reason: "timeout" | "output" | "record"; collected: number }
  | { status: "not-a-repository" }
  | { status: "git-unavailable" }
  | { status: "failed"; detail: string };

function truncateDetail(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > WARNING_DETAIL_CHARS
    ? `${trimmed.slice(0, WARNING_DETAIL_CHARS)}…`
    : trimmed;
}

function describeOversizedReason(
  reason: "timeout" | "output" | "record",
  limits: WorkspaceGitFileListingLimits,
): string {
  if (reason === "timeout") {
    return `采集超过 ${Math.round(limits.softTimeoutMs / 1000)}s 超时`;
  }
  if (reason === "output") {
    return `输出超过 ${Math.round(limits.maxOutputBytes / (1024 * 1024))}MB 上限`;
  }
  return `单条路径超过 ${Math.round(limits.maxRecordChars / 1024)}KB 上限`;
}

export interface CreateWorkspaceGitFileListingSourceOptions {
  limits?: Partial<WorkspaceGitFileListingLimits>;
  logger?: Pick<ServiceLogger, "warn">;
  /** 注入时钟（冷却期测试用）；缺省 Date.now。 */
  now?: () => number;
  environmentProvider?: GitEnvironmentProvider;
}

export function createWorkspaceGitFileListingSource(
  options: CreateWorkspaceGitFileListingSourceOptions = {},
): WorkspaceGitFileListingSource {
  const limits: WorkspaceGitFileListingLimits = {
    ...WORKSPACE_GIT_LISTING_LIMITS,
    ...options.limits,
  };
  const logger = options.logger ?? createServiceLogger("workspace-file-index");
  const now = options.now ?? Date.now;
  const environmentProvider = options.environmentProvider ?? createGitEnvironmentProvider();

  // 冷却表与警告去重归 source 实例所有（与"索引归服务实例"一致，
  // 不同 Host/注入过滤器不共享）。冷却表是负缓存：只存"别再试"的时间戳，
  // 不存清单内容——与 fileService 的清单缓存不构成双缓存并存（spec R3）。
  const cooldownUntilByKey = new Map<string, number>();
  const warnedKeys = new Set<string>();

  function warnOnce(key: string, message: string): void {
    if (warnedKeys.has(key)) {
      return;
    }
    warnedKeys.add(key);
    logger.warn(undefined, message);
  }

  function enterCooldown(key: string): void {
    cooldownUntilByKey.set(key, now() + limits.cooldownMs);
    while (cooldownUntilByKey.size > limits.cooldownMaxEntries) {
      const oldest = cooldownUntilByKey.keys().next();
      if (oldest.done) {
        break;
      }
      cooldownUntilByKey.delete(oldest.value);
    }
  }

  function runGitLsFiles(binary: string, rootPath: string): Promise<GitListingRunResult> {
    return new Promise<GitListingRunResult>((resolve) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          binary,
          // -z：NUL 分隔原始路径（不受 core.quotepath 转义影响，含特殊字符路径可精确还原）。
          // --cached --others --exclude-standard：tracked + 未跟踪且未被 .gitignore 忽略，
          // 与全量扫描的可见集合最接近（差异边界见 spec R6）。
          // --recurse-submodules 与 --others 互斥（git 实测 unsupported mode），故不递归子模块。
          [
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ],
          {
            cwd: rootPath,
            env: environmentProvider.createCommandEnv(),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch (error) {
        resolve({
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const records: string[] = [];
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let totalBytes = 0;
      let stderrTail = "";
      let stoppedReason: "timeout" | "output" | "record" | null = null;

      const finish = (result: GitListingRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.removeAllListeners("close");
        child.removeAllListeners("error");
        resolve(result);
      };

      // 限额中止：SIGKILL + 销毁 stdio 后立即结算，不等 close
      // （ls-files 无子进程面：过滤器不被 ls-files 触发，hooks 已被硬化矩阵停用）。
      const abort = (reason: "timeout" | "output" | "record"): void => {
        stoppedReason = reason;
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已退出；忽略。
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ status: "oversized", reason, collected: records.length });
      };

      const softTimer = setTimeout(() => {
        // 软超时先礼后兵：SIGTERM（Windows 上等价终止），close 结算为 oversized(timeout)。
        if (!settled) {
          stoppedReason ??= "timeout";
          child.kill();
        }
      }, limits.softTimeoutMs);
      const hardTimer = setTimeout(() => {
        abort("timeout");
      }, limits.hardTimeoutMs);

      const countBytes = (byteLength: number): boolean => {
        totalBytes += byteLength;
        if (totalBytes > limits.maxOutputBytes) {
          abort("output");
          return false;
        }
        return true;
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled || !countBytes(chunk.byteLength)) {
          return;
        }
        pending += decoder.write(chunk);
        let nul = pending.indexOf("\0");
        while (nul !== -1) {
          const record = pending.slice(0, nul);
          pending = pending.slice(nul + 1);
          if (record.length > limits.maxRecordChars) {
            abort("record");
            return;
          }
          if (record.length > 0) {
            records.push(record);
          }
          nul = pending.indexOf("\0");
        }
        if (pending.length > limits.maxRecordChars) {
          abort("record");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled || !countBytes(chunk.byteLength)) {
          return;
        }
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
      });

      child.once("error", (error: NodeJS.ErrnoException) => {
        // ENOENT：git 二进制或 cwd 在探测后消失（workspace 并发删除）——静默降级，
        // 扫描路径会对缺失目录给出既有错误面。
        if (error?.code === "ENOENT") {
          finish({ status: "git-unavailable" });
          return;
        }
        finish({ status: "failed", detail: error.message });
      });

      child.once("close", (code) => {
        if (settled) {
          return;
        }
        if (stoppedReason) {
          finish({ status: "oversized", reason: stoppedReason, collected: records.length });
          return;
        }
        // 冲刷解码器尾部（多字节字符跨 chunk）；-z 输出以 NUL 结尾，pending 正常为空。
        const tail = decoder.end();
        if (tail.length > 0) {
          if (tail.length > limits.maxRecordChars) {
            abort("record");
            return;
          }
          pending += tail;
          if (pending.length > 0) {
            records.push(pending);
          }
        }
        if (code === 0) {
          finish({ status: "ok", records });
          return;
        }
        if (stderrTail.toLowerCase().includes("not a git repository")) {
          finish({ status: "not-a-repository" });
          return;
        }
        finish({
          status: "failed",
          detail: `exit=${code ?? "null"}${stderrTail.trim() ? ` ${stderrTail.trim()}` : ""}`,
        });
      });
    });
  }

  return {
    async collect(rootPath: string): Promise<WorkspaceGitFileListingOutcome> {
      const binary = await environmentProvider.resolveGitBinary();
      if (!binary) {
        // git 不可用：静默走既有扫描路径（现有行为不变；探测结果由 provider 缓存，
        // 不会形成 spawn 风暴）。
        return { kind: "git-unavailable" };
      }

      const cooldownKey = `${binary}\u0000${rootPath}`;
      const cooldownUntil = cooldownUntilByKey.get(cooldownKey);
      if (cooldownUntil !== undefined) {
        if (now() < cooldownUntil) {
          return { kind: "cooling-down", retryAfterMs: cooldownUntil - now() };
        }
        cooldownUntilByKey.delete(cooldownKey);
      }

      const run = await runGitLsFiles(binary, rootPath);
      switch (run.status) {
        case "ok": {
          // 换行注入过滤：含 \n/\r 的路径剔除并计数（防清单注入，spec R5）。
          const { paths, droppedNewlinePaths } = filterGitListingNewlinePaths(run.records);
          if (droppedNewlinePaths > 0) {
            warnOnce(
              `${cooldownKey}\u0000newline`,
              `[workspace-file-index] Git 清单中 ${droppedNewlinePaths} 条路径含换行/回车字符，已剔除（防清单注入）；这些文件不会出现在文件搜索结果中。`,
            );
          }
          return { kind: "listing", paths, droppedNewlinePaths };
        }
        case "oversized": {
          enterCooldown(cooldownKey);
          warnOnce(
            `${cooldownKey}\u0000oversized`,
            `[workspace-file-index] Git 文件清单超限中止（${describeOversizedReason(
              run.reason,
              limits,
            )}；已采集 ${run.collected} 条路径）。该 workspace 改用目录扫描构建文件索引（构建更慢，结果完整）；约 ${Math.round(
              limits.cooldownMs / 60_000,
            )} 分钟后自动重试 Git 清单。`,
          );
          return { kind: "oversized", reason: run.reason, collectedPaths: run.collected };
        }
        case "not-a-repository":
          // 非 git 目录：静默降级（现有行为不变）。
          return { kind: "not-a-repository" };
        case "git-unavailable":
          return { kind: "git-unavailable" };
        case "failed": {
          warnOnce(
            `${cooldownKey}\u0000failed`,
            `[workspace-file-index] git ls-files 失败，改用目录扫描构建文件索引：${truncateDetail(
              run.detail,
            )}`,
          );
          return { kind: "failed", detail: run.detail };
        }
      }
    },
  };
}
