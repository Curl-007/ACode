import type { Logger } from "@acode/contracts";
import {
  createMemorySampleWriteGate,
  memoryUsageToSampleFields,
  acodeProtocolNotifications,
  type MemorySample,
  type ACodeProtocolNotification,
} from "@acode/shared";
import {
  createACodeProcessResourceSampler,
  type ACodeProcessResourceSampler,
} from "../process-resource-sampler.js";
import type { ACodeProtocolAgentServer } from "./server.js";

/**
 * 空闲退出自检钩子(spec: packages/services/specs/chat-lane-idle-reclaim.md R2):
 * 搭 60s 资源采样节拍,不新增定时器;evaluator 是纯状态机,单次失败只损失当轮计时。
 */
export interface ProtocolIdleExitHook {
  onTick(): void;
  collectCounters(): Record<string, number>;
}

export function startProtocolResourceSampler(
  server: ACodeProtocolAgentServer,
  send: (message: ACodeProtocolNotification) => void,
  logger: Logger,
  idleExit?: ProtocolIdleExitHook,
): ACodeProcessResourceSampler | undefined {
  try {
    // 本地内存诊断日志：复用同一 60s 节拍，
    // 变化/心跳门控后才写一行，避免与消息流同频刷盘。
    const memoryDiagnosticsGate = createMemorySampleWriteGate();
    const sampler = createACodeProcessResourceSampler({
      onSample: (sample, memoryUsage) => {
        send({
          method: acodeProtocolNotifications.processResourceSample,
          params: sample,
        });
        // resident session TTL / 水位收敛借用资源采样节拍（60s）作兜底，不新增定时器；
        // sampler 对 onSample 已有异常兜底，单次 rebalance 失败不影响遥测上报。
        server.rebalanceResidentSessions();
        try {
          // 同一节拍先做瞬态事件时间兜底淘汰，再采样，日志里的 eventRows 反映淘汰后的驻留量。
          server.pruneSessionEventStores();
          server.pruneDetachedChildPublishers();
        } catch {
          // 兜底淘汰失败不影响资源上报与诊断日志。
        }
        try {
          // 静默自检在 rebalance/prune 之后:本轮刚释放的会话事实立即参与判定。
          idleExit?.onTick();
        } catch {
          // 空闲退出自检失败只损失当轮计时,不影响资源上报与会话收敛。
        }
        try {
          const memorySample: MemorySample = {
            role: "agent_node",
            ...memoryUsageToSampleFields(memoryUsage),
            counters: {
              ...server.collectMemoryDiagnostics(),
              ...(idleExit ? idleExit.collectCounters() : {}),
            },
          };
          const reason = memoryDiagnosticsGate.evaluate(memorySample, Date.now());
          if (reason) {
            const { role: _role, counters, ...memoryFields } = memorySample;
            logger.info("Process memory sample", {
              event: "acode_protocol.process.memory_sample",
              reason,
              ...memoryFields,
              counters,
            });
          }
        } catch {
          // 诊断日志失败只丢当前样本，不影响资源上报与 rebalance。
        }
      },
    });
    sampler.start();
    return sampler;
  } catch {
    // 资源遥测是 best effort，初始化失败不能改变 Agent 启动结果。
    return undefined;
  }
}
