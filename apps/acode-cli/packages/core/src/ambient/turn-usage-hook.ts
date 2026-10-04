// K6 Ambient 预算感知调度（specs/ambient-budget-scheduler.md R1 前置子项）：
// turn 成功路径的 usage 旁路写——usage 滚动账本的数据源接线（单一写入点）。
//
// 为什么是「旁路」：账本是 ambient 域自持有的预算数据（与 SQLite usage 观测面
// 独立），它的写入失败不得改变 turn 业务语义；反之 SQLite 观测面缺席（usageStore
// 未配置）时账本照常记——预算公式不能因观测面裁剪而失明。
import { getSharedAmbientUsageLedger, type AmbientUsageLedger } from "./usage-ledger.js";
import { isAmbientSession } from "./session-kind.js";

export interface AmbientTurnUsageFact {
  status: "completed" | "error" | "cancelled";
  inputTokens?: number;
  outputTokens?: number;
}

export interface AmbientTurnUsageHookDeps {
  /** 注入账本（测试/装配层显式绑定）；缺省进程内共享实例。 */
  ledger?: AmbientUsageLedger;
  warn?(message: string, details?: Record<string, unknown>): void;
}

/**
 * 把一次 turn 的用量写入滚动账本。只记成功路径（status=completed）且有实际 token
 * 的 turn（hook 拦截等 0-token 完成不产生噪音行）。kind 按「当前会话是否 ambient」
 * 判定（session-kind 标记由 fork 端口绑定处登记）。永不抛错。
 */
export async function appendAmbientUsageForTurn(
  sessionId: string,
  fact: AmbientTurnUsageFact,
  deps: AmbientTurnUsageHookDeps = {},
): Promise<void> {
  try {
    if (fact.status !== "completed") return;
    const tokensIn = fact.inputTokens ?? 0;
    const tokensOut = fact.outputTokens ?? 0;
    if (tokensIn <= 0 && tokensOut <= 0) return;
    const ledger = deps.ledger ?? getSharedAmbientUsageLedger();
    await ledger.append({
      ts: Date.now(),
      tokensIn,
      tokensOut,
      taskId: sessionId,
      kind: isAmbientSession(sessionId) ? "ambient" : "user",
    });
  } catch (error) {
    deps.warn?.("Ambient usage ledger bypass write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "ambient.usage.write.failed",
    });
  }
}
