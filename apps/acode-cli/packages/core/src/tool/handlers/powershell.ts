// ============================================================
// PowerShell Tool Handler（specs/powershell-tool.md）
// ============================================================
// Windows 原生面一等工具：注册表（HKLM:/HKCU: PSDrive）、服务、ACL、事件日志、
// WMI 走本工具；POSIX/git 工作流走 Bash（Windows 上为 Git Bash，见 bash-prompt.ts
// 的锚定行）。执行形态 = 每次全新 `-NoProfile -NonInteractive` 进程（R2，解析在
// powershell-launch.ts）：工作目录经 handler 侧捕获尾跨调用持久（R3），变量/
// 函数/env 等 shell 状态不持久。权限与风险分类走 bash 同款面（R4，关键词面与
// capability 在 powershell-risk.ts）；描述文本在 powershell-prompt.ts。

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BashInputSchema,
  BashOutputJsonSchema,
  BashOutputSchema,
  CoreErrorType,
  createCoreError,
  type BashInput,
  type BashOutput,
  type CommandExecutionSpanWriter,
  type ExecutionRequest,
  type TraceContext,
} from "@acode/contracts";
import {
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  type BashTimeoutPolicy,
} from "../bash-timeout-policy.js";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
} from "../types.js";
import {
  commandCategory,
  createBashInputJsonSchema,
  createExecutionRunOptions,
  emptyBashOutput,
  finishBashCommandTelemetry,
  toBackgroundedBashOutput,
} from "./bash.js";
import { supportsBashBackgroundLifecycle } from "./bash-background-lifecycle.js";
import { decideBashCwdPolicy } from "./bash-cwd-policy.js";
import { formatBashModelContent, formatPersistedBashModelContent } from "./bash-model-content.js";
import { toBashOutput, type BashProgressTiming } from "./bash-output.js";
import {
  createWrappedPowerShellCommand,
  readCapturedPowerShellCwd,
} from "./powershell-cwd.js";
import {
  defaultPowerShellLaunch,
  type PowerShellLaunch,
} from "./powershell-launch.js";
import { createPowerShellProviderDescription } from "./powershell-prompt.js";
import { resolvePowerShellPermissionCapability } from "./powershell-risk.js";
import { classifySafeCommandIdentity } from "./tool-perf.js";

// 同目录先例（bash.ts re-export bash-metadata）：入口文件是工具面的唯一公开引用点。
// 只 re-export 有真实消费者的符号（knip exports 面收敛）；接线方需要 launch/描述
// 工厂时直接从 powershell-launch.js / powershell-prompt.js 导入。
export {
  createWrappedPowerShellCommand,
  readCapturedPowerShellCwd,
} from "./powershell-cwd.js";
export { resolvePowerShellLaunch } from "./powershell-launch.js";
export {
  isPowerShellConfirmKeywordCommand,
  resolvePowerShellPermissionCapability,
} from "./powershell-risk.js";
export { detectNoShellToolWarning } from "./powershell-shell-availability.js";

const MAX_INLINE_OUTPUT_BYTES = 30_000;
const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
export const POWER_SHELL_TOOL_NAME = "PowerShell";

// -----------------------------------------------
// Handler
// -----------------------------------------------

function startPowerShellCommandTelemetry(
  input: BashInput,
  context: ToolExecutionContext,
): CommandExecutionSpanWriter | undefined {
  const identity = classifySafeCommandIdentity(input.command);
  return context.telemetry?.startCommand({
    category: commandCategory(input.command),
    commandCount: identity.count ?? 0,
    safeName: identity.name ?? "other",
    sandboxed: input.dangerouslyDisableSandbox !== true,
    // 结构事实（本工具只有 PowerShell 一种执行器），不走 bash.ts 的 displayName 启发。
    shellKind: "powershell",
  });
}

