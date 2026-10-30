// 拆分依据：translate.ts 超 400 行架构上限。run 的「等待半程」——订阅事件流后发送、
// 按 inputId/turnId 归属过滤等待本 run 触发的 turn 终态（H1）——是独立的轮询收口逻辑，
// 独立成叶子；方法分发表通过本叶子的 runAndWaitTurn 接入。
import type { IACodeAgentService } from "@acode/services";
import { translateSessionEvent } from "./translateEvents.js";
import { HarnessMethodError, isRecord } from "./translateSupport.js";

export const RUN_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const RUN_POLL_INTERVAL_MS = 200;

export interface TurnTerminalResult {
  resultType: "success" | "cancelled" | "error";
  response?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationMs?: number;
  error?: { message: string; code?: string };
  inputId?: string;
}

/**
 * run 的等待半程：先订阅事件流再发送，等待**本 run 触发的 turn** 的终态（H1 归属过滤）。
 *
 * 归属方案（按优先级，实证依据见 apps/acode-cli runtime/methods/turn.ts 的
 * TurnStarted/TurnComplete payload 均回显 sendText 的 inputId）：
 * 1. **inputId 归属（主路径）**：run 预分配 inputId（`harness-run-<uuid>`）随 sendPrompt
 *    下发；引擎 TurnStarted/TurnComplete 事件 payload 回显该 inputId。turn_done 携带
 *    本 run 的 inputId → 直接收口；TurnStarted(inputId=本 run) 捕获其 envelope turnId
 *    → 同 turnId 的 TurnDone 也收口。
 * 2. **退化路径（引擎不回显 inputId 的兼容场景）**：只接受「订阅建立之后观察到
 *    TurnStarted 的 turnId」的终态——订阅前已在途的旧 turn（如 send 挂起中被 deny 的
 *    turn）的终态被跳过，不再被 run 冒领。捕获到 inputId 关联后退化窗口即关闭
 *    （并发第三方 turn 的终态不再误收；同会话并发 run 的精确归属仍不区分，v1 串行假设）。
 *
 * 为什么不用 readSessionEvents 轮询：从 afterSeq=0 起扫会命中历史 turn 的终态
 * （同会话第二次 run 会拿到第一次的结果）；订阅窗口天然只覆盖新事件。
 */
export async function runAndWaitTurn(
  agent: Pick<IACodeAgentService, "onDynamicSessionEvent" | "sendPrompt">,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    content: string;
    /** H1：run 预分配并随 send 下发的 inputId（引擎在 turn 事件 payload 中回显）。 */
    inputId: string;
    model?: unknown;
    toolDenylist?: string[];
  },
  timeoutMs: number,
): Promise<{ sent: { stateRevision?: number }; terminal: TurnTerminalResult }> {
  const pending: TurnTerminalResult[] = [];
  // H1 归属状态：ownedTurnIds=TurnStarted(本 inputId) 捕获的 turnId；
  // liveTurnIds=订阅建立后观察到的 TurnStarted turnId（退化窗口）；
  // sawOwnershipSignal=已观察到本 run 的归属信号（关闭退化窗口）。
  const ownedTurnIds = new Set<string>();
  const liveTurnIds = new Set<string>();
  let sawOwnershipSignal = false;
  let wake: (() => void) | undefined;
  const subscription = agent.onDynamicSessionEvent({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    deliveryKind: "desktop-continuous",
  });
  const disposable = subscription((serviceEvent) => {
    if (serviceEvent.type !== "session.event") return;
    for (const translated of translateSessionEvent(serviceEvent.event)) {
      if (translated.kind === "turn_started") {
        if (translated.turnId !== undefined) liveTurnIds.add(translated.turnId);
        if (translated.inputId === params.inputId) {
          sawOwnershipSignal = true;
          if (translated.turnId !== undefined) ownedTurnIds.add(translated.turnId);
        }
        continue;
      }
      if (translated.kind !== "turn_done") continue;
      const byInputId = translated.inputId === params.inputId;
      const byOwnedTurnId =
        translated.turnId !== undefined && ownedTurnIds.has(translated.turnId);
      // H1 退化路径仅在未捕获到任何归属信号时启用。
      const byLiveTurnId =
        !sawOwnershipSignal &&
        translated.turnId !== undefined &&
        liveTurnIds.has(translated.turnId);
      if (!byInputId && !byOwnedTurnId && !byLiveTurnId) continue;
      pending.push({
        resultType: translated.resultType,
        ...(translated.response !== undefined ? { response: translated.response } : {}),
        ...(translated.usage !== undefined ? { usage: translated.usage } : {}),
        ...(translated.durationMs !== undefined ? { durationMs: translated.durationMs } : {}),
        ...(translated.error !== undefined ? { error: translated.error } : {}),
        ...(translated.inputId !== undefined ? { inputId: translated.inputId } : {}),
      });
      wake?.();
    }
  });
  try {
    const sent = await agent.sendPrompt({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      sessionId: params.sessionId,
      content: params.content,
      inputId: params.inputId,
      ...(isRecord(params.model) ? { modelSelection: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    const deadline = Date.now() + timeoutMs;
    while (pending.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HarnessMethodError(
          "run_timeout",
          `run did not observe a terminal turn event within ${timeoutMs}ms`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.min(remaining, RUN_POLL_INTERVAL_MS),
        );
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
    return { sent, terminal: pending[0] as TurnTerminalResult };
  } finally {
    disposable.dispose();
  }
}
