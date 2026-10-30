// message.tsx 批次 5 外迁（messageFileLinkTargets）的接缝内决策表测试。无 DOM；
// rehype 插件用对象字面量模拟 hast 树；openMessageFileLinkInEditor 用桩 stat/open。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageFileLinkTarget,
  formatMarkdownFileLinkTargetHref,
  hasFileExtension,
  isExplicitDirectoryMarkdownLink,
  isExternalWebHref,
  openMessageFileLinkInEditor,
  rewriteLocalFileMarkdownTargetsRehypePlugin,
  shouldRewriteMarkdownFileLinkHref,
  type HastElementNode,
} from "../src/components/ai-elements/messageFileLinkTargets.js";

test("formatMarkdownFileLinkTargetHref：Windows 盘符补前导斜杠绕过 harden", () => {
  assert.equal(formatMarkdownFileLinkTargetHref("C:\\ws\\a.ts"), "/C:/ws/a.ts");
  assert.equal(formatMarkdownFileLinkTargetHref("d:/ws/a.ts"), "/d:/ws/a.ts");
});

test("formatMarkdownFileLinkTargetHref：file:// 取解码后路径", () => {
  assert.equal(formatMarkdownFileLinkTargetHref("file:///etc/a.ts"), "/etc/a.ts");
});

test("formatMarkdownFileLinkTargetHref：已有前缀直通 / 裸路径补 ./", () => {
  assert.equal(formatMarkdownFileLinkTargetHref("./a.ts"), "./a.ts");
  assert.equal(formatMarkdownFileLinkTargetHref("/abs/a.ts"), "/abs/a.ts");
  assert.equal(formatMarkdownFileLinkTargetHref("#section"), "#section");
  assert.equal(formatMarkdownFileLinkTargetHref("../up.ts"), "../up.ts");
  assert.equal(formatMarkdownFileLinkTargetHref("https://x.com/a"), "https://x.com/a");
  assert.equal(formatMarkdownFileLinkTargetHref("a.ts"), "./a.ts");
  assert.equal(formatMarkdownFileLinkTargetHref("src/a.ts"), "./src/a.ts");
});

test("formatMarkdownFileLinkTargetHref：行号/列号后缀保留", () => {
  assert.equal(formatMarkdownFileLinkTargetHref("a.ts:30"), "./a.ts:30");
  assert.equal(formatMarkdownFileLinkTargetHref("a.ts:30:5"), "./a.ts:30:5");
  assert.equal(formatMarkdownFileLinkTargetHref("C:\\ws\\a.ts:30"), "/C:/ws/a.ts:30");
});

test("shouldRewriteMarkdownFileLinkHref 决策矩阵", () => {
  // 绝对路径（posix / file://）可直接解析 → 改写。
  assert.equal(shouldRewriteMarkdownFileLinkHref("/etc/a.ts"), true);
  assert.equal(shouldRewriteMarkdownFileLinkHref("file:///etc/a.ts"), true);
  // 裸文件名带扩展名 → 改写（harden 前先补 ./）。
  assert.equal(shouldRewriteMarkdownFileLinkHref("README.md"), true);
  // 裸文件名无扩展名且无路径分隔 → 不改写。
  assert.equal(shouldRewriteMarkdownFileLinkHref("README"), false);
  // 相对路径带分隔 → 改写。
  assert.equal(shouldRewriteMarkdownFileLinkHref("src/a.ts"), true);
  // 锚点 / 外链 / 上级逃逸 → 不改写。
  assert.equal(shouldRewriteMarkdownFileLinkHref("#section"), false);
  assert.equal(shouldRewriteMarkdownFileLinkHref("https://x.com/a"), false);
  assert.equal(shouldRewriteMarkdownFileLinkHref("../up.ts"), false);
  // 嵌套 .. 归一后逃逸 workspace → 不改写。
  assert.equal(shouldRewriteMarkdownFileLinkHref("a/../../b.ts"), false);
});

