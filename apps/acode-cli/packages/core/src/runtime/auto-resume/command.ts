// /auto-resume 命令面（specs/turn-auto-resume.md「/auto-resume 命令面（零 token）」）：
// 解析 + 回执文本（随 locale zh/en）的单一实现模块。CLI command-center 拦截与
// bootstrap v4/command handler leaf 复用同一模块——依赖方向约束（bootstrap 不得
// 反向依赖 cli，且 cli→bootstrap 已成边）决定本体住 core；core 承载命令解析的
// 先例 = overnight/duration.ts 的 parseOvernightDuration（cli command-center 消费）。
import type { AutoResumeStatusSnapshot } from "./types.js";

/** off <时长> 上限：30 天。 */
export const AUTO_RESUME_MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1_000;

/** 自定义继续指令长度上限（进 config 与 provider 可见 prompt，拒绝对话框级滥用）。 */
export const AUTO_RESUME_MAX_MESSAGE_LENGTH = 4_000;

export type AutoResumeCommandIntent =
  | { kind: "status" }
  /** 裸 on/off：进程内立即生效 + 持久化 config（照 /locale 写 config 先例）。 */
  | { kind: "setEnabled"; enabled: boolean; persist: true }
  /** off <时长>：进程内 pause overlay，到期自动恢复，不持久化。 */
  | { kind: "pause"; durationMs: number }
  /** msg <文本> / msg clear：进程内立即生效 + 持久化 config.continueMessage。 */
  | { kind: "setContinueMessage"; message: string | null; persist: true };

export type AutoResumeCommandParseResult =
  | { ok: true; intent: AutoResumeCommandIntent }
  | { ok: false; error?: string };

export type AutoResumeDurationParseResult =
  | { ok: true; durationMs: number }
  | { ok: false; error: string };

export interface AutoResumeCommandOutcome {
  ok: boolean;
  /** 持久化写盘时回执 configPath（照 /locale 先例）。 */
  configPath?: string;
  error?: string;
}

/** 命令执行宿主窄面：CLI（CommandCenterApp）与 desktop（v4 record.app）都能结构满足。 */
export interface AutoResumeCommandHost {
  getStatus?(): AutoResumeStatusSnapshot | undefined;
  apply?(
    intent: AutoResumeCommandIntent,
  ): Promise<AutoResumeCommandOutcome> | AutoResumeCommandOutcome;
  getLocale?(): string | undefined;
  now?(): number;
}

/** bootstrap ACodeApp / cli CommandCenterApp 的结构子集（host 工厂入参）。 */
export interface AutoResumeCommandAppLike {
  getAutoResumeStatus?(): AutoResumeStatusSnapshot | undefined;
  applyAutoResumeCommand?(
    intent: AutoResumeCommandIntent,
  ): Promise<AutoResumeCommandOutcome> | AutoResumeCommandOutcome;
  getLocale?(): string | undefined;
}

export function createAutoResumeCommandHost(app: AutoResumeCommandAppLike): AutoResumeCommandHost {
  return {
    getStatus: () => app.getAutoResumeStatus?.(),
    apply: (intent) =>
      app.applyAutoResumeCommand
        ? app.applyAutoResumeCommand(intent)
        : { ok: false, error: "auto-resume command surface is not available in this client" },
    getLocale: () => app.getLocale?.(),
  };
}

const USAGE =
  "Usage: /auto-resume status | on | off [duration] | msg <text> | msg clear\n" +
  "  duration: 45s / 30m / 2h / 1d / 90 (bare number = minutes), max 30 days";

/**
 * 时长解析：`45s/30m/2h/1d`、组合（`1h30m`，大小写不敏感）、纯数字 = 分钟；
 * 上限 30 天，零/负/未知单位返回可读错误（用户输入面，不抛异常）。
 */
