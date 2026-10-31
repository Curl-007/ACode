// ============================================================
// git ref / 路径校验与 diff argv（自 workflow-git-world-read.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 427 行超过 400 行门禁。本叶承载实参校验一族：
// base ref 字符集、工作区相对路径的越界检查、`git diff` 的 argv 构造。
// `validateGitRef` 导出给原文件（changedFiles 的 argv 构造也用它）。

import { WorkflowError } from "@acode/dynamic-workflow";

/**
 * base ref 的严格字符集：首字符必须是字母/数字，其后允许 `[A-Za-z0-9._/@^~-]`。
 *
 * 首字符不许是 `-` 是这条规则里唯一**安全相关**的部分：`-foo` 会被 git 当成选项而不是 ref，
 * 而"哪些选项存在"不由我们决定。首字符也不许是 `.`，顺手挡住 `.` / `..` 这类既不是合法 ref、
 * 又长得像区间的输入。
 *
 * 刻意排除的：空白（一个 ref 里没有空白的合法理由）、`{`/`}`（`@{u}` 这类 reflog 语法，v1
 * 不支持）、`:`（`ref:path` 语法）、以及任何 `..`（区间——v1 只接受**单个** ref）。这些都不是"危险"，只是超出了 v1 承诺过的语义；接受它们等于
 * 让脚本依赖一份没人写下来的契约。
 */
export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/**
 * 工作区 pathspec。git.* 是**世界读取**，而这个工作流的"世界"处处都是工作区：
 * files.glob/read/grep 是工作区范围的，actor 子会话以工作区为 cwd，权限档位也是工作区范围的。
 * 所以 git 的观察也收在同一个世界里——否则 `changedFiles()` 会交出工作区之外的路径，而
 * `changedFiles() → files.read(p)` 这个最显然的两行组合就成了一个陷阱。
 *
 * 代价（v1 有意接受）：工作区是仓库子目录时，看不到子目录之外的改动。
 *
 * 权威定义住在本叶（diff 与 changedFiles 共用；changedFiles 在原文件里，它反向 import 本叶，
 * 而不是本叶 import 原文件——叶子不反向依赖桶）。
 */
export const WORKSPACE_PATHSPEC = ".";

/**
 * `git.diff(base?, path?)` 的 argv。base 缺省为 `HEAD`；path 缺省为工作区 pathspec `.`，
 * 且**总是**排在 `--` 之后，这样一个恰好与分支同名的路径不会被 git 解读成 ref（也不会反过来）。
 *
 * `--relative` 在这一条上是必需的，理由与别处不同：补丁文本里的 `a/… b/…` 头是 git 自己写的，
 * 我们不解析、也没法事后剥前缀，所以只能让 git 按 cwd（= 工作区）为基准输出。少了它，
 * `changedFiles()` 说"只有 a.md 改了"而 `diff()` 交出一段带 `../x` 的仓库级补丁——两个原语
 * 会对"什么算改动"给出不同答案。
 *
 * `--relative` 本身也会排除 cwd 之外的改动，所以 `-- .` 在无 path 时是冗余的。**冗余是有意的**：
 * 范围收束不该悄悄依赖另一个 flag 的副作用，写出来才能被 argv 测试钉住。
 */
export function gitDiffArgv(base: string | undefined, path: string | undefined): string[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? WORKSPACE_PATHSPEC : validateGitPath("git-diff", path);
  return ["diff", "--relative", ref, "--", pathspec];
}

/**
 * 校验一个 base ref，返回原串。形状不符即结构化 `DriverError`（node 级，脚本可 `catch`）。
 * 错误消息说明**为什么**被拒，因为写脚本的那一侧要据此改写，而不是去猜。
 */
export function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted. Pass ` +
        `one ref.`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax ` +
        `characters such as {} :).`,
    );
  }
  return value;
}

/**
 * 校验一个工作区相对路径，返回规范化（分隔符统一成 `/`）后的串。
 *
 * 三条，都是**词法层面的收束**（不追符号链接，见 v1 说明）：不许绝对路径、不许以 `-` 开头、
 * 不许含 `..` 段。第三条就是这一侧的越界检查：`relative` 的规范化结果里 `..` 只可能出现在
 * 开头，所以"没有 `..` 段且不是绝对路径"等价于"解析后仍在工作区内"。
 *
 * 以 `-` 开头即便排在 `--` 之后也已经安全，仍然拒绝：这是纵深防御——`--` 一旦哪天漏掉，
 * 一个 `-foo` 路径就是一个选项。
 */
function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path must not be empty. Pass a workspace-relative path or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option. ` +
        `Pass a path that does not start with '-'.`,
    );
  }
  if (looksAbsolute(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted. Pass the path relative to the workspace root.`,
    );
  }
  // 分隔符统一成 `/`：git 的 pathspec 在三个平台上都吃 `/`，而模型写出 windows 风格的
  // 相对路径是常事。规范化必须在 `..` 检查**之前**，否则 `..\x` 会从段切分里溜过去。
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the ` +
        `workspace. Pass a path inside the workspace.`,
    );
  }
  return normalized;
}

/**
 * 绝对路径判定，**不依赖当前平台**：`node:path` 的 posix 版认不出 `C:\x`，而这份校验要在
 * 三个平台上给同一个答案（跨平台原则：不按开发机的系统行为实现）。
 */
function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value);
}
