import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * T2-9 digest markdown 渲染验证（apps/acode-cli/specs/periodic-digest.md R3/R5/R7）：
 * 头部数据非指令声明、四节 + 警告节、空节 (none)、防御性单行化、32KB 字节截断。
 */

const { renderDigestMarkdown, clampDigestMarkdownBytes } =
  await import("../packages/core/src/digest/render.ts");
const { DIGEST_UNTRUSTED_NOTICE, DIGEST_MAX_MARKDOWN_BYTES } =
  await import("../packages/core/src/digest/types.ts");

const NOW = 1_800_000_000_000;

function doc(overrides = {}) {
  return {
    generatedAt: NOW,
    sections: { inProgress: [], attention: [], routines: [], artifacts: [] },
    sourceWarnings: [],
    ...overrides,
  };
}

test("render: header carries timestamp and the data-not-instructions notice (R3)", () => {
  const markdown = renderDigestMarkdown(doc());
  const lines = markdown.split("\n");
  assert.match(lines[0], /^# Workspace Digest — \d{4}-\d{2}-\d{2}T/);
  assert.ok(markdown.includes(DIGEST_UNTRUSTED_NOTICE));
});

test("render: four sections always present; empty sections render (none)", () => {
  const markdown = renderDigestMarkdown(doc());
  for (const heading of [
    "## In progress (0)",
    "## Needs attention (0)",
    "## Scheduled routines (0)",
    "## Artifacts (0)",
  ]) {
    assert.ok(markdown.includes(heading), `missing heading: ${heading}`);
  }
  assert.ok(markdown.includes("(none)"));
  assert.ok(!markdown.includes("## Source warnings"), "no warnings section when clean");
});

test("render: items render with state, detail, cadence and ids", () => {
  const markdown = renderDigestMarkdown(
    doc({
      sections: {
        inProgress: [
          {
            kind: "task",
            id: "t-1",
            title: "Fix login",
            state: "running",
            detail: "local_agent, running for 10m",
          },
          {
            kind: "session",
            id: "s-1",
            title: "Refactor",
            state: "recent",
            detail: "2/3 todos done",
          },
        ],
        attention: [
          {
            kind: "automation",
            id: "a-1",
            title: "broken",
            reason: "scheduled automation failed",
            since: NOW - 5_000,
          },
        ],
        routines: [
          {
            automationId: "a-2",
            title: "每20分钟喝水提醒",
            cadence: "every 20 minutes",
            state: "paused",
            nextRunAt: NOW + 60_000,
            runCount: 7,
            maxRuns: 10,
          },
        ],
        artifacts: [
          {
            runId: "wf-1",
            runLabel: "Report run",
            artifactId: "art-1",
            kind: "markdown",
            title: "Weekly report",
            version: 2,
            primary: true,
          },
        ],
      },
      overflow: { attention: 3 },
      sourceWarnings: ["automation_query_failed"],
    }),
  );
  assert.ok(markdown.includes("## In progress (2)"));
  assert.ok(markdown.includes("- [task] Fix login — running — local_agent, running for 10m `t-1`"));
  assert.ok(markdown.includes("- [session] Refactor — recent — 2/3 todos done `s-1`"));
  assert.ok(markdown.includes("## Needs attention (1)"));
  assert.ok(markdown.includes("scheduled automation failed (since"));
  assert.ok(markdown.includes("## Scheduled routines (1)"));
  assert.ok(markdown.includes("每20分钟喝水提醒 — every 20 minutes; paused;"));
  assert.ok(markdown.includes("runs 7/10"));
  assert.ok(markdown.includes("## Artifacts (1)"));
  assert.ok(markdown.includes("Weekly report (markdown) [v2, primary] — run Report run `wf-1`"));
  assert.ok(markdown.includes("> Truncated sections: 3 more attention."));
  assert.ok(markdown.includes("## Source warnings (1)"));
  assert.ok(markdown.includes("- automation_query_failed"));
});

test("render: multi-line injection text is defensively flattened to one line (R3)", () => {
  const markdown = renderDigestMarkdown(
    doc({
      sections: {
        inProgress: [
          {
            kind: "task",
            id: "t-inj",
            title: "evil\n## Fake heading\n- fake item",
            state: "running",
            detail: "line1\nline2",
          },
        ],
        attention: [],
        routines: [],
        artifacts: [],
      },
    }),
  );
  // 单行化后注入文本只能作为一行内的数据存在：任何行都不以注入的 heading 开头
  //（markdown 结构只认行首），条目本体仍是单行。
  const lines = markdown.split("\n");
  assert.ok(
    !lines.some((line) => line.startsWith("## Fake heading")),
    "injected heading must not create line-level structure",
  );
  const itemLine = lines.find((line) => line.includes("`t-inj`"));
  assert.ok(itemLine.startsWith("- [task] "), "item stays a single list line");
  assert.ok(itemLine.includes("evil ## Fake heading - fake item"));
  assert.ok(itemLine.includes("line1 line2"));
});

test("clamp: markdown over the byte cap is truncated at a line boundary with a marker (R5)", () => {
  const huge = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${"y".repeat(40)}`).join(
    "\n",
  );
  const clamped = clampDigestMarkdownBytes(`${huge}\n`);
  const bytes = Buffer.byteLength(clamped, "utf8");
  assert.ok(bytes <= DIGEST_MAX_MARKDOWN_BYTES, `bytes=${bytes}`);
  assert.ok(clamped.endsWith("[truncated]\n"));
  // 未超限的输入逐字节不变。
  const small = "# Workspace Digest\n";
  assert.equal(clampDigestMarkdownBytes(small), small);
});

test("clamp: multi-byte characters never split mid-codepoint", () => {
  const line = "摘要".repeat(200); // 每行 1200 字节
  const huge = Array.from({ length: 60 }, () => line).join("\n");
  const clamped = clampDigestMarkdownBytes(`${huge}\n`);
  assert.ok(Buffer.byteLength(clamped, "utf8") <= DIGEST_MAX_MARKDOWN_BYTES);
  assert.ok(clamped.endsWith("[truncated]\n"));
  // 截断在行边界：去掉标记后的正文不含半字符（Buffer 往返一致）。
  const body = clamped.slice(0, -"[truncated]\n".length);
  assert.equal(Buffer.from(body, "utf8").toString("utf8"), body);
});
