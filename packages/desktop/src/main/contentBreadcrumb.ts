// renderer 内容状态面包屑（specs/main-stall-diagnostics.md R11）：wire 契约校验
// （fail-closed 闭集）+ 按 webContentsId 的最新快照缓存 + send-only IPC 注册助手。
//
// 桶化理由：精确值既是噪声（每条消息都 diff）又是隐私面（内容规模细节），日志只
// 落桶名。闭集在本文件与 ui 侧 lib/contentStateBreadcrumb.ts 各持一份副本，spec
// R11 是唯一事实源；上移 packages/shared 属接线需求（channels.ts 归 W1-5）。
// 纯 Node，不 import electron（IPC 事件以结构面传入），node:test 可直接驱动。
import { isTrustedRendererSenderFrame, type SenderFrameLike } from "./rendererFrameTrust.js";

// TODO(接线): 通道常量待上移 packages/shared/src/channels.ts（PlatformChannels，
// W1-5 所有）；上移前 main 侧以本常量为事实源，preload/ui 接线使用同值字符串。
export const CONTENT_BREADCRUMB_IPC_CHANNEL = "acode:content-breadcrumb";

export const CONTENT_ROUTE_KINDS = ["chat", "settings", "browser", "other"] as const;
export const CONTENT_TRANSCRIPT_MSGS_BUCKETS = [
  "zero",
  "small",
  "medium",
  "large",
  "huge",
] as const;
export const CONTENT_COMPOSER_BLOCKS_BUCKETS = ["zero", "few", "many"] as const;
export const CONTENT_ROWS_HELD_BUCKETS = ["zero", "small", "medium", "large"] as const;

export type ContentRouteKind = (typeof CONTENT_ROUTE_KINDS)[number];
export type ContentTranscriptMsgsBucket = (typeof CONTENT_TRANSCRIPT_MSGS_BUCKETS)[number];
export type ContentComposerBlocksBucket = (typeof CONTENT_COMPOSER_BLOCKS_BUCKETS)[number];
export type ContentRowsHeldBucket = (typeof CONTENT_ROWS_HELD_BUCKETS)[number];

/** wire payload（renderer → main，snake_case）。 */
export interface ContentBreadcrumbWirePayload {
  route_kind: ContentRouteKind;
  transcript_msgs_bucket: ContentTranscriptMsgsBucket;
  composer_blocks_bucket: ContentComposerBlocksBucket;
  rows_held_bucket: ContentRowsHeldBucket;
}

export interface StoredContentBreadcrumb extends ContentBreadcrumbWirePayload {
  receivedAtMs: number;
}

/** 归因快照（进聚合日志的 content 块；stamp age 由 main 计算）。 */
export interface ContentBreadcrumbSnapshot extends ContentBreadcrumbWirePayload {
  stamp_age_ms: number;
}

function pickClosedSet<T extends string>(values: readonly T[], candidate: unknown): T | null {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate)
    ? (candidate as T)
    : null;
}

/**
 * wire 校验（fail-closed）：任一字段缺失/类型错/闭集外 ⇒ 整条返回 null。
 * 不做部分采纳——「字段缺失」与「值为零桶」必须可区分（spec R11）。
 */
export function parseContentBreadcrumbPayload(
  value: unknown,
  receivedAtMs: number,
): StoredContentBreadcrumb | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const routeKind = pickClosedSet(CONTENT_ROUTE_KINDS, raw.route_kind);
  const transcriptMsgs = pickClosedSet(CONTENT_TRANSCRIPT_MSGS_BUCKETS, raw.transcript_msgs_bucket);
  const composerBlocks = pickClosedSet(CONTENT_COMPOSER_BLOCKS_BUCKETS, raw.composer_blocks_bucket);
  const rowsHeld = pickClosedSet(CONTENT_ROWS_HELD_BUCKETS, raw.rows_held_bucket);
  if (!routeKind || !transcriptMsgs || !composerBlocks || !rowsHeld) return null;
  if (!Number.isFinite(receivedAtMs)) return null;
  return {
    route_kind: routeKind,
    transcript_msgs_bucket: transcriptMsgs,
    composer_blocks_bucket: composerBlocks,
    rows_held_bucket: rowsHeld,
    receivedAtMs,
  };
}

