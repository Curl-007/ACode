# Model Selection 视图永不携带 BYO API Key 明文（安全审计 M3）

## 背景

P1-5（`packages/provider-node/specs/byo-apikey-credential-ref.md`）把 BYO Provider API Key 迁进
加密凭据库：`provider_config.json` 只存 `credentialRef`，明文由 `ProviderRegistryService.#runRefreshLoop`
hydrate 回内存供 Host 侧执行链使用；`ApiKeyAccessConfig.toJSON()` 的落盘形态在有 ref 时刻意剥离明文
（"P1-5 核心安全属性"）。

但 selection 视图的序列化点 `serializeRegistryProviderConfig`（`packages/provider/src/resolver.ts`）
此前无条件输出内存里的 `access.apiKey` 且丢弃 `credentialRef`。该函数的结果经
`projectModelSelectionProviderView`（`facades.ts`）进入 `ModelSelectionView`，由
`IModelSelectionService.getView()/onDidChange`（`ServiceChannels.ModelSelection`）经 RPC 广播给
**每个连接客户端**（桌面 renderer、Web、手机远控；默认 loopback 无 token 姿态下本机任意进程可连
`/ws` 调 `getView()` 收割全部 BYO Key）。这与 P1-5「明文只存在于 Host 内存与落盘剥离」的设计直接
矛盾——等于在 toJSON 之外开了第二条明文越界面。

## 产品规则

- **selection 视图只发布非敏感事实**：`ModelSelectionView.providers[].config.access`（含 Off-Peak
  投影 `buildOffPeakModelSelectionView`）发给客户端时**永不含明文 `apiKey`，也不携带
  `credentialRef`**。access 只保留：`type`、`apiKeyManagementUrl`（P1-5 已裁定非 secret），以及
  zhipu-account 分支的 `accountType/mode/entitled`（账号事实，消费方依赖）。
- **序列化唯一收口点**：`serializeRegistryProviderConfig`。两个投影消费点
  （`packages/provider/src/facades.ts` 的 `projectModelSelectionProviderView` 与
  `packages/services/src/model-provider/offPeakModelSelectionView.ts`）都经它，不允许出现第二条
  selection 序列化路径。
- **执行链不受影响**：真正读明文 `access.apiKey` 的消费者（模型请求装配、CLI doctor 等）拿的是
  `ProviderRegistry` 持有的**类实例** `RegistryProviderConfig`（hydrate 后的内存值），不经过本
  序列化点；本规则只约束发往客户端的视图投影。
- **Settings 视图语义不变**：`ProviderSettingsView` 继续走 `ProviderConfig.toJSON()` 的 P1-5 落盘
  形态（有 ref 出 ref 不出明文；未迁移的明文回退态为表单兼容仍含明文）。本 spec 不改动它。

## 消费点证据（2026-10-08 全仓核查）

`ModelSelectionView.providers[].config` 的全部 UI/services 读取点：

- `packages/ui/src/lib/modelSelectionGroups.ts`：`acodeProviderAccountAccessSchema.safeParse(access)`
  （仅 zhipu-account 事实）+ `shouldShowModelVisionBadge`（仅 `access.type`/`mode`）；
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`：`isApiKeyAccess(access)`（仅 `type` 判断）；
- `packages/ui/src/lib/registryProviderView.ts`：仅 `api.baseUrl`；
- `packages/services/src/official-mcp/officialMcpCredentials.ts`：仅 zhipu-account 事实。

**没有任何代码读取 selection 视图里的 `access.apiKey` 值**（表单回显/保存走 Settings 视图，见
`providerSettingsFormTypes.ts`、`ProviderDraftSave.ts`）。因此剥离明文不需要 `hasApiKey` 布尔替代；
若未来出现「已配置 Key」展示需求，必须以布尔/存在性形式新增字段，不允许回退为明文。

## 接口

- `packages/provider/src/resolver.ts`：`serializeRegistryProviderConfig` 的 api-key 类分支
  （`api-key` / `zhipu-coding-plan-api-key`）不再输出 `apiKey` 与 `credentialRef`；返回类型不变
  （两字段在 `apiKeyAccessDataSchema` 中本就 optional，视图对象仍满足
  `RegistryProviderConfigObject`/`ProviderConfigObject`）。

## 验收场景

见 `packages/provider/test/model-selection-view-apikey-stripping.test.ts`：

1. vault hydrate 后的 BYO provider（内存同时持有 `apiKey` 明文 + `credentialRef`）经
   `createRegistryProviderConfig` → `projectModelSelectionProviderView` 后，序列化结果不含明文、
   不含 ref；`type` 与 `apiKeyManagementUrl` 保留。
2. 未迁移的明文回退态（仅 `apiKey`、无 ref）同样被剥离——selection 视图对任何形态都不发明文。
3. zhipu-account 分支不受影响（`accountType/mode/entitled` 原样保留，供
   `modelSelectionGroups`/`officialMcpCredentials` 消费）。
4. `ModelSelectionFacade.getView()` 产出的完整视图（实际 RPC 载荷面）JSON 序列化后不含明文 Key。
