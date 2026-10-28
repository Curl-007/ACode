/**
 * Message Projection 状态的所有者（R1-01 批次 B3）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeMessageProjectionState`
 * 剩余的扁平可写字段——任何 method 都能直接 `this.latestConversationMessageId = ...` /
 * `this.latestAssistantMessageId = ...` / `this.latestAssistantTurnId = ...` /
 * `this.lastEmittedLocalDate = ...` 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 MessageProjection 剩余的 4 个字段（latestConversationMessageId /
 * latestAssistantMessageId / latestAssistantTurnId / lastEmittedLocalDate）收敛进一个私有
 * owner，形态与 `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts` 完全一致：WeakMap
 * 持有真值、构造期用 Object.defineProperty 装只读 getter（无 setter、configurable:false）、
 * 写者只能经有限写端口。method 的读面（`this.latestConversationMessageId` 等）保持不变，
 * 只把**赋值点**改成端口调用，行为逐点等价。第 5 个字段 `lastRequestModelId` 已在
 * R1-01 B1 迁出至 RuntimeCacheDiagnosticsOwner（cache 归因输入），不在本批。
 *
 * 字段归属（唯一写入方 = message-persistence / compact-active / control-only-turn /
 * turn-stop / resume / rewind-message / turn）：
 * - latestConversationMessageId：user prompt / synthetic notice / compact summary /
 *   workflow-launch 消息持久化时推进的最新会话消息游标；
 * - latestAssistantMessageId / latestAssistantTurnId：assistant 消息持久化时同步推进；
 *   turn-stop 持久化失败回滚时按 identity 前置条件从 anchor 恢复；
 * - lastEmittedLocalDate：turn 边界的日期变化提醒游标（原子「读旧值 + 写新值」），
 *   cold resume 重置；rewind 不动（与迁移前一致）。
 *
 * 关键不变量（spec §B3）：turn-stop 回滚恢复的 identity 前置条件（游标仍指向被回滚
 * 消息才恢复 anchor）与恢复同事务；日期游标「读旧 + 写新」原子化，首日/同日不注入
 * 提醒的比较行留在调用方、逐字不变。
 */
import type { MessageId, TurnId } from "./deps.js";

export interface RuntimeMessageProjectionView {
  readonly latestConversationMessageId?: MessageId;
  readonly latestAssistantMessageId?: MessageId;
  readonly latestAssistantTurnId?: TurnId;
  readonly lastEmittedLocalDate?: string;
}

export interface RuntimeMessageProjectionPort {
  /**
   * 推进最新会话消息游标（原 `this.latestConversationMessageId = id` 单游标写）。
   * user prompt / synthetic notice / compact summary / workflow-launch 四处写点语义
   * 完全相同，共用本端口。只由 message-persistence / compact-active /
   * control-only-turn 调用。
   */
  recordConversationMessage(messageId: MessageId): void;
  /**
   * assistant 消息持久化：推进 latestConversationMessageId + latestAssistantMessageId；
   * 有 turnId 时同步推进 latestAssistantTurnId（truthy 判定与迁移前
   * `if (traceContext.turnId)` 一致）。只由 message-persistence 的
   * persistAssistantMessage 调用。
   */
  recordAssistantMessage(messageId: MessageId, turnId?: TurnId): void;
  /**
   * assistant 持久化失败回滚：仅当游标仍指向被回滚消息时从 anchor 恢复
   * （原 turn-stop.ts persistCompletedAssistantStep 的两段 identity 条件恢复）。
   * conversation 游标命中恢复 conversation；assistant 游标命中同步恢复
   * assistant + turn 游标；均未命中是 no-op。identity 前置条件与恢复同一同步片。
   */
  restoreFromPersistenceAnchor(
    rolledBackMessageId: MessageId,
    anchor: {
      latestConversationMessageId?: MessageId;
      latestAssistantMessageId?: MessageId;
      latestAssistantTurnId?: TurnId;
    },
  ): void;
  /**
   * resume/rewind 从持久消息整体替换三个 ID 游标（含清 undefined），不动日期游标
   * （原 resume.ts / rewind-message.ts 的三连赋值）。
   */
  rebuildFromMessages(input: {
    latestConversationMessageId?: MessageId;
    latestAssistantMessageId?: MessageId;
    latestAssistantTurnId?: TurnId;
  }): void;
  /** cold resume 重置日期游标为 undefined（原 resume.ts `this.lastEmittedLocalDate = undefined`）。 */
  resetLocalDateCursor(): void;
  /**
   * 日期游标原子「读旧值 + 写新值」（原 turn.ts injectDateChangeReminderIntoMessageHistory
   * 的 `const previousDate = this.lastEmittedLocalDate; this.lastEmittedLocalDate = currentDate`
   * 两行）。返回更新前的值；是否注入 date_change 提醒的比较
   * （`!previousDate || previousDate === currentDate`）与 addAttachment 留在调用方——
   * 提醒正文需要 previousDate，且 messageHistory 容器内写不经本端口。
   */
  emitLocalDateReminder(currentDate: string): string | undefined;
}

