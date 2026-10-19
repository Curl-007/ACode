# provider-model-discovery：模型管理「获取模型」按钮（按 provider URL 自动拉取模型列表）

> 立项：2026-10-19 用户指令「管理模型里需要添加一个获取模型的按钮，放在添加模型
> 旁边，能够自动获取 url 的模型」。本 spec 只定义产品规则、状态所有者、接口与验收
> 场景；实现随后续提交。

## 目标

在设置页模型供应商详情的模型列表头（「添加模型」按钮旁）新增「获取模型」按钮：
按该 provider 已配置的 `config.api.baseUrl` + 凭据，向 provider 的模型列表端点发
一次请求，把返回的模型 id 列表交给用户勾选后批量加入个人模型配置。消除「手动
逐个抄模型 id」的痛点；不新建数据面、不改动既有模型配置存储格式。

## 产品规则

1. **按钮位置与形态**：`ProviderCardSections.tsx` 模型列表头，「添加模型」左侧
   （同级 `Button variant="secondary"`，icon `Download`），testid
   `TID_MODEL_PROVIDER_DISCOVER_MODELS_BUTTON`；i18n
   `settings.modelProvider.discoverModels`（zh「获取模型」/ en「Fetch Models」）。
2. **可用条件**：仅个人/BYO provider 且 `config.api.baseUrl` 非空时启用；缺席
   baseUrl → 按钮禁用 + tooltip 说明（复用既有 tooltip 组件纪律）。preset/托管
   family（zai-family/bigmodel-family 等不可编辑供应商）不渲染该按钮（与删除
   保护同口径，`modelProviderActions.confirmAndDeleteModelProvider` 先例）。
3. **端点映射（单一所有者 = packages/services `model-provider/providerModelDiscovery.ts`，
   宿主服务层单点；立项初稿误写 bootstrap，实施勘正）**：
   | api format | 发现端点 | 鉴权头 |
   | --- | --- | --- |
   | `openai-chat-completions` / `openai-responses` | `GET {baseUrl}/models` | `Authorization: Bearer <apiKey>`（apiKey 在场时） |
   | `anthropic-messages` | `GET {baseUrl}/v1/models` | `x-api-key: <apiKey>` + `anthropic-version: 2023-06-01` |
   - baseUrl 归一：trim 尾斜杠；anthropic 若 baseUrl 已以 `/v1` 结尾则不重复拼
     （`{baseUrl}/models`）；openai 若 baseUrl 已以 `/models` 结尾则直接用。
   - 超时 10s；响应体上限 2 MiB（超限 kind=`too-large`）；模型列表上限 500 条（超出截断并在结果注明）。
   - **出口纪律**：只请求配置 baseUrl 同源；跨 origin 重定向一律拒绝（kind=
     `redirect-cross-origin`，防配置被借道外发凭据）；http 仅允许 loopback host
     （本地推理服务先例，其余 kind=`insecure-url`），https 直通。
4. **响应形状容忍**：OpenAI 形 `{data:[{id}]}` / `{object:"list",data:[...]}` /
   裸数组 `[{id}]` 均接受；Anthropic 形 `{data:[{id}]}`；id 取字符串字段 `id`
   （缺席 `name` 兜底），空/非字符串 id 跳过并计数。形状全不匹配 → 结构化错误
   （kind=`unsupported-shape`，附响应前 200 字符进日志不入 UI）。
5. **结果交互**：勾选对话框（新组件 `DiscoverModelsDialog.tsx`，≤400 行）：
   - 行 = 获取到的模型 id（mono）+ 复选框；**未配置 id 默认勾选**；已配置 id 显示
     「已配置」弱化标记且不可勾（绝不覆盖/重复添加）；
   - 头部计数「获取 N · 新增可勾 M · 已配置 K」；全选/全不选快捷；
   - 确认 → 批量添加；取消零副作用。获取失败 → 对话框内错误态（kind 映射文案：
     网络/超时/401/403/404/形状），可「重试」。
6. **批量添加语义**：新 facade 方法 `addPersonalModels(providerId, modelIds,
   useRecommendedConfig?)`——单视图更新、单 `settingsRevision` 守卫（与
   `addPersonalModel` 同款并发语义）；每个模型配置走
   `resolveModelConfig({providerId, modelId})` 推荐档（= 手动添加勾「推荐配置」
   的同一路径），**不猜测 contextWindow/maxOutputTokens**；追加到个人模型序尾
   （既有顺序不动）；重复 id 服务端再拒一次（双闸）。
