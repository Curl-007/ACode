// K2「对话内 Swarm 任务图」2b 装配层（specs/swarm-task-graph.md R4/R5/R6）：把 core 的
// plan store / runner / 持久化 seam / runtime-task 投影绑成 SwarmPlanPort，交给主
// runtime 的 deps（AgentRuntimeDeps.swarmPlanPort）。
//
// 绑定事实（选择依据见同目录先例）：
// - 子会话执行：createScriptWorkflowAgentRuntime 的装配线（overnight-controller.ts 同款
//   先例——共享 sessionStore/eventStore/ports 的唯一子会话装配线），taskType 用其缺省的
//   workflow_child 语义（spec R4「以 workflow 子会话形态执行」；worker 注入同一 port，
//   runtime-tools 按 taskType 只注册只读 PlanStatus，R5）。
// - 执行原语：executeNodeSubsession（node-execution-core.ts）。enforce 置 false——
//   swarm 的 artifact-or-nothing 裁决所有者是 runner 的 settle 面（2a 已测），闭包不
//   重复拥有第二份 enforcement；原语在此承担「子会话执行 + 提取」共享面，expert/swarm
//   的子会话行为不会各自漂移。
// - abort：PlanControl cancel 落图（cancel-node/cancel-plan → running 节点出队）后，
//   由 store 的 onChange 观测推导「哪些在飞执行已不被图承认」并 abort 其子会话
//   （runner 的 stale run 防护负责丢弃迟到结果，本层负责不再烧 token）。
// - 持久化：sessionStore 的 duck-typing seam（swarm/runtime-binding.ts，K4 先例）绑
//   SQLite 行（repositories/swarm-plans.ts，migration 0026）；能力缺席按纯内存降级。
// - 投影：plan 活跃时注册 runtime task（type: "swarm_plan"，registry 联合的取消语义
//   分组决策见 runtime-task/registry.ts 注释），计数与图摘要随每次提交刷新。
//
// 装配时序：本 wiring 在主 runtime 构造**前**创建（port 进 deps），runtime 实例构造后
// bindRuntime 绑定 executeNode 的迟到引用（overnight controller 的同款先后序——fork/turn
// 驱动都需要 runtime 实例，而调度点只在成功 turn 后才会触发，绑定时序安全）。

import type { SessionStorePort, TraceContext } from "@acode/contracts";
import {
  bindSwarmPlanPersistenceFromSessionStore,
  createSwarmPlanStore,
  createSwarmRunner,
  deriveSwarmAbortedNodeIds,
  syncSwarmPlanRuntimeTask,
  type SwarmExecuteNode,
  type SwarmPlanPort,
} from "@acode/core";
import type { AgentRuntime, RuntimeTaskRegistry } from "@acode/core";
import { executeNodeSubsession } from "@acode/core";
import { createChildTraceContext, createSessionId } from "@acode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "@acode/cli-workflow/contract";

export interface CreateSwarmPlanWiringDeps extends Omit<ScriptWorkflowAgentRuntimeDeps, "runtime"> {
  runtimeTaskRegistry: RuntimeTaskRegistry;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
}

export interface SwarmPlanWiring {
  /** 主 runtime deps 的注入面（工具注册门 + turn 调度点 + reminder 的消费端）。 */
  port: SwarmPlanPort;
  /** 主 runtime 构造后绑定 executeNode 的迟到引用（见文件头「装配时序」）。 */
  bindRuntime(runtime: AgentRuntime): void;
  /** 启动/恢复时从持久化行恢复 plan 并同步初始 runtime-task 投影（一次性）。 */
  hydrate(traceContext?: TraceContext): Promise<void>;
  /** app 关闭面：abort 全部在飞 worker 子会话（投影条目随 plan 生命周期收口）。 */
  dispose(): void;
}

