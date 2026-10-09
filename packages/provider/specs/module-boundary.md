# provider module boundary

## Scope

`packages/provider` 是模型 Provider 配置域：双层配置（ACode Built-in + Personal）
合并漏斗、Provider Registry 视图与模型选择校验、账号 Provider 状态、BYO API Key
凭据接口、设置/选择投影视图与配置数据 schema。本模块无 node:/DOM IO——文件与
网络物化由 `@acode/provider-node` 运行时注入。本 spec 登记其纳管为架构模块
（managed，ARCH-04 batch 2）：公开契约、状态所有权、依赖方向与验收场景。纳管
批次不改变任何运行时行为与包根公开 API。

## Ownership and invariants

- owner：`provider-config`。
- Provider 事实（revision、providers 列表、provider/model 索引、变更监听器）的
  唯一所有者是 `ProviderRegistry` 实例：视图冻结只读，`replace` 整体换页、
  revision 单调递增并同步通知监听者；重复 providerId/modelId 构造即抛错。
- 双层配置合并的唯一漏斗是 `ProviderConfigService`（ACode Built-in 层 +
  Personal 层，经 `ProviderSource`/`PersonalProviderConfigRepository` 接口注入）；
  本模块不持有文件句柄、watch 或定时器，Node 侧物化归 provider-node。
- API Key 红线：明文只经 `ProviderApiKeyVault` 接口进出；selection 视图序列化点
  负责 api-key 剥离（specs/model-selection-view-apikey-stripping.md）；http 明文
  端点产生 warning 级校验问题而非硬失败（specs/provider-http-endpoint-warning.md）。
- 校验严重度语义见 specs/config-validation-severity.md。

## Public boundary

- 公开契约是 `src/contract.ts`（治理登记面，`export *` 整体转发 index.ts）；
  `src/index.ts`（包根 `@acode/provider`）是运行时入口。两者都登记为
  publicEntrypoints。其余源文件是内部实现，跨模块 deep import 会被 architecture
  checker 以 `deep-import` 拒绝。
- 全仓消费均使用包根 specifier `@acode/provider`（含 provider-node、desktop
  tsup noExternal 内联与 CLI 测试；纳管前扫描确认零 deep import）。
- 行数/抑制例外（限期债，expires 2026-12-31）：
  - `onboard-provider-over-limit`（max-file-lines）：config-service.ts 757、
    facades.ts 688、config/model-config.ts 581、config/provider-config.ts 580；
  - `onboard-provider-disables`（disable-count）：上述 4 文件 + resolver.ts
    （各 1 条首行 max-lines 抑制）。
    到期前必须拆分/清理并移除例外；`.architecture-baseline.json` 不动。

## Dependency direction

- 允许：`@acode/shared`（域类型与配置 schema 投影：model-config、
  model-selection、config-schema、account-provider-state 子路径）、zod
  ——requires: [shared]，与 module.ts 清单一致。
- 禁止：provider 依赖 provider-node/services/desktop 等物化或消费方模块
  （物化经接口注入倒置）；任何模块反向依赖 provider 内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——0 处 node: 导入，本可声明 domain，
  但为与其余五个纳管模块形态一致并预留 Facade 演进空间，统一用 app 单层。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：provider 在 managed
   语义下，除已登记的 `onboard-provider-over-limit` 与 `onboard-provider-disables`
   两条例外外零违规（forbidCycles、deep-import、max-contract-lines、
   max-public-methods）。
2. `node scripts/architecture/architecture-check.mjs context provider` 展示 owner
   `provider-config`、module.ts 与 contract.ts。
3. `pnpm --filter @acode/provider test` 全绿；包根导出面（index.ts）与纳管前
   逐名一致。
4. `tsc -b packages/provider`（根 `pnpm typecheck` 名单内）通过；
   `contract.example.ts` 随包工程一起编译（纯内存 Registry，无 IO）。
