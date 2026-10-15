// TTL 持久授权的落盘文件形态：解析、逐条校验与版本迁移
// （specs/mcp-lifecycle-ttl-approval.md R4）。
//
// 从 ttl-approvals.ts 拆出：架构门禁 max-file-lines（400 行）；文件形态是存储的
// 持久化契约面，独立成模块也让「迁移语义」有单一落点。
//
// fail-closed 方向（宁可多问、不可误放）：文件损坏 / 来自未来版本的写入 / 非法
// 条目 → 授权消失 → 判定回落 ask。
import { randomUUID } from "node:crypto";
import {
  TTL_PERMISSION_GRANT_FILE_VERSION,
  type TtlPermissionGrant,
  type TtlPermissionGrantFile,
} from "@acode/contracts";

export interface ParseTtlPermissionGrantFileResult {
  file: TtlPermissionGrantFile;
  /** 被丢弃的非法/过期条目数（观测用）。 */
  discarded: number;
  /** 文件声明了高于本构建认识的版本：整份作废（旧构建不得猜测未来语义）。 */
  futureVersion: boolean;
  /** 文件不可解析：整份作废。 */
  corrupt: boolean;
}

/**
 * 带版本文件形态的解析与迁移（spec R4）：
 * - version 缺失/0 → 按 1 宽松解析（v0 草案形态与 1 同字段，逐条校验即迁移）；
 * - version > 1 → 整份作废并置 futureVersion（回落 ask，安全方向）；
 * - 逐条校验：toolName 非空、expiresAt 可解析且未过期、origin 在闭集内；
 *   非法条目丢弃计数，不猜测、不修复。
 */
export function parseTtlPermissionGrantFile(
  raw: unknown,
  nowMs: number,
): ParseTtlPermissionGrantFileResult {
  const empty: TtlPermissionGrantFile = { version: 1, grants: [] };
  if (!isRecord(raw)) {
    return { file: empty, discarded: 0, futureVersion: false, corrupt: true };
  }
  const version = raw.version;
  if (version !== undefined && version !== 0 && version !== TTL_PERMISSION_GRANT_FILE_VERSION) {
    // 未来版本：整份作废（fail-closed）。
    return { file: empty, discarded: 0, futureVersion: true, corrupt: false };
  }
  if (!Array.isArray(raw.grants)) {
    return { file: empty, discarded: 0, futureVersion: false, corrupt: true };
  }
  const grants: TtlPermissionGrant[] = [];
  let discarded = 0;
  for (const candidate of raw.grants) {
    const grant = parseGrant(candidate, nowMs);
    if (grant) grants.push(grant);
    else discarded += 1;
  }
  return {
    file: { version: TTL_PERMISSION_GRANT_FILE_VERSION, grants },
    discarded,
    futureVersion: false,
    corrupt: false,
  };
}

export function parseIsoDateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrant(candidate: unknown, nowMs: number): TtlPermissionGrant | undefined {
  if (!isRecord(candidate)) return undefined;
  const toolName = candidate.toolName;
  if (typeof toolName !== "string" || toolName.trim().length === 0) return undefined;
  const expiresAt = parseIsoDateMs(candidate.expiresAt);
  // 已过期或不可解析的期限：条目作废（过期授权本就回落 ask）。
  if (expiresAt === undefined || expiresAt <= nowMs) return undefined;
  const origin = candidate.origin;
  if (origin !== "interactive" && origin !== "unattended") return undefined;
  const grantedAtMs = parseIsoDateMs(candidate.grantedAt);
  const ruleContent = candidate.ruleContent;
  const scopeKey = candidate.scopeKey;
  const grantId = candidate.grantId;
  return {
    grantId: typeof grantId === "string" && grantId.length > 0 ? grantId : randomUUID(),
    toolName,
    ...(typeof ruleContent === "string" && ruleContent.length > 0 ? { ruleContent } : {}),
    expiresAt: new Date(expiresAt).toISOString(),
    grantedAt: new Date(grantedAtMs ?? nowMs).toISOString(),
    origin,
    ...(typeof scopeKey === "string" && scopeKey.length > 0 ? { scopeKey } : {}),
  };
}
