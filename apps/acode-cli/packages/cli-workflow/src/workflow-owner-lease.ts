// Workflow session owner lease 的生命周期管理（specs/workflow-owner-lease.md）。
//
// 单一所有者纪律：claim / renew（同 token 重入）/ 心跳 / 惰性重试**只发生在本模块**。
// 接线（bootstrap/app/workflow-wiring.ts）与桥的 fallback（script-workflow-methods.ts）
// 都经 contract 从这里拿 `ownerReady` 与 `reclaim`，不再各自持有租约逻辑——此前的
// 一次性 claim 有两个实机确认的缺陷（spec D1/D2）：活 owner 无续租、30s 后自己的
// 写闸门拒自己；启动窗口 claim 失败（活跃外部租约或瞬时 DB 错误）被缓存成进程级
// 永久锁死。
//
// 住在 @acode/cli-workflow 而不是 bootstrap：文件名与职责都属引擎族（W1-R3 边界，
// tests/bootstrap-boundary.test.mjs 强制），bootstrap 只保留装配接缝。
//
// 语义三态与原语一致：facts = 持有中；null = store 有能力但被他人持有/夺取；
// undefined = store 无租约能力面（legacy in-memory host），一切照旧。
import type { Logger } from "@acode/contracts";

export interface WorkflowOwnerLeaseFacts {
  ownerGeneration: number;
  ownerToken: string;
}

export interface WorkflowOwnerLease {
  leaseExpiresAt: number;
  ownerGeneration: number;
  ownerToken: string;
}

/** claim/renew 原语的窄化端口（SessionStorePort.claimWorkflowSessionOwner 的子集）。 */
export type WorkflowOwnerClaimPort = (input: {
  leaseMs?: number;
  ownerToken: string;
  parentSessionId: string;
}) => Promise<WorkflowOwnerLease | null>;

export interface WorkflowOwnerLeaseManager {
  /** 初始 claim 的结果。构造后立即发起；resolve 后心跳（若成功）已在跑。 */
  ownerReady: Promise<WorkflowOwnerLeaseFacts | null | undefined>;
  /**
   * 惰性重试：持有中直接回当前 facts；非持有（初始 claim 失败或被接管）时重新
   * claim 一次——旧租约若已过期即当场取得所有权并武装心跳。并发调用去重。
   * **不做内部等待循环**（spec「未做与取舍」）：仍被活跃外部 owner 持有就回 null，
   * 由调用方抛既有错误，数秒后重试自愈。
   */
  reclaim(): Promise<WorkflowOwnerLeaseFacts | null | undefined>;
  /** 停心跳。生产不调用（interval 已 unref，进程亡故即停）；测试与拆卸用。 */
  dispose(): void;
}

/**
 * 写边界闸门（spec R4/D3）：两个写消费端（dwf `ensureWorkflowOwner`、script runtime
 * `run()`）共用的**唯一**一处「读 live 所有权」逻辑。收敛到一个 helper 是为了杜绝两份
 * 租约读取实现各自漂移（AGENTS.md「单一写入路径」）。
 *
 * **病根（D3）**：此前两个消费端各自写成 `let owner = await ownerReady; if (owner === null)
 * owner = await reclaim();`。`ownerReady` 是一次性 promise，初始 claim 成功后**永久冻结**
 * 在首份 facts，于是 `owner === null` 恒假、`reclaim()` 在接管后永不触发——manager 的 live
 * `current = null`（心跳被接管时清）对写路径结构性不可见，消费端拿陈旧 `(T1, gen1)` 继续
 * 走：不带闸门的 `createRun` 把陈旧行落库，首个 gated 写入撞 `(T2, gen2)` 被拒，行永远
 * 冻结在非终态（D1 从第二条路径复活），且 reclaim 不可达 → 自愈/惰性收敛永不发生 →
 * 进程级永久锁死（D2）。
 *
 * **修复依据（R4）**：恒经 `reclaim()` 读 live 所有权，绝不读冻结的 `ownerReady`。
 * `reclaim()` 的快路径在仍持有时直接回缓存 `current`（不打 DB，happy path 零额外开销；
 * `current` 由心跳每 renewIntervalMs 续新）；在被接管（`current === null`）时重发 claim——
 * 旧租约已过期即当场取回所有权并重新武装心跳，仍被活跃外部 owner 持有才回 `null` 让
 * 消费端抛既有错误。写时的最终权威仍是既有 DB 闸门（`isWorkflowSessionOwner`）：快路径的
 * 「缓存 current 可能滞后一个心跳窗」由那道闸门兜住并抛 `Stale workflow owner write
 * rejected`，本 helper 只负责把「接管已被 manager 侦测到」这一 live 事实暴露给消费端。
 *
 * `ownerReady` 缺席（store 无能力面，legacy in-memory host，R6）时直通 `undefined`，
 * 消费端走既有「无 owner facts」路径，语义逐字节不变。
 */
