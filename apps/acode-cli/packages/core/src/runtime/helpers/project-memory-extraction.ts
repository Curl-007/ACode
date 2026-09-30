import {
  selectActiveConversationBranch,
  traceContextToLogContext,
  type TraceContext,
} from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { createMemoryRecallInjector, resolveMemoryIdentityKey } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const EXTRACTION_MAX_TURNS = 5;
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * specs/memory-injection-fail-closed.md R9 的写侧 scope guard。
 *
 * Extraction 循环最长 5 轮模型往返，而工具执行器与容器化判定都硬绑在调度时刻的快照上
 * （project-memory-agent.ts:110-112、memory-agent-loop.ts:151-193）；身份源在这段窗口里可变
 * （runtime/methods/resume.ts:125-129 重写 config.memory.workspaceIdentity）。每轮开始前用
 * 既有构造工具重解析一次 memoryRoot 并与绑定值比对，变了就停轮，避免把记忆写进一个
 * 已经不属于本会话的目录。
 */
function createMemoryScopeGuard(
  runtime: AgentRuntimeInternal,
  boundMemoryRoot: string,
): MemoryScopeGuard {
  let superseded = false;
  return {
    isScopeStillCurrent() {
      if (superseded) return false;
      const resolved = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
      if (resolved === boundMemoryRoot) return true;
      superseded = true;
      return false;
    },
    wasSuperseded() {
      return superseded;
    },
  };
}

interface MemoryScopeGuard {
  isScopeStillCurrent(): boolean;
  wasSuperseded(): boolean;
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      const fileSystem = runtime.fileSystemPort;
      if (!fileSystem) {
        // 没有文件系统端口就无法重读验证任何记忆，fail-closed：不注入清单、不跑循环、不写文件。
        runtime.logger?.warn("Project memory extraction discarded: no file system port", {
          ...traceContextToLogContext(input.snapshot.traceContext),
          event: "memory.extraction.scope_superseded",
          module: "core.runtime",
          reason: "storage-error",
          status: "failed",
        });
        telemetry.finishFailed("execute", "internal", new Error("missing file system port"));
        return "no-op" as const;
      }

      // fail-closed（specs/memory-injection-fail-closed.md R8）：快照里的 memoryRoot 是**调度时刻**
      // 解析的，而队列可以把这次 Extraction 拖到任意晚——memory/extraction.ts:160-169 的 coalescing
      // 在有 extraction 正在跑时只把新快照存进 latestPending，前一次最多 5 轮模型往返。
      // 身份源在这段窗口里是可变的：resume 用会话落盘身份重写 config.memory.workspaceIdentity
      // （runtime/methods/resume.ts:125-129），配置也有运行期写入口（runtime/methods/config.ts:56）。
      // memoryRoot 是 identity + cliStorageRoot + workspacePath 经既有构造工具
      // resolveProjectMemoryRoot 得到的唯一结果，所以它就是 scope 的单一判据：不一致（含记忆被
      // 停用 → undefined）就整体放弃这次 run。读侧丢弃只是少一份清单，写侧继续跑会把记忆写进
      // 另一个 workspace 的目录，故这里比清单丢弃更严。
      const currentMemoryRoot = resolveEnabledProjectMemoryRoot(
        runtime.config,
        runtime.workspaceRoot,
      );
      if (currentMemoryRoot !== input.snapshot.memoryRoot) {
        runtime.logger?.warn(
          "Project memory extraction discarded: memory scope changed while queued",
          {
            ...traceContextToLogContext(input.snapshot.traceContext),
            event: "memory.extraction.scope_superseded",
            module: "core.runtime",
            reason: currentMemoryRoot === undefined ? "disabled" : "scope-changed",
            status: "failed",
          },
        );
        // superseded：这次 run 绑定的 scope 已被替换。no-op 会推进 cursor（extraction.ts:122），
        // error 不会——那会让同一个窗口每次触发都重抽且不保证收敛，与本文件下方
        // 「到顶仍返回 success」已记录的取舍同源。
        telemetry.finishCancelled("superseded");
        return "no-op" as const;
      }