export function parseAutoResumeDuration(input: string): AutoResumeDurationParseResult {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: `Duration is empty. ${USAGE}` };
  }
  if (/^\d+$/.test(raw)) {
    const minutes = Number(raw);
    return clampDuration(minutes * 60_000, raw);
  }
  const unitToMs: Record<"s" | "m" | "h" | "d", number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  let totalMs = 0;
  let rest = raw;
  for (;;) {
    rest = rest.replace(/^[\s_]+/, "");
    if (rest === "") break;
    const match = /^(\d+)[\s_]*(s|m|h|d)/i.exec(rest);
    if (!match) {
      return {
        ok: false,
        error: `Unable to parse duration "${raw}": only s/m/h/d units or a bare minute number are supported. ${USAGE}`,
      };
    }
    const unit = match[2]!.toLowerCase() as "s" | "m" | "h" | "d";
    totalMs += Number(match[1]) * unitToMs[unit];
    rest = rest.slice(match[0].length);
  }
  return clampDuration(totalMs, raw);
}

function clampDuration(durationMs: number, raw: string): AutoResumeDurationParseResult {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, error: `Duration must be positive (got "${raw}"). ${USAGE}` };
  }
  if (durationMs > AUTO_RESUME_MAX_PAUSE_MS) {
    return {
      ok: false,
      error: `Duration exceeds the 30-day cap (got "${raw}"). ${USAGE}`,
    };
  }
  return { ok: true, durationMs };
}

export function parseAutoResumeCommand(args: string): AutoResumeCommandParseResult {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "status") {
    return { ok: true, intent: { kind: "status" } };
  }
  const splitAt = trimmed.search(/\s/);
  const head = (splitAt === -1 ? trimmed : trimmed.slice(0, splitAt)).toLowerCase();
  const rest = splitAt === -1 ? "" : trimmed.slice(splitAt + 1).trim();

  if (head === "on") {
    if (rest !== "") {
      return { ok: false, error: `"on" takes no arguments. ${USAGE}` };
    }
    return { ok: true, intent: { kind: "setEnabled", enabled: true, persist: true } };
  }
  if (head === "off") {
    if (rest === "") {
      return { ok: true, intent: { kind: "setEnabled", enabled: false, persist: true } };
    }
    const parsed = parseAutoResumeDuration(rest);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    return { ok: true, intent: { kind: "pause", durationMs: parsed.durationMs } };
  }
  if (head === "msg") {
    if (rest === "") {
      return { ok: false, error: `Missing message text. ${USAGE}` };
    }
    if (rest.toLowerCase() === "clear") {
      return { ok: true, intent: { kind: "setContinueMessage", message: null, persist: true } };
    }
    if (rest.length > AUTO_RESUME_MAX_MESSAGE_LENGTH) {
      return {
        ok: false,
        error: `Message exceeds ${AUTO_RESUME_MAX_MESSAGE_LENGTH} characters.`,
      };
    }
    return { ok: true, intent: { kind: "setContinueMessage", message: rest, persist: true } };
  }
  return { ok: false, error: `Unknown subcommand "${head}". ${USAGE}` };
}

export async function handleAutoResumeCommand(
  args: string,
  host: AutoResumeCommandHost,
): Promise<{ response: string }> {
  const locale = normalizeAutoResumeLocale(host.getLocale?.());
  const now = host.now?.() ?? Date.now();
  const parsed = parseAutoResumeCommand(args);
  if (!parsed.ok) {
    return { response: parsed.error ?? USAGE };
  }
  if (parsed.intent.kind === "status") {
    return {
      response: formatAutoResumeStatusReceipt(host.getStatus?.(), locale, now),
    };
  }
  if (!host.apply) {
    return {
      response: t(
        locale,
        "auto-resume is not available in this client.",
        "当前客户端不支持 /auto-resume。",
      ),
    };
  }
  const outcome = await host.apply(parsed.intent);
  if (!outcome.ok) {
    return {
      response:
        outcome.error ??
        t(locale, "Failed to apply the auto-resume command.", "auto-resume 命令执行失败。"),
    };
  }
  return {
    response: formatAutoResumeAppliedReceipt(parsed.intent, outcome, locale, now),
  };
}

