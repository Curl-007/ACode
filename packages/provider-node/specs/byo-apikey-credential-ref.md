# BYO Provider API Key 迁移到加密凭据库（credentialRef）

安全加固 P1-5。把用户在设置里录入的自定义 Provider API Key 从 `provider_config.json` **明文**迁移到
加密凭据库（`credentials.json`，即 P0-4 已加固的存储），文件里只保留 `credentialRef` 引用。

## 背景

设置里录入的 BYO Provider Key 经 `ProviderDraftSave.ts` → `config-service.ts savePersonalProviderOverlay`
→ `NodePersonalProviderConfigRepository` **明文**序列化进 `~/.acode/v2/provider_config.json`
（`ApiKeyAccessConfig.toJSON` 直接吐出 `apiKey`）。加密的 `credentials.json` 此前只管 OAuth/账号 Key，
**不覆盖 BYO Provider Key**。后果：家目录被外带（云同步/备份/磁盘镜像/恶意依赖/本产品自带的 Read·Bash
工具）即可读到全部付费 API Key 明文。

**已确立的同源先例**（本次直接复用，不另造一套）：
- CLI 的 coding-plan 登录已经把 apiKey 存进 `SharedACodeCredentialStore`（`auth-login.ts:339`
  `credentialStore.saveMany({ [credentialKey]: input.apiKey })`），provider_config 只写 providerId/modelId。
- 远程 provisioning 已有一套 `PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS` allowlist + cipher 解密链路。

## 产品规则

- **落盘形态**：`provider_config.json` 里 BYO provider 的 access **只存 `credentialRef`**（一个稳定的字符串引用），
  不再存 `apiKey` 明文。真 key 进加密凭据库，键名形如 `provider:apikey:<providerId>`（与 CLI 既有键命名空间一致）。
- **读取（hydration）**：`credentialRef` 在 **ProviderRegistryService 的异步刷新循环**
  （`registry-service.ts #runRefreshLoop`）里解析回 `apiKey`，再交给同步的 `#resolver.resolve(...)`。
  因此 registry 之后的全部下游消费者（约 39 处同步读 `access.apiKey`）拿到的仍是明文 key，**无需改动**。
- **写入**：`savePersonalProviderOverlay` 收到含 `apiKey` 的 access 时，把 key 存进凭据库、
  文件里改写为 `credentialRef`；`apiKey` 字段不写盘。
- **revision 不变量必须保持**：`NodePersonalProviderConfigRepository` 的 `revision = sha256(encode(update))`，
  且 `providerProvisioningSource.readProvisionablePersonalConfig` 会重新 hash 磁盘字节并断言等于 `revision`。
  因此 **snapshot 必须停在 ref 形态**（ref 是稳定字符串 → hash 确定 → 与磁盘一致），
  hydration **不得**回灌进 revision 计算或 snapshot，否则每次 1s 轮询都会误判「配置变化」并重写文件。
- **迁移（必须非破坏性）**：首次读到某 provider 的文件里仍是明文 `apiKey` 时——
  1. 先把明文写进凭据库（拿到 `credentialRef`）；
  2. **确认凭据库写入成功后**，才把文件里的 `apiKey` 换成 `credentialRef` 并原子重写；
  3. 任一步失败 → **不动文件**（明文照旧可读），下次读写重试迁移。
  绝不出现「文件已删明文、凭据库还没写入」的中间态。
  - **刻意不做 `.bak` 备份**（修订初版规格）：备份文件会把明文 API Key 复制到第二个路径，
    这比 P1-5 要消除的问题更糟——等于主动新增一处明文落盘。非破坏性由「先入库、后改文件」
    的顺序保证：明文的副本在凭据库里（已加密），不在另一个明文文件里。
    写入本身经 `atomicWritePrivateTextFile`（临时文件 + rename），不存在半写状态；
    真正损坏的文件仍由既有的 `backupCorruptFile` 留证（那条路径备份的是损坏内容，不是明文 Key）。
  - **无写放大**：迁移自终止。文件一旦是 ref 形态，`hasPlaintextApiKeys` 为 false，
    读路径快通道完全不触碰凭据库；且 ref 是确定性命名，`encode` 结果稳定，
    `revision` 不会漂移，轮询不会误判变化。凭据库持续不可用时也不会反复重写文件
    （vaulted 回退为原 update，与磁盘内容一致），只是每轮上报一次 recovery 事件。
