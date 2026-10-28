// ============================================================
// git log 构造与解析（自 workflow-git-world-read.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 427 行超过 400 行门禁。本叶承载 `git log` 一族：
// 字段格式、argv 构造与记录解析。与兄弟叶之间零 import。

import { WorkflowError } from "@acode/dynamic-workflow";

/** `git.log()` 的一条记录。权威声明是 FACADE_DTS 里的 `declare interface GitCommit`。 */
export interface GitCommitResult {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** `git log` 的字段格式：NUL 分隔的 hash / subject / author name / author date(ISO-8601)。 */
export const GIT_LOG_PRETTY = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/**
 * `git.log(count)` 的 argv。count 由调用方校验并夹在 [1, cap] 内。
 *
 * **刻意不带 pathspec，与本族其余 op 不对称。** commit 是仓库级的对象；给 log 加一个
 * pathspec 会把它的语义改成"碰过工作区的那些 commit"，那是另一个问题，没人点过。log 读的是
 * 历史元数据（hash / subject / author / date），不是工作区里的路径，所以工作区收束对它没有
 * 可施加的对象。
 */
export function gitLogArgv(count: number): string[] {
  return ["log", `-n${count}`, GIT_LOG_PRETTY];
}

/**
 * 解析 {@link GIT_LOG_PRETTY} 的输出：每行一条记录，字段以 NUL 分隔。
 *
 * 这一条按**换行**切记录是可靠的，与路径列表的情形不同：`%s` 是 commit message 的第一行，
 * 按定义不含换行，而其余三个字段（hash / author name / ISO 日期）也都不含换行。所以这里
 * 不需要 `-z`。
 *
 * 字段数不等于 4 即抛：格式串与解析器都在本模块里，两者不一致只可能是本地改动出了岔子，
 * 而一条只填了一半的 commit 会一路流进 journal 与模型的上下文。
 */
export function parseGitLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split("\n")) {
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.length === 0) continue;
    const fields = record.split("\u0000");
    if (fields.length !== 4) {
      throw new WorkflowError(
        "DriverError",
        `world-read git-log: cannot parse the output; a record should have 4 NUL-separated ` +
          `fields, got ${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}
