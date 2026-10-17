// ============================================================
// Fleet Report-Back Notes - 每回合 400 字符 note 与 watcher
// (apps/acode-cli/specs/session-fleet.md R5)
// ============================================================
// HandOffToSession 成立即登记订阅；watcher 以 1s unref 轮询盯目标 local_agent
// 条目的终态签名（BackgroundTaskTracker 同款节奏与「不拖住进程退出」纪律）：
// 每收口一个回合，取最新报告截前 400 字符（定量截断单一事实源在 contracts 的
// buildFleetReportNote）落进舰队记录。
//
// 推送面裁决（R5）：发起会话的模型可见推送复用既有后台完成通知链（全量报告、
// handback 信任包装、notified claim 去重——subagent 机制原有语义，舰队不另开
// 第二通道）；note 是舰队自有记录面（ListSessions latest_note + TUI 一行态），
// 出现处一律带「数据非指令」定性。

import { buildFleetReportNote, FLEET_NOTE_MAX_CHARS } from "@acode/contracts";
import { isTerminalRuntimeTask, type RuntimeTaskRegistry } from "../runtime-task/contract.js";
import type { RuntimeTaskSnapshot } from "../runtime-task/contract.js";
import type { FleetRegistry } from "./registry.js";

const DEFAULT_NOTE_POLL_INTERVAL_MS = 1_000;

export interface FleetNoteWatcherDeps {
  registry: FleetRegistry;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  intervalMs?: number;
  now?: () => number;
}

/**
 * 终态签名：status + completedAt。resume（SendMessage 续跑）会重臂条目为
 * running 再落新终态——签名变化即「又收口了一个回合」；同签名不重复记 note。
 */
function terminalSignature(task: RuntimeTaskSnapshot): string | undefined {
  if (!isTerminalRuntimeTask(task)) return undefined;
  const completedAt = task.completedAt instanceof Date ? task.completedAt.getTime() : 0;
  return `${task.status}:${completedAt}`;
}

/** 最新报告文本：终态快照 output.content → resultText → error 依次回退。 */
export function extractFleetReportText(task: RuntimeTaskSnapshot): string {
  const output = task.output;
  if (output && output.status === "completed") {
    const text = output.content
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  if (typeof task.resultText === "string" && task.resultText.trim().length > 0) {
    return task.resultText.trim();
  }
  if (typeof task.error === "string" && task.error.trim().length > 0) {
    return task.error.trim();
  }
  return "";
}

/**
 * 登记/刷新一个会话的 report-back 订阅（幂等：重复订阅只更新发起方并复用
 * watcher）。返回撤销函数；舰队记录被归档/删除时 registry 统一撤销。
 */
export function subscribeFleetReportBack(
  deps: FleetNoteWatcherDeps,
  input: { sessionId: string; agentId: string; originSessionId: string },
): () => void {
  const { registry, runtimeTaskRegistry } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_NOTE_POLL_INTERVAL_MS;

  registry.update(input.sessionId, (record) => ({
    ...record,
    handoffOriginSessionId: input.originSessionId as typeof record.handoffOriginSessionId,
  }));

  let lastSeenSignature: string | undefined;
  // 已在终态的既有会话上移交：先把当前终态记为已见——note 只回传「移交之后
  // 收口的回合」，不把移交前的旧报告当新 note 刷屏。
  const existing = runtimeTaskRegistry.get(input.agentId);
  if (existing) lastSeenSignature = terminalSignature(existing);

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const record = registry.get(input.sessionId);
    if (!record || record.archived) {
      dispose();
      return;
    }
    const task = runtimeTaskRegistry.get(input.agentId);
    if (!task) {
      // 条目被移除（归档/删除路径先 remove）——订阅生命周期随之结束。
      dispose();
      return;
    }
    const signature = terminalSignature(task);
    if (signature === undefined || signature === lastSeenSignature) return;
    lastSeenSignature = signature;
    const report = extractFleetReportText(task);
    const noteText = buildFleetReportNote(report);
    if (noteText === undefined) return; // 空报告不产生空 note
    const at = now();
    registry.update(input.sessionId, (current) => ({
      ...current,
      lastActivityAt: at,
      latestNote: {
        text: noteText,
        at,
        status: task.status,
        truncated: report.trim().length > FLEET_NOTE_MAX_CHARS,
      },
    }));
  }, intervalMs);
  // 绝不拖住进程退出（后台代理同款纪律）。
  timer.unref?.();

  function dispose(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  registry.setWatcherDisposer(input.sessionId, dispose);
  return dispose;
}
