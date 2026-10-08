// Build-time generator: 把 dynamic-workflow-runtime 的 childMain 函数源文本物化到
// packages/dynamic-workflow-runtime/src/generated/child-main-text.ts，renderChildEntry 以该
// 字符串常量内嵌沙箱子进程入口 .mjs，不再依赖运行期 Function.prototype.toString()。
//
// 为什么不能用运行期 toString()：桌面字节码形态（J5-L1）下 loader 以 " ".repeat(sourceLength)
// 作为 vm.Script 的源文本编译 cachedData（scripts/desktop-agent-bytecode-runtime.cjs:61），
// 而 V8 的 Function.prototype.toString() 从脚本源文本取值——字节码形态下任何函数的 toString
// 都返回等长纯空格，旧 renderChildEntry 渲染出的入口文件是 `const main = <空格>;`，
// 动态工作流与 snippet 全部 SyntaxError 致死（v0.0.4 实测）。详见
// apps/acode-cli/specs/workflow-child-entry-rendering.md。
//
// 形态沿 generate-bash-command-registry.mjs / generate-prompt-manifest.mjs 先例：
// 生成物提交入库，--check 做漂移守护（漂移退出码 1），tests/workflow-child-entry-render.test.mjs
// 在 CI（pnpm test）钉住一致性。幂等：内容一致时不重写（watch/测试循环保持快，沿 generate-libs.mjs）。
//
// 运行（tsx 是本包 devDependency，包 scripts 已接好）：
//   node --import tsx scripts/generate-child-main.mjs [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const outputPath = join(
  appRoot,
  "packages",
  "dynamic-workflow-runtime",
  "src",
  "generated",
  "child-main-text.ts",
);

// tsx 即时转译 child-source.ts（非压缩、无 __name 注入），toString 按该形态捕获。
const { childMain } = await import("../packages/dynamic-workflow-runtime/src/child-source.ts");
const text = childMain.toString();

// 物化自检：挡住 tsx/esbuild 行为变化导致静默产出空格或残缺文本（本 bug 的原始形态就是等长空格）。
let compiles = false;
try {
  // new Function 只编译不执行；childMain 文本不是完整函数表达式时抛 SyntaxError。
  new Function(`return (${text});`);
  compiles = true;
} catch {
  compiles = false;
}
if (!/\S/.test(text) || !/^function\s+childMain\s*\(/.test(text.trimStart()) || !compiles) {
  process.stderr.write(
    "generate-child-main: 捕获的 childMain 源文本异常（为空格、非完整函数或不可编译），拒绝写入。请检查 tsx 转译行为。\n",
  );
  process.exit(1);
}

const output = `// GENERATED FILE — DO NOT EDIT.
// 重新生成：pnpm --filter @acode/cli child-main:generate（apps/acode-cli/scripts/generate-child-main.mjs）。
// 事实源：packages/dynamic-workflow-runtime/src/child-source.ts 的 childMain 函数；
// --check 漂移守护 + tests/workflow-child-entry-render.test.mjs 钉住一致性。
// 用途：renderChildEntry 以本常量内嵌子进程入口 .mjs，不依赖运行期 Function.prototype.toString()
// （字节码形态下不可用，见 packages/desktop/specs/agent-bytecode-production.md 风险登记）。
export const CHILD_MAIN_TEXT = ${JSON.stringify(text)};
`;

if (process.argv.includes("--check")) {
  const existing = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
  if (existing === output) {
    process.stdout.write("generate-child-main: 生成文件与 childMain 当前源文本一致\n");
    process.exit(0);
  }
  process.stderr.write(
    "generate-child-main: generated/child-main-text.ts 与 childMain 当前源文本漂移。\n" +
      "请运行 pnpm --filter @acode/cli child-main:generate 并提交生成文件。\n",
  );
  process.exit(1);
}

if (existsSync(outputPath) && readFileSync(outputPath, "utf8") === output) {
  process.exit(0);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output);
process.stdout.write(`generate-child-main: 已写入 generated/child-main-text.ts（${text.length} 字符函数源文本）\n`);
