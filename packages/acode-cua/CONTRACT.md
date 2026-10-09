# acode-cua contract

Computer Use 的 API 兼容占位包（fail-closed）。本构建不含 Computer Use：所有
运行时表面（CUA runtime、broker RPC、Helper 安装/启动/校验、PiP 会话客户端、
native addon 加载）一律报告 unavailable 并 fail-closed。

- 真实公开面 = `package.json` exports 的 12 个子路径，映射到包根下的扁平
  `.js`/`.d.ts` 文件（无 `src/` 目录、无构建步骤）。`contract.ts` 是类型
  精选阅读视图，不新增运行时导出。
- 跨模块导入只能使用 exports 子路径（如 `@acode/acode-cua/broker/server`）；
  架构检查器经 `architecture-policy.yaml` 的 `global.aliasRules` 把子路径
  解析到实际文件，并以其为 publicEntrypoints 做 deep-import 校验。
- 类型无法表达的不变量：占位实现中谓词（isOfficialCuaImageRefText、
  isBrokerMethod、shouldRunCuaScreenCaptureProbe 等）恒为 `false`；
  `callBrokerMethod` / `dispatchRequest` / installer / lifecycle 入口以
  BrokerError / CuaHelperError（code: unavailable / helper_unavailable）
  拒绝；权限端口保持隐私 fail-closed 语义（宁可报 denied/unknown，
  不泄露探测能力）。
- 依赖方向：`requires: []`——包内只 import node 内建模块；禁止 acode-cua
  反向依赖任何 workspace 模块。
- 边界与验收场景见 `specs/module-boundary.md`。