export function createSwarmPlanWiring(deps: CreateSwarmPlanWiringDeps): SwarmPlanWiring {
  const logger = deps.logger;
  // duck-typing 在装配期完成一次：测试替身/远程 store 缺席时按纯内存降级（info 不是
  // warn——这是能力探测的正常分支，不是故障）。
  const persistence = bindSwarmPlanPersistenceFromSessionStore(deps.sessionStore, {
    sessionID: deps.sessionId,
  });
  if (persistence === undefined) {
    logger?.info("Swarm plan persistence unavailable; plan stays in-memory for this session", {
      event: "swarm.plan.persistence_unavailable",
      module: "bootstrap.swarm",
    });
  }

  // 在飞执行的 abort 面：nodeId → 当前执行实例的 controller（一节点同时最多一个在飞
  // 执行——claim 门槛保证；requeue 换执行 = 新 controller 覆盖旧 key，旧的已被 finally 清除）。
  const inFlightControllers = new Map<string, AbortController>();
  const runtimeTaskId = `swarm-plan:${String(deps.sessionId)}`;

  let boundRuntime: AgentRuntime | undefined;
  const resolveRuntime = (): AgentRuntime => {
    if (boundRuntime === undefined) {
      throw new Error("Swarm plan wiring executed a node before bindRuntime() was called.");
    }
    return boundRuntime;
  };

  const store = createSwarmPlanStore({
    // 存储边界告警面（H2 hydrate 复位 / L2 clear 写穿失败的生产 warn）。
    logger: deps.logger,
    onChange: ({ plan, previous }) => {
      // cancel 的在飞 abort（2a 登记的残留）：running→非 running（或 plan 清除）的节点，
      // 其子会话回合不再被图承认——abort，让 executeTurn 以取消收尾（迟到结果由 runner
      // 的 stale run 防护丢弃）。
      for (const nodeId of deriveSwarmAbortedNodeIds(previous, plan)) {
        const controller = inFlightControllers.get(nodeId);
        if (controller === undefined) continue;
        controller.abort();
        logger?.info("Swarm worker subsession aborted after plan change", {
          event: "swarm.plan.worker_aborted",
          module: "bootstrap.swarm",
          nodeId,
        });
      }
      // runtime-task 投影（R4 唯一可见面）：每次提交后同步一次。
      syncSwarmPlanRuntimeTask({ plan, registry: deps.runtimeTaskRegistry, taskId: runtimeTaskId });
    },
    ...(persistence === undefined ? {} : { persistence }),
  });

  const executeNode: SwarmExecuteNode = async ({ node, owner, prompt }) => {
    const runtime = resolveRuntime();
    const controller = new AbortController();
    inFlightControllers.set(node.id, controller);
    // child 会话身份：owner 是 runner 生成的唯一执行实例 id（requeue 换执行 = 换会话），
    // 对齐 workflow_${activityId} 的可读前缀形态。
    const childSessionId = createSessionId(`swarm_${node.id}_${owner}`);
    const childTraceContext = createChildTraceContext(deps.traceContext, {
      attributes: {
        parentSessionId: String(deps.sessionId),
        swarmNodeId: node.id,
        swarmOwner: owner,
      },
      sessionId: childSessionId,
    });
    try {
      const childRuntime = createScriptWorkflowAgentRuntime({
        childSessionId,
        deps: { ...deps, runtime },
        // 工厂只读 opts（agentType/tools/systemPrompt 等）；prompt 是入参形状的必填位，
        // 传 R3 装配好的全文（下游不消费它——执行统一走下面的 subsessionRunner）。
        request: { opts: { agentType: "acode-swarm-worker" }, prompt },
        traceContext: childTraceContext,
        configOverrides: {
          agentName: "acode-swarm-worker",
          // H3（批次B对抗复核）：工厂缺省的 yolo 是 dwf actor 的信任假设；swarm worker 由
          // 主对话 PlanSeed 派发，build 模式下模型经免审批 worker 即获得无审批执行面。
          // 显式继承父会话 mode（overnight-controller fork 的同款先例，R1 红线「权限语义
          // 不放宽」）；父 mode 缺席时置 undefined，让 runtime 走默认分级。
          mode: deps.runtimeConfig.mode,
        },
        // worker 见图不自改图（R5）：注入同一 port，taskType=workflow_child 下注册面只有
        // 只读 PlanStatus（推导在 core runtime-tools.ts）。
        swarmPlanPort: port,
      });
      // 共享执行原语（文件头「执行原语」）：enforce=false——裁决所有者是 runner 的
      // settle 面；原语提供子会话执行 + 提取的共享面。request 的 activityId/runId/task
      // 等字段是原语入参形状（子会话 runner 只消费 prompt/abortSignal），取确定性可读值。
      // TNode=SwarmPlanNode 由 request 推断（原语的泛型设计，node-execution-core.ts）。
      const { result } = await executeNodeSubsession({
        enforcement: { enforce: false, maxArtifactRequeues: 0, priorArtifactRequeues: 0 },
        request: {
          abortSignal: controller.signal,
          activityId: `swarm-${owner}`,
          cwd: deps.workingDirectory,
          node,
          parentSessionId: String(deps.sessionId),
          phase: "swarm",
          prompt,
          runId: runtimeTaskId,
          task: node.content,
          traceContext: childTraceContext,
        },
        runner: {
          run: async (request) => {
            const turn = await childRuntime.executeTurn(request.prompt, undefined, {
              abortSignal: request.abortSignal,
              inputSource: "subagent",
              traceContext: childTraceContext,
            });
            const settledSelection = childRuntime.getSessionModelSelection();
            return {
              model: settledSelection
                ? `${settledSelection.providerId}/${settledSelection.modelId}`
                : undefined,
              response: turn.response,
              sessionId: childSessionId,
              traceId: turn.traceId,
              turnId: turn.turnId,
            };
          },
        },
      });
      return { response: result.response };
    } finally {
      if (inFlightControllers.get(node.id) === controller) {
        inFlightControllers.delete(node.id);
      }
    }
  };

  // 派发链自愈告警面（L1）：pass 失败的 warn 由 runner 自报，不再依赖调用方 catch。
  const runner = createSwarmRunner({ executeNode, logger: deps.logger, store });
  const port: SwarmPlanPort = { runner, store };

  return {
    bindRuntime(runtime) {
      boundRuntime = runtime;
    },
    dispose() {
      for (const controller of inFlightControllers.values()) {
        controller.abort();
      }
      inFlightControllers.clear();
    },
    hydrate: async () => {
      const hydrated = await store.hydrate();
      if (hydrated.error !== undefined) {
        // 坏行是数据完整性事件：warn + 空图起步（plan-store 已把数据留给人工排查）。
        logger?.warn("Swarm plan hydrate failed; starting with an empty plan", {
          error: hydrated.error,
          event: "swarm.plan.hydrate_failed",
          module: "bootstrap.swarm",
        });
      }
      // hydrate 不触发 onChange（采用既有事实不是图变更）：初始投影在此显式同步一次。
      syncSwarmPlanRuntimeTask({
        plan: store.getPlan(),
        registry: deps.runtimeTaskRegistry,
        taskId: runtimeTaskId,
      });
    },
    port,
  };
}
