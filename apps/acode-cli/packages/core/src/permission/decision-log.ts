// ============================================================
// 权限决策日志（specs/permission-adjudication-batch2.md R2）
// ============================================================
// env ACODE_PERMISSION_DECISION_LOG=1 → <workingDirectory>/.acode_permission_decisions.jsonl
// 逐决策追加（fire-and-forget，**失败静默**——日志故障绝不阻断权限决策链路）。
// 本地文件、零网络出口（no-telemetry 红线）；关闭态近零开销（模块级缓存 env
// 判定，不做任何 IO）。与 auto 分类器审计 sink（第一批 R6）互不干涉：那个记
// 「分类器裁决」，这个记「权限决策终局」。

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export const PERMISSION_DECISION_LOG_ENV = "ACODE_PERMISSION_DECISION_LOG";
export const PERMISSION_DECISION_LOG_FILE = ".acode_permission_decisions.jsonl";

/** reason 截断（自由文本只做诊断，不进任何判定；对齐分类器 reason 纪律）。 */
export const PERMISSION_DECISION_LOG_REASON_MAX_CHARS = 200;

export interface PermissionDecisionLogEntry {
  /** epoch ms。 */
  ts: number;
  tool: string;
  decision: "allow" | "ask" | "deny";
  ruleId: string;
  /** 裁决模式（含权限层扩展档 dontAsk）。 */
  mode: string;
  riskLevel?: string;
  sideEffectScope?: string;
  sessionId?: string;
  reason?: string;
}

/** env 判定缓存（进程级；测试经 resetPermissionDecisionLogForTest 清零）。 */
let cachedEnabled: boolean | undefined;

function isDecisionLogEnabled(): boolean {
  if (cachedEnabled === undefined) {
    cachedEnabled = process.env[PERMISSION_DECISION_LOG_ENV] === "1";
  }
  return cachedEnabled;
}

/**
 * 追加一条决策记录。env 未开启 = 立即返回（零 IO）；写入失败静默吞掉
 * （appendFile 的 promise 挂 catch，绝不 rethrow、绝不 await 阻塞决策链路）。
 * 顺序化写队列：审计面承诺「决策顺序 = 落盘顺序」（并发 fire-and-forget 的
 * appendFile 不保证完成序，诊断相关性依赖顺序）；队列自身永不拒绝。
 */
let writeQueue: Promise<void> = Promise.resolve();

export function appendPermissionDecisionLogEntry(
  entry: PermissionDecisionLogEntry,
  options: { workingDirectory?: string } = {},
): void {
  if (!isDecisionLogEnabled()) return;
  const line = `${JSON.stringify(normalizeEntry(entry))}\n`;
  const logPath = join(options.workingDirectory ?? process.cwd(), PERMISSION_DECISION_LOG_FILE);
  writeQueue = writeQueue.then(() =>
    appendFile(logPath, line, "utf8").catch(() => {
      // 失败静默（spec R2）：不可写目录、并发竞争都不影响权限决策与后续追加。
    }),
  );
}

function normalizeEntry(entry: PermissionDecisionLogEntry): PermissionDecisionLogEntry {
  if (typeof entry.reason !== "string") return entry;
  if (entry.reason.length <= PERMISSION_DECISION_LOG_REASON_MAX_CHARS) return entry;
  return { ...entry, reason: `${entry.reason.slice(0, PERMISSION_DECISION_LOG_REASON_MAX_CHARS)}…` };
}

/** 测试隔离：清 env 判定缓存（测试里开关环境变量后必须调用）。 */
export function resetPermissionDecisionLogForTest(): void {
  cachedEnabled = undefined;
}
