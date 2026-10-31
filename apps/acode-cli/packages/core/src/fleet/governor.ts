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
//
// ── 多 App 同进程（2026-10-26 review §2 P3 修复）────────────────────────
// 前提证据：specs/gen-ui-visualize.md「注册表绑定（2026-10-12 实机修复：多 app
// 进程）」Bug 6——桌面 app-server 每 workspace 一个 agent 进程、每会话一个
// create-app、多 app 并存（CLI-04 sink 会话化正是按此前提行动）。
// 根因：governor 曾是进程单例 + 构造期把 `const deps = configuredDeps` 快照进
// 闭包，第二个 App 的 configureCliGovernor 被已建成的单例**静默丢弃**——governor
// 永久只持 App#1 的 app 作用域 runtimeTaskRegistry（create-app 每 app new 一份）。
// 受害扫描却迭代**进程级** FleetRegistry（所有 App 的会话），用 App#1 registry
// 判「在跑」：App#2 里真在跑的会话不在 App#1 registry → get(agentId) 缺席 →
// 旧 isFleetSessionRunning 返回 false → 被当 idle → 内存压力下 stopTask 一个真在
// 跑的会话（跨 App 驱逐守护失效）。
// 修复：
//   (1) deps 改为**按 appId 键控的进程级注册表**（照 CLI-04 sink 范式：
//       mcp/call-audit.ts registerMcpCallAuditSink、worktree/session-worktree-fence.ts），
//       每个 App 注册自己的 deps、close 时幂等释放（实例身份校验，迟到释放不误删）；
//   (2) 受害判定的「在跑」检查读**所有已注册 App registry 的并集**（任一 App 报在跑
//       即在跑）——FleetSessionRecord 不携带 owning-app 身份（registry.ts：只有
//       launchedBySessionId），无法按记录精确解析 owning registry，故用并集（保守，
//       且无需给记录加身份字段）；
//   (3) fail-safe floor：会话运行态若不能被任何已注册 registry **正向解析**（present
//       条目），一律视为 unknown，绝不当作 idle 受害候选——unknown ≠ idle。
// governor 单例本身（cap、10s unref 轮询）保持进程级；只有 deps 绑定 per-App，且
// peek/logger/now 走并集**动态**解析，第二个 App 注册后无需重建单例即生效。

import { totalmem } from "node:os";
import {
  CliGovernor,
  type CliGovernorLogger,
  type GovernorEvictTrigger,
  type GovernorLruVictim,
} from "../runtime/cli-governor.js";
import { computeSessionCap, type MemoryPressureSource } from "../runtime/memory-pressure.js";
import { isTerminalRuntimeTask, type RuntimeTaskRegistry } from "../runtime-task/contract.js";
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

/** configureCliGovernor（无 appId 的兼容面）登记到的进程缺省键。 */
const DEFAULT_GOVERNOR_APP_ID = "__process_default__";

let governorSingleton: CliGovernor | undefined;
let evictionPort: CliGovernorEvictionPort | undefined;
// 进程级 per-App deps 注册表（appId → deps）。取代旧的单一 configuredDeps 快照，
// 使多 App 的 deps 不再互相覆盖 / 被已建单例丢弃；peek 的在跑判定读它的并集。
const appDepsRegistry = new Map<string, FleetGovernorDeps>();

/**
 * 注册一个 App 的 governor deps，返回幂等释放函数（照 CLI-04 registerMcpCallAuditSink
 * 范式）。同 appId 重复注册做浅合并（后到键覆盖）；释放只删自己登记的那份对象——
 * 同 appId 后来者已覆盖时，早注册者的迟到释放不误删（实例身份校验，对齐
 * unregisterVisualizationFragmentStore 的「迟到 dispose 不得清掉新 app 绑定」纪律）。
 */
