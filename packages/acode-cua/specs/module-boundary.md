# Spec: acode-cua 模块边界（fail-closed 占位包）

## 背景与产品规则

`packages/acode-cua` 是 Computer Use 的 API 兼容占位构建：本构建不携带
Computer Use 能力，但必须让所有既有消费者（services 的 cua-permission-broker、
desktop main、acode-cli node-repl-host/core）在不改代码的前提下编译与运行，
且任何 CUA 请求都以明确的 unavailable 语义失败，绝不静默降级为“看起来可用”。

## 状态所有权

- 包本身无持久状态、无后台进程；`CuaHelperLifecycleManager` 仅持有调用方
  传入的 dispose 回调与当前 managed 引用（占位实现中 create 返回 undefined）。
- 权限/Helper/PiP 的业务状态归消费者模块（services cua-permission-broker 等）
  所有；acode-cua 只提供协议类型、常量与 fail-closed 实现。

## 公开接口（唯一合法访问面）

公开面 = `package.json` exports 的 12 个子路径，逐一映射到包根扁平文件：

| 导出子路径                    | 文件（.js / .d.ts）          |
| ----------------------------- | ---------------------------- |
| `.`                           | `index`                      |
| `./frame-contract`            | `frame-contract`             |
| `./host-display-contract`     | `host-display-contract`      |
| `./request-access-contract`   | `request-access-contract`    |
| `./pip-session`               | `pip-session`                |
| `./pip-session/node`          | `pip-session-node`           |
| `./broker`                    | `broker`                     |
| `./broker/server`             | `broker-server`              |
| `./broker/ports`              | `broker-ports`               |
| `./broker/socketPath`         | `broker-socket-path`         |
| `./broker/helperConstants`    | `broker-helper-constants`    |
| `./broker/helperHealth`       | `broker-helper-health`       |

架构检查器没有 `<pkgRoot>/src/<subpath>` 之外的包内解析约定，因此
`architecture-policy.yaml` 的 `global.aliasRules` 为每个子路径声明精确映射
（模块级 aliasRules 只对本模块内部导入生效，覆盖不了外部 importer，故必须
声明在 global 段）。`publicEntrypoints` 与上表 .js 文件一一对应。

## 不变量

1. fail-closed：运行时入口（execute / callBrokerMethod / dispatchRequest /
   installer.ensureInstalled 等）返回 isError 结果或抛出 BrokerError /
   CuaHelperError；谓词恒为 false；`createPipSessionClient().enabled === false`。
2. 无反向依赖：包内只 import node 内建模块（node:crypto / node:os /
   node:path）与包内相对文件；`requires: []`。
3. API 兼容：导出名与类型签名保持与上游真实 CUA 包一致，消费者零改动。
4. 布局冻结：保持扁平 .js/.d.ts 构建（不引入 src/、不新增构建步骤）；
   `module.ts` / `contract.ts` / `contract.example.ts` 为治理工件，运行时
   与根 typecheck（tsc -b 清单不含本包）均不编译它们。

## 失败语义

- 任何“CUA 是否可用”的判定失败都必须落到 denied / unknown / unavailable，
  不得因异常路径泄露探测能力或伪造成功。
- 环境变量逃生门（ACODE_CUA_PERMISSION_BROKER_SOCKET /
  ACODE_CUA_PERMISSION_BROKER_UNAVAILABLE / ACODE_CUA_HELPER_ADDON）只影响
  socket 路径解析与显式禁用，不能让占位实现变为可用。

## 迁移边界

真实 Computer Use 能力经 `@acode/acode-cua-plugin`（插件商店分发）提供；
本包永远保持占位。若未来恢复真实实现，需先更新本 spec 与 CONTRACT.md，
再替换实现文件；exports 子路径与公开类型保持向后兼容。

## 验收场景

1. 架构检查：`node scripts/architecture/architecture-check.mjs context acode-cua`
   显示 owner、契约文件与 publicEntrypoints；`check` 对本模块零违规。
2. 导入解析：services / desktop / acode-cli 中所有
   `@acode/acode-cua/<subpath>` 导入都解析到上表声明的 publicEntrypoints，
   无 deep-import、无 unresolved-workspace-import。
3. 运行时：消费者调用 execute / broker / PiP 入口得到明确的 unavailable
   错误（BrokerError code: unavailable，CuaHelperError code:
   helper_unavailable）或 isError 结果，进程不崩溃。
