/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
// Command inbox：统一命令 admission 与查询入口。
// 三类事实严格分离：in-flight / live input 永远 pinned；只有 settled 进入 512/session LRU。
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  ConversationInputIntent,
} from "@acode/shared/acode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  PROTOCOL_V4_LIMITS,
  ROW_TARGETING_COMMANDS,
  parseCommandEnvelope,
} from "@acode/shared/acode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口）。 */
type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

interface CommandInboxHost {
  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** 以下回调顺序就是持久化事实优先级；实现必须精确匹配 sourceCommandId。 */
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}

interface InFlightEntry {
  ack: CommandAck;
  final: Promise<CommandAck>;
  resolveFinal: (ack: CommandAck) => void;
}

type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

interface LiveInputEntry {
  ack: CommandAck;
  intent: ConversationInputIntent;
}

type CommandInboxOutcome =
  | { kind: "ack"; ack: CommandAck }
  | {
      kind: "execute";
      envelope: CommandEnvelope;
      ack: CommandAck;
      /** CLI 串行 admission 分配的权威顺序；用它构造 ConversationInputIntent。 */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
      /** 执行完成后回填终态。必须调用一次，用于释放 per-session admission gate。 */
      settle: (final: CommandFinal) => void;
    };

// createSession 与 null sessionId query 归全局桶。
const GLOBAL_BUCKET = "@global";

export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

type GateRelease = () => void;

/**
 * FIFO async gate。返回显式 release 是因为 per-session gate 要跨过 gateway execute，
 * 直到 settle 才释放；普通 with-lock 会在 handle 返回时过早放行下一条 admission。
 */
class AsyncGateRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<GateRelease> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

export class CommandInbox {
  private readonly inFlight = new Map<string, Map<string, InFlightEntry>>();
  private readonly liveInputs = new Map<string, Map<string, LiveInputEntry>>();
  private readonly settled = new Map<string, Map<string, CommandAck>>();
  private readonly admissionSeq = new Map<string, number>();
  private readonly keyGates = new AsyncGateRegistry();
  private readonly sessionGates = new AsyncGateRegistry();

  constructor(private readonly host: CommandInboxHost) {}