export function registerCliGovernorAppDeps(appId: string, deps: FleetGovernorDeps): () => void {
  const existing = appDepsRegistry.get(appId);
  const merged: FleetGovernorDeps = existing ? { ...existing, ...deps } : { ...deps };
  appDepsRegistry.set(appId, merged);
  return () => {
    if (appDepsRegistry.get(appId) === merged) appDepsRegistry.delete(appId);
  };
}

/**
 * host 装配兼容面（无 appId）：登记到进程缺省键。新代码用 registerCliGovernorAppDeps
 * 拿到 per-App 释放函数（create-app close 路径释放）。governor 懒建，重复调用浅合并
 * （evictionPort 一经 attach 不被覆盖——首个 launch 的端口即进程事实源）。
 */
export function configureCliGovernor(deps: FleetGovernorDeps): void {
  registerCliGovernorAppDeps(DEFAULT_GOVERNOR_APP_ID, deps);
}

/** 懒接驱逐端口（spec R4）：首个在位者生效，后续 attach 忽略。 */
export function attachCliGovernorEvictionPort(port: CliGovernorEvictionPort): void {
  evictionPort ??= port;
}

// ── 并集解析（多 App fail-safe floor） ───────────────────────────────

/**
 * 会话运行态（并集口径）：任一已注册 App registry 报 present-non-terminal = running；
 * 无任何在跑但至少一个 present-terminal = idle；所有已注册 registry 都无该 agentId 条目
 * = unknown（无法正向解析）。
 */
type FleetSessionRunState = "running" | "idle" | "unknown";

function resolveFleetSessionRunState(record: FleetSessionRecord): FleetSessionRunState {
  let sawTerminal = false;
  for (const deps of appDepsRegistry.values()) {
    const taskRegistry = deps.runtimeTaskRegistry;
    if (taskRegistry === undefined) continue;
    const task = taskRegistry.get(record.agentId);
    // 该 registry 不拥有此 agentId：跳过，不算「正向解析」（并集里别的 App 可能拥有）。
    if (task === undefined) continue;
    // union 保守：任一 App 里在跑即在跑——绝不驱逐。
    if (!isTerminalRuntimeTask(task)) return "running";
    sawTerminal = true;
  }
  // fail-safe floor：没有任何已注册 registry 正向命中该 agentId → unknown。unknown ≠ idle：
  // 跨 App（owning app 未注册 / 已 close 释放）的会话运行态无法解析，绝不当 idle 受害候选。
  // 真正 idle 的会话在其 owning app registry 里是 present-terminal（runner.ts 完成走
  // update(status:"completed")，条目留在册；remove 只在启动失败/abort——那时还没有舰队
  // 记录——或 archive/delete——那同时归档/删记录），故 floor 不误伤合法驱逐。
  return sawTerminal ? "idle" : "unknown";
}

function resolveLogger(): CliGovernorLogger | undefined {
  for (const deps of appDepsRegistry.values()) if (deps.logger !== undefined) return deps.logger;
  return undefined;
}

function resolveNow(): () => number {
  for (const deps of appDepsRegistry.values()) if (deps.now !== undefined) return deps.now;
  return Date.now;
}

function resolveTotalMemoryBytes(): number {
  for (const deps of appDepsRegistry.values())
    if (deps.totalMemoryBytes !== undefined) return deps.totalMemoryBytes;
  return totalmem();
}

function resolvePressureSource(): MemoryPressureSource | undefined {
  for (const deps of appDepsRegistry.values())
    if (deps.pressureSource !== undefined) return deps.pressureSource;
  return undefined;
}

/**
 * LRU 受害者 peek（spec R3 + fail-safe floor）：非归档 + **正向解析为 idle**（某已注册
 * App registry 里 present-terminal）者中 lastActivityAt 最旧者。running 与 unknown
 * （无任何已注册 registry 命中）都不够格——unknown ≠ idle 是多 App 驱逐守护的核心不变量。
 */
