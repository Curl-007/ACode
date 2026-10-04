// 机制参照 jcode (MIT)：jcode-app-core ambient cycle 结束的自提议语义
// （Complete+有请求 → Scheduled，否则 Idle），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R3 cycle 语义）。
//
// 围栏形态（cycle response 尾部，模型可见的「提议下次唤醒」通道）：
//   ```acode-schedule
//   {"wakeInMinutes": 30, "taskDescription": "再查一次构建状态", "priority": "normal"}
//   ```

export interface AmbientScheduleProposal {
  /** 相对 cycle 结束时刻的分钟数（1-1440）。 */
  wakeInMinutes: number;
  taskDescription: string;
  priority?: "low" | "normal" | "high";
}

/**
 * 解析 response 尾部的 ```acode-schedule 围栏提议。
 * 取**最后一个**围栏（模型可能在正文中先打草稿）；内容必须是一段 JSON 对象且
 * wakeInMinutes/taskDescription 合法。任何不合法 → null（视为无提议 → Idle 语义），
 * 不抛错：围栏是建议性通道，坏提议不该终结 runner。
 */
export function parseAmbientScheduleProposal(responseText: string): AmbientScheduleProposal | null {
  const matches = [...responseText.matchAll(/```acode-schedule\s*\n([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  let value: unknown;
  try {
    value = JSON.parse(last[1]!.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    wakeInMinutes?: unknown;
    taskDescription?: unknown;
    priority?: unknown;
  };
  if (
    typeof candidate.wakeInMinutes !== "number" ||
    !Number.isInteger(candidate.wakeInMinutes) ||
    candidate.wakeInMinutes < 1 ||
    candidate.wakeInMinutes > 1440
  ) {
    return null;
  }
  if (typeof candidate.taskDescription !== "string" || candidate.taskDescription.trim().length === 0) {
    return null;
  }
  if (
    candidate.priority !== undefined &&
    candidate.priority !== "low" &&
    candidate.priority !== "normal" &&
    candidate.priority !== "high"
  ) {
    return null;
  }
  return {
    wakeInMinutes: candidate.wakeInMinutes,
    taskDescription: candidate.taskDescription.trim(),
    ...(candidate.priority !== undefined ? { priority: candidate.priority } : {}),
  };
}
