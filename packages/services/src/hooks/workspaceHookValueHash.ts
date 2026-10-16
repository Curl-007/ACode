import { createHash } from "node:crypto";
import type { WorkspaceHookTrustRecord } from "@acode/shared/workspace-hook-trust-store-file";
import type { CanonicalWorkspaceHookEntryData } from "@acode/shared/workspace-hook-discovery";

/**
 * Workspace Hook 信任「展示值哈希」与等价判定（价值提取第二轮 T2-s5① 先行件，
 * spec 见 packages/services/specs/hooks-trust-value-hash.md）。
 *
 * 两面关系与单源义务：CLI 树（apps/acode-cli）是信任执行面与 store 唯一写入方，
 * 以 (workspaceIdentity, hookDeclarationDigest) 精确匹配放行；本模块只服务 services
 * 展示面的 trustState 分类，不写 store、不建第二份同意库。信任记录文件与 schema 的
 * 单源仍是 @acode/shared/workspace-hook-trust-store-file。
 *
 * 「值哈希失配即重问」：declaration digest 本身已覆盖全部值面（值变→digest 变→
 * 回到待信任态）。本模块补的是**改名兼容**（参考实现 formerLabels 的 ACode 等价物）：
 * declaration digest 的键面包含源文件相对路径/发现序/索引，仅路径或位置变化、
 * 值未变时 digest 也变——展示值哈希对这些键面不变量取哈希，把「改名」与「新钩子」
 * 区分开（stale_digest vs pending_trust）。
 *
 * 安全边界：任何等价命中都**不升级**为 trusted_persistent——runtime 按精确 digest
 * 强制，展示面单方面放行会造成「UI 已信任、Hook 永不执行」分歧（hooksService 头
 * 注释登记的事故模式）。等价只降低打扰等级（可重新 grant 的陈旧记录 vs 全新未知钩子）。
 */

/** 展示值哈希 canonical payload 的域分离标签。 */
export const WORKSPACE_HOOK_DISPLAY_VALUE_HASH_TAG = "workspace-hook-display-value-v1";

/** slot 等价键的域分离标签（镜像 runtime hasStaleSlotRecord 的比较字段集）。 */
export const WORKSPACE_HOOK_SLOT_KEY_TAG = "workspace-hook-slot-v1";

export type WorkspaceHookDisplayTrustState =
  | "trusted_persistent"
  | "stale_digest"
  | "pending_trust";

interface DisplayCommandSource {
  type: "command" | "process";
  command: string;
  args?: readonly string[];
}

/**
 * displayCommand 推导必须与 CLI 写记录侧（workspace-hook-trust-records.ts 的
 * displayCommandAtGrant）逐字一致，否则记录侧哈希永远对不上：
 * process → [command, ...args].join(" ")；command → command。
 */
export function deriveWorkspaceHookDisplayCommand(entry: DisplayCommandSource): string {
  return entry.type === "process"
    ? [entry.command, ...(entry.args ?? [])].join(" ")
    : entry.command;
}

