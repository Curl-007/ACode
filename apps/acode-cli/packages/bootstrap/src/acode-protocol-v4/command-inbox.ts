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
  buildSupersededCloseOutAck,
  isSupersededCloseOutAck,
  parseCommandEnvelope,
  resolveCommandRedelivery,
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
  /**
   * 重投递取代的 abort 口（specs/protocol-attachment-typed-errors.md R2/W1）：
   * 取代裁决命中时中止旧投递的在飞执行。缺席 = 无 abort 点；R2 规则 4c 要求
   * 无可用 abort 点的命令类型不得进入取代闭集。实现必须 best-effort：失败只报
   * 诊断，不得反向打断新投递的 admission（旧响应已被 suppressed 位压制）。
   */
  abortInFlightCommand?(envelope: CommandEnvelope): Promise<void> | void;
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
  /** 本投递的原始信封：重投递取代时 abort 精确指向旧运行（同 commandId，不同世代）。 */
  envelope: CommandEnvelope;
  /**
   * 重投递取代位（spec R2 规则 1/2）：置位后本投递的业务终态被压制——settle 变为
   * no-op（不入 settled LRU、不写持久事实、不触碰同 commandId 的新一代 inFlight/live
   * 条目），旧 wire 投递只以 close-out ack 收口防 RPC 悬挂。
   */
  suppressed?: boolean;
  /** 本投递持有的 session gate 释放柄：取代时提前放行新投递的串行 admission（release 幂等）。 */
  releaseSessionGate?: GateRelease;
}

type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

interface LiveInputEntry {
  ack: CommandAck;
  intent: ConversationInputIntent;
  /**
   * 取代位联动（spec R2）：旧投递被取代时其 live pin 一并标记——lookupExact 跳过它
   * （否则新投递会被旧 admission ACK 短路成 duplicate），releaseLiveInput 对它的收口
   * 不写 settled LRU（旧运行的 abort 终态不是业务事实）。新投递 pinLiveInput 会整体
   * 覆盖本条目，标记随旧对象一起被替换。
   */
  suppressed?: boolean;
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
      /**
       * 执行完成后回填终态。必须调用一次，用于释放 per-session admission gate。
       * 返回值非空 = 本投递已被重投递取代（spec R2 规则 2）：返回的是旧 wire 投递的
       * close-out ack（stale + proto.supersededByRedelivery），调用方应以它作为旧 RPC
       * 的响应收口，不得当作业务终态——业务终态由取代后的新投递唯一持有。
       */
      settle: (final: CommandFinal) => CommandAck | undefined;
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
      if (pinned) {
        // 重投递裁决（spec protocol-attachment-typed-errors.md R2 / 接线 W1）：默认闭集
        // 为空 = 全部现役命令保持既有 dedupe（共享 final），supersede 是惰性路径。
        // 入集命令在此取代旧投递并**继续向下**按新 admission 接管（不返回 duplicate）。
        if (resolveCommandRedelivery(envelope.type).action !== "supersede") {
          return this.ackOnly(this.retryAck(await pinned.final));
        }
        this.supersedeInFlight(bucketKey, pinned);
      }
      const existing = await this.lookupExact(key);
      if (existing) return this.ackOnly(this.retryAck(existing));