export function formatAutoResumeAppliedReceipt(
  intent: AutoResumeCommandIntent,
  outcome: AutoResumeCommandOutcome,
  locale: AutoResumeLocale,
  now: number,
): string {
  const configSuffix = outcome.configPath
    ? `\n${t(locale, "Config: ", "配置：")}${outcome.configPath}`
    : "";
  switch (intent.kind) {
    case "setEnabled":
      return intent.enabled
        ? t(locale, "auto-resume enabled.", "已开启跨回合自动继续。") + configSuffix
        : t(locale, "auto-resume disabled.", "已停用跨回合自动继续。") + configSuffix;
    case "pause": {
      const duration = formatAutoResumeDuration(intent.durationMs, locale);
      const until = formatLocalTimestamp(now + intent.durationMs);
      return locale === "zh"
        ? `已暂停跨回合自动继续 ${duration}（至 ${until}）。`
        : `auto-resume paused for ${duration} (until ${until}).`;
    }
    case "setContinueMessage":
      return intent.message === null
        ? t(
            locale,
            "Custom continue message cleared; the default template is used.",
            "已清除自定义继续指令，恢复默认模板。",
          ) + configSuffix
        : t(locale, "Custom continue message saved.", "已保存自定义继续指令。") + configSuffix;
    case "status":
      // status 不经本函数（handleAutoResumeCommand 直接走 status 回执）。
      return formatAutoResumeStatusReceipt(undefined, locale, now);
  }
}

export function formatAutoResumeStatusReceipt(
  status: AutoResumeStatusSnapshot | undefined,
  locale: AutoResumeLocale,
  now: number,
): string {
  if (!status) {
    return t(
      locale,
      "auto-resume status is not available in this client.",
      "当前客户端无法读取 auto-resume 状态。",
    );
  }
  const lines: string[] = [];
  const enabledText = status.enabled
    ? t(locale, "enabled", "已启用")
    : t(locale, "disabled", "已停用");
  lines.push(`${t(locale, "auto-resume: ", "跨回合自动继续：")}${enabledText}`);
  if (status.pausedUntilMs !== undefined && status.pausedUntilMs > now) {
    lines.push(
      `${t(locale, "paused until: ", "暂停至：")}${formatLocalTimestamp(status.pausedUntilMs)} (${formatAutoResumeDuration(status.pausedUntilMs - now, locale)} ${t(locale, "remaining", "后恢复")})`,
    );
  }
  lines.push(
    `${t(locale, "continue message: ", "继续指令：")}${
      status.continueMessage ? t(locale, "custom", "自定义") : t(locale, "default", "默认")
    }`,
  );
  lines.push(
    `${t(locale, "current session: ", "当前会话：")}${status.count}/${status.maxResumes} ${t(
      locale,
      "resumes",
      "次自动继续",
    )}` +
      (status.repeats > 0 && status.lastSignature
        ? `; ${t(locale, "same-signature repeats", "相同错误签名连续")} ${status.repeats}× (${status.lastSignature})`
        : ""),
  );
  if (status.pendingResumeAtMs !== undefined && status.pendingResumeAtMs > now) {
    lines.push(
      `${t(locale, "next resume at: ", "下次自动继续：")}${formatLocalTimestamp(status.pendingResumeAtMs)}`,
    );
  }
  return lines.join("\n");
}

export type AutoResumeLocale = "zh" | "en";

export function normalizeAutoResumeLocale(locale: string | undefined): AutoResumeLocale {
  return locale?.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

function t(locale: AutoResumeLocale, en: string, zh: string): string {
  return locale === "zh" ? zh : en;
}

/** 毫秒时长的人可读形态（d/h/m/s 分段，只保留非零高位两段）。 */
export function formatAutoResumeDuration(durationMs: number, locale: AutoResumeLocale): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units =
    locale === "zh"
      ? { d: "天", h: "小时", m: "分钟", s: "秒" }
      : { d: "d", h: "h", m: "m", s: "s" };
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}${units.d}`);
  if (hours > 0) parts.push(`${hours}${units.h}`);
  if (minutes > 0 && parts.length < 2) parts.push(`${minutes}${units.m}`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds}${units.s}`);
  if (parts.length === 0) parts.push(`0${units.s}`);
  return locale === "zh" ? parts.join("") : parts.join(" ");
}

function formatLocalTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