function sha256Hex(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** 展示值哈希：不含路径/发现序/索引（改名不变量）。matcher 缺省按 null 归一。 */
export function computeWorkspaceHookDisplayValueHash(input: {
  event: string;
  matcher: string | null | undefined;
  displayCommand: string;
}): string {
  return sha256Hex([
    WORKSPACE_HOOK_DISPLAY_VALUE_HASH_TAG,
    input.event,
    input.matcher ?? null,
    input.displayCommand,
  ]);
}

export function computeWorkspaceHookEntryDisplayValueHash(
  entry: CanonicalWorkspaceHookEntryData,
): string {
  return computeWorkspaceHookDisplayValueHash({
    event: entry.event,
    matcher: entry.matcher,
    displayCommand: deriveWorkspaceHookDisplayCommand(entry),
  });
}

/**
 * 记录侧展示值哈希。AtGrant 字段不足以推导时返回 null（不参与改名等价，fail-closed）：
 * - eventAtGrant/displayCommandAtGrant 是 schema 必填，理论恒在；防御性判空。
 * - matcherAtGrant 可选：缺失（undefined）时无法区分「无 matcher」与「旧记录没存」，
 *   与 runtime slot 比较语义一致（undefined !== null），不判等。
 */
export function computeWorkspaceHookRecordDisplayValueHash(
  record: WorkspaceHookTrustRecord,
): string | null {
  if (!record.eventAtGrant || !record.displayCommandAtGrant) return null;
  if (record.matcherAtGrant === undefined) return null;
  return computeWorkspaceHookDisplayValueHash({
    event: record.eventAtGrant,
    matcher: record.matcherAtGrant,
    displayCommand: record.displayCommandAtGrant,
  });
}

/**
 * slot 等价键：event+源相对路径+发现序+matcher+两级索引（不含 digest）。
 * 与 runtime hasStaleSlotRecord 同字段集同语义：同 slot 而 digest 不同＝
 * 「同位置配置值变了」→ 重新询问（stale_digest 标签）。
 */
export function computeWorkspaceHookSlotKey(input: {
  event: string;
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
}): string {
  return sha256Hex([
    WORKSPACE_HOOK_SLOT_KEY_TAG,
    input.event,
    input.sourceRelativePath,
    input.sourceDiscoveryOrder,
    input.matcher,
    input.matcherIndex,
    input.hookIndex,
  ]);
}

/** 记录侧 slot 键：任一 slot AtGrant 字段缺失即不可比（返回 null），镜像 runtime 的跳过语义。 */
export function computeWorkspaceHookRecordSlotKey(record: WorkspaceHookTrustRecord): string | null {
  if (
    record.sourceDiscoveryOrderAtGrant === undefined ||
    record.matcherIndexAtGrant === undefined ||
    record.hookIndexAtGrant === undefined ||
    record.matcherAtGrant === undefined
  ) {
    return null;
  }
  return computeWorkspaceHookSlotKey({
    event: record.eventAtGrant,
    sourceRelativePath: record.sourcePathAtGrant,
    sourceDiscoveryOrder: record.sourceDiscoveryOrderAtGrant,
    matcher: record.matcherAtGrant,
    matcherIndex: record.matcherIndexAtGrant,
    hookIndex: record.hookIndexAtGrant,
  });
}

export function computeWorkspaceHookEntrySlotKey(
  entry: CanonicalWorkspaceHookEntryData,
  sourceDiscoveryOrder: number,
): string {
  return computeWorkspaceHookSlotKey({
    event: entry.event,
    sourceRelativePath: entry.sourceRelativePath,
    sourceDiscoveryOrder,
    matcher: entry.matcher,
    matcherIndex: entry.matcherIndex,
    hookIndex: entry.hookIndex,
  });
}

/**
 * 展示 trustState 分类（全部 fail-closed，判定顺序即优先级）：
 * 1. 精确 digest 命中 → trusted_persistent（与 runtime 放行条件一致）。
 * 2. slot 等价（同位置值变）→ stale_digest（镜像 runtime）。
 * 3. 改名等价（值同、路径/位置变）→ stale_digest（重新询问，但标记为已信任记录演进）。
 * 4. 其余 → pending_trust。
 */
export function resolveWorkspaceHookDisplayTrustState(input: {
  entry: CanonicalWorkspaceHookEntryData;
  sourceDiscoveryOrder: number;
  trustedDigests: ReadonlySet<string>;
  recordSlotKeys: ReadonlySet<string>;
  recordDisplayValueHashes: ReadonlySet<string>;
}): WorkspaceHookDisplayTrustState {
  if (input.trustedDigests.has(input.entry.hookDeclarationDigest)) {
    return "trusted_persistent";
  }
  if (
    input.recordSlotKeys.has(
      computeWorkspaceHookEntrySlotKey(input.entry, input.sourceDiscoveryOrder),
    )
  ) {
    return "stale_digest";
  }
  if (input.recordDisplayValueHashes.has(computeWorkspaceHookEntryDisplayValueHash(input.entry))) {
    return "stale_digest";
  }
  return "pending_trust";
}
