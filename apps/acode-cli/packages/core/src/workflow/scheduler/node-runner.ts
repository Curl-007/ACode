import {
  createChildTraceContext,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
} from "@acode/contracts";
import { WorkflowSchedulerEventLog } from "./events.js";
import { addArtifact, compactWorkflowPayload, updateGraphNode, upsertActivity } from "./graph.js";
import { executeNodeSubsession } from "./node-execution-core.js";
import { buildDefaultNodePrompt, safeArtifactName } from "./prompts.js";
import { isArtifactGateWorkerNode } from "../artifact-gate.js";
import type {
  NodeRunStarted,
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerSnapshotAccess,
  WorkflowSchedulerNodePromise,
} from "./types.js";

export interface WorkflowNodeRunnerRuntime {
  createActivityId: () => string;
  eventLog: WorkflowSchedulerEventLog;
  runner: WorkflowGraphSchedulerDeps["runner"];
  writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];
}

export function runWorkflowNode(
  snapshotAccess: WorkflowGraphSchedulerSnapshotAccess,
  node: WorkflowGraphNode,
  options: WorkflowGraphSchedulerRunOptions,
  maxAttempts: number,
  runtime: WorkflowNodeRunnerRuntime,
): WorkflowSchedulerNodePromise {
  let resolveStarted: (value: NodeRunStarted) => void = () => {};
  const started = new Promise<NodeRunStarted>((resolve) => {
    resolveStarted = resolve;
  });
  const promise = (async () => {
    const initialSnapshot = snapshotAccess.getSnapshot();
    const activityId = runtime.createActivityId();
    const startedAt = runtime.eventLog.timestamp();
    const inputArtifactPaths = initialSnapshot.artifacts.map((artifact) => artifact.path);
    const traceContext = options.traceContext
      ? createChildTraceContext(options.traceContext, {
          attributes: {
            workflowActivityId: activityId,
            workflowKind: initialSnapshot.kind,
            workflowNodeId: node.id,
            workflowPhase: options.phase,
            workflowRunId: initialSnapshot.runId,
          },
          sessionId: options.traceContext.sessionId,
        })
      : undefined;
    const activeSnapshot = upsertActivity(
      updateGraphNode(initialSnapshot, node.id, {
        error: undefined,
        status: "active",
      }),
      {
        activityId,
        inputArtifactPaths,
        kind: "agent_session",
        nodeId: node.id,
        outputArtifactPaths: [],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        startedAt,
        status: "active",
        traceId: traceContext?.traceId,
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(activeSnapshot, { signal: options.abortSignal });
    snapshotAccess.setSnapshot(activeSnapshot);
    await runtime.eventLog.appendGraphStatus(
      activeSnapshot,
      node.id,
      options.phase,
      "active",
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(activeSnapshot, "node_started", {
      message: `Node started: ${node.title}`,
      nodeId: node.id,
      phase: options.phase,
      signal: options.abortSignal,
    });
    resolveStarted({ snapshot: activeSnapshot });

    try {
      // K2（specs/swarm-task-graph.md R4/接口章）：子会话执行 + response→typed 提取 +
      // artifact-or-nothing 裁策改经共享原语（node-execution-core.ts，expert 与 swarm runner
      // 同一份语义）。原语只是既有决策的结构移动：reason 映射、封顶表达式、错误文案与
      // 事件写序逐字节保留——expert 行为零回归是 K2 红线（workflow-typed-artifacts 全场景
      // 重跑钉住）。enforce 的判定（deep 档且仅 worker/task 节点，评审 J2 修复：phase 容器
      // 节点的提示词走 buildPhasePrompt 早退分支，对它强制等于「不告知规则却判违规」的
      // 确定性 requeue→fail 死路，spec「边界与非目标」）留在调用方——它拥有图语义。
      const gate = options.artifactGate;
      const { rejection, result, typed } = await executeNodeSubsession({
        enforcement: {
          enforce: gate?.preset === "deep" && isArtifactGateWorkerNode(node),
          maxArtifactRequeues: gate ? gate.maxArtifactRequeues : 0,
          priorArtifactRequeues: node.artifactRequeues ?? 0,
        },
        request: {
          abortSignal: options.abortSignal,
          activityId,
          cwd: options.cwd,
          node,
          onChildSessionStarted: async (event) => {
            const latestSnapshot = snapshotAccess.getSnapshot();
            const currentActivity = latestSnapshot.activities.find(
              (activity) => activity.activityId === activityId,
            );
            if (!currentActivity || currentActivity.status !== "active") return;
            const childStartedSnapshot = upsertActivity(
              latestSnapshot,
              {
                ...currentActivity,
                ...(event.model ? { model: event.model } : {}),
                sessionId: event.sessionId,
                traceId: event.traceId ?? currentActivity.traceId,
                turnId: event.turnId ?? currentActivity.turnId,
              },
              runtime.eventLog.timestamp(),
            );
            await runtime.writeSnapshot(childStartedSnapshot, { signal: options.abortSignal });
            snapshotAccess.setSnapshot(childStartedSnapshot);
            await runtime.eventLog.emitEvent(childStartedSnapshot, "workflow_session_linked", {
              message: `Workflow session linked: ${event.sessionId}`,
              nodeId: node.id,
              payload: compactWorkflowPayload({
                activityId,
                model: event.model,
                sessionId: event.sessionId,
                traceId: event.traceId,
                turnId: event.turnId,
              }),
              phase: options.phase,
              signal: options.abortSignal,
            });
          },
          onEvent: options.onEvent,
          parentSessionId: options.parentSessionId,
          phase: options.phase,
          prompt: options.buildPrompt
            ? options.buildPrompt({ node, phase: options.phase, snapshot: activeSnapshot })
            : buildDefaultNodePrompt(activeSnapshot, node, options.phase, options.artifactGate),
          runId: activeSnapshot.runId,
          task: activeSnapshot.task,
          traceContext,
        },
        runner: runtime.runner,
      });
      // J2-3（specs/workflow-typed-artifacts.md R2-R4）：typed artifact 提取与分档强制。
      // light：有效块挂载到 artifact.typed，无效/缺失忽略（零回归）；deep：缺失或薄
      // artifact 走 artifact-or-nothing——requeue 一次（封顶 maxArtifactRequeues），再犯 fail。
      // 裁决已由共享原语给出（rejection），这里只保留 workflow 状态机的落图与事件簿记。
      if (rejection !== null) {
        const artifactRequeues = rejection.artifactRequeues;
        const willRequeue = rejection.willRequeue;
        const nextStatus: WorkflowNodeStatus = willRequeue ? "pending" : "failed";
        const errorMessage = rejection.errorMessage;
        const latestSnapshot = snapshotAccess.getSnapshot();
        const currentActivity = latestSnapshot.activities.find(
          (activity) => activity.activityId === activityId,
        );
        const requeuedSnapshot = upsertActivity(
          updateGraphNode(latestSnapshot, node.id, {
            artifactRequeues,
            error: errorMessage,
            status: nextStatus,
          }),
          {
            activityId,
            completedAt: runtime.eventLog.timestamp(),
            error: errorMessage,
            inputArtifactPaths,
            kind: "agent_session",
            ...(currentActivity?.model ? { model: currentActivity.model } : {}),
            nodeId: node.id,
            outputArtifactPaths: [],
            parentSessionId: options.parentSessionId,
            phase: options.phase,
            sessionId: result.sessionId,
            startedAt,
            status: nextStatus,
            traceId: result.traceId ?? traceContext?.traceId,
            turnId: result.turnId,
          },
          runtime.eventLog.timestamp(),
        );
        await runtime.writeSnapshot(requeuedSnapshot, { signal: options.abortSignal });
        snapshotAccess.setSnapshot(requeuedSnapshot);
        await runtime.eventLog.appendGraphStatus(
          requeuedSnapshot,
          node.id,
          options.phase,
          nextStatus,
          options.abortSignal,
        );
        // 复用既有 node_failed 事件（不新增枚举）：payload.artifactRequeue 区分修复通道。
        // requeue 返回 ok:true——它是修复通道不是执行错误，不计入 consecutiveErrors；
        // 封顶后的 fail 与既有 error-retry 同形（ok:false，error_threshold 保险丝继续生效）。
        await runtime.eventLog.emitEvent(requeuedSnapshot, "node_failed", {
          message: errorMessage,
          nodeId: node.id,
          payload: { artifactRequeue: true, artifactRequeues, retry: willRequeue },
          phase: options.phase,
          signal: options.abortSignal,
        });
        return { nodeId: node.id, ok: willRequeue, snapshot: requeuedSnapshot };
      }
      const artifact = await runtime.writeArtifact(
        activeSnapshot.runId,
        `${options.artifactDirectory ?? "artifacts/exec"}/${safeArtifactName(node.id)}.md`,
        result.response,
        { signal: options.abortSignal },
      );
      const latestSnapshot = snapshotAccess.getSnapshot();
      const completedSnapshot = addArtifact(
        upsertActivity(
          updateGraphNode(latestSnapshot, node.id, {
            attempts: node.attempts,
            error: undefined,
            status: "completed",
          }),
          {
            activityId,
            artifactPath: artifact.relativePath,
            completedAt: runtime.eventLog.timestamp(),
            inputArtifactPaths,
            kind: "agent_session",
            nodeId: node.id,
            outputArtifactPaths: [artifact.relativePath],
            parentSessionId: options.parentSessionId,
            phase: options.phase,
            ...(result.model ? { model: result.model } : {}),
            sessionId: result.sessionId,
            startedAt,
            status: "completed",
            traceId: result.traceId ?? traceContext?.traceId,
            turnId: result.turnId,
          },
          runtime.eventLog.timestamp(),
        ),
        {
          contentType: "text/markdown",
          createdAt: runtime.eventLog.timestamp(),
          label: node.title,
          path: artifact.relativePath,
          phase: options.phase,
          // J2-3：typed 段随 artifact 记录落 snapshot（critic gate 的置信度债务数据源）。
          ...(typed ? { typed } : {}),
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(completedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(completedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        completedSnapshot,
        node.id,
        options.phase,
        "completed",
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(completedSnapshot, "artifact_written", {
        message: `Artifact written: ${artifact.relativePath}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      await runtime.eventLog.emitEvent(completedSnapshot, "node_completed", {
        message: `Node completed: ${node.title}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: true, snapshot: completedSnapshot };
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw error;
      }
      const attempts = (node.attempts ?? 0) + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const nextStatus: WorkflowNodeStatus = attempts >= maxAttempts ? "failed" : "pending";
      const latestSnapshot = snapshotAccess.getSnapshot();
      const currentActivity = latestSnapshot.activities.find(
        (activity) => activity.activityId === activityId,
      );
      const failedSnapshot = upsertActivity(
        updateGraphNode(latestSnapshot, node.id, {
          attempts,
          error: errorMessage,
          status: nextStatus,
        }),
        {
          activityId,
          completedAt: runtime.eventLog.timestamp(),
          error: errorMessage,
          inputArtifactPaths,
          kind: "agent_session",
          ...(currentActivity?.model ? { model: currentActivity.model } : {}),
          nodeId: node.id,
          outputArtifactPaths: [],
          parentSessionId: options.parentSessionId,
          phase: options.phase,
          ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
          startedAt,
          status: nextStatus,
          traceId: currentActivity?.traceId ?? traceContext?.traceId,
          ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(failedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(failedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        failedSnapshot,
        node.id,
        options.phase,
        nextStatus,
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(failedSnapshot, "node_failed", {
        message: errorMessage,
        nodeId: node.id,
        payload: { attempts, retry: nextStatus === "pending" },
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: false, snapshot: failedSnapshot };
    }
  })() as WorkflowSchedulerNodePromise;
  promise.started = started;
  return promise;
}
