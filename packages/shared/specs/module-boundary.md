# Shared module boundary

## Scope

`packages/shared/src` 是跨进程协议 / schema / 类型的唯一事实源（@acode/shared）。
本 spec 登记其纳管为架构模块（managed，ARCH-04 batch 3）：公开契约、依赖方向、
无环纪律与验收场景。纳管不改变任何运行时行为；公开 API 名逐名不变。

## Ownership and invariants

- owner：`shared-protocol`。
- 协议/schema 的唯一事实源在本模块；UI、services、session、server、CLI、
  harness-sdk 只做投影与消费，不得复制第二份词表（如枚举字面量、channel 名）。
- Account Access schema/类型的唯一事实源是叶子文件 `src/account-access-types.ts`；
  `acode-protocol/index.ts` 与包根 barrel 保持 re-export（公开 API 名不变）。
- 本模块不承载业务状态与 IO 编排；`node.ts` / `node/` 只做凭据主密钥、keychain
  等无状态平台原语。

## Public boundary

- 权威公开面 = `packages/shared/package.json` 的 20 个子路径 exports；对应源文件
  （`src/index.ts`、`src/runtimeEnv.ts`、`src/mcp.ts`、`src/runtime-tool-runtime.ts`、
  `src/browser-use/nodeReplBroker.ts`、`src/process-diagnostic.ts`、
  `src/model-selection.ts`、`src/account-provider-state.ts`、`src/model-config.ts`、
  `src/config-schema.ts`、`src/node.ts`、`src/acodeEndpoint.ts`、
  `src/workspaceFileSearch.ts`、`src/workspaceFileEntriesCodec.ts`、
  `src/acode-protocol-v4/index.ts`、`src/harness-api/index.ts`、四个
  `src/workspace-hook-*.ts`）加上 `src/contract.ts` 登记为 publicEntrypoints。
- `src/contract.ts` 是治理用精选视图（核心协议/schema 名字速览），不整体转发
  权威面；跨模块导入仍应走 package.json exports 子路径。
- deep-import ratchet 对所有消费方生效（含 legacy 模块）：纳管前实测全部
  非豁免入边都命中上述入口（acode-cli 测试文件的相对路径 deep import 属
  RATCHET_EXEMPT 面，不阻断）。

## Dependency direction

- 允许：`@acode/model-option-map`（requires，`model-config.ts` 的
  `compileModelOptionMap` 单一边）、zod、node 内置模块（34 处 `node:` import，
  集中在 `node/` 与凭据链路）。
- 禁止：依赖任何其它 workspace 模块；任何模块 deep import 本模块内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——存在直接 node IO（keychain 子进程、
  crypto），声明 domain 层会触发 domain-io，且模块内无层间方向约束需求。
- 无环（纳管时修复，公开 API 名不变）：
  1. `acode-protocol/index.ts ↔ usage-stats.ts`：index 从 usage-stats 导入值
     （APP_USAGE_RANGES/appUsageSnapshotSchema），usage-stats 反向需要 Account
     Access 类型。修复：类型与 schema 迁至新叶子 `account-access-types.ts`，
     两侧直引叶子，barrel re-export 保持导出面。
  2. `channels.ts ↔ index.ts`：index `export * from "./channels.js"` 而 channels
     反向 `import type ... from "./index.js"`。修复：channels 直引 `mcp.ts` 与
     `protocol.js` 叶子。
     新文件不得从 `index.ts` barrel 反向导入。

## Registered debt（例外，expires 2026-12-31）

- `onboard-b3-shared-over-limit`：26 个存量超 400 行文件（与
  `.architecture-baseline.json` 集合一致）；例外只冻结存量，新增超限文件仍阻断。
- `onboard-b3-shared-disables`：18 个含 lint disable 的存量文件；新增 disable
  仍阻断。到期前应拆分文件、移除 disable，而不是续期例外。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：shared 零新违规
   （cycle、deep-import、max-file-lines、disable-count、missing-module-artifact、
   missing-public-entrypoint 全绿；baseline 不新增）。
2. `node scripts/architecture/architecture-check.mjs context shared` 展示
   owner/contract/requires。
3. `pnpm --filter @acode/shared test` 全绿；包根与子路径导出面与纳管前逐名一致
   （ACodeAccountAccess 等 4 个名字仍从 acode-protocol barrel 与包根可导入）。
4. `pnpm exec tsc -b packages/shared` 通过（contract.example.ts 参与编译）。