- **明文回退兼容**：解密/ref 解析失败时，读取路径必须仍能识别文件里**残留的明文 `apiKey`**（迁移未完成或
  凭据库不可用时），按原样返回而不是报错——宁可暂时用明文，也不能让用户的 provider 当场失效。

## 状态所有者与写入路径

- **凭据真值唯一所有者**：`credentials.json`（经 `ICredentialService` / `SharedACodeCredentialStore`，
  P0-4 的加密 cipher）。`provider_config.json` 只持有 `credentialRef`。
- **hydration 唯一入口**：`ProviderRegistryService.#runRefreshLoop`（provider-node/registry-service.ts）。
  这是唯一把 ref 变回明文 key 的地方，且天然异步、在同步 resolver 之前。
- **注入边界（避免循环依赖）**：`provider-node` **不能** import `services`（services 已依赖 provider-node）。
  凭据库以**可选依赖注入**形式传入：`services` 侧 `ProviderConfigRuntime` / `NodeProviderConfigRuntime`
  构造时注入一个 `providerApiKeyVault`（load/save 接口），CLI 侧 `auth-login` 注入它已有的
  `SharedACodeCredentialStore`。未注入时（如纯 builtin、测试）退化为「不迁移、明文照读」的安全空操作。

## 接口

- `packages/provider/src/config/provider-data-schema.ts`：`apiKeyAccessDataSchema` 新增
  `credentialRef: z.string().nullable().optional()`；`completeApiKeyAccessDataSchema` 放宽为
  「`apiKey` 或 `credentialRef` 至少有一个」（不再强制 `apiKey` 必填）。
- `packages/provider/src/config/provider-config.ts`：`ApiKeyAccessConfig` 携带 `credentialRef`，
  `toJSON()` 输出 `credentialRef`、**不输出** `apiKey` 明文（除非是未迁移的明文回退态）。
- 新增 `ProviderApiKeyVault` 接口（provider-node，注入式）：`load(ref): Promise<string|null>`、
  `save(providerId, apiKey): Promise<string /*ref*/>`、
  `delete(ref): Promise<void>`（幂等；条目不存在时为无操作，供引用消失后的孤儿清理）。
- `registry-service.ts`：refresh 循环在 resolve 前对 personalProviders 做一次 `hydrateCredentialRefs`
  （把 ref → apiKey），产出的 registry 含明文，snapshot 仍存 ref 形态。
- `registry-service.ts`：refresh 循环在 resolve 前对 personalProviders 做一次 `hydrateCredentialRefs`
  （把 ref → apiKey），产出的 registry 含明文，snapshot 仍存 ref 形态。

## 验收场景

见 `packages/provider-node/tests/`（新增，仅用 mkdtemp 临时目录 + 内存/临时凭据库，**绝不触碰真实 ~/.acode**）：

1. **写路径**：保存含 apiKey 的 BYO provider → 文件里只有 `credentialRef`，无明文；凭据库里有该 key。
2. **读路径**：文件含 `credentialRef` + 凭据库有值 → registry 里 `access.apiKey` 是明文真值（下游可用）。
3. **revision 稳定**：同一份 ref 文件连续多次 read，revision 不变；文件 mtime/size 不变（不重写）；
   凭据库对同一把 Key **只被 save 一次**（迁移已自终止，无写放大）。
4. **迁移非破坏**：文件含明文 apiKey + 凭据库写入失败 → 文件**仍是明文**、未损坏、仍可读，
   且经 `onRecovery` 上报失败。**刻意不产生 `.bak` 备份**：备份等于把明文 Key 复制到第二个路径，
   比本特性要消除的问题更糟；非破坏性由「先入库成功、后改文件」的顺序保证。
