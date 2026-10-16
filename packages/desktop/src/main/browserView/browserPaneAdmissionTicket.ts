/**
 * 内嵌浏览器 pane 的一次性准入凭据（one-shot admission ticket）。
 *
 * 机制来源见 specs/embedded-browser-pane-governance.md 件 1：交互准入的 consent
 * 凭据 mint 后单次消费，缺失/复用/过期即拒（闭集 reason）。与 owner/generation
 * 的分工：generation 拒绝「过期绑定」，ticket 限制「新鲜同意的复用」——一次
 * consent 只授权一次准入，且必须在 TTL 内消费。
 *
 * 生产 mint 方是未来的 consent 面（renderer 确认流/协议命令，接线登记于 spec）；
 * 当前唯一消费面是 BrowserGuestManager.claimTab，enforcement 默认关闭。
 */

/** 准入档位闭集：站点级同意 / 高风险目标单独同意（对齐参考机制 tier 语义）。 */
export type BrowserPaneAdmissionTier = "site" | "high-risk";

/** consume 的闭集判定：命中未过期 / 命中已过期 / tombstone 复用 / 从未 mint。 */
type BrowserPaneAdmissionConsumeOutcome = "ok" | "expired" | "consumed" | "missing";

interface BrowserPaneAdmissionTicketKey {
  /** 所有权 scope（guest manager 的 scopeKey）；跨 scope 不可互用。 */
  scopeKey: string;
  /** 准入目标（claimTab 场景 = tabId）。 */
  targetKey: string;
  tier: BrowserPaneAdmissionTier;
}

interface BrowserPaneAdmissionTicketLedgerOptions {
  /** 凭据有效期；缺省 120s（对齐参考实现 12e4）。 */
  ttlMs?: number;
  /** 注入时钟供单测；缺省 Date.now。 */
  now?: () => number;
  /** 结构化日志（mint/consume/expired 全落 info 语义，由调用方决定级别）。 */
  log?: (message: string) => void;
  generateTicketId?: () => string;
}

interface TicketEntry {
  ticketId: string;
  mintedAt: number;
}

const DEFAULT_ADMISSION_TICKET_TTL_MS = 120_000;
const KEY_SEPARATOR = "\u0000";

function ticketKey(key: BrowserPaneAdmissionTicketKey): string {
  return [key.scopeKey, key.targetKey, key.tier].join(KEY_SEPARATOR);
}

/** 简单非加密递增 id：ticketId 只做日志关联，不承担防伪（防伪靠键匹配+单次消费）。 */
let ticketIdCounter = 0;

export class BrowserPaneAdmissionTicketLedger {
  private readonly tickets = new Map<string, TicketEntry>();
  /** 已消费键的 tombstone：把「复用」与「从未 mint」区分成不同闭集 reason。 */
  private readonly consumedTombstones = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log?: (message: string) => void;
  private readonly generateTicketId: () => string;

  constructor(options: BrowserPaneAdmissionTicketLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_ADMISSION_TICKET_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.generateTicketId =
      options.generateTicketId ??
      (() => {
        ticketIdCounter += 1;
        return `adm-${ticketIdCounter}`;
      });
  }

  /**
   * 铸造凭据。重复 mint 同键覆盖旧票（consent 刷新语义：最新一次同意生效）。
   * mint 时惰性 GC 全部过期票与过期 tombstone（对齐参考实现的懒清理）。
   */
  mint(key: BrowserPaneAdmissionTicketKey): string {
    const now = this.now();
    this.pruneExpired(now);
    const ticketId = this.generateTicketId();
    const mapKey = ticketKey(key);
    this.tickets.set(mapKey, { ticketId, mintedAt: now });
    // 重新 mint 清除同键 tombstone：新同意不应背着旧复用记录。
    this.consumedTombstones.delete(mapKey);
    this.log?.(
      `[browser-governance] admission ticket minted tier=${key.tier} ticketId=${ticketId}`,
    );
    return ticketId;
  }

  /**
   * 单次消费：命中即删除并落 tombstone（保留至 TTL 期满），复用返回 `consumed`。
   * 过期票按 `expired` 拒绝且不落 tombstone（过期与复用是两种故障，需可区分）。
   */
  consume(key: BrowserPaneAdmissionTicketKey): {
    ok: boolean;
    reason: BrowserPaneAdmissionConsumeOutcome;
  } {
    const now = this.now();
    const mapKey = ticketKey(key);
    const entry = this.tickets.get(mapKey);
    if (entry) {
      this.tickets.delete(mapKey);
      if (now - entry.mintedAt > this.ttlMs) {
        this.log?.(
          `[browser-governance] admission ticket expired tier=${key.tier} ticketId=${entry.ticketId} ageMs=${now - entry.mintedAt}`,
        );
        return { ok: false, reason: "expired" };
      }
      this.consumedTombstones.set(mapKey, now);
      this.log?.(
        `[browser-governance] admission ticket consumed tier=${key.tier} ticketId=${entry.ticketId}`,
      );
      return { ok: true, reason: "ok" };
    }
    const tombstoneAt = this.consumedTombstones.get(mapKey);
    if (tombstoneAt !== undefined && now - tombstoneAt <= this.ttlMs) {
      // 同键复用：consent 是一次性的，第二次准入必须重新走同意面。
      this.log?.(`[browser-governance] admission ticket reuse rejected tier=${key.tier}`);
      return { ok: false, reason: "consumed" };
    }
    this.log?.(`[browser-governance] admission ticket missing tier=${key.tier}`);
    return { ok: false, reason: "missing" };
  }

  /** 只读探测（不消费）：供诊断/测试断言台账状态。 */
  has(key: BrowserPaneAdmissionTicketKey): boolean {
    const entry = this.tickets.get(ticketKey(key));
    return entry !== undefined && this.now() - entry.mintedAt <= this.ttlMs;
  }

  /** scope 终结（closeSession/closeWindow）时批量清理该 scope 的票，防跨会话残留。 */
  dropScope(scopeKey: string): void {
    const prefix = scopeKey + KEY_SEPARATOR;
    for (const mapKey of this.tickets.keys()) {
      if (mapKey.startsWith(prefix)) this.tickets.delete(mapKey);
    }
    for (const mapKey of this.consumedTombstones.keys()) {
      if (mapKey.startsWith(prefix)) this.consumedTombstones.delete(mapKey);
    }
  }

  private pruneExpired(now: number): void {
    for (const [mapKey, entry] of this.tickets) {
      if (now - entry.mintedAt > this.ttlMs) this.tickets.delete(mapKey);
    }
    for (const [mapKey, consumedAt] of this.consumedTombstones) {
      if (now - consumedAt > this.ttlMs) this.consumedTombstones.delete(mapKey);
    }
  }
}
