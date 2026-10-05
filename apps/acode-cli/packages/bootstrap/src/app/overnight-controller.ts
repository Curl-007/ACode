// K3「Overnight 挂机执行」接线层（specs/overnight-execution.md）：把 core 的 run 编排
// （overnight/runner.ts）绑到 CLI agent 进程的真实驱动面。
//
// 绑定事实（选择依据见同目录先例）：
// - coordinator fork：进程内没有 packages/services 的远端任务服务（那是 desktop/server 形态）；
//   agent 侧「sourceTaskId fork」的等价物是既有 session fork 链——
//   runtime.forkWorkspaceFromCheckpoint({ targetMessageId })（message 目标形态：
//   「历史包含目标回合、不回退其后 checkpoint」，正对「fork 全部父 messages 于当下」；
//   先例：TUI /fork → app.forkFromCheckpoint）。provider 配置经子 runtime 的
//   setSessionModelSelection 显式继承（legacy fork 不复制选型 entry；R1 不跨重启，
//   运行期内存绑定即完整）。
// - turn 驱动：子 AgentRuntime.executeTurn（先例：script-workflow-runtime.ts 的 actor
//   驱动面——非交互任务的每轮 turn 由宿主直接调 executeTurn，与 cron 派发最终汇入的
//   是同一个 turn 执行面）。
// - 子 runtime 复用 createScriptWorkflowAgentRuntime 的装配（共享 sessionStore/eventStore/
//   ports/eventSink 的唯一子会话装配线），以 configOverrides 恢复 overnight 语义：
//   mode 沿用父会话（J1 分级与 permission 管线不因挂机放宽）、subagents 保留
//   （运营契约允许在有正期望时派 helper）、taskType 对齐落盘的 fork 会话。
import { join } from "node:path";
import type {
  ExecutionPort,
  FileSystemPort,
  MessageId,
  ModelSelection,
  TraceContext,
} from "@acode/contracts";
import type { RuntimeTaskRegistry } from "@acode/core";
import {
  startOvernightRun,
  type OvernightCoordinatorForkRequest,
  type OvernightCoordinatorLease,
  type OvernightCoordinatorPort,
  type OvernightPreflightCollectors,
  type OvernightPreflightGitSnapshot,
  type OvernightRunHandle,
} from "@acode/core";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import type { ScriptWorkflowAgentRuntimeDeps } from "./script-workflow-child-runtime.js";
import type { ACodeBuiltinHostCommand } from "../builtin-prompt-command.js";

export interface CreateOvernightControllerDeps extends ScriptWorkflowAgentRuntimeDeps {
  executionPort: ExecutionPort;
  fileSystemPort: FileSystemPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  traceContext: TraceContext;
}

export interface OvernightStartResult {
  ok: boolean;
  runId?: string;
  /** 给用户看的回执（拦截面展示；不进模型）。 */
  response: string;
}

export interface OvernightController {
  start(durationMs: number, traceContext?: TraceContext): Promise<OvernightStartResult>;
  cancel(): OvernightStartResult;
  /** 入口拦截面的统一消费点：解析后的结构化动作 → 宿主动作。 */
  handleHostCommand(
    command: ACodeBuiltinHostCommand,
    traceContext?: TraceContext,
  ): Promise<OvernightStartResult>;
  getActiveRunId(): string | undefined;
  /** app 关闭面（R1 生命周期绑定）：收口 runtime-task 投影。 */
  dispose(): void;
}

const GIT_SNAPSHOT_TIMEOUT_MS = 10_000;

function parseGitStatusPorcelain(stdout: string): OvernightPreflightGitSnapshot {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const branchLine = lines.find((line) => line.startsWith("## "));
  if (!branchLine) return { error: "git status --branch 未返回分支行（可能不在 git 仓库内）" };
  const branchSegment = branchLine.slice(3).split("...")[0]!.trim();
  return {
    branch: branchSegment.length > 0 ? branchSegment : undefined,
    dirty: lines.length > 1,
  };
}

