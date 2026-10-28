// ============================================================
// git.* world reads：只读**按构造**
// ============================================================
// 本模块是 git world-read 的**纯**那一半：实参校验、固定 argv 的构造、以及 porcelain-v2 /
// log / 路径列表输出的解析。副作用（真正 spawn 出一个 git）留在 workflow-world-read.ts。
//
// 行数拆分（原 427 行超过 400 行门禁）：按「一族一叶」拆成三个叶子——
//   - git-status.ts：status / 路径列表解析与共享的剥前缀/切段工具；
//   - git-log.ts：log 的字段格式、argv 与解析；
//   - git-diff-show.ts：ref / 路径校验与 diff argv。
// 本文件降为桶：原样再导出三个叶子，消费方（唯一：workflow-world-read.ts）的 import 不变。
// 仅 changedFiles 的命令计划留在本文件：它是**唯一**跨叶的构造——无 base 时由 diff 命令与
// untracked 命令两条拼成，ref 校验取自 git-diff-show.ts（叶子不反向 import 桶）。
//
// 为什么拆成纯模块：这里的每一条都是可以被单独钉住的性质——"这个 op 的 argv 恰好是这几个
// 元素"、"detached HEAD 时 branch 缺席"、"`-foo` 作为 base 被拒"、"带换行的文件名原样穿过"。
// 它们放在执行侧就只能经一个 fake port 间接断言；放在这里可以直接断言。
//
// ————————————————————————————————————————————————————————————————
// 只读是**构造**出来的，不是检查出来的
// ————————————————————————————————————————————————————————————————
// 本模块只能构造出五个被允许的子命令的 argv。没有一条路径能拼出 shell 字符串，也没有一处
// 把脚本给的串直接当成子命令或选项：base ref 过一道严格字符集（禁首字符 `-`，禁 `..` 区间），
// path 必须是工作区相对且不越界，且**总是**排在 `--` 之后。所以"写不进去"是这份代码能表达的
// 东西的性质，而不是一道可能哪天被忘掉的权限检查。
//
// ————————————————————————————————————————————————————————————————
// 两条贯穿全模块的输出契约（都是实测定下来的，不是从文档推的）
// ————————————————————————————————————————————————————————————————
// **1. `-z`：NUL 分隔，路径逐字节原样。** 不加 `-z` 时 `core.quotePath` 默认为真，git 会把
// 非 ASCII 路径 C 引用加八进制转义——`文档.md` 变成一串 `"\346\226\207..."`。这在本仓库的用户
// 身上是常态而不是边角。`-z` 一并解决两件事：路径不再被引用转义，且**含换行的文件名**不再
// 破坏按行切分（按行切会把它劈成两个不存在的路径，且没有任何报错——"少见且静默错误"正是
// 这套代码不接受的失败形态）。我们自己的 `git log` 也已经用 `%x00` 分隔字段，所以整族一致。
//
// **2. 路径一律以「工作区相对」交出，转换在我们这一侧做一次。** 实测：`-z` 会让
// `status --porcelain=v2` 输出**仓库根相对**路径，且没有任何 flag 或 config 能把它改回 cwd 相对
// （`status.relativePaths` 对 porcelain -z 无效）；`diff --name-only` 默认也是仓库根相对；而
// `ls-files --others` 默认是 **cwd 相对**。三条命令三种基准。
//
// 于是这里定一条统一规则：**线上一律取仓库根相对**（`ls-files` 补 `--full-name` 对齐），
// 再用一次 `rev-parse --show-prefix` 拿到工作区相对仓库根的前缀，在解析时剥掉它。这样
// 「基准」只有一处、只有一种，而不是三条命令各自依赖一个不同的 git 默认值——那种混搭正是
// 会让 `changedFiles()` 同时吐出两种基准路径的 bug（工作区就是仓库根时三者恰好相同，
// 所以它会一直不被发现，直到某个工作区是子目录）。
//
// 唯一的例外是 `git.diff` 的**补丁文本**：它不是我们解析的路径列表，而是一段带 `a/… b/…`
// 头的整体输出，没法在事后剥前缀。那一条因此用 git 自己的 `--relative` 让基准对齐。

import { validateGitRef, WORKSPACE_PATHSPEC } from "./git-diff-show.js";

/**
 * 一次 git 世界读取要跑的一条命令。`argv` 不含 `"git"` 本身——可执行文件名由执行侧提供，
 * 这样本模块完全不碰进程。
 */
interface GitCommandPlan {
  readonly argv: readonly string[];
}

/**
 * 未跟踪文件的固定 argv。`--exclude-standard` 让它尊重 .gitignore；`--full-name` 把它从
 * cwd 相对拉成仓库根相对，与 status / diff 对齐（本模块顶部的输出契约 2）。
 */
const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/**
 * `git.changedFiles(base?)` 要跑的命令。
 *
 * 无 base 时是**两条**命令的并集：`diff --name-only HEAD` 加上 `ls-files --others
 * --exclude-standard`。未跟踪文件对读者而言就是改动，漏掉它们会让这个原语在一条刚开的
 * feature 分支上毫无用处（那时几乎所有新文件都还未跟踪）。
 *
 * 给了 base 时只有一条：`diff --name-only <base>`。"相对某个 ref 改了什么"是一个关于
 * **已跟踪历史**的问题——一个从未进过 git 的文件与任何 ref 都无从比较。
 */
export function gitChangedFilesPlan(base: string | undefined): GitCommandPlan[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const tracked: GitCommandPlan = {
    argv: ["diff", "--name-only", "-z", ref, "--", WORKSPACE_PATHSPEC],
  };
  if (base !== undefined) return [tracked];
  return [tracked, { argv: [...GIT_UNTRACKED_ARGV] }];
}

// ——————————————————————————————— 桶：原样再导出三个叶子 ———————————————————————————————

export * from "./git-status.js";
export * from "./git-log.js";
export * from "./git-diff-show.js";
