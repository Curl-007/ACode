import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
} from "../../shared/src/validationAppSettings.js";
import { acodeTaskMetaSchema } from "../../shared/src/validation.js";
import { readAskUserQuestionAnswers } from "../src/lib/askUserQuestion.js";
import {
  getAgentPrimaryText,
  getAgentKindLabel,
} from "../src/ToolCallBlocks/renderers/agentHelpers.js";
import { getToolCallErrorText } from "../src/lib/toolError.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { extractStructuredDiff } from "../src/lib/toolDiffPreview.js";

const meta = {
  taskId: "session-example",
  traceId: "trace-example",
  title: "Example",
  workspacePath: "/example/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "build",
  provider: "glm",
};

test("current task metadata is accepted without upgrading third-party Agent identities", () => {
  assert.equal(acodeTaskMetaSchema.parse(meta).provider, "glm");
  // 外部引擎槽位已下线：旧第三方 provider 值不再被拒绝，而是解析时归一为缺省（undefined）
  // ——消费方经 resolveAgentEngine 回退 glm，且不会伪造 glm 边界混入 runtime provider 过滤
  // （spec: agent-engine-external-slots-removal.md，旧持久化数据无需迁移）。
  for (const provider of ["claude", "codex", "gemini", "opencode"]) {
    const parsed = acodeTaskMetaSchema.safeParse({ ...meta, provider });
    assert.equal(parsed.success, true, provider);
    assert.equal(parsed.success ? parsed.data.provider : "not-success", undefined, provider);
  }
});

test("obsolete Agent settings are stripped without dropping current user preferences", () => {
  const settings = {
    enabledBuiltinAgentCliProviders: ["claude", "codex"],
    localePreference: "en-US",
  };
  for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
    const parsed = schema.parse(settings);
    assert.equal(parsed.localePreference, "en-US");
    assert.equal("enabledBuiltinAgentCliProviders" in parsed, false);
  }
});

test("current question results work while Claude ACP text is no longer interpreted as answers", () => {
  const input = { question: "Choose", options: [{ label: "One" }, { label: "Two" }] };
  assert.deepEqual(
    readAskUserQuestionAnswers({ input, output: { type: "answered", selected: "One" } }),
    { Choose: "One" },
  );
  assert.deepEqual(
    readAskUserQuestionAnswers({ input, output: { type: "answered_custom", text: "Custom" } }),
    { Choose: "Custom" },
  );
  assert.deepEqual(readAskUserQuestionAnswers({ output: { answers: { Choose: "Two" } } }), {
    Choose: "Two",
  });
  for (const output of ['"Choose"="One"', { content: [{ text: '"Choose"="One"' }] }]) {
    assert.equal(readAskUserQuestionAnswers({ input, output }), undefined);
    assert.equal(readAskUserQuestionAnswers({ input, raw: { output } }), undefined);
    assert.equal(readAskUserQuestionAnswers({ input, raw: { rawOutput: output } }), undefined);
  }
});

test("ACode subagent identity wins over retired Codex nicknames", () => {
  const tool = {
    id: "tool-example",
    kind: "Agent",
    title: "Agent",
    status: "completed" as const,
    input: { subagent_type: "researcher", description: "Inspect sources" },
    raw: { nickname: "retired nickname" },
  };
  assert.equal(getAgentPrimaryText(tool, "Agent"), "Inspect sources");
  assert.equal(getAgentKindLabel(tool, "Agent"), "researcher");
  assert.equal(resolveToolCallIdentity({ toolName: "Task" }).family, "agent");
  assert.equal(resolveToolCallIdentity({ kind: "spawn_agent" }).family, "unknown");
});

test("current tool errors remain available without Claude ACP status overrides", () => {
  assert.equal(
    getToolCallErrorText({ status: "failed", error: "Permission denied" }),
    "Permission denied",
  );
  assert.equal(
    getToolCallErrorText({
      status: "failed",
      output: "<tool_use_error>Invalid input</tool_use_error>",
    }),
    "Invalid input",
  );
  assert.equal(
    getToolCallErrorText({
      status: "completed",
      raw: { status: "failed", rawOutput: "legacy error" },
    }),
    undefined,
  );
});

test("generic structured diffs still accept current tool content", () => {
  const diff = { type: "diff", path: "/example/file.ts", oldText: "before", newText: "after" };
  assert.deepEqual(extractStructuredDiff({ content: [diff] }), {
    path: diff.path,
    oldText: diff.oldText,
    newText: diff.newText,
  });
});
