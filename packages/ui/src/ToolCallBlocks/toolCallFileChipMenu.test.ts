import assert from "node:assert/strict";
import test from "node:test";
import type { EditorInfo } from "@acode/shared";
import {
  planToolCallFileChipMenu,
  resolveToolCallFileChipPath,
  resolveToolCallFileChipRelativePath,
} from "./toolCallFileChipMenu.js";

// 工具卡文件 chip 右键菜单的纯逻辑。菜单自身的 JSX 与右键交互在现有 DOM 测试基建下
// 测不到（shim 没有事件派发 / 布局测量，Radix 菜单关闭态不挂载），所以把「渲染哪些条目」
// 拆成纯函数钉住：平台差异只能通过这张表体现，不能在组件里散落条件分支。

function editor(id: string, name = id): EditorInfo {
  return { id, name, iconDataUrl: `data:image/png;base64,${id}` };
}

const windowsEditors = [
  editor("explorer", "资源管理器"),
  editor("vscode", "Visual Studio Code"),
];

test("相对路径按 workspace 拼接，绝对路径原样返回", () => {
  // 分隔符跟随 workspace（Windows 用反斜杠），子路径里已有的分隔符不做二次改写。
  assert.equal(
    resolveToolCallFileChipPath("specs/agent-teams.md", "D:\\work\\repo"),
    "D:\\work\\repo\\specs/agent-teams.md",
  );
  assert.equal(
    resolveToolCallFileChipPath("specs/agent-teams.md", "/home/dev/repo"),
    "/home/dev/repo/specs/agent-teams.md",
  );
  assert.equal(
    resolveToolCallFileChipPath("D:\\other\\a.md", "D:\\work\\repo"),
    "D:\\other\\a.md",
  );
  assert.equal(resolveToolCallFileChipPath("/home/dev/a.md", "/home/dev/repo"), "/home/dev/a.md");
});

test("URI 转义先还原：workspace 名带空格时不能把 %20 当文件名", () => {
  assert.equal(
    resolveToolCallFileChipPath("docs/my%20file.md", "/home/dev/repo"),
    "/home/dev/repo/docs/my file.md",
  );
});

test("没有 workspace scope 时退回工具原文路径，不猜绝对路径", () => {
  assert.equal(resolveToolCallFileChipPath("specs/a.md"), "specs/a.md");
  assert.equal(resolveToolCallFileChipRelativePath("specs/a.md"), "specs/a.md");
});

test("复制相对路径给出 workspace 内的相对值", () => {
  assert.equal(
    resolveToolCallFileChipRelativePath("specs/a.md", "D:\\work\\repo"),
    "specs/a.md",
  );
  assert.equal(
    resolveToolCallFileChipRelativePath("D:\\work\\repo\\specs\\a.md", "D:\\work\\repo"),
    "specs/a.md",
  );
});

test("Windows：编辑器列表里已有资源管理器，「在文件管理器中打开」不重复渲染", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: windowsEditors,
    editorsResolved: true,
    canOpenLocalFileManager: true,
    canRevealInFileManager: true,
  });

  assert.deepEqual(
    plan.editors.map((item) => item.id),
    ["explorer", "vscode"],
  );
  assert.equal(plan.showRevealInFileManager, false);
  assert.equal(plan.showNoEditorsHint, false);
  assert.equal(plan.showOpenGroup, true);
});

test("Linux：白名单为空，补一条显式的「在文件管理器中打开」", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: [],
    editorsResolved: true,
    canOpenLocalFileManager: true,
    canRevealInFileManager: true,
  });

  assert.equal(plan.showRevealInFileManager, true);
  // 已经有可用的本地打开位置，不再叠一条「未找到可用 App」。
  assert.equal(plan.showNoEditorsHint, false);
  assert.equal(plan.showOpenGroup, true);
});

test("Web：没有本地文件管理器，整组「打开」不渲染，只剩复制路径", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: [],
    editorsResolved: true,
    canOpenLocalFileManager: false,
    canRevealInFileManager: false,
  });

  assert.equal(plan.showOpenGroup, false);
  assert.equal(plan.showRevealInFileManager, false);
  assert.equal(plan.showNoEditorsHint, false);
});

test("Docker 远程：编辑器失败关闭且不能打开本机文件管理器，给出可解释的禁用提示", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: [],
    editorsResolved: true,
    canOpenLocalFileManager: true,
    canRevealInFileManager: false,
  });

  assert.equal(plan.showNoEditorsHint, true);
  assert.equal(plan.showRevealInFileManager, false);
  assert.equal(plan.showOpenGroup, true);
});

test("枚举未结束时只显示「加载中」，不提前给「打开位置」（否则条目会先出现再消失）", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: [],
    editorsResolved: false,
    canOpenLocalFileManager: true,
    canRevealInFileManager: true,
  });

  assert.equal(plan.showNoEditorsHint, true);
  assert.equal(plan.showRevealInFileManager, false);
  assert.equal(plan.showOpenGroup, true);
});

test("枚举失败后（editorsResolved 仍置位）退到「在文件管理器中打开」而不是卡在加载中", () => {
  const plan = planToolCallFileChipMenu({
    availableEditors: [],
    editorsResolved: true,
    canOpenLocalFileManager: true,
    canRevealInFileManager: true,
  });

  assert.equal(plan.showNoEditorsHint, false);
  assert.equal(plan.showRevealInFileManager, true);
});