      // 固定锁序：key gate → per-session admission gate。session gate 持有到 settle，
      // 因而同 session 不同 commandId 以 CLI 实际执行 admission 的顺序串行。
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // 等待 session gate 期间，上一条命令可能增量写入了本 key 的持久化事实。
        const afterWaitPinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
        if (afterWaitPinned) {
          // 与 :pinned 首查同一裁决（R2/W1）。key gate 串行下同 commandId 的在飞条目
          // 理论上不会在本分支出现（防御性对称接线）：命中 supersede 时旧条目已被
          // 取代收口，本投递继续走下方 admission；命中 dedupe 时保持既有语义。
          if (resolveCommandRedelivery(envelope.type).action !== "supersede") {
            releaseSession();
            return this.ackOnly(this.retryAck(await afterWaitPinned.final));
          }
          this.supersedeInFlight(bucketKey, afterWaitPinned);
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
        const entry: InFlightEntry = {
          ack: decision.ack,
          envelope,
          final,
          resolveFinal,
          releaseSessionGate: releaseSession,
        };
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
            if (settled) return undefined;
            settled = true;
            // 被重投递取代的旧投递（spec R2 规则 1/2）：settle 不产出任何业务事实——
            // 不入 settled LRU、不覆盖 live pin、不删除同 commandId 的新一代 inFlight
            // 条目。返回 close-out ack 供 gateway 收口旧 wire 投递（防 RPC 悬挂/误判）；
            // session gate 已在 supersedeInFlight 提前释放，这里的幂等 release 只是兜底。
            if (entry.suppressed) {
              releaseSession();
              return buildSupersededCloseOutAck(
                envelope.commandId,
                decision.ack.revisionAtDecision,
              );
            }
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
    // 被取代投递的收口（spec R2 规则 2）：旧运行的 abort/cancel 终态不是业务事实，
    // 不得进 settled LRU——否则新投递的 lookupExact 会命中它短路成 duplicate(stale)，
    // 取代永远跑不起来。注意世代边界：新一代 pinLiveInput 会整体覆盖条目（标记随之
    // 消失），晚于新 pin 到达的旧 release 无法在 inbox 层归因——该竞态属 R2 规则 4b
    // 的入集评审义务（持久事实层必须能区分世代），取代闭集当前为空集，惰性路径。
    if (live?.suppressed) return;
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
    // 被取代的旧 live pin 不是可短路的事实（spec R2 规则 2）：跳过它，让新投递按
    // 正常 admission 接管；条目本体留给 releaseLiveInput 做静默收口。
    if (live && !live.suppressed) return live.ack;
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

  /**
   * 重投递取代（specs/protocol-attachment-typed-errors.md R2 规则 2 / 接线 W1）：
   * 「abort 旧运行 + 收口旧投递 + 新运行接管」的 inbox 半边。
   *
   * - 旧 wire 投递以 close-out ack（stale + proto.supersededByRedelivery）resolve 其
   *   final——只防 RPC 悬挂，不是业务终态（isSupersededCloseOutAck 判别）；
   * - suppressed 位置位后旧 settle 变 no-op：不入 settled LRU、不写持久事实；
   * - 旧 live pin 同步标记（lookupExact 跳过、releaseLiveInput 静默收口）；
   * - session gate 提前释放（幂等）：新投递接管本 session 的串行 admission 位次；
   * - abort 是 best-effort：同步抛错/异步拒绝都不得打断新投递的 admission——响应
   *   已被压制，abort 未生效最多是旧运行跑完但不产生业务终态（诊断归 gateway 实现）。
   *
   * 注意：取代后本投递继续走 handle() 的 lookupExact——若该 commandId 存在**更早世代**
   * 的 settled/持久事实，仍会被短路成 duplicate。入集评审（R2 规则 4b）必须把这条
   * 短路纳入「持久事实可被新 run 安全覆盖或封存作废」的验收范围。
   */
  private supersedeInFlight(bucketKey: string, pinned: InFlightEntry): void {
    pinned.suppressed = true;
    this.inFlight.get(bucketKey)?.delete(pinned.envelope.commandId);
    const live = this.liveInputs.get(bucketKey)?.get(pinned.envelope.commandId);
    if (live) live.suppressed = true;
    pinned.resolveFinal(
      buildSupersededCloseOutAck(pinned.envelope.commandId, pinned.ack.revisionAtDecision),
    );
    pinned.releaseSessionGate?.();
    try {
      const aborting = this.host.abortInFlightCommand?.(pinned.envelope);
      // 异步 abort 失败静默收口：诊断由 host 实现（gateway）自己的 onError 通道负责。
      if (aborting) Promise.resolve(aborting).catch(() => undefined);
    } catch {
      // 同步抛错同上：取代裁决本身已经成立，不因 abort 实现缺陷回退。
    }
  }

  private retryAck(ack: CommandAck): CommandAck {
    // close-out 不是业务终态（spec R2 规则 2）：不得被折叠成 duplicate——它只在
    // 取代路径出现，原样透传才能让请求方按 isSupersededCloseOutAck 判别「旧投递已
    // 被取代收口」，而不是误读成又一次重复投递。
    if (isSupersededCloseOutAck(ack)) return ack;
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
