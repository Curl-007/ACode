# 动态工作流子进程入口渲染：childMain 源文本构建期物化

性质：**发布形态缺陷修复 + 构建链约定**。修复 v0.0.4 字节码形态下动态工作流
（CreateWorkflow / AmendWorkflow / ResumeWorkflowRun）与 EvalWorkflowSnippet
全部 SyntaxError 致死的缺陷。

## 背景与根因

`renderChildEntry`（`packages/dynamic-workflow-runtime/src/child-source.ts`）此前用
`childMain.toString()` 把沙箱子进程主函数当源码内嵌进生成的入口文件
`.acode/workflow-runs/<runId>.mjs`（`const main = <源文本>;`）。

桌面字节码形态（J5-L1，`packages/desktop/specs/agent-bytecode-production.md`）下，loader 以
`" ".repeat(metadata.sourceLength)` 作为 `vm.Script` 的源文本编译 cachedData
（`scripts/desktop-agent-bytecode-runtime.cjs:61`）。V8 的 `Function.prototype.toString()`
从脚本源文本取值，因此该形态下**任何函数的 toString() 都返回等长纯空格**。入口文件被渲染成
`const main = <空格>;`，Node 加载模块即 SyntaxError，工作流脚本 0 行执行。
v0.0.4 生产安装（Electron 41 字节码形态）实测 5/5 复现（3 次 snippet + 2 次 run，含一次 resume）。

这是 childMain 自包含约束的第三个形态坑：前两个（esbuild `minify + keepNames` 的 `__name`
helper）靠「内层函数不许有名字」约束与注释拦截；字节码形态击穿的则是「运行期 toString」
这个手段本身——源码与 minify 形态下测试全绿，只在字节码产物里坏。

## 产品规则

1. 子进程入口渲染必须在**所有发布形态**（源码 tsx、esbuild bundle、esbuild minify+keepNames、
   字节码）下产出等价、可执行的入口文件；渲染**不得依赖宿主运行期的
   `Function.prototype.toString()`**。
2. `childMain` 的源文本在构建期物化为提交入库的生成文件
   `packages/dynamic-workflow-runtime/src/generated/child-main-text.ts` 中的字符串常量
   `CHILD_MAIN_TEXT`；`renderChildEntry` 只内嵌该常量。
3. childMain 的两条自包含约束继续成立（见 `child-source.ts` 注释）：函数体只引用参数、
   语言 intrinsics 与 Node 全局。「内层函数不许有名字」约束保留为防御——物化文本经 tsx
   非压缩转译捕获，`__name` 风险当前不存在，但约束防止未来捕获形态变化时回归。
4. 生成文件是派生物：禁止手改；修改 childMain 必须重新生成，漂移由守护测试与 `--check`
   拦截（CI 经 `pnpm test` 阻断）。

## 状态所有权

- **唯一事实源**：`packages/dynamic-workflow-runtime/src/child-source.ts` 的 `childMain` 函数体。
- **唯一写入路径**：`apps/acode-cli/scripts/generate-child-main.mjs`（经 tsx 导入 childMain
  捕获 toString()；支持 `--check` 只读校验；写入前自检捕获文本非空格、以
  `function childMain(` 开头、可经 `new Function` 编译为函数表达式）。
- **派生物**：`packages/dynamic-workflow-runtime/src/generated/child-main-text.ts`
  （提交入库；随包 `tsc` 构建进 dist；esbuild 打 acode.cjs 时作为常量池值携带；
  字节码编译后作为字符串常量保留，不受空格源文本占位影响）。
- **消费方**：`renderChildEntry`（唯一插值点）。SEA 子命令 `__acode-dwf-child` 与
  `node <entry>` 自启两条路径都只消费渲染出的入口文件，不 import runtime 包，
  因此单点修复同时覆盖两条启动路径。

## 接口

- `pnpm --filter @acode/cli child-main:generate`——重新生成并写回（幂等：内容一致不重写）。
- `pnpm --filter @acode/cli child-main:check`——校验生成文件与 childMain 当前源文本逐字节
  一致，漂移退出码 1 并提示重新生成。

## 验收场景

1. **字节码形态回归**（`tests/workflow-child-entry-render.test.mjs`）：把 `childMain.toString`
   污染为返回等长空格（模拟字节码 loader 的空格源文本形态）后，`renderChildEntry` 产出的
   入口仍包含真实函数文本、不含长空格段、且经 `node --check` 可编译。旧实现（运行期
   toString）在此场景下渲染出空格 main，必然失败。
2. **漂移守护**：常量 `CHILD_MAIN_TEXT` 与运行期（tsx 形态）`childMain.toString()` 全等；
   `--check` 对当前检出退出码 0；修改 childMain 未重新生成时，CI（`pnpm test`）经上述
   断言失败。生成确定性：同一检出重复生成逐字节相同。
3. **结构完整**：入口文件包含 payload JSON 字面量、`main` 函数、`start(deps)` 导出与
   BOOTSTRAP 标记（`__execute`、`workflow-sandbox`）。
4. **既有链路零回归**：`workflow-script-determinism.test.mjs`（真实跑 runWorkflowScript →
   renderChildEntry → spawn node 的端到端）保持绿色；script-workflow（本就是字符串常量
   姿态）不受影响。
5. **真实字节码形态端到端**（发布构建复验项，dev 环境无法复现字节码形态）：生产安装或
   `ACODE_DESKTOP_AGENT_BYTECODE=1` 打包后，CreateWorkflow / EvalWorkflowSnippet 能正常
   启动子进程并跑完最小脚本。

## 所有权边界

- `apps/acode-cli/scripts/generate-child-main.mjs`（新增，唯一写入者）
- `packages/dynamic-workflow-runtime/src/generated/child-main-text.ts`（新增，生成物，提交入库）
- `packages/dynamic-workflow-runtime/src/child-source.ts`（renderChildEntry 插值来源改为常量 +
  注释同步；childMain 函数体不动）
- `apps/acode-cli/package.json`（child-main:generate / child-main:check 脚本）
- `apps/acode-cli/packages/bootstrap/src/app/script-workflow-child-source.ts`（仅注释：dwf 形态
  描述同步为物化常量）
- `apps/acode-cli/tests/workflow-child-entry-render.test.mjs`（新增）
- 本 spec；`packages/desktop/specs/agent-bytecode-production.md` 风险登记补
  「字节码形态 Function.prototype.toString() 不可用」条目

边界外：字节码 loader 的空格源文本机制本身（J5-L1 既定设计，不改）；构建链脚本
（生成物提交入库，`build-desktop-agent-cli.mjs` / `prepare-agent-node-bundle.mjs` /
bare-tsc 路径均无需改动）；script-workflow 的字符串常量实现（已免疫，不动）。
