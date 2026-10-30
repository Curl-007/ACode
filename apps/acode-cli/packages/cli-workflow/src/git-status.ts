// ============================================================
// git status / 路径列表解析（自 workflow-git-world-read.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 427 行超过 400 行门禁。本叶承载 `git status` 一族：
// GIT_STATUS_ARGV、porcelain-v2 解析、路径列表解析与共享的剥前缀/切段工具。
// 与兄弟叶之间零 import（同层的三条解析链互不依赖），对外契约与原文件逐字一致。

import { WorkflowError } from "@acode/dynamic-workflow";

/** `git.status()` 的返回形状。权威声明是 FACADE_DTS 里的 `declare interface GitStatus`。 */
export interface GitStatusResult {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * 工作区相对仓库根的前缀（`"sub/nested/"`，在仓库根为空串）。这是把线上的仓库根相对路径
 * 换算成工作区相对路径的唯一依据，见原模块顶部的输出契约 2。
 */
export const GIT_SHOW_PREFIX_ARGV: readonly string[] = ["rev-parse", "--show-prefix"];

/**
 * `git status` 的固定 argv。`--branch` 是 GitStatus.branch 的来源；`-- .` 把观察范围收在
 * 工作区之内（见原模块的 {@link WORKSPACE_PATHSPEC}）。
 */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/** `rev-parse --show-prefix` 的输出 → 前缀串（仓库根时为空串）。 */
export function parseGitShowPrefix(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

/**
 * 解析 `git status --porcelain=v2 -z --branch -- .`。
 *
 * 段首字符即记录类型：`#` 头信息、`1` 普通变更、`2` 重命名/复制、`u` 未合并、`?` 未跟踪、
 * `!` 已忽略（只在 `--ignored` 下出现，这里不会有）。`1`/`2` 的 `XY` 两位分别是**暂存区**与
 * **工作区**状态，`.` 表示未变——所以一个文件可以同时进 staged 与 unstaged（改了、暂存了、
 * 又接着改）。
 *
 * 两处 `-z` 特有的形状（都实测过）：
 *   - 头信息行同样以 NUL 终止，不是换行。
 *   - **rename/copy 项占两段**：`2 … R100 <新路径>\0<原路径>`（不带 `-z` 时这两者用 TAB 分隔）。
 *     所以解析必须显式多消费一段，否则原路径会被当成下一条记录——而它不以类型字符开头，
 *     会被静默丢掉。原路径本身不交出：facade 报告的是"现在哪些路径变了"。
 *
 * 路径是记录的**尾段**而不是定长字段：路径可以含空格（甚至换行，`-z` 下原样保留），所以按
 * "跳过前 N 个空格分隔字段、取余文"来切，绝不整段 split。
 */
export function parseGitStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // detached HEAD 时 git 写字面量 "(detached)"。此时 branch **缺席**，而不是带着这个
      // 占位串——把它当分支名交出去，脚本就会拿它去做 diff。
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      // `1` 的路径是第 8 个字段起；`2` 多一个 `<X><score>` 字段，所以从第 9 个起，且其**原路径**
      // 占紧随其后的一整段（`-z` 下的分隔符是 NUL），必须显式跳过。
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // 未合并（冲突）：算工作区待处理，落 unstaged。它确实"有待办"，而 staged 会误导——
      // 一个冲突文件不是"已经准备好提交"。
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
    // `!` 与未识别的段：跳过。
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    ...(branch === undefined ? {} : { branch }),
    clean,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * 把 `--name-only -z` / `ls-files -z` 的输出切成**工作区相对**路径列表。
 * 两者都已由 argv 拉成仓库根相对（`--full-name`），所以这里统一剥一次前缀。
 */
export function parseGitPathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/**
 * 把 `-z` 输出切成段：按 NUL 切，丢掉空段（末尾的 NUL 终止符会留下一个空段）。
 *
 * 丢空段是安全的，且对 rename 项的双段消费无影响：路径永远不是空串，所以空段只可能来自
 * 终止符本身。
 */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/**
 * 剥掉工作区前缀，把仓库根相对路径换算成**工作区相对**路径（原模块顶部的输出契约 2）。
 *
 * 前缀外的路径**大声失败**而不是原样交出。`-- .` 已经保证了每个路径都在工作区之内，所以
 * 走到这里说明某个假设塌了；此时把一个带 `../` 的路径交给脚本，正是这套收束要防的那件事，
 * 而脚本会拿它去 `files.read`。宁可让节点失败。
 */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw new WorkflowError(
    "DriverError",
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace, so the scoping is broken; report this as a bug.`,
  );
}

/**
 * 从第 `index` 个空格分隔字段起的**整段余文**。porcelain v2 的字段是单空格分隔且定长，
 * 只有路径在最后且可含空格，所以"跳过 N 个空格再取余文"是这里唯一正确的切法。
 */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** 去重并排序。journal 存的是这个值，所以它必须只依赖内容而不依赖 git 的输出顺序。 */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
