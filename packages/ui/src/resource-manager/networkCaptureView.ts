/**
 * 资源管理器 network tab 的纯视图规则（packages/desktop/specs/runtime-network-capture.md 的
 * 桌面链路一节）。过滤（子串、大小写不敏感）与分页（50/页）都是纯函数——订阅、开关与清空
 * 的状态机在 `NetworkSection.tsx`，规则放这里可以单独被 node --test 钉住。
 */

/** 每页条数（spec：分页前/后，每页 50）。 */
export const NETWORK_CAPTURE_PAGE_SIZE = 50;

/** 本地保留的记录上界：环形缓冲对齐 agent 侧的 500 条，再留一页余量给在途批次。 */
export const NETWORK_CAPTURE_MAX_RECORDS = 500 + NETWORK_CAPTURE_PAGE_SIZE;

/** 一条被观测到的出站请求（agent runtime 进程内；字段由 v4 networkCaptureRecords 事件携带）。 */
export interface NetworkCaptureRecord {
  /** 发起时刻（epoch 毫秒）。 */
  startedAt: number;
  /** 发起面（如 `cli`）；展示列「Phase」。 */
  phase?: string;
  method: string;
  /** 已脱敏的 URL（userinfo 剥离、query 值已替换为 `<redacted>`）。 */
  url: string;
  /** 响应状态码；网络层失败为 null（与 v4 networkCaptureRecordSchema 同形），在途请求缺席。 */
  status?: number | null;
  /** 耗时（毫秒）；在途请求缺席。 */
  durationMs?: number;
}

/** 子串过滤（大小写不敏感）。空/纯空白查询 = 不过滤。 */
export function filterNetworkRecords(
  records: readonly NetworkCaptureRecord[],
  query: string,
): NetworkCaptureRecord[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...records];
  return records.filter(
    (record) =>
      record.url.toLowerCase().includes(needle) ||
      record.method.toLowerCase().includes(needle) ||
      (record.phase !== undefined && record.phase.toLowerCase().includes(needle)) ||
      (record.status !== undefined && String(record.status).includes(needle)),
  );
}

export interface NetworkCapturePage {
  /** 当前页的记录（引用稳定：来自同一份过滤结果数组）。 */
  records: NetworkCaptureRecord[];
  /** 1 起的页码。 */
  page: number;
  pageCount: number;
}

/**
 * 分页：把过滤结果按 50/页切开。页码越界时**钳到最后一页**而不是给一个空页——
 * 清空或过滤收窄后旧页码必然越界，钳回尾部让用户始终看得见东西。
 */
export function paginateNetworkRecords(
  records: readonly NetworkCaptureRecord[],
  page: number,
  pageSize: number = NETWORK_CAPTURE_PAGE_SIZE,
): NetworkCapturePage {
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const start = (clamped - 1) * pageSize;
  return { records: records.slice(start, start + pageSize), page: clamped, pageCount };
}

/** 追加一批记录并维持上界（最旧的被挤掉）。 */
export function appendNetworkRecords(
  current: readonly NetworkCaptureRecord[],
  batch: readonly NetworkCaptureRecord[],
  max: number = NETWORK_CAPTURE_MAX_RECORDS,
): NetworkCaptureRecord[] {
  const next = [...current, ...batch];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 时间列的展示（HH:MM:SS，本地时区）；非法时刻回退空串而不是 NaN。 */
export function formatNetworkRecordTime(startedAt: number): string {
  if (!Number.isFinite(startedAt)) return "";
  const date = new Date(startedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 耗时列的展示：<1s 用毫秒，否则秒带一位小数。 */
export function formatNetworkRecordDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}
