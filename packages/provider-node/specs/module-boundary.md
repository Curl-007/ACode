# provider-node module boundary

## Scope

`packages/provider-node` 是 Provider 配置域的 Node.js 运行时物化层：把
`@acode/provider` 的域模型（双层配置、Registry、Facade）接到真实文件系统与
网络（Built-in 配置下载/缓存/远程同步、Personal 配置文件仓库、凭据库注入、
路径解析）。本 spec 登记其纳管为架构模块（managed，ARCH-04 batch 2）：公开契约、
状态所有权、依赖方向与验收场景。纳管批次不改变任何运行时行为与包根公开 API。

## Ownership and invariants

- owner：`provider-node-runtime`。
- 文件 watch、轮询定时器与恢复回调的唯一所有者是对应 source/repository 实例
  （`NodeACodeBuiltinProviderConfigSource` / `NodePersonalProviderConfigRepository`）；
  `NodeProviderConfigRuntime` / `NodeProviderRegistryRuntime` 只做装配与生命周期
  治理：`#startPromise` 保证单次启动，`#disposed` 保证释放幂等，check 定时器有
  in-flight 去重（`#checkInFlight`），不另存第二份配置缓存。
- 双层配置（ACode Built-in + Personal）合并的唯一漏斗是 provider 模块的
  `ProviderConfigService`；runtime 以 `configService` 属性透出，不并行实现合并。
- Personal 配置写盘走「锁内 transform-CAS + canonical 化 + 原子写」；encode 对
  undefined 键不物化（config-persistence 审计 W6 判定的良性范式）。
- BYO API Key 明文唯一落点是注入的 `ProviderApiKeyVault`；配置文件只存
  credentialRef（安全加固 P1-5）。

## Public boundary

- 公开契约是 `src/contract.ts`（治理登记面，`export *` 整体转发 index.ts）；
  `src/index.ts`（包根 `@acode/provider-node`）是运行时入口。两者都登记为
  publicEntrypoints。其余源文件是内部实现，跨模块 deep import 会被 architecture
  checker 以 `deep-import` 拒绝。
- 全仓消费均使用包根 specifier `@acode/provider-node`（desktop 经 tsup
  noExternal 内联源码，导入面不变）。
- **已登记的潜在债**：`apps/acode-cli/tests/protocol-worker-vault-injection.test.mjs`
  以相对路径 deep import 3 个内部文件（`acode-builtin-release.ts`、
  `provider-config-file-codec.ts`、`runtime-paths.ts`）。importer 属 legacy 模块
  acode-cli 且命中测试豁免 pattern（`tests/` 目录），当前不产生违规；**不把这
  3 个文件加为 publicEntrypoints**（那会把测试捷径固化成公开面），后续应改经
  包根入口消费。

## Dependency direction

- 允许：`@acode/provider`（域模型/Service/Facade 类型）、`@acode/shared`（含
  model-config、model-selection、node 子路径投影）、zod、node 内置模块
  （12 处 node: 导入：fs/path/os/crypto/timers 等）——requires: [provider,
  shared]，与 module.ts 清单一致。
- 禁止：provider-node 依赖 desktop/server/services 等消费方；任何模块反向依赖
  provider-node 内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——本模块的存在意义就是持有文件与
  网络 IO，声明 domain 层会触发 domain-io。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：provider-node 在
   managed 语义下零违规（无超限文件、无 lint disable、forbidCycles、
   deep-import、module-dependency）；不新增例外，`.architecture-baseline.json`
   不动；上述 CLI 测试 deep import 保持豁免且不扩大。
2. `node scripts/architecture/architecture-check.mjs context provider-node` 展示
   owner `provider-node-runtime`、module.ts 与 contract.ts。
3. `pnpm --filter @acode/provider-node test` 全绿；包根导出面（index.ts）与
   纳管前逐名一致。
4. `tsc -b packages/provider-node`（根 `pnpm typecheck` 名单内）通过；
   `contract.example.ts` 随包工程一起编译（无 IO，仅编译与文档验证）。