export function createOvernightController(deps: CreateOvernightControllerDeps): OvernightController {
  const logger = deps.logger;
  let activeRun: OvernightRunHandle | undefined;

  const scriptWorkflowDeps: ScriptWorkflowAgentRuntimeDeps = {
    appOptions: deps.appOptions,
    appVersion: deps.appVersion,
    ...(deps.artifactStore ? { artifactStore: deps.artifactStore } : {}),
    configResult: deps.configResult,
    ...(deps.contextSourcePort ? { contextSourcePort: deps.contextSourcePort } : {}),
    fileSystemPort: deps.fileSystemPort,
    ...(deps.httpClientPort ? { httpClientPort: deps.httpClientPort } : {}),
    imageProcessorPort: deps.imageProcessorPort,
    logger: deps.logger,
    ...(deps.pdfDocumentPort ? { pdfDocumentPort: deps.pdfDocumentPort } : {}),
    ...(deps.mcpPort ? { mcpPort: deps.mcpPort } : {}),
    modelFactory: deps.modelFactory,
    permissionService: deps.permissionService,
    runtime: deps.runtime,
    runtimeConfig: deps.runtimeConfig,
    sessionId: deps.sessionId,
    sessionStore: deps.sessionStore,
    storageRoot: deps.storageRoot,
    workingDirectory: deps.workingDirectory,
  };

  // spec 的产物路径是 workspace 相对形态（.acode/overnight/...）；宿主探测/写盘必须
  // 解析到同一 workingDirectory（coordinator 的 Write 工具也以它为 cwd）。
  const overnightWorkspaceFile = (...segments: string[]): string =>
    join(deps.workingDirectory, ".acode", "overnight", ...segments);

  const preflightCollectors: OvernightPreflightCollectors = {
    collectMemory: () => {
      const usage = process.memoryUsage();
      return {
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
      };
    },
    collectGitStatus: async () => {
      try {
        const result = await deps.executionPort.run({
          // argv 形态不经 shell（preflight 是引擎采集面，不是模型工具调用，
          // 不需要会话 shell 选择语义），git 在 PATH 缺席时按采集失败处理。
          command: { mode: "argv", file: "git", args: ["status", "--porcelain=v1", "--branch"] },
          cwd: deps.workingDirectory,
          timeoutMs: GIT_SNAPSHOT_TIMEOUT_MS,
          trace: deps.traceContext,
        });
        if (result.status !== "completed") {
          return { error: `git status ${result.status}（exit ${result.exitCode ?? "?"}）` };
        }
        return parseGitStatusPorcelain(result.stdout.text);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const coordinator: OvernightCoordinatorPort = {
    forkCoordinatorTask: async (request: OvernightCoordinatorForkRequest) => {
      const runtime = deps.runtime;
      // fork 全部父 messages 于当下：targetMessageId = 父 active 分支最后一条消息
      // （coordinator.ts 的投影已给出）。message 目标形态只撤销其后 checkpoint——
      // 目标即最新消息时等价纯对话 fork，不动工作区文件。
      const forked = await runtime.forkWorkspaceFromCheckpoint({
        targetMessageId: request.targetMessageId as MessageId,
        traceContext: deps.traceContext,
      });
      const childRuntime = createScriptWorkflowAgentRuntime({
        childSessionId: forked.forkedSessionId,
        deps: scriptWorkflowDeps,
        // 与 create-app 的 run service 装配同款：request 只是工厂签名占位（opts 为空 =
        // 不覆盖任何东西），overnight 的差异全部经 configOverrides 表达。
        request: { opts: {} } as never,
        traceContext: deps.traceContext,
        configOverrides: {
          agentName: "acode-overnight",
          // dwf child 的 yolo 是 actor 的信任假设；overnight 沿用父会话分级（R1 红线：
          // 权限语义不放宽）。父 mode 缺席时置 undefined，让 runtime 走默认分级。
          mode: deps.runtimeConfig.mode,
          // dwf child 禁 subagents；运营契约要求 helper 只在正期望时可用——保留。
          subagents: { enabled: true },
          // 与落盘 child session 的 taskType 对齐（buildForkedSessionInput 的 "fork"）。
          taskType: "fork",
        },
      });
      // provider 配置继承：legacy fork 链不复制选型 entry，显式绑定父会话当前选择。
      // R1 生命周期绑定 app 运行期——内存绑定即完整，不需要持久化面。
      const parentSelection: ModelSelection | undefined = runtime.getSessionModelSelection();
      if (parentSelection) {
        childRuntime.setSessionModelSelection(parentSelection);
      }
      const lease: OvernightCoordinatorLease = {
        taskId: String(forked.forkedSessionId),
        runCoordinatorTurn: async (prompt) => {
          try {
            await childRuntime.executeTurn(prompt, undefined, {
              traceContext: deps.traceContext,
            });
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      };
      return lease;
    },
  };

  const controller: OvernightController = {
    async start(durationMs, traceContext) {
      if (activeRun) {
        return {
          ok: false,
          response: `已有进行中的 overnight run（${activeRun.runId}）；先用 /overnight cancel 停止再启动新的 run。`,
        };
      }
      const runtime = deps.runtime;
      let handle: OvernightRunHandle;
      try {
        handle = await startOvernightRun({
          parentTaskId: String(runtime.getSessionId()),
          durationMs,
          coordinator,
          getParentFacts: async () => {
            const parentSession = await deps.sessionStore.getSession(deps.sessionId);
            if (!parentSession) {
              throw new Error(`overnight fork 找不到父会话 ${String(deps.sessionId)}`);
            }
            return {
              parentMessages: await deps.sessionStore.messages({ sessionID: deps.sessionId }),
              parentSession,
              modelSelection: runtime.getSessionModelSelection(),
            };
          },
          writePreflightReport: async (path, content) => {
            // preflight 是引擎工件（见 core/overnight/preflight.ts 文件头论证）：
            // 接线层经 fileSystemPort 直写，不经 Write 工具/权限管线。
            await deps.fileSystemPort.writeTextFile({
              path: overnightWorkspaceFile(...path.split(/[\\/]/)),
              content,
              createParents: true,
              atomic: true,
              trace: traceContext ?? deps.traceContext,
            });
          },
          preflightCollectors,
          morningReportExists: async (runId) => {
            try {
              const stat = await deps.fileSystemPort.stat({
                path: overnightWorkspaceFile(runId, "morning-report.md"),
                trace: deps.traceContext,
              });
              return stat.kind === "file";
            } catch {
              // 探测失败按不存在处理（supervisor 的 fail-safe 方向，R5）
              return false;
            }
          },
          taskRegistry: deps.runtimeTaskRegistry,
          countTaskCards: async (runId) => {
            try {
              const listing = await deps.fileSystemPort.listDirectory({
                path: overnightWorkspaceFile(runId, "cards"),
                trace: deps.traceContext,
              });
              return listing.entries.filter(
                (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
              ).length;
            } catch {
              return 0;
            }
          },
          collectMemorySample: () => process.memoryUsage().rss,
          onEvent: (event) => {
            if (event.type === "overnight.started") {
              logger?.info("Overnight run started", {
                event: "overnight.run.started",
                module: "bootstrap.overnight",
                runId: event.runId,
                targetWakeAtMs: event.targetWakeAtMs,
              });
            } else if (event.type === "overnight.completed") {
              logger?.info("Overnight run completed", {
                cancelled: event.cancelled,
                event: "overnight.run.completed",
                module: "bootstrap.overnight",
                runId: event.runId,
              });
            } else if (event.type === "overnight.failed") {
              logger?.error(
                "Overnight run failed",
                undefined,
                {
                  event: "overnight.run.failed",
                  module: "bootstrap.overnight",
                  runId: event.runId,
                  ...(event.error ? { error: event.error } : {}),
                },
              );
            } else if (event.type === "overnight.turn_long_running") {
              logger?.warn("Overnight coordinator turn still running", {
                elapsedMs: event.elapsedMs,
                event: "overnight.turn_long_running",
                module: "bootstrap.overnight",
                runId: event.runId,
              });
            }
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn("Overnight run start failed", {
          error: message,
          event: "overnight.run.start_failed",
          module: "bootstrap.overnight",
        });
        return { ok: false, response: `overnight run 启动失败：${message}` };
      }
      activeRun = handle;
      // 终态后清空 active 槽，允许下一次 /overnight。
      void handle.completion.finally(() => {
        if (activeRun === handle) activeRun = undefined;
      });
      return {
        ok: true,
        runId: handle.runId,
        response: `Overnight run ${handle.runId} 已启动：fork 隐藏 coordinator 自当前会话，持续自主工作到目标时刻。取消用 /overnight cancel。`,
      };
    },
    cancel() {
      const run = activeRun;
      if (!run) {
        return { ok: false, response: "当前没有进行中的 overnight run。" };
      }
      run.requestCancel();
      return {
        ok: true,
        runId: run.runId,
        response: `已请求取消 overnight run ${run.runId}（协作式：当前 turn 完整收尾后终止）。`,
      };
    },
    async handleHostCommand(command, traceContext) {
      if (command.kind === "overnight-cancel") {
        return controller.cancel();
      }
      if (command.kind === "overnight-invalid") {
        return { ok: false, response: command.error };
      }
      return await controller.start(command.durationMs, traceContext);
    },
    getActiveRunId: () => activeRun?.runId,
    dispose() {
      activeRun?.dispose();
    },
  };
  return controller;
}