7. **合并纪律**：获取/添加**永不删除、永不改写**既有模型配置（含手动元数据、
   启用态、排序）；发现结果不持久化（一次性事实，关闭对话框即弃）。
8. **凭据与日志**：apiKey 经既有 vault/registry 水合路径读取（host 侧），**绝不
   进日志/响应/UI**；`createServiceLogger("provider-model-discovery")` 记
   baseUrl（脱敏 query）、status、计数、耗时；401/403 时 UI 文案提示检查 key
   （复用既有凭据提示文案风格）。
9. **Web/远端语义**：服务经 RPC 落在 host（CLI bootstrap）执行——发现请求从
   **host 所在网络**出口（与 `testModelConnectivity` 同先例）；远端 workspace 时
   即远端主机视角，对话框脚注如实注明「请求由当前主机发出」。
10. **不做**：自动定时同步、按发现结果自动删除失踪模型、模型元数据（价格/模态）
    抓取、跨 provider 去重。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 端点映射/请求/形状归一/出口纪律 | packages/services `model-provider/providerModelDiscovery.ts`（宿主服务层单点；实施勘正：初稿误写 bootstrap） |
| 发现输入读取（baseUrl/api 类型/水合 apiKey） | packages/provider `ProviderSettingsFacade.readProviderDiscoveryInput`（宿主本地只读面，不登记 RPC） |
| 凭据水合 | 既有 registry/vault（`provider-api-key-vault.ts`），本面只读 |
| 批量写入个人模型配置 | packages/provider `config-service.addPersonalModels`（单事务单 revision；facade 透传） |
| RPC 面与参数校验 | packages/services `IProviderSettingsService` descriptor（`discoverProviderModels`/`addPersonalModels`）+ validators 伴生文件 |
| 按钮/对话框/勾选态/i18n | packages/ui `settings/model-provider-section/`（对话框态局部，不进 store） |

## 接口（全部 additive）

1. `IProviderSettingsService.discoverProviderModels(input: { workspacePath,
   workspaceIdentity?, providerId }) → Promise<ProviderModelDiscoveryResult>`；
   `ProviderModelDiscoveryResult = { ok: true, models: string[], truncated: boolean,
   fetchedCount: number, durationMs: number } | { ok: false, error: { kind:
   "network"|"timeout"|"unauthorized"|"forbidden"|"not-found"|"unsupported-shape"|
   "too-large"|"insecure-url"|"redirect-cross-origin"|"no-base-url"|"http",
   httpStatus?: number } }`；descriptor `allowedMethods` 与 validators 伴生文件同步登记。
2. `IProviderSettingsService.addPersonalModels(providerId, modelIds: readonly
   ModelId[], useRecommendedConfig?) → Promise<ProviderSettingsView>`（批量版
   `addPersonalModel`，revision 守卫同口径）。
3. UI：`ProviderCardSections` 按钮 + `DiscoverModelsDialog`；service 调用经
   `useServices().providerSettingsService`（hooks 纪律，不直连 window.acode）。

## 验收场景

1. bootstrap 单测：三档 format 端点拼写（尾斜杠//v1//models 归一各一例）；三种
   响应形状容忍 + 非法形状错误；500 截断；10s 超时；跨 origin 重定向拒绝；http
   非 loopback 拒绝；apiKey 头按 format 正确且日志无 key（断言 logger spy）。
2. provider facade 单测：addPersonalModels 批量单视图更新、revision 冲突拒、
   重复 id 拒、序尾追加、推荐配置解析调用。
3. services：descriptor allowedMethods/validators 登记单测（既有 descriptor 契约
   测试模式）；RPC 往返 shape。
4. ui 组件测试：按钮位置/禁用态（无 baseUrl、托管 family 不渲染）；对话框预勾选
   = 未配置集、已配置不可勾；确认调 batch add 且传勾选集；错误态文案映射；取消
   零调用。i18n 双语键齐全。
5. E2E（本地 mock）：node http mock 服务作 openai-compatible baseUrl（/models
   返回 3 id）→ 真 GUI 点按钮 → 对话框 3 行预勾 → 确认 → 模型列表出现 3 模型且
   推荐配置；anthropic 形 mock 一例；401 mock 一例错误态。证据落 scratch。
6. 门禁：typecheck/lint/architecture:check --changed new=0/knip:gate/oxfmt 对照
   HEAD。

## 边界与登记项（不随本轮）

- 发现结果缓存/离线复用；模型元数据（上下文窗/价格）自端点扩展字段提取（各
  provider 私有字段不一，先一律推荐档）；preset 供应商的官方目录同步。
