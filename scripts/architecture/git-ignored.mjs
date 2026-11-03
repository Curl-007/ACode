import path from "node:path";
import { gitFileNames } from "./git-file-names.mjs";

// 不从 policy.mjs 复用 posix()：policy.mjs 要 import 本文件，反向依赖会形成 ESM 环。
function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * 从治理输入里剔除被 git 忽略的构建产物，使本地检查与 CI 检查的输入集合等价。
 *
 * 根因：policy.mjs 的 walk 只按目录名跳过 node_modules/dist/out/coverage/.git，
 * 看不见落在源码目录里的产物。例如
 * apps/acode-cli/packages/browser-use-plugin/scripts/{browser-client,relay-server}.mjs
 * 由同目录 build.mjs 生成，被该包 .gitignore 第 2-3 行显式忽略，却因 `.mjs` 后缀被
 * 当成源码收集。CI 的干净检出没有这些文件，于是本地报出 CI 恒不存在的违规
 * （2026-11-03 实测：本地 violations 412 / baseline 410 / new 2，CI 410 / 410 / 0，
 * 且 CI 的 Architecture check 为 success）——本地门禁与 CI 门禁不等价，
 * 会让 .husky/pre-push 因一个 CI 永远看不见的产物阻断推送。
 *
 * 用 git 的忽略规则做权威判定而非硬编码路径：tracked 文件永远不会被 check-ignore
 * 判为 ignored，所以本过滤只可能剔除「未纳入版本控制的产物」，不会漏掉真实源码。
 * CI 的干净检出没有 ignored 文件，本函数在 CI 上是恒等变换，不改变既有门禁结果。
 *
 * 失败降级方向是「保留原集合」：git 不可用（非仓库检出、浅克隆异常）时宁可多报，
 * 也不静默缩小治理范围——那等于让门禁在无人察觉时失效。
 */
export async function withoutGitIgnored(cwd, files) {
  if (files.length === 0) return files;
  const relative = files.map((file) => toPosix(path.relative(cwd, file)));
  let ignored;
  try {
    // check-ignore 退出码 1 = 没有路径被忽略，是正常结果（CI 上恒为此）。
    ignored = await gitFileNames(cwd, ["check-ignore", "--stdin", "-z"], {
      stdin: `${relative.join("\0")}\0`,
      okCodes: [0, 1],
    });
  } catch {
    return files;
  }
  if (ignored.length === 0) return files;
  const ignoredSet = new Set(ignored.map((name) => toPosix(name)));
  return files.filter((file, index) => !ignoredSet.has(relative[index]));
}
