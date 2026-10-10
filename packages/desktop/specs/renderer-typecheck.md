# Desktop Renderer 类型门禁

## 目标

Desktop renderer 必须在独立的 `tsconfig.renderer.json` 中通过 `tsc --noEmit`。该工程与
main/host 分开编译，不能依赖开发者已生成的声明或 bundler 对 CSS/Preload bridge 的隐式处理。

## 所有者与边界

- `packages/client/src/globals.d.ts` 是 `window.acode` preload bridge 的公共类型事实源。
- `packages/desktop/src/renderer/src/ambient.d.ts` 只负责把该公共声明接入 renderer 编译，
  不复制 bridge 方法定义；`css.d.ts` 声明已由 Vite 处理的 CSS side-effect 模块。
- 两个声明文件均由 renderer tsconfig 编译，Knip 将其登记为类型入口，不能误删或整目录忽略。
- CI 与 release 的 `verify` job 都必须执行同一条 renderer typecheck 命令。

## 不变量

1. renderer 源码可以直接使用 `window.acode`，且类型来自 `@acode/client/globals`。
2. `@acode/ui/styles.css` 的 side-effect import 在独立 tsc 中可解析，不改变运行时打包行为。
3. 删除公共声明或 CSS ambient 接线时，renderer typecheck 和门禁测试必须失败。

## 验收

- `pnpm exec tsc -p packages/desktop/tsconfig.renderer.json --noEmit` exit 0。
- CI 与 release 在根 typecheck 后执行该命令；不把 `tsc` 错误改成 `skipLibCheck` 或 `any`。