class RuntimeMessageProjectionOwner {
  #latestConversationMessageId?: MessageId;
  #latestAssistantMessageId?: MessageId;
  #latestAssistantTurnId?: TurnId;
  #lastEmittedLocalDate?: string;

  get latestConversationMessageId(): MessageId | undefined {
    return this.#latestConversationMessageId;
  }

  get latestAssistantMessageId(): MessageId | undefined {
    return this.#latestAssistantMessageId;
  }

  get latestAssistantTurnId(): TurnId | undefined {
    return this.#latestAssistantTurnId;
  }

  get lastEmittedLocalDate(): string | undefined {
    return this.#lastEmittedLocalDate;
  }

  readonly port: RuntimeMessageProjectionPort = Object.freeze({
    recordConversationMessage: (messageId: MessageId): void => {
      this.#latestConversationMessageId = messageId;
    },
    recordAssistantMessage: (messageId: MessageId, turnId?: TurnId): void => {
      this.#latestConversationMessageId = messageId;
      this.#latestAssistantMessageId = messageId;
      if (turnId) {
        this.#latestAssistantTurnId = turnId;
      }
    },
    restoreFromPersistenceAnchor: (
      rolledBackMessageId: MessageId,
      anchor: {
        latestConversationMessageId?: MessageId;
        latestAssistantMessageId?: MessageId;
        latestAssistantTurnId?: TurnId;
      },
    ): void => {
      if (this.#latestConversationMessageId === rolledBackMessageId) {
        this.#latestConversationMessageId = anchor.latestConversationMessageId;
      }
      if (this.#latestAssistantMessageId === rolledBackMessageId) {
        this.#latestAssistantMessageId = anchor.latestAssistantMessageId;
        this.#latestAssistantTurnId = anchor.latestAssistantTurnId;
      }
    },
    rebuildFromMessages: (input: {
      latestConversationMessageId?: MessageId;
      latestAssistantMessageId?: MessageId;
      latestAssistantTurnId?: TurnId;
    }): void => {
      this.#latestConversationMessageId = input.latestConversationMessageId;
      this.#latestAssistantMessageId = input.latestAssistantMessageId;
      this.#latestAssistantTurnId = input.latestAssistantTurnId;
    },
    resetLocalDateCursor: (): void => {
      this.#lastEmittedLocalDate = undefined;
    },
    emitLocalDateReminder: (currentDate: string): string | undefined => {
      const previousDate = this.#lastEmittedLocalDate;
      this.#lastEmittedLocalDate = currentDate;
      return previousDate;
    },
  });
}

const owners = new WeakMap<object, RuntimeMessageProjectionOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeMessageProjection(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeMessageProjectionOwner();
  Object.defineProperties(runtime, {
    latestConversationMessageId: {
      configurable: false,
      enumerable: true,
      get: () => owner.latestConversationMessageId,
    },
    latestAssistantMessageId: {
      configurable: false,
      enumerable: true,
      get: () => owner.latestAssistantMessageId,
    },
    latestAssistantTurnId: {
      configurable: false,
      enumerable: true,
      get: () => owner.latestAssistantTurnId,
    },
    lastEmittedLocalDate: {
      configurable: false,
      enumerable: true,
      get: () => owner.lastEmittedLocalDate,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeMessageProjectionPort(runtime: object): RuntimeMessageProjectionPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime message projection has not been initialized");
  return owner.port;
}