export function peekFleetLruIdleVictim(
  options: { now?: () => number } = {},
): GovernorLruVictim | null {
  const registry = getFleetRegistry();
  let best: FleetSessionRecord | undefined;
  for (const record of registry.listActive()) {
    // 在跑（任一 App）绝不被驱逐；unknown（无法正向解析）同样绝不被驱逐（fail-safe floor）。
    if (resolveFleetSessionRunState(record) !== "idle") continue;
    if (best === undefined || record.lastActivityAt < best.lastActivityAt) {
      best = record;
    }
  }
  if (best === undefined) return null;
  const now = (options.now ?? resolveNow())();
  return {
    sessionId: best.sessionId,
    idleSeconds: Math.max(0, Math.round((now - best.lastActivityAt) / 1000)),
  };
}

/**
 * 进程级 governor 单例（先例：getFleetRegistry）。首访懒建 + start（缺省轮询源，
 * 10s unref 定时器，不阻塞进程退出）。cap 构造期算一次（spec R1，进程级）；
 * peek/logger/now 走并集**动态**解析——第二个 App 注册后无需重建单例即生效（修复
 * 旧「构造期快照 configuredDeps 进闭包 → 后到 App 被静默丢弃」的根因）。
 */
export function getCliGovernor(): CliGovernor {
  if (governorSingleton !== undefined) return governorSingleton;
  const cap = computeSessionCap(resolveTotalMemoryBytes());
  // 动态 logger 代理：每次调用解析当前并集里的首个 logger——App#1 close 释放后
  // App#2 的 logger 自然接管，不再永久持 App#1 的 logger。
  const dynamicLogger: CliGovernorLogger = {
    debug: (message, meta) => resolveLogger()?.debug?.(message, meta),
    info: (message, meta) => resolveLogger()?.info?.(message, meta),
    warn: (message, meta) => resolveLogger()?.warn?.(message, meta),
    error: (message, meta) => resolveLogger()?.error?.(message, meta),
  };
  governorSingleton = new CliGovernor({
    cap: () => cap,
    countActive: () => getFleetRegistry().listActive().length,
    // 动态并集读取（多 App 修复核心）：不再把某个 App 的 deps 快照进闭包。
    peekLruIdleVictim: () => peekFleetLruIdleVictim(),
    // 动态判定（spec R4 fail-safe）：端口懒接，构造期快照会让先建的 governor
    // 永久失去驱逐能力。evictionPort 首到先得，且 stopTask 是 app 作用域（runner.ts：
    // 对未知/非 local_agent taskId no-op）——跨 App 最坏是「没能暂停另一个 App 的 idle
    // 会话」（fail-safe，无副作用），绝不会「误停另一个 App 的在跑会话」。
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
          resolveLogger()?.error?.("[cli-governor] evict stopTask failed", {
            sessionId,
            trigger: context.trigger,
            error: String(error),
          });
        });
    },
    logger: dynamicLogger,
    now: () => resolveNow()(),
    onEvent: (event) => {
      // 缺省观测面 = 结构化日志（事件闭集语义见 spec R7）；宿主可经
      // configureCliGovernor 前置订阅者时再叠加（当前无遥测面，spec 非目标）。
      if (event.type === "governor_evict") {
        resolveLogger()?.info?.("[cli-governor] session paused by governor (recoverable)", {
          sessionId: event.sessionId,
          trigger: event.trigger,
          idleSeconds: event.idleSeconds,
        });
      }
    },
  });
  governorSingleton.start(resolvePressureSource());
  return governorSingleton;
}

/**
 * 测试隔离：停源 + 清单例 + 清 per-App deps 注册表/驱逐端口（对齐
 * resetFleetRegistryForTest 先例）。
 */
export function resetCliGovernorForTest(): void {
  governorSingleton?.stop();
  governorSingleton = undefined;
  evictionPort = undefined;
  appDepsRegistry.clear();
}
