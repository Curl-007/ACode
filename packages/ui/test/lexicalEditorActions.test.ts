// LexicalChatInput 批次 5 外迁（lexicalEditorActions）的接缝内测试。
// headless Lexical：createEditor + PromptMentionNode 在无 DOM 下跑真实 editor.update/read
// （已探针验证）。两处环境适配（不改变被测对象）：
//   1. PromptMentionNode 链路上 fileDisplay 等静态 import 的 .png/.svg 资源 node --import tsx
//      无法加载（ERR_UNKNOWN_FILE_EXTENSION）；用 module.registerHooks 重定向到 data: 空模块
//      （对照 pluginListRows.test.ts 先例；node --test 每文件独立进程，不影响其他测试）。
//      因此被测模块与 lexical 本体都必须走 test.before 里的动态 import——静态 import 会被提升，
//      在 registerHooks 生效前就开始加载（这是 ts-no-dynamic-import 的刻意例外：模块加载边界测试）。
//   2. 被测动作用非 discrete update（异步提交）；读取前用 registerUpdateListener 等待 Lexical
//      真实提交事件，不用 wall-clock 定时器。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import type { $getRoot, LexicalEditor } from "lexical";
import type { ComposerMentionPrefill } from "../src/store/acodeSessionStoreTypes.js";
import type * as EditorActions from "../src/lexical-chat-input/lexicalEditorActions.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\.(png|svg|css)$/.test(specifier)) {
      return { url: "data:text/javascript,export default ''", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let actions: typeof EditorActions;
let $getRootRef: typeof $getRoot;

const createTestEditor = async (): Promise<LexicalEditor> => {
  const { createEditor } = await import("lexical");
  const { PromptMentionNode } = await import("../src/mentions/nodes/PromptMentionNode.js");
  return createEditor({
    namespace: "lexical-editor-actions-test",
    nodes: [PromptMentionNode],
    onError: (error: Error) => {
      throw error;
    },
  });
};

/** 等待下一次 Lexical update 提交（真实事件，非定时器）。必须在触发动作前注册。 */
const waitForNextUpdate = (editor: LexicalEditor): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unregister = editor.registerUpdateListener(() => {
    unregister();
    resolve();
  });
  return promise;
};

const fileMention: ComposerMentionPrefill = {
  id: "file:src/a.ts",
  category: "files",
  label: "a.ts",
  value: "src/a.ts",
  markdown: "[a.ts](src/a.ts)",
};

test.before(async () => {
  actions = await import("../src/lexical-chat-input/lexicalEditorActions.js");
  ({ $getRoot: $getRootRef } = await import("lexical"));
});

test("replaceEditorText + getEditorMarkdown：\\n\\n 分段 round-trip", async () => {
  const editor = await createTestEditor();
  let updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "第一段\n\n第二段");
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "第一段\n\n第二段");
  updated = waitForNextUpdate(editor);
  actions.resetEditor(editor);
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "");
});

test("replaceEditorTextWithPluginMentions：内联 plugin mention 解析为结构化节点", async () => {
  const editor = await createTestEditor();
  const updated = waitForNextUpdate(editor);
  actions.replaceEditorTextWithPluginMentions(editor, "用 [@文件系统](plugin://fs@1.0) 处理");
  await updated;
  const markdown = actions.getEditorMarkdown(editor.getEditorState());
  assert.ok(markdown.includes("[@文件系统](plugin://fs@1.0)"));
  assert.ok(markdown.startsWith("用 "));
});

test("replaceEditorWithMention / Skill / SlashCommand：预填 markdown 透传", async () => {
  const editor = await createTestEditor();
  let updated = waitForNextUpdate(editor);
  actions.replaceEditorWithMention(editor, fileMention);
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "[a.ts](src/a.ts) ");

  updated = waitForNextUpdate(editor);
  actions.replaceEditorWithSkillMention(editor, "code-review", "$code-review-full");
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "$code-review-full ");

  updated = waitForNextUpdate(editor);
  actions.replaceEditorWithSlashCommandMention(editor, "plan");
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "/plan ");
});

