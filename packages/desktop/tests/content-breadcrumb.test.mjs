import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_BREADCRUMB_IPC_CHANNEL,
  CONTENT_COMPOSER_BLOCKS_BUCKETS,
  CONTENT_ROUTE_KINDS,
  CONTENT_ROWS_HELD_BUCKETS,
  CONTENT_TRANSCRIPT_MSGS_BUCKETS,
  createContentBreadcrumbRegistry,
  parseContentBreadcrumbPayload,
  registerContentBreadcrumbIpc,
} from "../src/main/contentBreadcrumb.js";
import { isTrustedRendererSenderFrame } from "../src/main/rendererFrameTrust.js";

/**
 * renderer 内容状态面包屑（specs/main-stall-diagnostics.md R11/R12）单测：
 * wire 校验 fail-closed、per-wc 最新快照、stamp age、销毁清理、
 * 受信 senderFrame 判定与 IPC 注册助手。
 */

const VALID_PAYLOAD = {
  route_kind: "chat",
  transcript_msgs_bucket: "medium",
  composer_blocks_bucket: "few",
  rows_held_bucket: "large",
};

test("wire 闭集与 spec R11 一致（副本漂移守卫）", () => {
  assert.deepEqual([...CONTENT_ROUTE_KINDS], ["chat", "settings", "browser", "other"]);
  assert.deepEqual(
    [...CONTENT_TRANSCRIPT_MSGS_BUCKETS],
    ["zero", "small", "medium", "large", "huge"],
  );
  assert.deepEqual([...CONTENT_COMPOSER_BLOCKS_BUCKETS], ["zero", "few", "many"]);
  assert.deepEqual([...CONTENT_ROWS_HELD_BUCKETS], ["zero", "small", "medium", "large"]);
  assert.equal(CONTENT_BREADCRUMB_IPC_CHANNEL, "acode:content-breadcrumb");
});

test("parse：合法 payload 采纳并附 receivedAtMs；畸形一律整条拒绝（fail-closed）", () => {
  assert.deepEqual(parseContentBreadcrumbPayload(VALID_PAYLOAD, 5_000), {
    ...VALID_PAYLOAD,
    receivedAtMs: 5_000,
  });
  const rejected = [
    null,
    "chat",
    42,
    {},
    { ...VALID_PAYLOAD, route_kind: "cowork" }, // 闭集外
    { ...VALID_PAYLOAD, transcript_msgs_bucket: 3 }, // 类型错
    { ...VALID_PAYLOAD, composer_blocks_bucket: undefined }, // 缺失
    { route_kind: "chat" }, // 部分字段不构成采纳理由
    { ...VALID_PAYLOAD, rows_held_bucket: "" },
  ];
  for (const payload of rejected) {
    assert.equal(
      parseContentBreadcrumbPayload(payload, 1_000),
      null,
      `应拒绝 ${JSON.stringify(payload) ?? String(payload)}`,
    );
  }
  assert.equal(
    parseContentBreadcrumbPayload(VALID_PAYLOAD, Number.NaN),
    null,
    "receivedAt 非法同样拒绝",
  );
});

test("registry：per-wc 只留最新一条；stamp age 由 main 计算；clear 后归 null", () => {
  let t = 10_000;
  const registry = createContentBreadcrumbRegistry({ now: () => t });
  assert.equal(registry.snapshotFor(1), null, "从未上报 ⇒ null");

  assert.equal(registry.record(1, VALID_PAYLOAD), true);
  t = 12_000;
  assert.equal(registry.record(1, { ...VALID_PAYLOAD, route_kind: "settings" }), true);
  t = 13_500; // age 以最新一条的接收时刻起算
  assert.deepEqual(registry.snapshotFor(1), {
    route_kind: "settings",
    transcript_msgs_bucket: "medium",
    composer_blocks_bucket: "few",
    rows_held_bucket: "large",
    stamp_age_ms: 1_500,
  });
  // 另一个 wc 各自独立
  assert.equal(registry.snapshotFor(2), null);
  registry.record(2, { ...VALID_PAYLOAD, route_kind: "browser" });
  assert.equal(registry.snapshotFor(2).route_kind, "browser");
  assert.equal(registry.snapshotFor(1).route_kind, "settings");

  registry.clear(1);
  assert.equal(registry.snapshotFor(1), null, "销毁清理后不得残留");
  assert.equal(registry.snapshotFor(2).route_kind, "browser");
});

