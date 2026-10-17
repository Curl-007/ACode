// TTL 持久授权存储（specs/mcp-lifecycle-ttl-approval.md R4）。
//
// 「允许 N 天」式批准的单一所有者：内存为唯一读源（判定路径同步消费），落盘为
// 异步 best-effort（与 ambient 账本同一哲学）。过期授权从 active 集合消失后，判定
// 自然落回该工具原本的 ask 分支——不存在「过期后仍放行」或「过期即 deny」。
//
// 与既有 permission 骨架的挂接：本存储只产出 allow 级规则集
// （activeAllowRuleset），由 PermissionService 在「策略地板 / disallowedTools /
// 项目 deny/ask / plan 拒写」之后消费——收紧层结构性压过 TTL 授权（spec R4
// 判定位次），TTL 永不参与 deny/ask 的加强。
//
// 落盘文件形态（版本号、逐条校验、迁移与 fail-closed 作废）见 ttl-approval-file.ts。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TTL_PERMISSION_GRANT_FILE_VERSION,
  type PermissionRuleset,
  type PermissionUpdate,
  type TtlPermissionGrant,
  type TtlPermissionGrantFile,
  type TtlPermissionGrantOrigin,
} from "@acode/contracts";
// 数据根解析单一来源：与 ambient 域共用同一镜像（services getDataBaseDir 的 core 侧
// 等价物），TTL 授权文件落在 `<数据根>/cli/permissions/`（与 `<数据根>/cli/ambient/`
// 同一层级惯例）。
import { defaultAmbientDataRootDir } from "../ambient/usage-ledger.js";
import { isRecord, parseIsoDateMs, parseTtlPermissionGrantFile } from "./ttl-approval-file.js";

/** 无人值守（cron / off-peak / automation 派发）批准的缺省期限（天）。 */
export const DEFAULT_UNATTENDED_TTL_DAYS = 7;
/** 无人值守批准的期限上限（天）：更长的请求被夹紧，绝不永久。 */
export const MAX_UNATTENDED_TTL_DAYS = 30;
/** 交互式批准的期限上限（天）。 */
export const DEFAULT_MAX_TTL_DAYS = 365;

const DAY_MS = 86_400_000;

export function defaultTtlApprovalFilePath(dataRootDir: string): string {
  return join(dataRootDir, "cli", "permissions", "ttl-approvals.json");
}

/**
 * PermissionService 消费 TTL 授权的窄读接口（只读 active allow 规则集）。
 * 存储本体（grant/revoke/落盘）由装配层与批准链路持有，判定层不可写。
 */
export interface TtlApprovalReader {
  activeAllowRuleset(input?: { scopeKey?: string }): PermissionRuleset | undefined;
}

/**
 * 批准链路的写入面（grantSessionPermission 的 TTL 分流用）。TtlApprovalStore
 * 同时实现读写两面；只读替身缺写入面时调用方回落会话语义（见 service.ts）。
 */
export interface TtlApprovalWriter {
  applyPermissionUpdates(
    updates: readonly PermissionUpdate[],
    options: { origin: TtlPermissionGrantOrigin; scopeKey?: string },
  ): number;
}

export interface TtlApprovalGrantInput {
  toolName: string;
  ruleContent?: string;
  origin: TtlPermissionGrantOrigin;
  /** 与 ttlDays 二选一；两者都给出时以 expiresAt 为准（再经夹紧）。 */
  expiresAt?: string;
  ttlDays?: number;
  scopeKey?: string;
}

export interface TtlApprovalStoreOptions {
  /** 落盘路径；缺省 `<数据根>/cli/permissions/ttl-approvals.json`。 */
  filePath?: string;
  now?: () => number;
  warn?: (message: string, details?: Record<string, unknown>) => void;
  /** 交互式批准的期限上限（天）；缺省 365。 */
  maxTtlDays?: number;
}

