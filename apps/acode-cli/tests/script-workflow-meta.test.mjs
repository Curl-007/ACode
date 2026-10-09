import assert from "node:assert/strict";
import test from "node:test";

const { readWorkflowScriptDocument } =
  await import("../packages/cli-workflow/src/script-workflow-meta.ts");

function readDocument(content) {
  return readWorkflowScriptDocument({
    fileSystemPort: {
      async readTextFile() {
        return { content, truncated: false };
      },
    },
    scriptPath: "/tmp/review.workflow.js",
    traceContext: { traceId: "trace_meta" },
  });
}

test("SWF-05: meta 只接受 AST 纯字面量并返回解析值", async () => {
  const document = await readDocument(`
    export const meta = {
      name: "review",
      description: 'literal',
      phases: [{ title: "Inspect", detail: "files" }],
      whenToUse: "manual",
    };
    return 42;
  `);
  assert.deepEqual(document.meta, {
    description: "literal",
    name: "review",
    phases: [{ detail: "files", title: "Inspect" }],
    whenToUse: "manual",
  });
  assert.match(document.body, /return 42/);
});

test("SWF-05: meta 求值不执行 Node 表达式，也不接受调用/副作用", async () => {
  const marker = [];
  await assert.rejects(
    () =>
      readDocument(`
        export const meta = {
          name: (marker.push("side effect"), "review"),
          description: "literal",
          phases: [],
        };
      `),
    /pure literal|not allowed/i,
  );
  assert.deepEqual(marker, [], "拒绝过程不能执行 metadata 表达式");
});

test("SWF-05: meta 必须是首条 export const 声明，拒绝非字面量键形态", async () => {
  await assert.rejects(
    () =>
      readDocument(
        `const before = 1; export const meta = { name: "x", description: "d", phases: [] };`,
      ),
    /must begin/i,
  );
  for (const expression of [
    '{ name: "x", description: "d", phases: [], ...extra }',
    '{ name: "x", description: "d", phases: [], ["whenToUse"]: "x" }',
    '{ name: "x", description: "d", phases: [], phases() {} }',
    '{ name: `${process.cwd()}`, description: "d", phases: [] }',
  ]) {
    await assert.rejects(
      () => readDocument(`export const meta = ${expression};`),
      /not allowed|not a pure literal/i,
      expression,
    );
  }
});
