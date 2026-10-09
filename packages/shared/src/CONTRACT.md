# shared

`@acode/shared` 是跨进程协议 / schema / 类型的唯一事实源。权威公开面是
`packages/shared/package.json` 的 20 个子路径 exports（包根 `index.ts` 与
`./acode-protocol-v4`、`./harness-api`、`./node`、`./model-selection`、
`./model-config`、`./config-schema` 等），它们对应的源文件与 `contract.ts`
一起登记为 publicEntrypoints；跨模块 deep import 会被架构检查拒绝。

`contract.ts` 是治理用精选视图（核心协议/schema 名字的有界速览），不替代
package.json exports 权威面。owner 是 `shared-protocol`。

依赖方向：本模块只依赖 `@acode/model-option-map`（`model-config.ts` 调用
`compileModelOptionMap`）与 zod；`node.ts` / `node/` 子目录使用 node 内置模块
（crypto、keychain 子进程等），因此整模块声明为单层 `app`（无 domain 层）。
任何模块不得反向依赖本模块的内部实现文件。

无环纪律（forbidCycles 纳管时修复的两处文件级环，公开 API 名不变）：
`acode-protocol/index.ts ↔ usage-stats.ts` 通过新叶子 `account-access-types.ts`
解环（Account Access schema/类型唯一事实源，barrel 保持 re-export）；
`channels.ts ↔ index.ts` 通过 channels 直引 `mcp.ts` / `protocol.ts` 叶子解环。
新文件不得从 `index.ts` barrel 反向导入——直引具体叶子模块。
