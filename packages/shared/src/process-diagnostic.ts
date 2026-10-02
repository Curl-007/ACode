import { z } from "zod";

// 启动早期或协议故障时 stdout 尚不可用，进程诊断使用独立的 stderr 单行契约。
export const ACODE_PROCESS_DIAGNOSTIC_PREFIX = "[acode-process-exception] ";
export const ACODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS = 128;
export const ACODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4_000;
export const ACODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS = 16_000;
export const ACODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS = 128 * 1024;
export const ACODE_AGENT_LIFECYCLE_LOG_MARKER = "[acode-agent-lifecycle-reported]";

const processErrorKindSchema = z.enum(["uncaughtException", "unhandledRejection"]);
export const acodeProcessDiagnosticSchema = z
  .object({
    version: z.literal(1),
    errorId: z.uuid(),
    kind: processErrorKindSchema,
    origin: processErrorKindSchema,
    name: z.string().min(1).max(ACODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(ACODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    stack: z.string().max(ACODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type ACodeProcessDiagnostic = z.infer<typeof acodeProcessDiagnosticSchema>;

export function parseACodeProcessDiagnostic(line: string): ACodeProcessDiagnostic | undefined {
  if (
    !line.startsWith(ACODE_PROCESS_DIAGNOSTIC_PREFIX) ||
    line.length > ACODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS
  ) {
    return undefined;
  }
  try {
    const result = acodeProcessDiagnosticSchema.safeParse(
      JSON.parse(line.slice(ACODE_PROCESS_DIAGNOSTIC_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    // 诊断旁路不得因损坏帧中断业务协议或退出处理。
    return undefined;
  }
}

// ── 外部引擎错误签名分类 ──────────────────────────────
// 镜像 ZCode kernel 的两组签名数组（zcode-kernel.js:20081-20093）。外部引擎多为
// 用户自装、未 bundle，「引擎未安装 / 运行时缺失 / 运行时崩溃」是常见路径而非异常。
// 只做小写子串命中：命中即归类，不改写原文，避免跨引擎版本过度匹配。

/**
 * 非重试的 workspace-prepare / 引擎缺失错误。命中即代表自动重试无意义
 * （缺 binary、缺依赖、缺 API key、配置损坏），应直接 surface 给用户。
 */
export const AGENT_ENGINE_NON_RETRYABLE_SIGNATURES = [
  "binary 未找到",
  "未正确安装",
  "binary not found",
  "not installed",
  "initialize 前进程已退出",
  "initialize 超时",
  "进程启动失败",
  "optional dependency was not installed",
  "Cannot find package '@openai/codex-",
  "Missing optional dependency @openai/codex-",
  "Missing Codex runtime files",
  "Gemini API key is missing or not configured",
  "Please fix the configuration file(s)",
  "Expected property name or '}' in JSON",
  "已暂停自动重试",
] as const;

/** opencode/bun 运行时崩溃签名（含 win32 STATUS_STACK_BUFFER_OVERRUN code=3221226505）。 */
export const AGENT_ENGINE_RUNTIME_CRASH_SIGNATURES = [
  "opencode runtime 崩溃",
  "opencode runtime crashed",
  "bun has crashed",
  "segmentation fault",
  "panic(main thread)",
  "code=3221226505",
] as const;

function matchesAnySignature(text: string, signatures: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}

export function isNonRetryableWorkspacePrepareError(text: string): boolean {
  return matchesAnySignature(text, AGENT_ENGINE_NON_RETRYABLE_SIGNATURES);
}

export function isOpenCodeRuntimeCrashError(text: string): boolean {
  return matchesAnySignature(text, AGENT_ENGINE_RUNTIME_CRASH_SIGNATURES);
}

export type ACodeAgentEngineErrorKind =
  | "runtime-crash"
  | "non-retryable-prepare"
  | "unclassified";

/**
 * 把一段 stderr/错误文本归类为引擎错误类型，供进程管理器决定「是否值得自动重试」
 * 与「surface 哪种诊断」。崩溃优先于 prepare（崩溃可能伴随 prepare 文案）。
 */
export function classifyAgentEngineError(text: string): ACodeAgentEngineErrorKind {
  if (isOpenCodeRuntimeCrashError(text)) {
    return "runtime-crash";
  }
  if (isNonRetryableWorkspacePrepareError(text)) {
    return "non-retryable-prepare";
  }
  return "unclassified";
}