export class TtlApprovalStore implements TtlApprovalReader {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly warn?: (message: string, details?: Record<string, unknown>) => void;
  private readonly maxTtlDays: number;
  /** key = toolName + ruleContent + scopeKey；同键新授权替换旧授权（续期即重新批准）。 */
  private readonly grants = new Map<string, TtlPermissionGrant>();
  private loadPromise?: Promise<void>;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: TtlApprovalStoreOptions = {}) {
    this.filePath =
      options.filePath ?? defaultTtlApprovalFilePath(defaultAmbientDataRootDir());
    this.now = options.now ?? Date.now;
    this.warn = options.warn;
    this.maxTtlDays = Math.max(1, options.maxTtlDays ?? DEFAULT_MAX_TTL_DAYS);
  }

  /** 装配入口：构造 + 完成首次加载。注入 PermissionConfig 前必须 await 本工厂。 */
  static async create(options: TtlApprovalStoreOptions = {}): Promise<TtlApprovalStore> {
    const store = new TtlApprovalStore(options);
    await store.load();
    return store;
  }

  /** 幂等加载；文件事实并入内存（同键以内存较新者为准，加载不得覆盖运行期批准）。 */
  async load(): Promise<void> {
    this.loadPromise ??= this.loadOnce();
    await this.loadPromise;
  }

  private async loadOnce(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) return;
      // 读失败（权限/IO）按空存储处理：授权消失 → 回落 ask（fail-closed）。
      this.warn?.("TTL approval store read failed; grants fall back to ask", {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.filePath,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warn?.("TTL approval store file is corrupt; grants fall back to ask", {
        filePath: this.filePath,
      });
      return;
    }
    const result = parseTtlPermissionGrantFile(parsed, this.now());
    if (result.futureVersion) {
      this.warn?.("TTL approval store file version is newer than this build; grants discarded", {
        filePath: this.filePath,
      });
      return;
    }
    if (result.corrupt) {
      this.warn?.("TTL approval store file shape is invalid; grants discarded", {
        filePath: this.filePath,
      });
      return;
    }
    if (result.discarded > 0) {
      this.warn?.("TTL approval store dropped invalid or expired grants", {
        discarded: result.discarded,
        filePath: this.filePath,
      });
    }
    for (const grant of result.file.grants) {
      const key = grantKey(grant);
      // 运行期（load 前）已批准的条目更新：文件里的旧版本不得覆盖。
      if (!this.grants.has(key)) this.grants.set(key, grant);
    }
  }

  /**
   * 记一条限期授权（同步进内存；落盘异步 best-effort）。
   * 期限解析：expiresAt > ttlDays > 无人值守默认；夹紧上限（无人值守 30 天、
   * 交互式 maxTtlDays）。交互式批准必须显式给期限——永久 allow 走既有项目规则
   * 路径，不属于 TTL 存储。过期时刻已过去 → 抛错（不记「出生即死」的授权）。
   */
  grant(input: TtlApprovalGrantInput): TtlPermissionGrant {
    const nowMs = this.now();
    const explicitMs =
      input.expiresAt !== undefined ? parseIsoDateMs(input.expiresAt) : undefined;
    if (input.expiresAt !== undefined && explicitMs === undefined) {
      throw new Error(`Invalid TTL approval expiresAt: ${String(input.expiresAt)}`);
    }
    let expiresAtMs = explicitMs;
    if (expiresAtMs === undefined) {
      if (typeof input.ttlDays === "number" && Number.isFinite(input.ttlDays) && input.ttlDays > 0) {
        expiresAtMs = nowMs + Math.floor(input.ttlDays * DAY_MS);
      } else if (input.origin === "unattended") {
        // 无人值守场景的持久批准默认带期限（spec R4）：绝不永久。
        expiresAtMs = nowMs + DEFAULT_UNATTENDED_TTL_DAYS * DAY_MS;
      } else {
        throw new Error(
          "A TTL approval requires expiresAt or ttlDays; permanent allows must go through the project permission ruleset",
        );
      }
    }
    const capDays =
      input.origin === "unattended"
        ? Math.min(MAX_UNATTENDED_TTL_DAYS, this.maxTtlDays)
        : this.maxTtlDays;
    expiresAtMs = Math.min(expiresAtMs, nowMs + capDays * DAY_MS);
    if (expiresAtMs <= nowMs) {
      throw new Error("TTL approval expiry is already in the past");
    }
    const grant: TtlPermissionGrant = {
      grantId: randomUUID(),
      toolName: input.toolName,
      ...(input.ruleContent !== undefined && input.ruleContent.length > 0
        ? { ruleContent: input.ruleContent }
        : {}),
      expiresAt: new Date(expiresAtMs).toISOString(),
      grantedAt: new Date(nowMs).toISOString(),
      origin: input.origin,
      ...(input.scopeKey !== undefined && input.scopeKey.length > 0
        ? { scopeKey: input.scopeKey }
        : {}),
    };
    this.grants.set(grantKey(grant), grant);
    this.schedulePersist();
    return grant;
  }

  /**
   * 把批准链路产出的 PermissionUpdate 折算成 TTL 授权（同步进内存，落盘异步）。
   * - allow + expiresAt → 按期限记授权（unattended 时夹紧上限）；
   * - allow 无 expiresAt 且 origin=unattended → 默认 7 天（无人值守的「持久」批准
   *   一律限期，spec R4）；
   * - allow 无 expiresAt 且 origin=interactive → 不进 TTL 存储（维持既有持久规则
   *   路径，由调用方照常走 project ruleset 持久化）；
   * - deny/ask 携带 expiresAt → 忽略（收紧类规则没有「到期自动放宽」的语义）。
   * 返回实际记入的授权条数。
   */
  applyPermissionUpdates(
    updates: readonly PermissionUpdate[],
    options: { origin: TtlPermissionGrantOrigin; scopeKey?: string },
  ): number {
    let applied = 0;
    for (const update of updates) {
      if (update.type !== "addRules" || update.behavior !== "allow") continue;
      const hasExpiry = typeof update.expiresAt === "string" && update.expiresAt.length > 0;
      if (!hasExpiry && options.origin !== "unattended") continue;
      if (hasExpiry && parseIsoDateMs(update.expiresAt) === undefined) {
        // 期限不可解析：fail-closed 丢弃整条更新（不猜期限、不降级成永久）。
        this.warn?.("TTL permission update dropped: unparsable expiresAt", {
          expiresAt: String(update.expiresAt),
        });
        continue;
      }
      for (const rule of update.rules) {
        if (typeof rule?.toolName !== "string" || rule.toolName.trim().length === 0) continue;
        this.grant({
          toolName: rule.toolName,
          ...(typeof rule.ruleContent === "string" ? { ruleContent: rule.ruleContent } : {}),
          origin: options.origin,
          ...(hasExpiry ? { expiresAt: update.expiresAt } : {}),
          ...(options.scopeKey ? { scopeKey: options.scopeKey } : {}),
        });
        applied += 1;
      }
    }
    return applied;
  }

  /** 撤销：按 grantId 或按规则键（toolName+ruleContent+scopeKey）。返回撤销条数。 */
  revoke(match: { grantId: string } | { toolName: string; ruleContent?: string; scopeKey?: string }): number {
    let removed = 0;
    if ("grantId" in match) {
      for (const [key, grant] of this.grants) {
        if (grant.grantId === match.grantId) {
          this.grants.delete(key);
          removed += 1;
        }
      }
    } else {
      const key = grantKey({
        toolName: match.toolName,
        ruleContent: match.ruleContent,
        scopeKey: match.scopeKey,
      });
      if (this.grants.delete(key)) removed = 1;
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  /**
   * 判定层消费面（同步）：未过期且作用域匹配的授权 → allow 规则集。
   * 无匹配返回 undefined（调用方跳过，不产生空规则集匹配开销）。
   * 缺省 scopeKey 的上下文只消费用户级授权（带 scopeKey 的授权不生效，fail-closed）。
   */
  activeAllowRuleset(input?: { scopeKey?: string }): PermissionRuleset | undefined {
    const active = this.listActive(input);
    if (active.length === 0) return undefined;
    return {
      version: 1,
      allow: active.map((grant) => ({
        toolName: grant.toolName,
        ...(grant.ruleContent !== undefined ? { ruleContent: grant.ruleContent } : {}),
      })),
    };
  }

  listActive(input?: { scopeKey?: string }): TtlPermissionGrant[] {
    const nowMs = this.now();
    const scopeKey = input?.scopeKey;
    const active: TtlPermissionGrant[] = [];
    for (const [key, grant] of this.grants) {
      const expiresAtMs = Date.parse(grant.expiresAt);
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
        // 惰性清除：过期条目在评估时出内存（文件侧在下次 persist 时裁剪）。
        this.grants.delete(key);
        continue;
      }
      if (grant.scopeKey !== undefined && grant.scopeKey !== scopeKey) continue;
      active.push(grant);
    }
    return active;
  }

  /** 等待挂起的落盘完成（测试与进程收口用）。 */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  private schedulePersist(): void {
    // 串行化写入：并发 grant 不产生交叉写；失败仅 warn（内存是唯一读源）。
    this.persistChain = this.persistChain.then(() => this.persistOnce()).catch((error) => {
      this.warn?.("TTL approval store persist failed", {
        error: error instanceof Error ? error.message : String(error),
        filePath: this.filePath,
      });
    });
  }

  private async persistOnce(): Promise<void> {
    const nowMs = this.now();
    const grants = [...this.grants.values()].filter((grant) => {
      const expiresAtMs = Date.parse(grant.expiresAt);
      return !Number.isNaN(expiresAtMs) && expiresAtMs > nowMs;
    });
    const file: TtlPermissionGrantFile = {
      version: TTL_PERMISSION_GRANT_FILE_VERSION,
      grants,
    };
    // 原子替换（与 ambient 队列同一惯例）：临时文件 + rename，读者永远看不到半截 JSON。
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

function grantKey(grant: {
  toolName: string;
  ruleContent?: string;
  scopeKey?: string;
}): string {
  return `${grant.toolName}\u0000${grant.ruleContent ?? ""}\u0000${grant.scopeKey ?? ""}`;
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
}