5. **明文回退 / 悬空引用**：凭据库不可用（`vault.load` 抛错）或引用悬空（返回 null）时，
   hydration 保留原 access、不抛错、不把 apiKey 置空——provider 不会当场失效。
6. **远程 provisioning 不破**：`readProvisionablePersonalConfig` 的核心断言（重算磁盘 hash 等于
   `snapshot.revision`）对 ref 形态文件仍成立，不因 hydration 抛「配置在读取期间发生变化」。
7. **无 vault 注入**：构造 repository 时不传 vault → 明文 provider 照写照读、不迁移、不崩溃（安全空操作），
   且读路径行为与改动前完全一致（不会平白开始加文件锁）。
8. **overlay 不静默丢 Key**：已有 `credentialRef` 的 access 叠加一个新明文 apiKey 时，新 Key 胜出、
   旧 ref 被清空。否则 `toJSON()` 在有 ref 时丢弃明文 → 用户改 Key 看着保存成功、实际仍用旧 Key。
9. **hydration 后的内存值不落盘**：`toJSON()` 在存在 `credentialRef` 时永不输出 `apiKey`，
   即使内存对象已被 registry hydrate 填上明文。
10. **协议 worker hydrate（R1）**：非 standalone 的 `startProcessProviderRegistryRuntime` 也能把
    ref 形态 hydrate 回明文——registry 解析结果里 `access.apiKey` 是真值而非 ref 字符串。
11. **provisioning 同步 BYO Key（R2）**：source 从 credentials.json 导出 `provider:apikey:*` 条目
    （scope `provider-apikey`），envelope schema 接受；scope 与 key 不匹配的条目被目标端校验拒绝。
12. **删除 provider 清理凭据（R3）**：update 移除带 ref 的 provider → 对应 vault 条目被删；
    仍被引用的 ref 不受影响；`vault.delete` 失败不影响已提交的文件写入（仅上报）。

## 跨进程 / 跨环境注入完整性（回归修复，2026-09-28）

P1-5 首版实现漏了「**谁读 vault 化的 provider_config.json，谁就得有 vault**」这条不变量的完整执行，
造成三条回归（见 `docs/security-hardening-handoff.md` §5）。本节把不变量及其执行点固化为规则：

### R1：协议 worker 无条件注入 vault

- 桌面 host 与它拉起的 agent worker（`acode.cjs app-server --stdio`）**共用同一份**
  `provider_config.json` 与 `credentials.json`（路径由 `ACODE_DATA_BASE_DIR` / 默认 homedir 一致解析；
  cipher 与 store 均惰性，构造无磁盘副作用）。
- `startProcessProviderRegistryRuntime` **无论是否 standalone 都必须注入 vault**。standalone 专属的
  账号管理（`createAccountSource` / `importLegacy` / `providerRuntimeHeadersPort`）仍仅限 CLI standalone。
- 违反后果：worker 读到 ref 形态但无法 hydrate → `access.apiKey` 是 ref 字符串被当 Key 用 →
  桌面 BYO provider 全线静默 401。
- worker 侧凭据变更订阅不再假定 standaloneAccount 存在：仅刷新 registry（重新 hydrate）。

### R2：BYO Key 随 provisioning envelope 同步

- provisioning 导出的凭据 allowlist 必须包含 `provider:apikey:<providerId>`（scope `provider-apikey`）。
  信封里 personalConfig 带 ref、credentials 带真值；目标端保存真值后经同一 hydration 生效。
- **传输加密门槛（安全审计 M5）**：信封的 credentials 是 cipher 解密后的明文，只允许经加密传输
  跨环境（wss/TLS、SSH/WSL/Docker stdio）；桌面连 server kind 的 ws:// 明文连接时 Main 不注册
  provisioning lane、整体跳过同步并告警（schemaVersion 1 的 replace-allowlist 目标语义下，
  `credentials: []` 的「仅配置」信封会清空远端凭据，不可作为降级形态）。判定与门槛唯一实现见
  `packages/desktop/specs/provisioning-transport-encryption-gate.md`。
