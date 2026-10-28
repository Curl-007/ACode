// ============================================================
// world-read 搜索叶：files.glob 与 files.grep
// ============================================================
// 拆分自 workflow-world-read.ts（649 行，超出 400 行文件级门禁）。本叶承载 world-read 的
// "搜索面"：files.glob 与 files.grep 两条端口路径（含 cap+1 上限探测与归一化）。
//
// 依赖方向：只依赖基础叶 world-read-files.ts（WorldReadDeps 与共享原语），不反向依赖桶。

import { WORLD_READ_CAPS } from "@acode/dynamic-workflow";
import { capExceeded, toWorkspaceRelative, type WorldReadDeps } from "./world-read-files.js";

/**
 * `files.glob(pattern)`：经 FileSystemPort 的 searchFiles，归一成 facade 承诺的形状。
 *
 * 三步归一都来自端口语义与 facade 承诺的落差——端口结果不能原样交出。
 * 端口是为 UI 的 Glob 工具设计的：绝对路径、mtime 降序、默认 100 条截断。
 *
 * - **cap+1 拒绝**（与 worldGrep 同一惯用法）：端口的默认截断静默生效过，一次 5000 文件
 *   的 glob 只交出 2%，且错误视图会进 journal 被 resume 重放。cap 归 WORLD_READ_CAPS
 *   所有，恰好 cap 条无从区分"正好"与"被截断"，故多要一条。
 * - **工作区相对化**：绝对路径让脚本按工作区相对前缀写的路由（`startsWith("apps/…")`）
 *   全部落空，把 6 路扇出静默坍缩成 1 路；grep/git 早已相对化，glob 是漏网的那个。
 * - **字典序重排**：mtime 随任何一次写文件漂移，journaled 值必须确定——同一脚本两次
 *   提交不该扇出在不同的次序上。拒绝语义保证到这里手上必是全量匹配，重排是完备的。
 */
export async function worldGlob(deps: WorldReadDeps, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const result = await deps.fileSystemPort.searchFiles({
    path: deps.cwd,
    pattern,
    maxResults: cap + 1,
  }, deps.signal === undefined ? undefined : { signal: deps.signal });
  if (result.files.length > cap || result.truncated) {
    throw capExceeded(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return result.files.map((path) => toWorkspaceRelative(deps.cwd, path)).sort();
}

/**
 * `files.grep(pattern, glob?)`：经 FileSystemPort 的 searchText（ripgrep 语义）。
 *
 * **headLimit 取 cap + 1**，这是本方法唯一不显然的一行。上限是"命中超过 cap 就拒绝"，
 * 而端口只会按 headLimit 截断——所以刚好取 cap 会得到一个歧义结果：cap 条命中，既可能是
 * 正好 cap 条（应当放行），也可能是被截掉了后面一百万条（应当拒绝）。多取一条就把这个
 * 歧义消掉了：拿到 cap+1 条即确知溢出，而代价仍然只有一条记录，不必物化整个结果集。
 * `truncated` 是同一判断的第二条线（端口若因别的原因截断，我们手上就不是完整结果了）。
 */
export async function worldGrep(
  deps: WorldReadDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const result = await deps.fileSystemPort.searchText({
    path: deps.cwd,
    pattern,
    ...(glob === undefined ? {} : { glob }),
    outputMode: "content",
    showLineNumbers: true,
    headLimit: cap + 1,
  }, deps.signal === undefined ? undefined : { signal: deps.signal });
  if (result.entries.length > cap || result.truncated) {
    throw capExceeded(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const entry of result.entries) {
    // content 模式下每条命中都带行号与行文本；缺其一的条目不是一条内容命中（例如端口在
    // 别的 outputMode 下产出的计数项），跳过而不是填 0 / "" 造一条假命中。
    if (entry.lineNumber === undefined || entry.text === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(deps.cwd, entry.path),
      line: entry.lineNumber,
      text: entry.text,
    });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw capExceeded(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

/** `files.grep` 的一条命中。权威声明是 FACADE_DTS 里的 `declare interface GrepMatch`。 */
export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}
