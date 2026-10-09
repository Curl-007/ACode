# acode-cli-contracts module

`@acode/contracts` 是 CLI 与宿主共享的类型/纯函数契约包，纳管为架构模块 `acode-cli-contracts`（owner: `cli-contracts`，规格：`apps/acode-cli/specs/architecture-contracts-module.md`）。

- **contract.ts**：策展的稳定公开面（端口 + 核心类型，纯 re-export）。跨模块新依赖先在这里登记。
- **index.ts**：包主入口（`exports["."]`），完整导出面；`plugins/index.ts` 与 `tools/node-repl.ts` 是另外两个 package.json 合法子路径入口。
- **依赖方向**：`requires: [shared]`（@acode/shared 及子路径）+ 外部 zod；模块内部为文件级 DAG，断环叶子（session-shared / observations / protocol-types / request-status / todo-confidence-gate / dynamic-workflow-run-error.port）不得反向引用桶文件。
- **纪律**：无 IO 实现、无运行时状态；`tools/contract.ts` 是工具声明域文件，不是模块契约。
