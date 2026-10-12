import assert from "node:assert/strict";
import test from "node:test";
import {
  appendNetworkRecords,
  filterNetworkRecords,
  formatNetworkRecordDuration,
  formatNetworkRecordTime,
  NETWORK_CAPTURE_MAX_RECORDS,
  NETWORK_CAPTURE_PAGE_SIZE,
  paginateNetworkRecords,
  type NetworkCaptureRecord,
} from "../src/resource-manager/networkCaptureView.js";

/**
 * 资源管理器 network tab 的纯视图规则（packages/desktop/specs/runtime-network-capture.md）：
 * 子串过滤、50/页分页、环形上界与展示格式。
 */

function record(url: string, overrides: Partial<NetworkCaptureRecord> = {}): NetworkCaptureRecord {
  return {
    startedAt: 1_700_000_000_000,
    method: "GET",
    url,
    ...overrides,
  };
}

test("过滤按 URL/方法/发起面/状态码的子串、大小写不敏感", () => {
  const records = [
    record("https://api.example.com/v1/chat", { method: "POST", status: 200 }),
    record("https://example.com/REDACTED?token=<redacted>", { phase: "cli" }),
    record("https://other.test/404", { status: 404 }),
  ];
  assert.equal(filterNetworkRecords(records, "example.com").length, 2);
  assert.equal(filterNetworkRecords(records, "POST").length, 1);
  assert.equal(filterNetworkRecords(records, "cli").length, 1);
  assert.equal(filterNetworkRecords(records, "404").length, 1);
  // 空与纯空白 = 不过滤；原数组不被修改。
  assert.equal(filterNetworkRecords(records, "  ").length, 3);
  assert.equal(filterNetworkRecords(records, "").length, 3);
});

test("分页 50/页，页码越界钳到最后一页", () => {
  const records = Array.from({ length: 120 }, (_, index) => record(`https://x.test/${index}`));
  const first = paginateNetworkRecords(records, 1);
  assert.equal(first.page, 1);
  assert.equal(first.pageCount, 3);
  assert.equal(first.records.length, NETWORK_CAPTURE_PAGE_SIZE);
  assert.equal(first.records[0].url, "https://x.test/0");

  const last = paginateNetworkRecords(records, 99);
  assert.equal(last.page, 3);
  assert.equal(last.records.length, 120 - 2 * NETWORK_CAPTURE_PAGE_SIZE);

  const empty = paginateNetworkRecords([], 5);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(empty.records, []);
});

test("追加批次维持上界，挤掉最旧的", () => {
  const initial = Array.from({ length: 400 }, (_, index) => record(`https://old.test/${index}`));
  const batch = Array.from({ length: 200 }, (_, index) => record(`https://new.test/${index}`));
  const next = appendNetworkRecords(initial, batch);
  assert.equal(next.length, NETWORK_CAPTURE_MAX_RECORDS);
  // 保留 550 条 = 最新的 350 条旧记录（50..399）+ 200 条新记录。
  assert.equal(
    next[0].url,
    `https://old.test/${initial.length - (NETWORK_CAPTURE_MAX_RECORDS - batch.length)}`,
  );
  assert.equal(next.at(-1)?.url, "https://new.test/199");
  // 未超界时不裁剪、保序追加。
  assert.equal(appendNetworkRecords([], batch).length, 200);
});

test("时间与耗时的展示格式", () => {
  const time = formatNetworkRecordTime(new Date("2026-01-02T03:04:05").getTime());
  assert.match(time, /^03:04:05$/);
  assert.equal(formatNetworkRecordTime(Number.NaN), "");
  assert.equal(formatNetworkRecordDuration(42), "42 ms");
  assert.equal(formatNetworkRecordDuration(1500), "1.5 s");
  assert.equal(formatNetworkRecordDuration(undefined), "");
});
