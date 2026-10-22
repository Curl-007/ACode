// 引导内联失败回退队列的 UI 呈现守护（packages/ui/specs/queue-guide-fellback-notice.md 场景 2/3）。
//
// ui 测试无 jsdom 套件（对齐 chatRowFactsSurface.test.ts）：
// - 纯函数 resolveGuideFellBackMessageId 直测 reasonCode → i18n id 映射（闭集三值 + 兜底）；
// - 源码契约钉住 QueueRow 的 fellBack 渲染分支接线；
// - i18n 键在 zh-CN / en-US 双份在场（缺键会显示原始 id）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveGuideFellBackMessageId } from "../src/v4/queueSteerFellback.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const QUEUE_PANEL = "../src/v4/ConversationQueuePanel.tsx";
const ZH_CN = "../src/i18n/locales/zh-CN.ts";
const EN_US = "../src/i18n/locales/en-US.ts";

const FELLBACK_KEYS = [
  "chat.queue.turnSteer.fellBack",
  "chat.queue.turnSteer.fellBack.noToolBoundary",
  "chat.queue.turnSteer.fellBack.turnInterrupted",
  "chat.queue.turnSteer.fellBack.attachmentsUnsupported",
] as const;

test("场景2: reasonCode 闭集三值各映射到自己的文案 id", () => {
  assert.equal(
    resolveGuideFellBackMessageId("guide.noToolBoundary"),
    "chat.queue.turnSteer.fellBack.noToolBoundary",
  );
  assert.equal(
    resolveGuideFellBackMessageId("guide.turnInterrupted"),
    "chat.queue.turnSteer.fellBack.turnInterrupted",
  );
  assert.equal(
    resolveGuideFellBackMessageId("guide.attachmentsUnsupported"),
    "chat.queue.turnSteer.fellBack.attachmentsUnsupported",
  );
});

test("场景2: 未知 / 缺省 reasonCode 落通用兜底 id（不抛、不返回裸码）", () => {
  assert.equal(resolveGuideFellBackMessageId(undefined), "chat.queue.turnSteer.fellBack");
  assert.equal(resolveGuideFellBackMessageId(""), "chat.queue.turnSteer.fellBack");
  assert.equal(
    resolveGuideFellBackMessageId("guide.someFutureReason"),
    "chat.queue.turnSteer.fellBack",
  );
});

test("场景3: QueueRow 含 fellBack 判定分支并接线 resolveGuideFellBackMessageId", () => {
  const panel = readSource(QUEUE_PANEL);
  // 只在确证的 fellBack 路径渲染（spec R3）：判定用 steer?.state === "fellBack"。
  assert.match(panel, /item\.steer\?\.state === "fellBack"/);
  // 文案经纯函数映射 + intl.formatMessage，不在组件里硬编码 reasonCode 词表。
  assert.match(panel, /resolveGuideFellBackMessageId\(item\.steer\.reasonCode\)/);
  assert.match(panel, /intl\.formatMessage\(\{ id: resolveGuideFellBackMessageId/);
  // 提示行走弱元数据排版（DESIGN.md：text-ui-xs + subtlest）。
  assert.match(panel, /text-ui-xs text-foreground-subtlest/);
});

test("场景3: 提示仅在 fellBackNotice 在场时渲染（非 fellBack 项零变化）", () => {
  const panel = readSource(QUEUE_PANEL);
  assert.match(panel, /fellBackNotice \? \(/);
});

test("i18n: fellBack 四键在 zh-CN / en-US 双份在场", () => {
  const zh = readSource(ZH_CN);
  const en = readSource(EN_US);
  for (const key of FELLBACK_KEYS) {
    assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
    assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
  }
});