test("registry：畸形 payload / 非法 wcId 拒绝且不污染既有快照；age 不为负", () => {
  let t = 20_000;
  const registry = createContentBreadcrumbRegistry({ now: () => t });
  registry.record(7, VALID_PAYLOAD);
  assert.equal(registry.record(7, { route_kind: "nope" }), false);
  assert.equal(registry.snapshotFor(7).route_kind, "chat", "拒绝不得覆盖旧快照");
  assert.equal(registry.record(1.5, VALID_PAYLOAD), false);
  assert.equal(registry.record(Number.NaN, VALID_PAYLOAD), false);
  t = 19_000; // 时钟回拨：age 钳 0 不为负
  assert.equal(registry.snapshotFor(7).stamp_age_ms, 0);
});

test("senderFrame 校验：主帧 + 应用自身面放行；子帧/远程/坏 URL 拒绝", () => {
  const trusted = [
    { url: "file:///C:/app/out/renderer/index.html", parent: null }, // 打包态 loadFile
    { url: "file:///opt/acode/renderer/index.html?windowKind=main", parent: null },
    { url: "http://localhost:5173/", parent: null }, // dev vite
    { url: "https://localhost:8443/index.html", parent: null },
    { url: "http://127.0.0.1:5173/", parent: null },
    { url: "http://[::1]:5173/", parent: null },
  ];
  for (const frame of trusted) {
    assert.equal(isTrustedRendererSenderFrame(frame), true, `应放行 ${frame.url}`);
  }
  const rejected = [
    null,
    undefined,
    { url: "http://localhost:5173/", parent: { url: "http://localhost:5173/" } }, // 子帧
    { url: "http://localhost:5173/" }, // parent 字段缺失的伪对象
    { url: "https://example.com/app", parent: null }, // 远程 origin（嵌入浏览器 guest）
    { url: "http://evil.com/?x=localhost", parent: null },
    { url: "not a url", parent: null },
    { url: "", parent: null },
    { parent: null }, // 无 URL
    "http://localhost:5173/",
  ];
  for (const frame of rejected) {
    assert.equal(
      isTrustedRendererSenderFrame(frame),
      false,
      `应拒绝 ${typeof frame === "string" ? frame : (JSON.stringify(frame) ?? String(frame))}`,
    );
  }
});

function createFakeIpcMain() {
  const listeners = new Map();
  return {
    listeners,
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
      return this;
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return this;
    },
    emit(channel, event, payload) {
      for (const listener of listeners.get(channel) ?? []) listener(event, payload);
    },
  };
}

test("registerContentBreadcrumbIpc：受信 sender 采纳、非受信拒绝并 warn（不回显 URL）", () => {
  const registry = createContentBreadcrumbRegistry({ now: () => 1_000 });
  const ipcMain = createFakeIpcMain();
  const warnings = [];
  const dispose = registerContentBreadcrumbIpc({
    ipcMain,
    registry,
    logger: { warn: (...args) => warnings.push(args) },
  });

  ipcMain.emit(
    CONTENT_BREADCRUMB_IPC_CHANNEL,
    { sender: { id: 3 }, senderFrame: { url: "http://localhost:5173/", parent: null } },
    VALID_PAYLOAD,
  );
  assert.equal(registry.snapshotFor(3).route_kind, "chat");
  assert.equal(warnings.length, 0);

  ipcMain.emit(
    CONTENT_BREADCRUMB_IPC_CHANNEL,
    { sender: { id: 4 }, senderFrame: { url: "https://example.com/", parent: null } },
    VALID_PAYLOAD,
  );
  assert.equal(registry.snapshotFor(4), null, "非受信 sender 不得入账");
  assert.equal(warnings.length, 1);
  const payload = warnings[0][1];
  assert.equal(payload.event, "breadcrumb_sender_rejected");
  assert.equal(JSON.stringify(payload).includes("example.com"), false, "不得回显帧 URL");

  // sender.id 缺失/非法：静默丢弃不入账
  ipcMain.emit(
    CONTENT_BREADCRUMB_IPC_CHANNEL,
    { senderFrame: { url: "file:///x", parent: null } },
    VALID_PAYLOAD,
  );
  assert.equal(warnings.length, 1);

  dispose();
  assert.equal(ipcMain.listeners.get(CONTENT_BREADCRUMB_IPC_CHANNEL).length, 0, "注销后移除监听");
});
