// 机制参照 jcode (MIT)：crates/jcode-overnight-core，自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 R1）。
import { OVERNIGHT_MAX_MS, OVERNIGHT_MIN_MS } from "./constants.js";

/** `/overnight <duration>` 的解析结果：判别联合，非法输入不抛异常（用户输入面）。 */
export type OvernightDurationParseResult =
  | { ok: true; durationMs: number }
  | { ok: false; error: string };

const UNIT_TO_MS: Record<"h" | "m" | "s", number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

const USAGE = "用法 /overnight <duration>，例如 8h、45m、90s、1h30m";

/** 把毫秒时长格式化为人可读形态（错误信息与首条 prompt 复用）。 */
export function formatOvernightDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  // 零时长也要有输出（"0 秒"），保证错误信息可读
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join("");
}

/**
 * 解析 `/overnight` 的时长参数。
 * 支持形态：`8h` / `45m` / `90s` / 组合（`1h30m`、`1h 30m`、`2h15m30s`，大小写不敏感）。
 * 硬限：1 分钟 – 12 小时（边界值本身合法）；裸数字、负数、未知单位、越界均返回可读错误。
 */
export function parseOvernightDuration(input: string): OvernightDurationParseResult {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: `时长为空。${USAGE}` };
  }

  let totalMs = 0;
  let rest = raw;
  for (;;) {
    // 段间允许空白/下划线分隔（"1h 30m" 与 "1h_30m" 等价）
    rest = rest.replace(/^[\s_]+/, "");
    if (rest === "") break;
    const match = /^(\d+)[\s_]*(h|m|s)/i.exec(rest);
    if (!match) {
      const fragment = rest.slice(0, 12);
      return {
        ok: false,
        error: `无法解析时长 "${raw}"（在 "${fragment}" 附近中断）：只支持 h/m/s 单位。${USAGE}`,
      };
    }
    const unit = match[2].toLowerCase() as "h" | "m" | "s";
    totalMs += Number(match[1]) * UNIT_TO_MS[unit];
    rest = rest.slice(match[0].length);
  }

  // 硬限校验放在求和之后：组合形态（如 11h59m90s）必须按总量判定
  if (totalMs < OVERNIGHT_MIN_MS) {
    return { ok: false, error: `时长过短：${formatOvernightDuration(totalMs)}，允许范围是 1 分钟到 12 小时。${USAGE}` };
  }
  if (totalMs > OVERNIGHT_MAX_MS) {
    return { ok: false, error: `时长过长：${formatOvernightDuration(totalMs)}，允许范围是 1 分钟到 12 小时。${USAGE}` };
  }
  return { ok: true, durationMs: totalMs };
}