export async function resolveWriteBoundaryOwner(deps: {
  ownerReady?: Promise<WorkflowOwnerLeaseFacts | null | undefined>;
  ownerReclaim?: () => Promise<WorkflowOwnerLeaseFacts | null | undefined>;
}): Promise<WorkflowOwnerLeaseFacts | null | undefined> {
  if (deps.ownerReady === undefined) return undefined;
  // 仍持有：reclaim 快路径回缓存 current（廉价续租）。被接管/初始失败：reclaim 重发
  // claim（自愈或回 null）。无 reclaim 能力（仅 ownerReady 的宿主）：退回冻结 facts——
  // 这类宿主没有 live 所有权可读，维持既有行为。
  if (deps.ownerReclaim === undefined) return deps.ownerReady;
  return deps.ownerReclaim();
}

const DEFAULT_LEASE_MS = 30_000;

function toFacts(lease: WorkflowOwnerLease): WorkflowOwnerLeaseFacts {
  return { ownerGeneration: lease.ownerGeneration, ownerToken: lease.ownerToken };
}

export function createWorkflowOwnerLeaseManager(deps: {
  claim?: WorkflowOwnerClaimPort;
  leaseMs?: number;
  logger?: Logger;
  ownerToken: string;
  parentSessionId: string;
  renewIntervalMs?: number;
}): WorkflowOwnerLeaseManager {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const renewIntervalMs =
    deps.renewIntervalMs ?? Math.max(1_000, Math.floor(leaseMs / 3));

  /**
   * 当前所有权认知：facts = 持有中（心跳在跑或刚 claim 成功）；null = 非持有；
   * undefined = store 无能力面。reclaim 的快路径读它，心跳被接管时清它——
   * 于是「被接管后原 owner 停写」（R4）在消费端下一次 ensure 时即时可见。
   */
  let current: WorkflowOwnerLeaseFacts | null | undefined =
    deps.claim === undefined ? undefined : null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reclaimInFlight: Promise<WorkflowOwnerLeaseFacts | null | undefined> | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const startHeartbeat = (): void => {
    if (heartbeat !== undefined || deps.claim === undefined) return;
    heartbeat = setInterval(() => {
      void (async () => {
        try {
          const renewed = await deps.claim?.({
            leaseMs,
            ownerToken: deps.ownerToken,
            parentSessionId: deps.parentSessionId,
          });
          if (renewed === null || renewed === undefined) {
            // 活跃外部 token 夺走了租约（我们的 lease 曾断档）。停表 + 自置非 owner：
            // 后续写入由既有闸门按 generation 拒绝，reclaim 会再试（spec R4）。
            stopHeartbeat();
            current = null;
            deps.logger?.warn?.("Workflow owner lease lost to takeover", {
              event: "workflow.owner.lease_taken_over",
              module: "bootstrap.app",
              parentSessionId: deps.parentSessionId,
            });
            return;
          }
          current = toFacts(renewed);
        } catch (error) {
          // 瞬时失败（如 SQLITE_BUSY）不值得停表：下一个 tick 再试，租约还有余量。
          deps.logger?.warn?.("Workflow owner lease renew failed", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "workflow.owner.renew_failed",
            module: "bootstrap.app",
          });
        }
      })();
    }, renewIntervalMs);
    // 心跳不得延长进程寿命：owner 进程亡故时租约按 R2 自然过期。
    heartbeat.unref?.();
  };

  const attemptClaim = async (): Promise<WorkflowOwnerLeaseFacts | null | undefined> => {
    if (deps.claim === undefined) return undefined;
    try {
      const lease = await deps.claim({
        leaseMs,
        ownerToken: deps.ownerToken,
        parentSessionId: deps.parentSessionId,
      });
      if (lease === null) {
        current = null;
        return null;
      }
      current = toFacts(lease);
      startHeartbeat();
      return current;
    } catch (error) {
      // claim 抛错（如重启竞态下的 BUSY）按「暂未持有」处理，不再像旧接线那样
      // 把一次失败缓存成进程级判决——reclaim 就是重试路径（spec D2/R3）。
      current = null;
      deps.logger?.warn?.("Workflow owner lease claim failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "workflow.owner.claim_failed",
        module: "bootstrap.app",
      });
      return null;
    }
  };

  const ownerReady = attemptClaim();

  return {
    ownerReady,
    async reclaim() {
      // 先让初始 claim 落定：与它并发再发一次同 token claim 无害（事务原语会串行化），
      // 但会让「初始失败 → 立即重试」的时序不可辨。落定后仍非持有才发起重试。
      await ownerReady;
      if (current !== null) return current;
      reclaimInFlight ??= attemptClaim().finally(() => {
        reclaimInFlight = undefined;
      });
      return reclaimInFlight;
    },
    dispose() {
      stopHeartbeat();
      // 停止续租即不再可靠持有：所有权认知一并放弃（undefined 的「无能力面」保持原样），
      // 之后的 reclaim 会重新走 claim。
      if (current !== undefined) current = null;
    },
  };
}
