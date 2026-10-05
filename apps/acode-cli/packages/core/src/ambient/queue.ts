// 机制参照 jcode (MIT)：crates/jcode-app-core/src/ambient/persistence.rs 的磁盘 JSON
// 队列（pop_ready：到期项按 priority 降序 + 时间升序），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R2/R3）。
//
// ambient 域自持有存储：`<数据根>/cli/ambient/queue.json`，与 services 定时任务域的
// SQLite 表分离（spec 红线：不合并存储、不合并调度器）。跨进程防双跑走本文件的
// claim 时间戳（services 定时任务域 CLAIM_STALE_MS 的同款语义——ACode 进程模型下
// claim 比 PID 文件贴：宿主可多窗口并存，进程存活 ≠ runner 存活）。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AMBIENT_QUEUE_CLAIM_STALE_MS,
  SCHEDULE_GLOBAL_MAX_ITEMS,
  SCHEDULE_MAX_ITEMS,
} from "./constants.js";
import { ambientDirPath } from "./usage-ledger.js";

// 上限常量在 constants.ts（spec 常量表唯一所有者）；在此 re-export 是因为执行点在
// queue.create，消费方（handler/测试）从本模块读语义上更内聚。
export { SCHEDULE_MAX_ITEMS, SCHEDULE_GLOBAL_MAX_ITEMS };

export type SchedulePriority = "low" | "normal" | "high";
export type ScheduleTarget = "ambient" | "session" | "spawn";

export interface ScheduledItem {
  scheduleId: string;
  createdAtMs: number;
  /** 到期时刻（epoch ms）；wakeInMinutes 由 handler 在创建时锚定真实时钟折算。 */
  wakeAtMs: number;
  priority: SchedulePriority;
  target: ScheduleTarget;
  taskDescription: string;
  context?: string;
  relevantFiles?: string[];
  /** 创建来源会话（session/spawn 投递目标判定与可观测面用）。 */
  createdBySession?: string;
}

export interface ScheduleCreateInput {
  wakeAtMs: number;
  priority?: SchedulePriority;
  target?: ScheduleTarget;
  taskDescription: string;
  context?: string;
  relevantFiles?: string[];
  createdBySession?: string;
}

interface QueueClaim {
  ownerId: string;
  claimedAtMs: number;
}

interface QueueFileShape {
  version: 1;
  items: ScheduledItem[];
  claim?: QueueClaim;
}

/** R2 上限错误：可读信息直接给模型（它可以在 tool result 里向用户解释并建议 cancel）。 */
export class ScheduleLimitError extends Error {
  constructor(limit: number) {
    super(
      `Schedule queue is full: at most ${limit} pending schedules may be retained. Cancel an existing one (action=cancel) before creating another.`,
    );
    this.name = "ScheduleLimitError";
  }
}

/**
 * F11（批次C）：取消他人会话的 schedule 项被拒（可读错误给模型）。单用户 CLI 多窗口
 * 形态下防误删并行窗口的工作单；归属键 = createdBySession（创建来源会话）。
 */
export class ScheduleOwnershipError extends Error {
  constructor(scheduleId: string) {
    super(
      `Schedule ${scheduleId} was created by another session and cannot be cancelled from this one.`,
    );
    this.name = "ScheduleOwnershipError";
  }
}

export class AmbientScheduleQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbientScheduleQueueError";
  }
}

export interface AmbientScheduleQueueDeps {
  dataRootDir: string;
  now?(): number;
  /** id 生成注入（测试确定性）；缺省用时间戳+随机段。 */
  newId?(): string;
}

const PRIORITY_ORDER: Record<SchedulePriority, number> = { high: 2, normal: 1, low: 0 };

function queueFilePath(dataRootDir: string): string {
  return join(ambientDirPath(dataRootDir), "queue.json");
}

/**
 * schedule 磁盘队列（R2）。
 *
 * 读-改-写经「写唯一名临时文件 + rename」落盘，进程崩溃不留下半截 JSON；进程内
 * 变更（create/cancel/popReady/claim 族）经实例级 promise 链串行化（F3），runner 是
 * 唯一消费者（R5 不变量）。跨进程 lost-update 是已登记的已知限制（spec 附录 A6）。
 */