export interface ContentBreadcrumbRegistry {
  /** 校验并缓存最新一条；返回是否被采纳（false = fail-closed 拒绝）。 */
  record(webContentsId: number, payload: unknown, receivedAtMs?: number): boolean;
  /** 该 wc 的最新内容桶快照；从未上报 ⇒ null。 */
  snapshotFor(webContentsId: number, nowMs?: number): ContentBreadcrumbSnapshot | null;
  /** webContents 销毁时清缓存（导航不清：面包屑跨导航仍有归因价值）。 */
  clear(webContentsId: number): void;
}

export function createContentBreadcrumbRegistry(
  options: {
    now?: () => number;
  } = {},
): ContentBreadcrumbRegistry {
  const now = options.now ?? (() => Date.now());
  const latest = new Map<number, StoredContentBreadcrumb>();
  return {
    record(webContentsId, payload, receivedAtMs) {
      if (!Number.isInteger(webContentsId)) return false;
      const stored = parseContentBreadcrumbPayload(payload, receivedAtMs ?? now());
      if (!stored) return false;
      latest.set(webContentsId, stored);
      return true;
    },
    snapshotFor(webContentsId, nowMs) {
      const stored = latest.get(webContentsId);
      if (!stored) return null;
      const at = nowMs ?? now();
      return {
        route_kind: stored.route_kind,
        transcript_msgs_bucket: stored.transcript_msgs_bucket,
        composer_blocks_bucket: stored.composer_blocks_bucket,
        rows_held_bucket: stored.rows_held_bucket,
        stamp_age_ms: Math.max(0, Math.round(at - stored.receivedAtMs)),
      };
    },
    clear(webContentsId) {
      latest.delete(webContentsId);
    },
  };
}

/** ipcMain.on 事件的最小结构面（真实 IpcMainEvent 结构兼容）。 */
export interface DiagnosticsIpcEventLike {
  sender?: { id?: unknown } | null;
  senderFrame?: SenderFrameLike | null;
}

export interface DiagnosticsIpcMainLike {
  on(
    channel: string,
    listener: (event: DiagnosticsIpcEventLike, payload: unknown) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: DiagnosticsIpcEventLike, payload: unknown) => void,
  ): unknown;
}

export interface RegisterContentBreadcrumbIpcOptions {
  ipcMain: DiagnosticsIpcMainLike;
  registry: ContentBreadcrumbRegistry;
  logger: { warn: (...args: unknown[]) => void };
  channel?: string;
  /** 缺省用 rendererFrameTrust 的主帧 + 本地 origin 判定（spec R11/R12）。 */
  isTrustedSenderFrame?: (frame: SenderFrameLike | null | undefined) => boolean;
}

/**
 * 注册面包屑 send-only 通道；返回注销函数。sender 校验失败只 warn 事件名不回显
 * 帧 URL（日志纪律：不落用户可达地址），并 fail-closed 丢弃。
 */
export function registerContentBreadcrumbIpc(
  options: RegisterContentBreadcrumbIpcOptions,
): () => void {
  const channel = options.channel ?? CONTENT_BREADCRUMB_IPC_CHANNEL;
  const isTrusted = options.isTrustedSenderFrame ?? isTrustedRendererSenderFrame;
  const listener = (event: DiagnosticsIpcEventLike, payload: unknown): void => {
    if (!isTrusted(event?.senderFrame)) {
      options.logger.warn("[renderer-diag] breadcrumb sender rejected", {
        event: "breadcrumb_sender_rejected",
      });
      return;
    }
    const webContentsId = event?.sender?.id;
    if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) return;
    options.registry.record(webContentsId, payload);
  };
  options.ipcMain.on(channel, listener);
  return () => {
    options.ipcMain.removeListener(channel, listener);
  };
}
