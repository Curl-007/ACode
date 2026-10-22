// ============================================================
// Fleet CliGovernor 组合面 - 舰队事实源 → governor 端口接线（WI-E4）
// (apps/acode-cli/specs/cli-governor.md R1/R3/R4)
// ============================================================
// 机制在 runtime/cli-governor.ts（纯注入端口，零 fleet 依赖）；本文件是舰队
// 组合面：cap 用 node:os.totalmem() 构造期算一次（spec R1 平台裁决），
// countActive/peekLruIdleVictim 走 FleetRegistry（进程单例，动态读取以兼容
// resetFleetRegistryForTest），evictVictim = SubagentPort.stopTask 的
// best-effort 可恢复暂停（spec R4：绝不 remove/归档，SendToSession 恢复面
// 原样保留）。
//
// 驱逐端口懒接：host 装配序不做要求——首个携带 subagentPort.stopTask 的
// fleet launch 完成 attach；缺席期间 evictionOn=false（fail-safe，只发
// would_evict 观测事件）。

import { totalmem } from "node:os";
import {
  CliGovernor,
  type CliGovernorLogger,
  type GovernorEvictTrigger,
  type GovernorLruVictim,
} from "../runtime/cli-governor.js";
import { computeSessionCap, type MemoryPressureSource } from "../runtime/memory-pressure.js";
import type { RuntimeTaskRegistry } from "../runtime-task/contract.js";
import { isFleetSessionRunning } from "./archive.js";
import { getFleetRegistry, type FleetSessionRecord } from "./registry.js";

/** 驱逐端口最小面（SubagentPort.stopTask 结构兼容；stopTask 在契约中可选）。 */
export interface CliGovernorEvictionPort {
  stopTask(taskId: string): Promise<unknown>;
}

export interface FleetGovernorDeps {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  logger?: CliGovernorLogger;
  /** 注入压力源（native 事件位）；缺省 = governor.start() 自建轮询源。 */
  pressureSource?: MemoryPressureSource;
  /** 测试注入：覆盖 RAM 读取（生产 = node:os.totalmem()）。 */
  totalMemoryBytes?: number;
  /** 测试注入时钟。 */
  now?: () => number;
}

let governorSingleton: CliGovernor | undefined;
let evictionPort: CliGovernorEvictionPort | undefined;
let configuredDeps: FleetGovernorDeps = {};

/**
 * host 装配面（可选）：预置 runtimeTaskRegistry/logger/压力源。governor 懒建，
 * 重复调用做浅合并（后到的键覆盖；evictionPort 一经 attach 不被覆盖——首个
 * launch 的端口即进程事实源）。
 */
export function configureCliGovernor(deps: FleetGovernorDeps): void {
  configuredDeps = { ...configuredDeps, ...deps };
}

/** 懒接驱逐端口（spec R4）：首个在位者生效，后续 attach 忽略。 */
export function attachCliGovernorEvictionPort(port: CliGovernorEvictionPort): void {
  evictionPort ??= port;
}

/** LRU 受害者 peek（spec R3）：非归档 + 非在跑（终态/条目缺席）中 lastActivityAt 最旧者。 */
export function peekFleetLruIdleVictim(
  deps: Pick<FleetGovernorDeps, "runtimeTaskRegistry" | "now"> = configuredDeps,
): GovernorLruVictim | null {
  const registry = getFleetRegistry();
  const runtimeTaskRegistry = deps.runtimeTaskRegistry;
  let best: FleetSessionRecord | undefined;
  for (const record of registry.listActive()) {
    // 在跑（非终态任务）的会话绝不被驱逐——idle guard 之外的第二重保护。
    if (isFleetSessionRunning(record, runtimeTaskRegistry)) continue;
    if (best === undefined || record.lastActivityAt < best.lastActivityAt) {
      best = record;
    }
  }
  if (best === undefined) return null;
  const now = (deps.now ?? Date.now)();
  return {
    sessionId: best.sessionId,
    idleSeconds: Math.max(0, Math.round((now - best.lastActivityAt) / 1000)),
  };
}

/**
 * 进程级 governor 单例（先例：getFleetRegistry）。首访懒建 + start（缺省
 * 轮询源，10s unref 定时器，不阻塞进程退出）。
 */
export function getCliGovernor(): CliGovernor {
  if (governorSingleton !== undefined) return governorSingleton;
  const deps = configuredDeps;
  const cap = computeSessionCap(deps.totalMemoryBytes ?? totalmem());
  const logger = deps.logger;
  governorSingleton = new CliGovernor({
    cap: () => cap,
    countActive: () => getFleetRegistry().listActive().length,
    peekLruIdleVictim: () => peekFleetLruIdleVictim(deps),
    // 动态判定（spec R4 fail-safe）：端口懒接，构造期快照会让先建的 governor
    // 永久失去驱逐能力。
    evictionEnabled: () => evictionPort !== undefined,
    evictVictim: (
      sessionId: string,
      context: { trigger: GovernorEvictTrigger; idleSeconds: number },
    ) => {
      const port = evictionPort;
      const record = getFleetRegistry().get(sessionId);
      if (port === undefined || record === undefined) return;
      // pause-not-kill：stopTask 是 best-effort 异步收口（终态任务天然 no-op）；
      // 舰队记录/runtime-task 条目/会话 JSONL 全保留，SendToSession 即恢复。
      void Promise.resolve()
        .then(() => port.stopTask(record.agentId))
        .catch((error: unknown) => {
          logger?.error?.("[cli-governor] evict stopTask failed", {
            sessionId,
            trigger: context.trigger,
            error: String(error),
          });
        });
    },
    ...(logger === undefined ? {} : { logger }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    onEvent: (event) => {
      // 缺省观测面 = 结构化日志（事件闭集语义见 spec R7）；宿主可经
      // configureCliGovernor 前置订阅者时再叠加（当前无遥测面，spec 非目标）。
      if (event.type === "governor_evict") {
        logger?.info?.("[cli-governor] session paused by governor (recoverable)", {
          sessionId: event.sessionId,
          trigger: event.trigger,
          idleSeconds: event.idleSeconds,
        });
      }
    },
  });
  governorSingleton.start(deps.pressureSource);
  return governorSingleton;
}

/** 测试隔离：停源 + 清单例 + 清 deps/驱逐端口（对齐 resetFleetRegistryForTest 先例）。 */
export function resetCliGovernorForTest(): void {
  governorSingleton?.stop();
  governorSingleton = undefined;
  evictionPort = undefined;
  configuredDeps = {};
}