export class AmbientScheduleQueue {
  private readonly deps: AmbientScheduleQueueDeps;
  /**
   * F3（批次C）：进程内写串行化链——create/cancel/popReady/tryClaim/renewClaim/
   * releaseClaim 的 read→write 全部经同一 promise 链互斥排队（swarm plan-store
   * mutate 的同款模式），消除本进程 handler 创建与 runner 消费的 RMW 交错丢写。
   * 跨进程 lost-update 是已登记的已知限制（spec 附录 A6：单用户 CLI 形态风险接受，
   * 文件锁列为后续项）。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(deps: AmbientScheduleQueueDeps) {
    this.deps = deps;
  }

  /** F3：把异步闭包排进串行链；task 内的读改写对同实例其他变更原子可见。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get filePath(): string {
    return queueFilePath(this.deps.dataRootDir);
  }

  private async readShape(): Promise<QueueFileShape> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return { version: 1, items: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 队列损坏按空处理：schedule 是建议性唤醒（可重建），与账本 fail-closed 的
      // 方向相反——队列层宽松、预算层保守，两层各自取「不伤害用户」的方向。
      return { version: 1, items: [] };
    }
    if (typeof parsed !== "object" || parsed === null) return { version: 1, items: [] };
    const shape = parsed as Partial<QueueFileShape>;
    if (!Array.isArray(shape.items)) return { version: 1, items: [] };
    return {
      version: 1,
      items: shape.items.filter((item): item is ScheduledItem => isValidItem(item)),
      claim: isValidClaim(shape.claim) ? shape.claim : undefined,
    };
  }

  private async writeShape(shape: QueueFileShape): Promise<void> {
    await mkdir(ambientDirPath(this.deps.dataRootDir), { recursive: true });
    const payload = `${JSON.stringify(shape, null, 2)}\n`;
    // F3（批次C）：tmp 名带 `${pid}-${randomUUID 前 8 位}` 唯一段——原先固定
    // `${filePath}.tmp`，两个并发写面（handler create 与 runner pop）先后 writeShape
    // 时，后者的 rename 会把前者尚未 rename 的 tmp 覆盖/抢走，前者 rename 时 tmp 已
    // 不在 → ENOENT 不在瞬态白名单 → 直接丢写。
    const tmp = `${this.filePath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, payload, "utf8");
    // Windows 上 rename 覆盖既有文件会被杀软/索引器的短暂句柄锁打断（EPERM/EBUSY），
    // 表现为瞬态错误：有限重试 + 退避，重试期间旧文件保持完整（原子性不受影响）。
    // F3：ENOENT 并入瞬态名单（tmp 被杀软移走时 rename 报 ENOENT）——重试前重建 tmp
    // 再 rename，否则重试必然继续 ENOENT。重试耗尽才向上抛——由 runner 的迭代级容错兜住。
    const RETRY_DELAYS_MS = [15, 50, 120];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, this.filePath);
        return;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isTransientRenameError(error)) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await writeFile(tmp, payload, "utf8");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async create(input: ScheduleCreateInput): Promise<ScheduledItem> {
    // F3：整个 read→limit→write 经串行链，与本进程其他变更互斥。
    return this.enqueue(async () => {
      const shape = await this.readShape();
      // F11（批次C）：上限按 createdBySession 计数（spec R2「每任务 50」），无归属项按
      // 同一键（undefined）聚合计数；全局软上限 200 防多会话总量失控（spec 偏差补记）。
      const ownCount = shape.items.filter(
        (item) => item.createdBySession === input.createdBySession,
      ).length;
      if (ownCount >= SCHEDULE_MAX_ITEMS) {
        throw new ScheduleLimitError(SCHEDULE_MAX_ITEMS);
      }
      if (shape.items.length >= SCHEDULE_GLOBAL_MAX_ITEMS) {
        throw new ScheduleLimitError(SCHEDULE_GLOBAL_MAX_ITEMS);
      }
      const item: ScheduledItem = {
        scheduleId: this.deps.newId?.() ?? newScheduleId(this.now()),
        createdAtMs: this.now(),
        wakeAtMs: input.wakeAtMs,
        priority: input.priority ?? "normal",
        target: input.target ?? "ambient",
        taskDescription: input.taskDescription,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.relevantFiles !== undefined ? { relevantFiles: input.relevantFiles } : {}),
        ...(input.createdBySession !== undefined ? { createdBySession: input.createdBySession } : {}),
      };
      shape.items.push(item);
      await this.writeShape(shape);
      return item;
    });
  }

  async list(): Promise<ScheduledItem[]> {
    const shape = await this.readShape();
    return [...shape.items].sort(compareByPriorityThenTime);
  }

  /**
   * 取消队列项。F11（批次C）：传入 ownerSessionId 时做归属校验——项属于其他会话 →
   * ScheduleOwnershipError（他人项给可读错误，不静默返回 false：误删并行窗口的工作单
   * 比拒绝更糟）。校验在串行段内执行（无 list→cancel 的 TOCTOU 窗口）。
   */
  async cancel(scheduleId: string, ownerSessionId?: string): Promise<boolean> {
    return this.enqueue(async () => {
      const shape = await this.readShape();
      const target = shape.items.find((item) => item.scheduleId === scheduleId);
      if (target === undefined) return false;
      if (
        ownerSessionId !== undefined &&
        target.createdBySession !== undefined &&
        target.createdBySession !== ownerSessionId
      ) {
        throw new ScheduleOwnershipError(scheduleId);
      }
      await this.writeShape({
        ...shape,
        items: shape.items.filter((item) => item.scheduleId !== scheduleId),
      });
      return true;
    });
  }