      const identityKey = resolveMemoryIdentityKey({
        workspaceIdentity: runtime.config.memory?.workspaceIdentity,
        workspacePath: runtime.workspaceRoot,
      });
      // 注入通道每次 run 新建：Extraction 关闭三层去重（每条 run 都是全新子代理上下文，
      // 抑制清单只会造成重复记忆，见 spec R5），账本因此没有跨 run 状态需要持有。
      const injector = createMemoryRecallInjector({ fileSystem, logger: runtime.logger });
      const recall = await injector.inject({
        dedupe: false,
        identityKey,
        memoryRoot: currentMemoryRoot,
        // 写侧子代理必须能 Read/Edit 具体文件，故用 target 形态（位置引用 + 相对路径）；
        // 路径来自目录扫描结果，不来自记忆内容（spec R6）。
        presentation: "target",
        signal: input.abortSignal,
        traceContext: input.snapshot.traceContext,
      });
      if (input.abortSignal.aborted) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      const prompt = buildMemoryExtractionPrompt({
        messageCount: input.messageCount,
        // 清单被 fail-closed 丢弃（injector 已 warn `memory.recall.discarded`）或目录为空时，
        // 整块不出现，Extraction 仍继续：少一份清单最多让模型多做一次查重（它有 Read/Grep/Glob），
        // 注入一份与盘上不一致的清单会让它基于已被改写/删除的记忆决定「更新哪个文件」。
        ...(recall.status === "injected" ? { recallBlock: recall.text } : {}),
      });
      const providerMessages = buildProjectMemoryAgentProviderMessages(
        runtime,
        input.snapshot,
        prompt,
      );
      const executor = createProjectMemoryAgentToolExecutor(runtime, input.snapshot);
      const scopeGuard = createMemoryScopeGuard(runtime, currentMemoryRoot);

      const loop = await runMemoryAgentLoop({
        abortSignal: input.abortSignal,
        executeTool: (toolCall, options) =>
          executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: input.snapshot.traceContext,
          }),
        isScopeStillCurrent: scopeGuard.isScopeStillCurrent,
        maxTurns: EXTRACTION_MAX_TURNS,
        messages: providerMessages,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        tools: input.snapshot.tools,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      // scope 中止必须优先于 capped 消费：runMemoryAgentLoop 的返回值形状刻意不变
      // （capped 仍只表示「到顶」，tests/subagent-maxturns-dangling.test.mjs 钉住这三个键），
      // 中止事实由 guard 自己承载，否则一次 scope 变更会被误报成 turn cap
      // （specs/memory-injection-fail-closed.md R9）。
      if (scopeGuard.wasSuperseded()) {
        runtime.logger?.warn("Project memory extraction stopped: memory scope changed mid-loop", {
          ...traceContextToLogContext(input.snapshot.traceContext),
          event: "memory.extraction.scope_superseded",
          module: "core.runtime",
          reason: "scope-changed",
          status: "failed",
          turns: loop.turns,
        });
        telemetry.finishCancelled("superseded");
        return "no-op" as const;
      }
      // 到顶截断必须与自然收尾分开记录：模型在第 EXTRACTION_MAX_TURNS 轮仍在索取工具时，
      // 抽取是**被切断**的（memory 文件可能只写了一半），而 `turns` 单独区分不了两者
      // （自然收尾在 break 前 +1、到顶由循环头 +1，都可以等于 maxTurns）。
      // 见 specs/command-terminal-state-audit.md §A。
      if (loop.capped) {
        runtime.logger?.warn("Project memory extraction hit the turn cap", {
          ...traceContextToLogContext(input.snapshot.traceContext),
          event: "memory.extraction.turn_capped",
          maxTurns: EXTRACTION_MAX_TURNS,
          module: "core.runtime",
          turns: loop.turns,
        });
      }
      telemetry.finishCompleted();
      // 到顶仍返回 success（cursor 照常推进）。取舍：MemoryExtractionExecutionStatus 是
      // extraction.ts 内的闭合四值联合（success/no-op/error/aborted），没有「截断」这一档，
      // 而 error/aborted 都不推进 cursor —— 那会让同一窗口在每次触发时反复重抽
      // （每轮最多 EXTRACTION_MAX_TURNS 次模型调用）且不保证收敛。本项只补可观测性，
      // 不改重抽策略；若产品要求到顶重试，需另立项并给出重试上界。
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
