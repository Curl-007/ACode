# CLI 独立交付门禁

## 所有者与规则

1. 根 workspace 的 lint 由根配置负责；CLI 各包的 lint 使用就近 CLI 配置，继承相同规则但不能继承根 `apps/acode-cli` 忽略项。
2. CLI lint 必须实际选择源码文件；空文件集合的 exit 1 是失败，不能开启 `no-error-on-unmatched-pattern` 掩盖。
3. 类型检查由单一入口 `scripts/typecheck-gate.mjs`（根 `pnpm typecheck`）拥有，覆盖三个阶段：`packages`（根工程引用 `tsc -b`，产出下游消费的 `.d.ts`）、`desktop-renderer`（`tsconfig.renderer.json --noEmit`）、`cli`（`turbo --cwd apps/acode-cli run typecheck`，含 `@acode/cli` 自身入口；兄弟包声明顺序由 turbo 的 `dependsOn: ["^build"]` 负责）。本地、CI 与 release 的每个 job 都只调用 `pnpm typecheck`。
4. `packages` 阶段是 barrier：renderer 经 project references 读取 `packages/*` 的声明，与 `tsc -b` 的写入并发会读到半成品声明并产生假失败；barrier 完成后 `desktop-renderer` 与 `cli` 并行执行。
5. 阶段清单只在 `scripts/typecheck-gate.mjs` 中声明一份。`--only`、`--stages-file` 是开发快循环与测试装配点，CI 与 release 不得使用它们缩小门禁范围；workflow 里出现 `typecheck` 的 `run` 必须逐字是 `pnpm typecheck`，不得内联 `tsc -p ...renderer.json` 或 `--dir apps/acode-cli/packages/cli typecheck` 形成旁路。
6. 任一阶段失败，门禁退出非零并指名阶段 id 与可复现命令；失败不得静默降级，也不得用关闭严格检查、扩大 `skipLibCheck` 或忽略诊断的方式制造通过。
7. Turbo lint 缓存必须把 CLI 和仓库根 lint 配置纳入输入；变更规则或作用域后不能复用旧的“通过”日志。
8. Knip 必须保留 files/dependencies/binaries 门禁。由 Renderer tsconfig 编译的 ambient/CSS 声明、架构 context 读取的 module 清单和 contract 示例按实际消费方式登记为入口；不扩大 ignore，也不保留失去消费者的内部 barrel。

## 验收

- `pnpm typecheck` 一次跑完三个阶段并退出码 0。
- 注入验收：以 `--stages-file` 指向含类型错误的 fixture 阶段，门禁退出非零、输出定位到该阶段 id；移除注入后同一入口退出 0。
- 依赖顺序验收：声明了 `dependsOn` 的阶段在其依赖结束后才开始；无依赖关系的阶段确实并行（以互相等待的 fixture 证明，串行则超时失败）。
- 旁路验收：`ci.yml` 与 `release.yml` 中所有含 `typecheck` 的 `run` 逐字为 `pnpm typecheck`，且两个 workflow 都不再出现 renderer 或 CLI 单入口的内联命令；根 `package.json` 的 `typecheck` 指向该脚本。
- `pnpm exec turbo --cwd apps/acode-cli run lint --force` 实际检查各有 lint 脚本包的源码，零 error。
- 根 lint 继续报告真实 warning/error，既有行数豁免不能扩为新模块的通用豁免。