  /**
   * 取走到期项（jcode pop_ready 语义：wakeAt <= now，priority 降序 + wakeAt 升序）。
   * 取走即从队列删除（消费完成由调用方负责；runner 的 cycle 失败也不回投——退避由
   * scheduler 的倍率承载，回投会造成同一项反复立即到期）。
   * F3：read→write 经串行链（与 create 互斥，防交错丢写/重复投递）。
   */
  async popReady(nowMs: number, filter?: (item: ScheduledItem) => boolean): Promise<ScheduledItem[]> {
    return this.enqueue(async () => {
      const shape = await this.readShape();
      const ready = shape.items
        .filter((item) => item.wakeAtMs <= nowMs && (!filter || filter(item)))
        .sort(compareByPriorityThenTime);
      if (ready.length === 0) return [];
      const readyIds = new Set(ready.map((item) => item.scheduleId));
      await this.writeShape({
        ...shape,
        items: shape.items.filter((item) => !readyIds.has(item.scheduleId)),
      });
      return ready;
    });
  }

  /** 最早到期时刻（epoch ms）；无匹配项返回 undefined。 */
  async nextDueMs(
    nowMs: number,
    filter?: (item: ScheduledItem) => boolean,
  ): Promise<number | undefined> {
    const shape = await this.readShape();
    let earliest: number | undefined;
    for (const item of shape.items) {
      if (filter && !filter(item)) continue;
      if (item.wakeAtMs <= nowMs) return nowMs;
      if (earliest === undefined || item.wakeAtMs < earliest) earliest = item.wakeAtMs;
    }
    return earliest;
  }

  async countPending(filter?: (item: ScheduledItem) => boolean): Promise<number> {
    const shape = await this.readShape();
    return shape.items.filter((item) => !filter || filter(item)).length;
  }

  // -------------------------------------------------------------------------
  // claim：跨进程防双跑（R3）。ownerId = runner 实例标识；claim 过期
  //（AMBIENT_QUEUE_CLAIM_STALE_MS）视为持有者已崩溃，允许重新认领。
  // -------------------------------------------------------------------------

  /** 尝试认领；已被他人持有且未过期 → false（调用方不得启动 runner）。F3：经串行链。 */
  async tryClaim(ownerId: string, nowMs?: number): Promise<boolean> {
    return this.enqueue(async () => {
      const at = nowMs ?? this.now();
      const shape = await this.readShape();
      const claim = shape.claim;
      if (claim && claim.ownerId !== ownerId && at - claim.claimedAtMs < AMBIENT_QUEUE_CLAIM_STALE_MS) {
        return false;
      }
      await this.writeShape({ ...shape, claim: { ownerId, claimedAtMs: at } });
      return true;
    });
  }

  /** 持有者本人续租（每次 runner 醒来都续，证明自己活着）。F3：经串行链。 */
  async renewClaim(ownerId: string, nowMs?: number): Promise<boolean> {
    return this.enqueue(async () => {
      const at = nowMs ?? this.now();
      const shape = await this.readShape();
      if (shape.claim?.ownerId !== ownerId) return false;
      await this.writeShape({ ...shape, claim: { ownerId, claimedAtMs: at } });
      return true;
    });
  }

  async releaseClaim(ownerId: string): Promise<void> {
    return this.enqueue(async () => {
      const shape = await this.readShape();
      if (shape.claim?.ownerId !== ownerId) return;
      await this.writeShape({ ...shape, claim: undefined });
    });
  }

  async getClaim(): Promise<QueueClaim | undefined> {
    return (await this.readShape()).claim;
  }
}

function compareByPriorityThenTime(a: ScheduledItem, b: ScheduledItem): number {
  const byPriority = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
  if (byPriority !== 0) return byPriority;
  return a.wakeAtMs - b.wakeAtMs;
}

/**
 * Windows 瞬态 rename 失败（杀软/索引器持锁）的判定：不是我们数据的问题。
 * F3（批次C）：ENOENT 并入——tmp 文件被杀软/索引器短暂移走时 rename 报 ENOENT，
 * 与 EPERM/EBUSY 同属「稍后重试有希望成功」的瞬态类（writeShape 重试路径会重建 tmp）。
 */
function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOENT";
}

function newScheduleId(nowMs: number): string {
  return `sched-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidItem(value: unknown): value is ScheduledItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ScheduledItem>;
  return (
    typeof item.scheduleId === "string" &&
    typeof item.createdAtMs === "number" &&
    typeof item.wakeAtMs === "number" &&
    (item.priority === "low" || item.priority === "normal" || item.priority === "high") &&
    (item.target === "ambient" || item.target === "session" || item.target === "spawn") &&
    typeof item.taskDescription === "string"
  );
}

function isValidClaim(value: unknown): value is QueueClaim {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Partial<QueueClaim>;
  return typeof claim.ownerId === "string" && typeof claim.claimedAtMs === "number";
}
