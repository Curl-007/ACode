# CLI 独立交付门禁

## 所有者与规则

1. 根 workspace 的 lint 由根配置负责；CLI 各包的 lint 使用就近 CLI 配置，继承相同规则但不能继承根 `apps/acode-cli` 忽略项。
2. CLI lint 必须实际选择源码文件；空文件集合的 exit 1 是失败，不能开启 `no-error-on-unmatched-pattern` 掩盖。
3. CI/release 在 CLI 依赖包 build 后执行 CLI entry typecheck、CLI workspace lint 和 Desktop renderer 独立类型检查。
4. Turbo lint 缓存必须把 CLI 和仓库根 lint 配置纳入输入；变更规则或作用域后不能复用旧的“通过”日志。
5. Knip 必须保留 files/dependencies/binaries 门禁。由 Renderer tsconfig 编译的 ambient/CSS 声明、架构 context 读取的 module 清单和 contract 示例按实际消费方式登记为入口；不扩大 ignore，也不保留失去消费者的内部 barrel。

## 验收

- `pnpm exec turbo --cwd apps/acode-cli run lint --force` 实际检查各有 lint 脚本包的源码，零 error。
- `pnpm --dir apps/acode-cli/packages/cli typecheck` 和独立 renderer tsc 零 error。
- 根 lint 继续报告真实 warning/error，既有行数豁免不能扩为新模块的通用豁免。
