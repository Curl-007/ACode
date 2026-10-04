// Agent/Host 进程 v8 堆上限护栏的共享契约与纯解析。
// spec: packages/services/specs/agent-v8-heap-guard.md
//
// 消费方:
// - desktop main:Host fork / cron scheduler 的 execArgv(R1);
// - services processManager:app-server spawn env 的 NODE_OPTIONS 合并(R2)。

export const ACODE_HOST_MAX_OLD_SPACE_MB_ENV_KEY = "ACODE_HOST_MAX_OLD_SPACE_MB";
export const ACODE_AGENT_MAX_OLD_SPACE_MB_ENV_KEY = "ACODE_AGENT_MAX_OLD_SPACE_MB";

/** 实测 Host 常驻提交 ~156MB,13× 余量(spec R6)。 */
export const DEFAULT_HOST_MAX_OLD_SPACE_MB = 2048;
/** 实测活跃长会话堆 93-200MB,15×+ 余量(spec R6)。 */
export const DEFAULT_AGENT_MAX_OLD_SPACE_MB = 3072;

/**
 * 解析堆上限 MB。fail-safe 方向与 idle-exit 的 env 解析**相反**:
 * 这里非法/缺省 → fallback(护栏是安全默认,打错字不应静默解除);
 * idle-exit 非法 → 禁用(误杀进程比不回收更糟)。`"0"` = 显式关闭注入(逃生门)。
 */
export function resolveMaxOldSpaceMb(raw: string | undefined, fallbackMb: number): number {
  if (raw === undefined) return fallbackMb;
  const trimmed = raw.trim();
  if (trimmed === "0") return 0;
  // 只接受纯十进制整数字符串(与 idle-exit env 同一严格口径)。
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallbackMb;
}

/**
 * 把 `--max-old-space-size=<mb>` 合并进既有 NODE_OPTIONS(空格拼接,不覆盖
 * coverage preload 等既有片段);mb<=0 时原样返回。
 */
export function appendMaxOldSpaceToNodeOptions(
  existing: string | undefined,
  mb: number,
): string | undefined {
  if (!Number.isFinite(mb) || mb <= 0) return existing;
  const flag = `--max-old-space-size=${mb}`;
  const base = existing?.trim();
  return base ? `${base} ${flag}` : flag;
}
