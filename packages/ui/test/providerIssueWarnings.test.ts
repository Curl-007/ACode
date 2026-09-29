import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConfigIssueDisplay,
  resolveConfigIssueText,
  selectProviderWarningIssues,
} from "../src/lib/providerIssueWarnings.js";
import { isBlockingConfigIssue } from "@acode/provider";
import type { ConfigValidationIssue } from "@acode/provider";

// 测试桩：把 i18n key 原样回显，便于断言映射结果。
const echoFormatMessage = (messageId: string): string => messageId;

function makeIssue(
  overrides: Partial<ConfigValidationIssue> & Pick<ConfigValidationIssue, "code">,
): ConfigValidationIssue {
  return {
    path: ["providers", "p1", "baseUrl"],
    message: `诊断 ${overrides.code}`,
    ...overrides,
  };
}

test("selectProviderWarningIssues 只保留显式 warning 诊断", () => {
  const warning = makeIssue({ code: "plaintext-http-endpoint", severity: "warning" });
  const error = makeIssue({ code: "invalid-url", severity: "error" });
  const result = selectProviderWarningIssues([warning, error]);
  assert.deepEqual(result, [warning]);
});

test("selectProviderWarningIssues 把缺省 severity 视为 error 并过滤", () => {
  const implicitError = makeIssue({ code: "required-field-missing" });
  const warning = makeIssue({ code: "plaintext-http-endpoint", severity: "warning" });
  const result = selectProviderWarningIssues([implicitError, warning]);
  // 缺省 severity 是 error（契约 R1），不得因为字段缺失被误判成 warning。
  assert.deepEqual(result, [warning]);
});

test("selectProviderWarningIssues 对空与 undefined 输入返回空数组", () => {
  assert.deepEqual(selectProviderWarningIssues([]), []);
  assert.deepEqual(selectProviderWarningIssues(undefined), []);
});

test("resolveConfigIssueText 将 plaintext-http-endpoint 映射到既有 i18n key", () => {
  const issue = makeIssue({
    code: "plaintext-http-endpoint",
    severity: "warning",
    message: "硬编码中文 message",
  });
  // spec R5：已知 code 一律走 i18n，不渲染诊断自带的单语 message。
  assert.equal(
    resolveConfigIssueText(issue, echoFormatMessage),
    "settings.modelProvider.baseUrlPlaintextHttpWarning",
  );
});

test("resolveConfigIssueText 对未知 code 回退 issue.message", () => {
  const issue = makeIssue({
    code: "required-field-missing",
    message: "缺少必填配置 providers.p1.apiKey",
  });
  assert.equal(resolveConfigIssueText(issue, echoFormatMessage), "缺少必填配置 providers.p1.apiKey");
});

test("resolveConfigIssueDisplay 的色调与 @acode/provider 谓词语义一致", () => {
  const cases: ConfigValidationIssue[] = [
    makeIssue({ code: "invalid-url", severity: "error" }),
    makeIssue({ code: "required-field-missing" }),
    makeIssue({ code: "plaintext-http-endpoint", severity: "warning" }),
  ];
  for (const issue of cases) {
    const display = resolveConfigIssueDisplay(issue, echoFormatMessage, "fallback");
    assert.equal(
      display.tone === "destructive",
      isBlockingConfigIssue(issue),
      `code=${issue.code} severity=${issue.severity ?? "(缺省)"} 的分流应与谓词一致`,
    );
  }
});

test("resolveConfigIssueDisplay 缺省 severity 走 destructive 且文案走 i18n 回退", () => {
  const issue = makeIssue({ code: "duplicate-model", message: "模型重复" });
  const display = resolveConfigIssueDisplay(issue, echoFormatMessage, "fallback");
  assert.equal(display.tone, "destructive");
  assert.equal(display.text, "模型重复");
});

test("resolveConfigIssueDisplay 无诊断时使用兜底文案与 destructive", () => {
  const display = resolveConfigIssueDisplay(undefined, echoFormatMessage, "配置不完整");
  assert.equal(display.tone, "destructive");
  assert.equal(display.text, "配置不完整");
});

test("resolveConfigIssueDisplay 的 warning 诊断同时改变文案来源与色调", () => {
  const issue = makeIssue({
    code: "plaintext-http-endpoint",
    severity: "warning",
    message: "硬编码中文 message",
  });
  const display = resolveConfigIssueDisplay(issue, echoFormatMessage, "配置不完整");
  assert.equal(display.tone, "warning");
  assert.equal(display.text, "settings.modelProvider.baseUrlPlaintextHttpWarning");
});