test("rewriteLocalFileMarkdownTargetsRehypePlugin：a.href 与 img.src 递归改写", () => {
  const tree: HastElementNode = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties: { href: "README.md" },
        children: [],
      },
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://x.com" },
        children: [
          {
            type: "element",
            tagName: "img",
            properties: { src: "docs/pic.png" },
            children: [],
          },
        ],
      },
      { type: "text", tagName: undefined, properties: {}, children: [] },
    ],
  };
  rewriteLocalFileMarkdownTargetsRehypePlugin()(tree);
  const [fileLink, webLink] = tree.children ?? [];
  assert.equal(fileLink?.properties?.href, "./README.md");
  assert.equal(webLink?.properties?.href, "https://x.com");
  assert.equal(webLink?.children?.[0]?.properties?.src, "./docs/pic.png");
});

test("hasFileExtension / isExplicitDirectoryMarkdownLink", () => {
  assert.equal(hasFileExtension("a.ts"), true);
  assert.equal(hasFileExtension("README"), false);
  // 正则 `/\.[^./\\]+$/` 视角下 dotfile 整体即「扩展名」。
  assert.equal(hasFileExtension(".gitignore"), true);
  assert.equal(isExplicitDirectoryMarkdownLink("src/", "src/"), true);
  assert.equal(isExplicitDirectoryMarkdownLink("src", "src\\"), true);
  assert.equal(isExplicitDirectoryMarkdownLink("src/a.ts", "src/a.ts"), false);
});

test("buildMessageFileLinkTarget：目录提示 + 相对路径派生", () => {
  const fileTarget = buildMessageFileLinkTarget({
    href: "src/a.ts",
    label: "a.ts",
    path: "/ws/src/a.ts",
    workspacePath: "/ws",
    workspaceIdentity: "id-1",
    workspaceRemoteSessionId: "rs-1",
  });
  assert.deepEqual(fileTarget, {
    path: "/ws/src/a.ts",
    label: "a.ts",
    pathKind: undefined,
    relativePath: "src/a.ts",
    workspacePath: "/ws",
    workspaceIdentity: "id-1",
    workspaceRemoteSessionId: "rs-1",
  });
  // 显式尾随斜杠 → directory 提示。
  const dirTarget = buildMessageFileLinkTarget({ href: "src/", label: "src", path: "/ws/src" });
  assert.equal(dirTarget.pathKind, "directory");
  // 无 workspacePath → relativePath 回退 label。
  assert.equal(dirTarget.relativePath, "src");
  // workspace 外路径 → relativePath 退化为文件名。
  const outside = buildMessageFileLinkTarget({
    href: "/etc/a.ts",
    label: "a.ts",
    path: "/etc/a.ts",
    workspacePath: "/ws",
  });
  assert.equal(outside.relativePath, "a.ts");
});

test("openMessageFileLinkInEditor：stat 真实类型覆盖展示提示", async () => {
  const calls: Array<{ editorId: string; path: string; options: Record<string, unknown> }> = [];
  const result = await openMessageFileLinkInEditor({
    editorId: "vscode",
    fileLink: { path: "/ws/src", label: "src", pathKind: undefined, workspaceIdentity: "id-1" },
    openInEditor: (editorId, path, options) => {
      calls.push({ editorId, path, options: { ...options } });
      return Promise.resolve({ success: true });
    },
    remoteTarget: { kind: "ssh", host: "h" },
    statFile: () => Promise.resolve({ type: "directory" }),
  });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.pathKind, "directory");
  assert.equal(calls[0]?.options.workspaceIdentity, "id-1");
  assert.deepEqual(calls[0]?.options.remoteTarget, { kind: "ssh", host: "h" });
});

test("isExternalWebHref：仅 http/https", () => {
  assert.equal(isExternalWebHref("https://x.com"), true);
  assert.equal(isExternalWebHref("http://x.com"), true);
  assert.equal(isExternalWebHref("file:///etc/a"), false);
  assert.equal(isExternalWebHref("mailto:a@b.c"), false);
  assert.equal(isExternalWebHref("not a url"), false);
});