async function executePowerShellHandler(
  input: unknown,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
  launch: PowerShellLaunch | undefined,
): Promise<BashOutput> {
  const parsed = BashInputSchema.parse(input) as BashInput;
  const executionPort = context.executionPort;

  if (!executionPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort is not configured for PowerShell tool",
      {
        context: { toolCallId: context.toolCallId, toolName: POWER_SHELL_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  if (!launch) {
    // fail-closed：解析不到 PowerShell 绝不静默换 shell（cmd/Git Bash 语义不同）。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "No PowerShell executable (pwsh or powershell.exe) was resolved on this machine; the PowerShell tool cannot run commands.",
      {
        context: { toolCallId: context.toolCallId, toolName: POWER_SHELL_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  if (parsed.command.trim().length === 0) {
    const commandTelemetry = startPowerShellCommandTelemetry(parsed, context);
    commandTelemetry?.finishCompleted();
    return emptyBashOutput(parsed);
  }

  // 与 bash.ts 同款：闲时 turn 的通知轮不带 turnExecutionModel，拒绝显式后台。
  if (parsed.run_in_background && context.offPeakTurn === true) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Idle-time tasks do not support background commands. Run this command in the foreground without run_in_background.",
      {
        context: { toolCallId: context.toolCallId, toolName: POWER_SHELL_TOOL_NAME },
        recoverable: true,
      },
    );
  }
  const backgroundLifecyclePort = supportsBashBackgroundLifecycle(executionPort)
    ? executionPort
    : undefined;
  if (parsed.run_in_background && !backgroundLifecyclePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort does not support the PowerShell background lifecycle",
      {
        context: { toolCallId: context.toolCallId, toolName: POWER_SHELL_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  const cwdFilePath = join(tmpdir(), `acode-ps-${crypto.randomUUID()}-cwd`);
  const request = createPowerShellExecutionRequest(
    parsed,
    context,
    timeoutPolicy,
    launch,
    cwdFilePath,
  );
  const progressTiming: BashProgressTiming = {};
  const commandTelemetry = startPowerShellCommandTelemetry(parsed, context);
  const runOptions = createExecutionRunOptions(
    context,
    POWER_SHELL_TOOL_NAME,
    progressTiming,
    commandTelemetry,
  );
  // 一期只支持显式后台（端口泛型，复用 Bash 生命周期）；超时自动转后台的
  // eligibility 判定是 bash 语法面，不提供（spec R3 登记后置）。
  const runCommand = async () =>
    parsed.run_in_background && backgroundLifecyclePort
      ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
          request,
          { mode: "explicit" },
          runOptions,
        )
      : { kind: "foreground" as const, result: await executionPort.run(request, runOptions) };
  const runResult = commandTelemetry
    ? await commandTelemetry.run(async () => {
        const observed = await runCommand();
        if (observed.kind === "backgrounded") {
          commandTelemetry.finishBackgrounded();
        } else {
          finishBashCommandTelemetry(commandTelemetry, observed.result);
        }
        return observed;
      })
    : await runCommand();

  if (runResult.kind === "backgrounded") {
    return toBackgroundedBashOutput(runResult.task, parsed);
  }

  const result = runResult.result;
  const resolvedCwd = await readCapturedPowerShellCwd(cwdFilePath);
  const cwdDecision = decideBashCwdPolicy({
    status: result.status,
    exitCode: result.exitCode,
    resolvedCwd,
    workspaceRoot: context.workspaceRoot,
    runtimeScope: context.runtimeScope,
  });
  if (cwdDecision.nextWorkingDirectory) {
    // 与 Bash 同一哲学：项目内保留新 cwd；越界 reset 回工作区并把文案并入 stderr。
    await context.setWorkingDirectory?.(cwdDecision.nextWorkingDirectory);
  }
  return toBashOutput(result, parsed, context, {
    progressTiming,
    stderrSuffix: cwdDecision.stderrSuffix,
  });
}

function createPowerShellExecutionRequest(
  input: BashInput,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
  launch: PowerShellLaunch,
  cwdFilePath: string,
): ExecutionRequest {
  return {
    command: {
      // argv 模式直 spawn：shell 模式对自定义 shell 字符串按 cmd `/d /s /c` 传参，
      // 与 PowerShell 参数面不兼容；不改 execution port 契约（spec R2）。
      mode: "argv",
      file: launch.file,
      // -NoProfile 挡 profile 注入（引擎钩子/历史植入面）；-NonInteractive 让控制台
      // 提示立即失败而非挂起；stdin 缺省 ignore = null 设备。
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        createWrappedPowerShellCommand(input.command, cwdFilePath),
      ],
    },
    cwd: resolveToolWorkingDirectory(undefined, {
      operation: "execute",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    }),
    timeoutMs: resolveBashTimeoutMs(input.timeout, timeoutPolicy),
    outputLimit: {
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxBufferBytes: MAX_INLINE_OUTPUT_BYTES,
      maxPersistedBytes: MAX_RUNTIME_PERSISTED_OUTPUT_BYTES,
      persistOutput: input.run_in_background ? "always" : "on_truncate",
    },
    sandbox: {
      enabled: !input.dangerouslyDisableSandbox,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attributes: {
        toolCallId: context.toolCallId,
        toolName: POWER_SHELL_TOOL_NAME,
      },
    } as unknown as TraceContext,
  };
}

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export function createPowerShellToolEntry(
  options: {
    bashTimeoutPolicy?: BashTimeoutPolicy;
    /** 显式传 null 表达「本机未解析到 PowerShell」（fail-closed，测试/接线用）。 */
    launch?: PowerShellLaunch | null;
  } = {},
): ToolEntry {
  const timeoutPolicy = options.bashTimeoutPolicy ?? DEFAULT_BASH_TIMEOUT_POLICY;
  const launch =
    options.launch === undefined ? defaultPowerShellLaunch() : (options.launch ?? undefined);
  const handler: ToolHandler = (input, context) =>
    executePowerShellHandler(input, context, timeoutPolicy, launch);
  return {
    capability: "Execute Windows-native shell commands through PowerShell",
    metadata: {
      shouldDefer: true, // tool-search wave1a: PowerShell 非常驻名单，默认 defer(specs/tool-search.md R4)
      name: POWER_SHELL_TOOL_NAME,
      description: createPowerShellProviderDescription({
        defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
        edition: launch?.edition ?? "windows-powershell",
        maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
      }),
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      timeoutMs: timeoutPolicy.defaultTimeoutMs,
      maxOutputBytes: 10_000_000,
      sideEffectScope: "system",
      riskLevel: "high",
      needsApproval: true,
    },
    formatModelContent: formatBashModelContent,
    formatPersistedModelContent: formatPersistedBashModelContent,
    handler,
    resolveTimeoutBudgetMs: (input) => {
      const parsed = BashInputSchema.safeParse(input);
      return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
    },
    resolvePermissionCapability: resolvePowerShellPermissionCapability,
    inputSchema: createBashInputJsonSchema(timeoutPolicy),
    outputSchema: BashOutputJsonSchema,
    runtimeInputSchema: BashInputSchema,
    runtimeOutputSchema: BashOutputSchema,
    permission: {
      // 与 Bash 同能力族（bash 同款权限面，spec R4）；规则域按 toolName 独立
      //（matchesRuleToolName 精确匹配，bare Bash 规则不连带本工具——spec 登记项）。
      permission: "bash",
      reason:
        "PowerShell can run subprocesses and may affect workspace, git, network, registry, or system state",
      riskLevel: "high",
      sideEffectScope: "system",
      needsApproval: true,
      patternSources: ["command"],
      alwaysAllowPatternSources: ["command"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxModelBytes: 30_000,
      strategy: "artifact",
      preview: { maxBytes: 30_000, direction: "tail" },
      artifact: { enabled: true, retention: "session" },
    },
    timeout: {
      defaultMs: timeoutPolicy.defaultTimeoutMs,
      maxMs: timeoutPolicy.maxTimeoutMs,
      allowCallOverride: true,
      cleanupGraceMs: 6_000,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: "PowerShell was cancelled and the child process was asked to stop",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

export const powerShellToolEntry: ToolEntry = createPowerShellToolEntry();