test("prependEditorMentionIfMissing：幂等——同 category+value 不重复插入", async () => {
  const editor = await createTestEditor();
  const updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "已有正文");
  await updated;
  const first = actions.prependEditorMentionIfMissing(editor, fileMention); // discrete，同步落账
  assert.equal(first, true);
  const markdown = actions.getEditorMarkdown(editor.getEditorState());
  assert.equal(markdown, "[a.ts](src/a.ts) 已有正文");
  const second = actions.prependEditorMentionIfMissing(editor, fileMention);
  assert.equal(second, false);
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "[a.ts](src/a.ts) 已有正文");
});

test("appendEditorFileMention / appendEditorPlainText：非空白结尾自动补空格", async () => {
  const editor = await createTestEditor();
  let updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "hello");
  await updated;
  updated = waitForNextUpdate(editor);
  actions.appendEditorFileMention(editor, "b.ts", "src/b.ts", "[b.ts](src/b.ts)");
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "hello [b.ts](src/b.ts) ");
  updated = waitForNextUpdate(editor);
  actions.appendEditorPlainText(editor, "world");
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "hello [b.ts](src/b.ts) world");
});

test("insertEditorMention：无 selectionState 时插入末尾", async () => {
  const editor = await createTestEditor();
  let updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "ab");
  await updated;
  updated = waitForNextUpdate(editor);
  actions.insertEditorMention(editor, fileMention);
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "ab[a.ts](src/a.ts) ");
});

test("insertEditorMention：带 selectionState 恢复光标位置插入", async () => {
  const editor = await createTestEditor();
  const updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "ab");
  await updated;
  // 把光标挪到 a|b 之间并捕获该 editorState。
  editor.update(
    () => {
      const firstText = $getRootRef().getAllTextNodes()[0];
      firstText?.select(1, 1);
    },
    { discrete: true },
  );
  const selectionState = editor.getEditorState();
  // 光标移到末尾后，用捕获的旧选区插入——应落在 a|b 之间。
  editor.update(() => $getRootRef().selectEnd(), { discrete: true });
  const inserted = waitForNextUpdate(editor);
  actions.insertEditorMention(editor, fileMention, selectionState);
  await inserted;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "a[a.ts](src/a.ts) b");
});

test("selectAfterPromptMentionById：命中 mention 跳选到尾随文本，未命中返回 false", async () => {
  const editor = await createTestEditor();
  const updated = waitForNextUpdate(editor);
  actions.replaceEditorWithMention(editor, fileMention);
  await updated;
  let hit = false;
  let miss = true;
  editor.update(
    () => {
      hit = actions.selectAfterPromptMentionById("file:src/a.ts");
      miss = actions.selectAfterPromptMentionById("file:missing.ts");
    },
    { discrete: true },
  );
  assert.equal(hit, true);
  assert.equal(miss, false);
});

test("isCollapsedSelectionAtEditorStart：编辑器起点判定", async () => {
  const editor = await createTestEditor();
  const updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "hello");
  await updated;
  // selectEnd 后不在起点。
  let atStart = true;
  editor.read(() => {
    atStart = actions.isCollapsedSelectionAtEditorStart();
  });
  assert.equal(atStart, false);
  // 移到文本起点后在起点。
  editor.update(
    () => {
      const firstText = $getRootRef().getAllTextNodes()[0];
      firstText?.select(0, 0);
    },
    { discrete: true },
  );
  editor.read(() => {
    atStart = actions.isCollapsedSelectionAtEditorStart();
  });
  assert.equal(atStart, true);
});

test("replaceEditorStateJson：state JSON round-trip", async () => {
  const editor = await createTestEditor();
  let updated = waitForNextUpdate(editor);
  actions.replaceEditorText(editor, "持久化内容");
  await updated;
  const json = JSON.stringify(editor.getEditorState().toJSON());
  updated = waitForNextUpdate(editor);
  actions.resetEditor(editor);
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "");
  updated = waitForNextUpdate(editor);
  actions.replaceEditorStateJson(editor, json);
  await updated;
  assert.equal(actions.getEditorMarkdown(editor.getEditorState()), "持久化内容");
});