  async handle(raw: unknown): Promise<CommandInboxOutcome> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      return this.ackOnly({
        commandId: this.extractCommandId(raw),
        status: "rejected",
        reasonCode: "proto.invalidPayload",
        message: parsed.error.message,
        revisionAtDecision: 0,
      });
    }
    const envelope = parsed.envelope;
    const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
    const bucketKey = this.bucketKey(envelope.sessionId);
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));

    try {
      const pinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
      if (pinned) return this.ackOnly(this.retryAck(await pinned.final));
      const existing = await this.lookupExact(key);
      if (existing) return this.ackOnly(this.retryAck(existing));

      // 固定锁序：key gate → per-session admission gate。session gate 持有到 settle，
      // 因而同 session 不同 commandId 以 CLI 实际执行 admission 的顺序串行。
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // 等待 session gate 期间，上一条命令可能增量写入了本 key 的持久化事实。
        const afterWaitPinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
        if (afterWaitPinned) {
          releaseSession();
          return this.ackOnly(this.retryAck(await afterWaitPinned.final));
        }
        const afterWait = await this.lookupExact(key);
        if (afterWait) {
          releaseSession();
          return this.ackOnly(this.retryAck(afterWait));
        }

        const decision = this.decide(envelope);
        if (decision.kind === "ack") {
          // `remember` 的非对称是**必要条件**，不是遗漏（详见 decide() 的返回类型注释）：
          // CAS/guard 丢弃一律 remember:false，唯一 remember:true 的是 guard 的 noop。
          // 把 stale 记进 settled LRU 会让客户端的**修正重试**永久失效——handle() 在
          // decide() 之前先查 lookupExact（本函数上方两处），同一 commandId 重发会被短路成
          // duplicate(stale)，永远拿不到 execute。noop 反之必须记住：它表示「该命令的效果
          // 已成立/无需再做」，重试方需要认出它。
          if (decision.remember) this.rememberSettled(bucketKey, envelope.commandId, decision.ack);
          releaseSession();
          return this.ackOnly(decision.ack);
        }

        const nextAdmissionSeq = (this.admissionSeq.get(bucketKey) ?? 0) + 1;
        const admittedAt = this.host.now?.() ?? Date.now();
        this.admissionSeq.set(bucketKey, nextAdmissionSeq);
        let resolveFinal!: (ack: CommandAck) => void;
        const final = new Promise<CommandAck>((resolve) => {
          resolveFinal = resolve;
        });
        const entry: InFlightEntry = { ack: decision.ack, final, resolveFinal };
        this.mapFor(this.inFlight, bucketKey).set(envelope.commandId, entry);

        // 旧单表 LRU 会在 >512 条 churn 时淘汰仍在执行/队列里的命令，随后
        // query 返回 unknown、重试再次执行。新命令先 pin，再释放 key gate。
        releaseKey();
        let settled = false;
        return {
          kind: "execute",
          envelope,
          ack: decision.ack,
          admissionSeq: nextAdmissionSeq,
          admittedAt,
          queueItemId: queueItemIdForCommand(envelope.commandId),
          settle: (final) => {
            if (settled) return;
            settled = true;
            const live = this.liveInputs.get(bucketKey)?.get(envelope.commandId);
            const ack = {
              ...decision.ack,
              ...final,
            };
            this.inFlight.get(bucketKey)?.delete(envelope.commandId);
            if (live) {
              live.ack = ack;
            } else {
              this.rememberSettled(bucketKey, envelope.commandId, ack);
            }
            // 在途 duplicate 过去直接拿 admission ACK，fork/create 尚无 child
            // result 时就返回，ACK 丢失重试会导航失败。所有同 key 请求必须共享这一个
            // final promise，并在释放 session FIFO 前看到同一终态。
            entry.resolveFinal(ack);
            releaseSession();
          },
        };
      } catch (error) {
        releaseSession();
        throw error;
      }
    } catch (error) {
      return this.ackOnly(this.queryUnavailableAck(key, error));
    } finally {
      // execute 路径已在 pin 后提前 release；release 幂等，其他路径在这里释放。
      releaseKey();
    }
  }

  /** 1..64 的上层 schema 由 gateway 校验；这里并行查询并保持 Promise.all 输入顺序。 */
  async query(
    keys: readonly CommandKey[],
  ): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
    return Promise.all(keys.map((key) => this.queryOne(key)));
  }

  /** queue/guide admission 后 pin 同一个完整 intent；settled churn 不得触及它。 */
  pinLiveInput(sessionId: string, intent: ConversationInputIntent, ack?: CommandAck): void {
    const bucketKey = this.bucketKey(sessionId);
    const inFlightAck = this.inFlight.get(bucketKey)?.get(intent.sourceCommandId)?.ack;
    this.mapFor(this.liveInputs, bucketKey).set(intent.sourceCommandId, {
      intent,
      ack: ack ??
        inFlightAck ?? {
          commandId: intent.sourceCommandId,
          status: "accepted",
          revisionAtDecision: 0,
        },
    });
    this.settled.get(bucketKey)?.delete(intent.sourceCommandId);
  }

  /** queue/guide 进入 transcript、取消或失败时解除 pin，并可把终态转入 settled LRU。 */
  releaseLiveInput(key: CommandKey, finalAck?: CommandAck): void {
    const bucketKey = this.bucketKey(key.sessionId);
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    this.liveInputs.get(bucketKey)?.delete(key.commandId);
    if (finalAck ?? live?.ack) {
      this.rememberSettled(bucketKey, key.commandId, finalAck ?? live!.ack);
    }
  }

  hasPinnedSessionState(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    return (
      (this.inFlight.get(bucketKey)?.size ?? 0) > 0 ||
      (this.liveInputs.get(bucketKey)?.size ?? 0) > 0
    );
  }

  /**
   * Resident 去激活后，inbox 也必须回到 CLI 冷启动状态。in-flight/live facts 不能清，
   * 调用方必须把它们作为回收保护条件；settled 仍可从 durable transcript/timeline 回源。
   */
  clearSession(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    if (this.hasPinnedSessionState(sessionId)) return false;
    this.inFlight.delete(bucketKey);
    this.liveInputs.delete(bucketKey);
    this.settled.delete(bucketKey);
    this.admissionSeq.delete(bucketKey);
    return true;
  }

  private async queryOne(
    key: CommandKey,
  ): Promise<{ key: CommandKey; result: CommandAck | "unknown" }> {
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));
    try {
      return { key, result: (await this.lookupExact(key)) ?? "unknown" };
    } catch (error) {
      return { key, result: this.queryUnavailableAck(key, error) };
    } finally {
      releaseKey();
    }
  }

  private async lookupExact(key: CommandKey): Promise<CommandAck | null> {
    const bucketKey = this.bucketKey(key.sessionId);
    const inflight = this.inFlight.get(bucketKey)?.get(key.commandId);
    if (inflight) return await inflight.final;
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    if (live) return live.ack;
    const settled = this.settled.get(bucketKey)?.get(key.commandId);
    if (settled) {
      this.touchSettled(bucketKey, key.commandId, settled);
      return settled;
    }

    for (const lookup of [
      this.host.lookupTranscriptCommand,
      this.host.lookupTimelineCommand,
      this.host.lookupChildCommand,
      this.host.lookupDiscardedCommand,
    ]) {
      const found = await lookup?.(key);
      if (found) return found;
    }
    return null;
  }

  /**
   * 裁决一条已解析的信封。纯函数：只读 host 的 revision/logEpoch 投影与两个裁决端口，
   * 不分配 admissionSeq、不产出副作用，所以任何丢弃路径的重试都是幂等的。
   *
   * `remember` = 这条 ack 是否进 settled LRU（512/session）。约定：
   * - **CAS / guard 的丢弃一律 `remember: false`**。这些终态描述的是「以客户端当时的
   *   baseRevision/baseLogEpoch 为前提不成立」，客户端读到 `revisionAtDecision` 后会用
   *   **同一 commandId** 修正重发；若记住了，重发会在 handle() 的 lookupExact 处被折叠成
   *   `duplicate`，修正永远无法被 admit。
   * - **guard 的 `noop` 必须 `remember: true`**（本方法唯一的 true）。noop 表示该命令的
   *   效果已成立或无需再做，是一个需要被重试方认出的终态事实。
   */
  private decide(
    envelope: CommandEnvelope,
  ): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
    const revision = envelope.sessionId === null ? 0 : this.host.getRevision(envelope.sessionId);
    if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.sessionNotFound",
          revisionAtDecision: 0,
        },
      };
    }

    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      // 纵深防御，正常路径**不可达**：parseCommandEnvelope 对同一条件先拒成
      // proto.invalidPayload（packages/shared/src/acode-protocol-v4/command.ts 的
      // 「CAS commands require baseRevision and baseLogEpoch」），handle() 在 parsed.ok
      // 为假时就已返回，走不到 decide()。decide 是 private、当前无旁路调用方，所以本分支
      // 只在「未来出现绕过 parse 的调用方」时才有意义。
      // 即使删掉它也不失守：baseRevision 缺失会落到下面的 `envelope.baseRevision !== revision`
      // 比较（undefined !== number 恒真）被拒成 staleRevision，只是 reasonCode 不够精确。
      // 保留 + 注明理由，取舍见 specs/command-terminal-state-audit.md §B。
      if (envelope.baseRevision === undefined) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "rejected",
            reasonCode: "proto.missingBaseRevision",
            revisionAtDecision: revision,
          },
        };
      }
      const logEpoch =
        envelope.sessionId === null ? null : this.host.getLogEpoch(envelope.sessionId);
      if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleLogEpoch",
            revisionAtDecision: revision,
          },
        };
      }
      if (envelope.baseRevision !== revision) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleRevision",
            revisionAtDecision: revision,
          },
        };
      }
    }

    const targetDecision = this.host.validateRowTarget?.(envelope);
    if (targetDecision?.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (targetDecision?.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }

    const decision = this.host.guard?.(envelope) ?? {
      verdict: "allow" as const,
    };
    if (decision.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "noop") {
      // 本方法唯一的 remember:true。noop ≠ 丢弃：它表示该命令的效果已成立/无需再做，
      // 是一个需要被晚到重试认出的终态事实，所以必须进 settled LRU（对比上面各条
      // CAS/guard 丢弃的 remember:false，理由见 decide() 的返回类型注释）。
      return {
        kind: "ack",
        remember: true,
        ack: {
          commandId: envelope.commandId,
          status: "noop",
          reasonCode: decision.reasonCode,
          revisionAtDecision: revision,
          result: decision.result,
        },
      };
    }
    return {
      kind: "execute",
      ack: {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision,
      },
    };
  }

  private retryAck(ack: CommandAck): CommandAck {
    // failed 是终态事实，不得被 duplicate 状态覆盖后让 UI/服务误判为可接受。
    //
    // **cancel 方向靠归一化覆盖，而不是靠这里点名**：CommandAck.status 的枚举里没有
    // `cancelled`（packages/shared/src/acode-protocol-v4/command.ts 的 commandAckSchema），
    // 取消在持久事实层就被投影成 `status:"failed"` + `reasonCode:"fault.command.inputCancelled"`
    // （bootstrap/src/acode-protocol-v4/persistent-command-facts.ts），所以取消的终态走的
    // 正是上面这条 failed 分支，同样不会被折叠成 duplicate。改动 status 枚举或那条归一
    // 投影时必须重新核对本处：两者是「取消终态不可被覆盖」这一条约定的上下两半。
    return ack.status === "failed" ? ack : { ...ack, status: "duplicate" };
  }

  private queryUnavailableAck(key: CommandKey, _error: unknown): CommandAck {
    return {
      commandId: key.commandId,
      status: "failed",
      reasonCode: "fault.command.queryUnavailable",
      revisionAtDecision: key.sessionId === null ? 0 : (this.host.getRevision(key.sessionId) ?? 0),
    };
  }

  private ackOnly(ack: CommandAck): CommandInboxOutcome {
    return { kind: "ack", ack };
  }

  private bucketKey(sessionId: string | null): string {
    return sessionId ?? GLOBAL_BUCKET;
  }

  private keyGateKey(key: CommandKey): string {
    return `${this.bucketKey(key.sessionId)}\0${key.commandId}`;
  }

  private mapFor<T>(store: Map<string, Map<string, T>>, bucketKey: string): Map<string, T> {
    let bucket = store.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      store.set(bucketKey, bucket);
    }
    return bucket;
  }

  private touchSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
  }

  private rememberSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
    while (bucket.size > PROTOCOL_V4_LIMITS.idempotencyTablePerSession) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  private extractCommandId(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "commandId" in raw) {
      const id = (raw as { commandId: unknown }).commandId;
      if (typeof id === "string") return id;
    }
    return "";
  }
}
