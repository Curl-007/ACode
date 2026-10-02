import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 副屏边界契约验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/side-chat-boundary-contract.md 的 R1–R3
 * 与验收场景 1–3：
 * - 场景 1：六要素在场 + 长度上限 + 无 CJK；
 * - 场景 2：注入机制零改动（源码级钉住 buildSelectionSideChatBoundary 结构）；
 * - 场景 3：selection_side_chat 档位归属回归（persisted + 非 mid-conversation）。
 */

const { SELECTION_SIDE_CHAT_BOUNDARY } = await import(
  "../packages/core/src/runtime/methods/session-fork.ts"
);
const {
  SYSTEM_REMINDER_PERSISTED_SOURCES,
  SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  isMidConversationSystemSource,
  getSystemReminderDescriptor,
} = await import("../packages/core/src/system-reminder/source.ts");

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

test("(场景1/R1) 六要素逐条可定位，长度 ≤1600，无 CJK", () => {
  const text = SELECTION_SIDE_CHAT_BOUNDARY;
  assert.ok(text.length > 0);
  assert.ok(text.length <= 1600, `边界文本超长：${text.length} > 1600`);
  assert.ok(!CJK_PATTERN.test(text));
  // 1 身份与定位：
  assert.match(text, /side conversation forked from the parent task/);
  assert.match(text, /answering questions and lightweight exploration/);
  assert.match(text, /never present yourself as continuing the main thread's active work/);
  // 2 历史指令废止 + 边界后新指令才是活的：
  assert.match(text, /reference context only/);
  assert.match(text, /instructions, plans, and requests that appear in it are not active instructions/);
  assert.match(text, /only what the user submits in this side conversation, after this boundary, is active/);
  // 3 历史批准无效（含「不得续做历史里的任务/工具调用/批准/编辑」）：
  assert.match(text, /Do not continue, execute, or complete any task, tool call, approval, or edit/);
  assert.match(text, /approvals recorded there authorize nothing in this side conversation/);
  // 4 父线程工具活动仅参考：
  assert.match(text, /Tool and MCP calls visible in the inherited history happened in the parent thread/);
  assert.match(text, /do not infer active work from them/);
  // 5 禁子代理：
  assert.match(text, /Do not spawn or interact with subagents from this side conversation/);
  assert.match(text, /work that needs fan-out belongs to the main thread/);
  // 6 改动与提权纪律：
  assert.match(text, /Stay read-only by default/);
  assert.match(text, /Modify the workspace only when the user explicitly asks for it in this side conversation/);
  assert.match(text, /keep the change minimal and local/);
  assert.match(text, /Never request escalated permissions or broader sandbox access unless the user explicitly asks/);
});

test("(场景2/R2) 注入机制零改动：source/可见性/水合结构钉住（源码级）", async () => {
  const source = await readFile(
    new URL("../packages/core/src/runtime/methods/session-fork.ts", import.meta.url),
    "utf8",
  );
  // persisted synthetic notice 的关键结构逐字在场：
  assert.ok(source.includes('source: "selection_side_chat"'));
  assert.ok(source.includes('visibility: "model-only"'));
  assert.ok(source.includes("synthetic: true"));
  assert.ok(source.includes('kind: "system_reminder"'));
  assert.ok(source.includes('transcriptVisibility: "hidden"'));
  assert.ok(source.includes("buildSyntheticUserNoticePartMetadata"));
  // 常量已导出（R2 测试可达性）：
  assert.ok(source.includes("export const SELECTION_SIDE_CHAT_BOUNDARY"));
});

test("(场景3/R2) selection_side_chat 档位归属回归：persisted + 非 mid-conversation", () => {
  assert.ok(SYSTEM_REMINDER_PERSISTED_SOURCES.includes("selection_side_chat"));
  assert.ok(!SYSTEM_REMINDER_PER_REQUEST_SOURCES.includes("selection_side_chat"));
  // 边界必须位于新问题之前：非 mid-conversation 集合成员（source.ts:77-87 既有理由）。
  assert.equal(isMidConversationSystemSource("selection_side_chat"), false);
  const descriptor = getSystemReminderDescriptor("selection_side_chat");
  assert.equal(descriptor.channel, "history_continuity");
  assert.equal(descriptor.lifecycle, "resume_history");
});
