// ============================================================
// Fleet Registry - 舰队会话的一等对象记录与所有权封闭
// (apps/acode-cli/specs/session-fleet.md R1-R3)
// ============================================================
// 进程级单例（先例：worktree 的 getSessionWorktreeManager）：child runtime 与
// 发起会话同进程，进程亡故 = 舰队亡故，与后台代理生命周期一致，因此内存态就是
// 完整事实源；持久化面（标题/归档/模式）写 sessionStore，冷目录属后续批次
// （spec 非目标 #1）。
//
// 所有权封闭（R3）：记录只在 launch **成功返回后**写入（session-launch.ts 的
// 顺序保证「报错/被拒的调用不确立所有权」）；resolveOwnedSession 只按 id 精确
// 匹配 + launchedBySessionId 相等判定，绝不从标题或叙述推断。

import type { CollaborationMode, SessionId } from "@acode/contracts";
import type { FleetRejectReason } from "@acode/contracts";

export interface FleetWorktreeFact {
  path: string;
  branch: string;
}

/** 回合收口 note（R5）：最新报告前 400 字符，数据非指令。 */
export interface FleetReportNote {
  text: string;
  at: number;
  /** 产生该 note 的回合终态词（completed/failed/stopped…）。 */
  status: string;
  truncated: boolean;
}

export interface FleetSessionRecord {
  /** child 会话 id（sess_subagent_<agentId> 恒等式）——舰队工具的寻址键。 */
  readonly sessionId: SessionId;
  /** runtime-task 条目 id（≡ agentId）：TaskOutput/TaskStop/SendMessage 的既有键。 */
  readonly agentId: string;
  readonly title: string;
  /** vessel profile 名（general-purpose / Plan / …）。 */
  readonly agentType: string;
  /** 所有权：成功 StartSession/HandOff 的发起会话。 */
  readonly launchedBySessionId: SessionId;
  readonly launchedByToolCallId: string;
  readonly startedAt: number;
  /** 在案权限模式（R4）：可请求四档 + auto（无人值守发起者的继承事实）。 */
  mode: CollaborationMode;
  /**
   * 模式谱系（R4 生效边界）：plan = Plan vessel 启动（resume 不带 modeOverride，
   * 持久化 execution-state 在下个回合边界绑定）；ceiling = 继承天花板启动
   * （热 resume 重锚发起者当前模式，recorded 绑定冷恢复面）。
   */
  modeLineage: "plan" | "ceiling";
  lastActivityAt: number;
  archived: boolean;
  archivedAt?: number;
  worktree?: FleetWorktreeFact;
  latestNote?: FleetReportNote;
  /** HandOffToSession 登记的回传订阅发起方（R5）。 */
  handoffOriginSessionId?: SessionId;
}

export type FleetOwnershipFailure = Extract<
  FleetRejectReason,
  "unknown_session" | "not_owned_by_caller" | "session_archived"
>;

export type FleetOwnershipResolution =
  | { ok: true; record: FleetSessionRecord }
  | { ok: false; reason: FleetOwnershipFailure; message: string };

export class FleetRegistry {
  private readonly records = new Map<string, FleetSessionRecord>();
  private readonly watcherDisposers = new Map<string, () => void>();

  register(record: FleetSessionRecord): void {
    this.records.set(record.sessionId, record);
  }

  get(sessionId: string): FleetSessionRecord | undefined {
    return this.records.get(sessionId);
  }

  update(
    sessionId: string,
    patcher: (record: FleetSessionRecord) => FleetSessionRecord,
  ): FleetSessionRecord | undefined {
    const current = this.records.get(sessionId);
    if (!current) return undefined;
    const next = patcher(current);
    this.records.set(sessionId, next);
    return next;
  }

  /** 删除 = 记录移除（所有权消灭，R8）；同时撤销 note watcher。 */
  remove(sessionId: string): void {
    this.records.delete(sessionId);
    this.disposeWatcher(sessionId);
  }

  listByLauncher(
    launcherSessionId: string,
    options: { includeArchived?: boolean } = {},
  ): FleetSessionRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        record.launchedBySessionId === launcherSessionId &&
        (options.includeArchived === true || !record.archived),
    );
  }

  /** 级联面 a（R7）：共享同一 worktree 路径的其它舰队会话。 */
  listSharingWorktree(worktreePath: string, excludeSessionId: string): FleetSessionRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        record.sessionId !== excludeSessionId &&
        !record.archived &&
        record.worktree?.path === worktreePath,
    );
  }

  /** 级联面 b（R7）：目标自己启动的会话（「已完成的 side 会话」候选）。 */
  listLaunchedBy(sessionId: string): FleetSessionRecord[] {
    return [...this.records.values()].filter(
      (record) => record.launchedBySessionId === sessionId && !record.archived,
    );
  }

  /**
   * 所有权封闭判定（R3）：只认 id 精确匹配 + launchedBy 相等。
   * `allowArchived` 供 DeleteSessions（归档会话可删）与 ArchiveSession 幂等面使用。
   */
  resolveOwned(
    callerSessionId: string,
    targetSessionId: string,
    options: { allowArchived?: boolean } = {},
  ): FleetOwnershipResolution {
    const record = this.records.get(targetSessionId);
    if (!record) {
      return {
        ok: false,
        reason: "unknown_session",
        message:
          `No fleet session with id "${targetSessionId}" was started from this transcript. ` +
          "Fleet tools only accept session ids that your own successful StartSession/HandOffToSession call returned - titles and ids from narration are never inferred.",
      };
    }
    if (record.launchedBySessionId !== callerSessionId) {
      return {
        ok: false,
        reason: "not_owned_by_caller",
        message:
          `Fleet session "${targetSessionId}" was started by another session. ` +
          "Ownership is closed to the transcript whose StartSession call returned the id.",
      };
    }
    if (record.archived && options.allowArchived !== true) {
      return {
        ok: false,
        reason: "session_archived",
        message: `Fleet session "${targetSessionId}" is archived; its conversation is retained and readable via ReadSessionContext, but it no longer accepts fleet operations.`,
      };
    }
    return { ok: true, record };
  }

  /** note watcher 的生命周期挂在记录上：remove/归档时撤销（notes.ts 注册）。 */
  setWatcherDisposer(sessionId: string, dispose: () => void): void {
    this.disposeWatcher(sessionId);
    this.watcherDisposers.set(sessionId, dispose);
  }

  disposeWatcher(sessionId: string): void {
    const dispose = this.watcherDisposers.get(sessionId);
    if (!dispose) return;
    this.watcherDisposers.delete(sessionId);
    try {
      dispose();
    } catch {
      // watcher 撤销失败不阻断归档/删除主流程（定时器已 unref，不阻塞进程退出）。
    }
  }
}

let fleetRegistrySingleton: FleetRegistry | undefined;

/** 进程级舰队 registry（单例先例：getSessionWorktreeManager）。 */
export function getFleetRegistry(): FleetRegistry {
  if (!fleetRegistrySingleton) fleetRegistrySingleton = new FleetRegistry();
  return fleetRegistrySingleton;
}

/** 测试隔离：替换单例并返回新实例。 */
export function resetFleetRegistryForTest(): FleetRegistry {
  fleetRegistrySingleton = new FleetRegistry();
  return fleetRegistrySingleton;
}