- 目标端 replace-allowlist 删除语义同样覆盖该 scope：`readProvisioningCredentials` 的 scope 解析、
  `listProviderProvisioningCredentialKeys` 的物理键枚举、`validateCredentialEntries` 的 scope↔key 校验、
  `captureBeforeState` 的 before 键收集，四处匹配**必须一致**，否则出现「信封带配置不带 Key」或
  「回滚漏键」的分叉。
- 版本偏差（旧目标端收到新 scope）表现为目标端 envelope 校验**显式失败**，而不是静默丢 Key。
- 桌面 host 的 `onDidMutate` 触发源变更的判定需包含该 scope：BYO Key 变化后远端应收到同步推送。

### R3：引用消失即清理凭据（vault.delete）

- 写入漏斗（`NodePersonalProviderConfigRepository.update`）在**文件提交之后**，对比提交前后
  personal providers 引用的 `credentialRef` 集合；消失的 ref 调 `vault.delete`。
- 顺序必须「**先写文件、后删凭据**」：反序会在写文件失败时留下「引用悬空且明文已删」的真丢 Key
  状态；正序的最坏情况是留下孤儿条目（与修复前状态相同，非破坏）。
- 删除失败**不回滚**已提交的文件写入（用户视角删除已成功），经 `onRecovery` 上报。
- delete 幂等：provisioning 的 credential 回滚与写入漏斗可能对同一 ref 各删一次，第二次必须是无操作。

## R1-c：明文回退的显式告警与装配点收口（2026-10-03 批次 4）

D6 裁决（docs/credential-os-keychain-design.md）：明文回退**保留**（可用性优先是既有产品
决定：vault 不可用时 Key 继续可用、下次写入重试迁移；硬闸会把安全成本转嫁为 headless BYO
不可用），但必须显式可发现，且「可修复的接线缺席」要收口根因。

- **成因调查结论**：全仓 `NodePersonalProviderConfigRepository` 构造点共三处——
  provider-node 内部工厂（options 透传）、`provider-config-runtime.ts`（转发
  `providerApiKeyVault`，桌面 services node.ts 与 CLI process-provider-registry-runtime
  两个装配点均已注入）、CLI `bootstrap/auth-login.ts`（**唯一缺口**：不注入 vault，
  `saveConfiguredDefault` 重写整份文件时把 `importLegacy` 带入的旧明文 BYO Key 原样落盘
  且不迁移）。
- **根因收口**：auth-login 构造点补注入 `createSharedCredentialStoreApiKeyVault(input.credentialStore)`
  ——与 process-provider-registry-runtime 同一适配器（同一 `credentials.json`、同一确定性
  引用键，桌面写入的 ref CLI 可读回的既有前提不变）。守护：
  `apps/acode-cli/tests/auth-login-vault-wiring.test.mjs` 源码不变量（构造参数缺
  `providerApiKeyVault` 即红）。
- **回退告警**：写入漏斗 `#writeLocked` 在 vault 化之后仍有明文 BYO Key 落盘时，发一次性
  `SECURITY NOTICE` console.warn（once-guarded，键 = 成因+文件路径：轮询/重复写入不刷屏，
  不同数据目录互不吞告警）。成因二分文案：vault 未注入（装配点缺失/纯 builtin/测试）vs
  save 失败（已经 `onRecovery` 上报，这里补用户可见面）。告警不改变任何行为——迁移
  重试与明文可用性照旧。

## 不在本特性范围

- `apiKeyManagementUrl` 等非敏感字段仍明文存文件（不是 secret）。
- 账号/OAuth Key 已在凭据库，不在本次范围。
- ~~OS 钥匙串接入仍是 P0-4 的后续工作~~ **已落地**（批次 4 R1-a/R1-b：主密钥入 OS 钥匙串 +
  一次性迁移，见 packages/services/specs/credential-storage.md）。本特性把 BYO key 并入
  凭据库，凭据库主密钥强度现由钥匙串保障。
