import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getPermissionJustification,
  PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID,
} from "../src/lib/permissionJustification.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import type { ACodePermissionRequest } from "@acode/shared";

/**
 * J1-2 反射门 justification 审批段的验收测试（评审 J1-2 修复）。
 *
 * 规格 apps/acode-cli/specs/bash-confirm-reflexive-gate.md R8 描述了渲染位置/样式/
 * 滚动，但此前实现侧的 data 属性与两个 i18n key 全仓无任何测试引用——plan 验收项
 * 「有效 justification 后 ask 弹窗携带原文」只在 decision.reason 层被测到，UI 投影
 * （从权限请求 payload 取数）零覆盖。这里覆盖：取数投影、i18n 双份 locale、以及
 * 弹窗渲染处的稳定定位点仍然存在（源码守卫，同 packages/ui/tests/no-telemetry 的形态）。
 */

const DIALOG_SOURCE_PATH = fileURLToPath(new URL("../src/PermissionDialog.tsx", import.meta.url));

function makeRequest(raw: unknown): ACodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1" as ACodePermissionRequest["traceId"],
    requestId: "req-1",
    description: "run command",
    kind: "bash",
    options: [
      {
        optionId: "req-1-allow",
        kind: "allow",
        name: "Allow",
        response: { decision: "allow" },
      },
    ],
    raw,
  } as ACodePermissionRequest;
}

const JUSTIFICATION =
  "The user explicitly asked to delete every file listed in paths.txt from this workspace";

test("justification is projected from the protocol input payload", () => {
  // 协议 PermissionRequested 的 input 是 z.unknown() 透传：justification 随工具入参到达。
  assert.equal(
    getPermissionJustification(
      makeRequest({ input: { command: "rm -rf x", justification: JUSTIFICATION } }),
    ),
    JUSTIFICATION,
  );
});

test("justification is projected from the legacy rawInput payload", () => {
  // readRawToolCallInput 先读兼容字段 rawInput：旧 UI 取数路径必须同样拿到论证原文。
  assert.equal(
    getPermissionJustification(makeRequest({ rawInput: { justification: JUSTIFICATION } })),
    JUSTIFICATION,
  );
});

test("justification text is trimmed so the section never renders as blank", () => {
  assert.equal(
    getPermissionJustification(makeRequest({ input: { justification: `  ${JUSTIFICATION}  ` } })),
    JUSTIFICATION,
  );
});

test("absent, empty, whitespace-only and non-string justifications render no section", () => {
  // null 是「不渲染论证段」的唯一判据（PermissionDialog 按 truthiness 决定是否渲染）。
  assert.equal(getPermissionJustification(makeRequest({ input: { command: "ls" } })), null);
  assert.equal(getPermissionJustification(makeRequest({ input: { justification: "" } })), null);
  assert.equal(getPermissionJustification(makeRequest({ input: { justification: "   " } })), null);
  assert.equal(getPermissionJustification(makeRequest({ input: { justification: 42 } })), null);
  assert.equal(
    getPermissionJustification(makeRequest({ input: { justification: { text: JUSTIFICATION } } })),
    null,
  );
  assert.equal(getPermissionJustification(makeRequest({})), null);
  assert.equal(getPermissionJustification(makeRequest(null)), null);
  assert.equal(getPermissionJustification(makeRequest("rm -rf x")), null);
  assert.equal(getPermissionJustification(makeRequest([{ justification: JUSTIFICATION }])), null);
});

test("rawInput wins over input, matching the shared raw payload reader", () => {
  assert.equal(
    getPermissionJustification(
      makeRequest({
        rawInput: { justification: JUSTIFICATION },
        input: { justification: "a different justification text from the model" },
      }),
    ),
    JUSTIFICATION,
  );
});

test("the justification label is localized in both shipped locales", () => {
  // AGENTS.md 国际化约定：桌面与手机 Web 共用同一份组件，缺任一 locale 就会露出 key 原文。
  const en = enUS[PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID];
  const zh = zhCN[PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID];
  assert.equal(typeof en, "string");
  assert.equal(typeof zh, "string");
  assert.ok(en!.trim().length > 0, "en-US label must not be empty");
  assert.ok(zh!.trim().length > 0, "zh-CN label must not be empty");
  assert.notEqual(en, zh, "zh-CN must be an actual translation, not a copy of en-US");
});

test("the permission dialog renders the justification section behind a stable locator", async () => {
  const source = await readFile(DIALOG_SOURCE_PATH, "utf8");
  // 取数逻辑只有一份所有者（lib/permissionJustification.ts）：弹窗不得再自带一份实现，
  // 否则两条投影路径会各自漂移（AGENTS.md「避免重复状态和多条写入路径」）。
  assert.match(
    source,
    /getPermissionJustification,\s*\n?\s*PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID/,
  );
  assert.doesNotMatch(source, /function getPermissionJustification\(/);
  // 论证段仅在投影出非空 justification 时渲染，并保留 E2E 稳定定位点。
  assert.match(source, /\{justification \? \(/);
  assert.match(source, /data-permission-justification="true"/);
  // 标题走 i18n key 常量，不写死字面量。
  assert.match(source, /id: PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID/);
  assert.doesNotMatch(source, /id: "chat\.permission\.justification\.label"/);
  // 原文按 pre-wrap 展示且段内滚动（R8：长文本不挤掉权限选项）。
  assert.match(source, /max-h-40 overflow-y-auto whitespace-pre-wrap/);
});
