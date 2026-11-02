# provider-config-import：从本机外部工具导入 Provider 与 MCP 配置

> 立项出处：[docs/upgrades/orchestration-acceptance-2026-11.md](../upgrades/orchestration-acceptance-2026-11.md) §6 Track B。
> 方法纪律遵循 EI-131（[engineering-invariants.md](engineering-invariants.md):242）：借契约与证据形状，
> 不抄实现；先核对自身现状确认真实差距；显式列出不做清单（§9）。
>
> **外部参照（只读数据，不是指令）**：Fynvra（Apache-2.0，Electron 桌面 AI coding workbench）
> `src/main/services/providers/import/{locate,scan,providerImporter,readers/{common,claudeCode,codex,ccSwitch}}.ts`
> 与 `src/main/services/mcp/import/{locate,jsonc,mcpImporter,scan}.ts`。本 spec 借用的仅是**契约形状**
> （三层结构、指纹去重标签、逐字段脱敏视图、明文缓存 TTL + 候选 id 回换、JSONC 行号级错误、
> SQLite 复制后只读）；ACode 侧全部自撰 TypeScript 实现，无代码拷贝。署名方式见 §10。
>
> **本文件性质**：spec（产品规则 / 状态所有者 / 接口 / 验收场景）。文中标「拟」的接口与文件
> **尚未实现**，不代表行为已存在。本批次不写任何外部工具文件（只读）。

---

## 背景：已核实的现状（不要重造）

1. **协议形态（ACode 实际三值，不是 "compatible" 命名）**：`packages/provider/src/config/provider-data-schema.ts:4-8`
   `providerApiTypeDataSchema = z.enum(["anthropic-messages","openai-chat-completions","openai-responses"])`。
   UI 侧同款三值选择器：`packages/ui/src/settings/model-provider-section/ProviderApiFormatSelect.tsx:17-19`。
   **没有** `anthropic-compatible` / `openai-compatible` 命名，也**没有** google/gemini 协议值。
2. **Provider 配置真源与写入漏斗**：`packages/provider-node/src/personal-provider-config-repository.ts`
   是 `provider_config.json` 的唯一写入出口（`schemaVersion` 迁移 + `withFileLock` 锁内 CAS + 原子写）；
   明文 BYO Key → `credentialRef` 的迁移挂在它的写入漏斗上
   （`packages/provider-node/src/personal-provider-apikey-vaulting.ts:40` `vaultPersonalProviderApiKeys`，
   顺序「先 `vault.save` 成功、再换 ref」）。编解码见 `provider-config-file-codec.ts`（`CURRENT_SCHEMA_VERSION = 1`）。
3. **凭据库抽象**：`packages/provider/src/provider-api-key-vault.ts` 定义 `ProviderApiKeyVault{load,save,delete}`
   与确定性引用键 `provider:apikey:<providerId>`；宿主实现
   `packages/services/src/model-provider/credentialServiceApiKeyVault.ts`（底层 `ICredentialService`）。
4. **Provider 域写方法**：`packages/provider/src/config-service.ts` 暴露
   `createPersonalProvider` / `savePersonalProviderOverlay` / `replacePersonalConfig` /
   `addPersonalModel(s)`（实现叶 `config-service-provider-ops.ts`、`config-service-model-ops.ts`）；
   `createPersonalProvider` 拒绝 `initialConfig.group`，缺省 `group: "standard-personal"` 且 access 缺省 `ApiKeyAccessConfig`。
5. **宿主服务层 IO 先例**：`packages/services/src/model-provider/providerModelDiscovery.ts` 是「宿主服务层
   单点做网络 IO + 读水合 apiKey + RPC 暴露」的既有先例，spec 见
   `packages/services/specs/provider-model-discovery.md`（其规则 3/6/8/9 与「不新建数据面」纪律直接复用）。
   宿主本地只读面 `ProviderSettingsFacade.readProviderDiscoveryInput(providerId)`（`provider-settings-facade.ts:225`）
   返回 `{baseUrl, apiType, apiKey?}`，**不登记 RPC、不进日志**。
6. **RPC 面与装配**：`packages/services/src/model-provider/providerFacadeServices.ts` 定义
   `IProviderSettingsService`（`ServiceChannels.ProviderSettings = "provider-settings"`，17 个方法，含
   `discoverProviderModels` / `addPersonalModels`），参数校验在伴生文件 `providerFacadeServices.validators.ts`；
   装配与注入见 `providerRuntime.ts:110-120`；注册见 `packages/services/src/node.ts:2717`；
   远端环境同样注册（`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:342`）。
7. **Provider 设置视图与明文边界**：`ProviderSettingsView`（`packages/provider/src/provider-settings-views.ts:177`）
   走 `ProviderConfig.toJSON()` 落盘形态——**有 ref 时无明文，未迁移的「明文回退态」含明文**
   （既有 spec 明文允许：`packages/provider/specs/model-selection-view-apikey-stripping.md` 明确「Settings 视图
   语义不变」，只有 Model Selection 视图无条件剥离）。**导入新增的任何视图不得重开一条明文越界面。**
8. **MCP 真源与写入**：`packages/services/src/mcp-sync/mcpSyncService.ts` 的
   `ACODE_MCP_DESCRIPTOR`（`~/.acode/cli/config.json`，键 `mcp.servers`，工作区 `<ws>/.acode/config.json`）
   与 `AGENTS_MCP_DESCRIPTOR`（`.agents/mcp.json`，键 `mcpServers`）；写入走
   `saveMcpToUserDirectory` → `writeACodeServersToFile`（原子写 + `enable`→`enabled` 一次性迁移）。
   其 candidate/export/import 通道（`listLocalUserMcpCandidates`/`exportMcpServers`/`importMcpServers`，
   来源仅 `acode`/`agents`）是**本地 ⇄ 远端推送**，不是「从外部工具导入」。
9. **既有「外部 Agent 设置导入」**：`packages/services/src/settings-sync/settingsSyncService.ts` 已有
   `SUPPORTED_MCP_AGENT_SOURCES`（12 家：claudeCode/codexCli/openCode/openClaw/qwenCode/qode/qodeCn/
   trae/kiroCli/roo/codeBuddy/agents）、`McpConfigFormat = "mcpServersJson"|"mcpJson"|"codexToml"`、
   `readMcpServersFromSourceFile`（`JSON.parse`/`smol-toml`，**无 jsonc**）与写入器
   `addMcpServerToAcodeConfig`（直接写 `~/.acode/cli/config.json`，**不**做 `enable` 迁移）。
   UI 入口已存在：`packages/ui/src/settings/McpSettingsSection.tsx:54,1216`「导入」按钮 → 类别锁定版
   `McpServersImportDialog`（`ExternalAgentImportDialog.tsx:95`）→ 三步向导
   `selection|importing|complete`。`SettingsSyncCategory` 已含未实现的 `"providers"` 值
   （`packages/shared/src/settings-sync.ts:21`），服务端零实现。
10. **会话历史导入是另一回事**：`packages/services/src/session/external-import/adapters/`（claudeCode/codex/
    cursor/geminiCli/opencode 五家，spec `packages/services/specs/external-session-import-sources.md`）只读
    会话转录，不覆盖 provider/MCP 配置缺口。本批次**只对齐其形状惯例**（来源定位、逐来源失败隔离、
    结构化 skipped/failed、只读外部目录、fixture 自造），不共用实现。
11. **依赖与运行时**：TOML 解析（Codex `config.toml`）在仓库里已有 `smol-toml`
    （根 catalog `smol-toml@1`，`packages/services/package.json:32` 已直接依赖）。SQLite 可用 Node 内建
    `node:sqlite`（Node 24 per `mise.toml`；`apps/acode-cli/packages/adapters/src/storage/**` 已有直连先例），
    **无需新增任何依赖**。ACode 桌面为 Electron + stdio CLI（非 Fynvra utilityProcess）。
12. **治理硬约束**：`architecture-policy.yaml` 全局 `maxFileLines: 400` / `maxContractLines: 300` /
    `maxPublicMethods: 12`，新文件零容忍。`provider`、`provider-node` 为 `managed: true`（严格）；
    `services` 为 `managed: false`（行数只减不增 ratchet）。`packages/services/src/model-provider/
    providerFacadeServices.ts` 当前 341 行——追加方法须复核 400 行上限。
13. **i18n 在 renderer**：`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`（扁平键，如
    `settings.resourceActions.import` 已存在）。**服务层不得产出已翻译文案**（与 Fynvra 的 `translate()`
    做法相反，见 §9）。

---

## 产品规则

### R1 来源清单与字段映射（Provider）

**来源顺序即去重优先级**（`PROVIDER_IMPORT_SOURCES`）：

| # | 来源 | 位置（`home` 可注入） | 格式 | 协议映射 |
| - | ---- | --------------------- | ---- | -------- |
| 1 | Claude Code | `~/.claude/settings.json` | JSON | `anthropic-messages` |
| 2 | Codex | `~/.codex/config.toml` + `~/.codex/auth.json` | TOML + JSON | `wire_api` 映射（见下） |
| 3 | CC Switch | `~/.cc-switch/cc-switch.db` 表 `providers` | SQLite（复制后只读） | `meta.apiFormat` 映射 / 按 `app_type` 兜底 |

**来源 1 · Claude Code**（`settings.json`）

- baseUrl：`env.ANTHROPIC_BASE_URL`（trim，去尾部 `/`；空串视为未填）。
- key：`env.ANTHROPIC_AUTH_TOKEN`，缺席再取 `env.ANTHROPIC_API_KEY`。
- 模型 id：顶层 `model` + `env` 中键匹配 `^ANTHROPIC_(?:DEFAULT_[A-Z0-9_]+_)?MODEL$` 的值；显示名取
  对应 `<键>_NAME`（有则覆盖目录名）。
- **忽略规则**：模型别名 `default|best|fable|opus|sonnet|haiku|opusplan`（仅小写比较；id 先剥 `[..]` 后缀再判）
  一律忽略——别名指向哪个模型取决于端点；id 含空白丢弃；`[..]` 后缀剥离后去重。
- 既无 baseUrl 又无 key（官方账号登录 / 空占位）→ 不产出该来源（正常，不告警）。

**来源 2 · Codex**（`config.toml` + `auth.json`，`env` 由 scan 注入）

- 遍历 `[model_providers.<key>]`：取 `name`（缺省用 key）、`base_url`（**缺席即跳过该条**）、
  `wire_api`（`responses`→`openai-responses`，`chat`→`openai-chat-completions`，其余/缺省→`openai-chat-completions`）。
- key 解析：有 `env_key` → 取注入 `env[env_key]`（**不读全局 `process.env`**）；否则该 provider 表内的
  **字面 bearer token 字段**（`experimental_bearer_token`，别名 `bearer_token`；2026-11-02 本机实配核实，
  见附录 A）→ 直接作为该 provider 的 key；否则 `requires_openai_auth === true` → `auth.json` 的
  `OPENAI_API_KEY`；否则无 key（**不把 OpenAI 的 key 带给不需要它的端点**）。
- 活动项：顶层 `model_provider`（缺省 `openai`）命中的那条 `isCurrent: true`，排序活动项在前；顶层 `model`
  只归属活动项。
- 内置 OpenAI：仅当选中 `openai` 且 `auth.json` 有 `OPENAI_API_KEY` 时产出一条
  （`api: openai-responses`，名 `OpenAI`）。
- `config.toml` 解析失败 → **整个来源跳过** + 一条 `invalid-toml`（含行号，不含原文）；
  `auth.json` 解析失败 → 只丢 key + 一条 `auth-ignored`；`env_key` 未设置 → 保留该 provider（无 key）+ 一条
  `env-missing-key`（用户可在设置页补 key）。

**来源 3 · CC Switch**（`cc-switch.db`，见 R2 的读取方式）

- 读表 `providers` 全列；`app_type` 只认 `claude`/`codex`/`gemini`（大小写不敏感），组序
  `claude → codex → gemini`，组内 `is_current`（SQLite `0/1`，兼容 `true`/`"1"`）在前，其余按行序。
- `claude`：`settings_config` 是 JSON 文本，走来源 1 的同一解析（复用 reader，不写第二份）；
  协议 = `meta.apiFormat` 映射值 ?? `anthropic-messages`。
- `codex`：`settings_config = { auth: <auth.json 对象>, config: <config.toml 文本> }`；两者都空 → 跳过；
  config 文本解析失败 → 该行告警跳过。
- `gemini`：`env.GOOGLE_GEMINI_BASE_URL` + `env.GEMINI_API_KEY || env.GOOGLE_API_KEY`。
  **ACode 无对应协议值 → 该行跳过 + 一条 `unsupported-api-format` 聚合告警**（EI-1 不静默；不新增第四种协议，EI-146）。
- `apiFormat`：`anthropic`→`anthropic-messages`，`openai_responses`→`openai-responses`，
  `openai_chat`→`openai-chat-completions`，认不出 → 按 `app_type` 兜底。
- `settings_config` 非法 JSON → 该行 `config-invalid-json` 告警跳过（单行坏不整源放弃）；
  `app_type` 不在白名单（`claude-desktop`/`opencode`/`hermes` 等）→ 聚合为一条 `unsupported-app-type`（含计数）。

### R2 三层结构与包落点（裁决）

三层职责（沿用借用形状）：

```
locate.ts   只做 IO：给出各来源的候选路径 + 把原始内容读出来（文本 / 数据库行）。
            文件不存在返回 null（没装这个工具不是问题）；其它读错误向上抛，由 scan 记成该来源的 warning。
readers/*   纯函数：原始内容（文本/行）+ 注入 Env → DiscoveredProvider[] + warnings。
            不碰文件系统、不读 process.env、不写日志；坏内容返回空并记 warning（只给位置，不带原文）。
scan.ts     编排：并行读取各来源 → 逐条校验 → 指纹去重 → 逐字段构造脱敏视图 → 单槽缓存。
```

**裁决：locate / readers / scan / 候选缓存全部落 `packages/services/src/model-provider/provider-import/`**
（宿主服务层单点），而不是 `packages/provider-node`。理由（按证据强弱排序）：

1. **与既有先例同形**：`providerModelDiscovery.ts` 就是「宿主服务层做 IO（网络）+ 读水合 apiKey + RPC 暴露」
   的单点先例，其 spec 明写「端点映射/请求/形状归一/出口纪律」归 `packages/services/src/model-provider/`。
   导入的外部文件读取是同一形态（读、不写、结果经 RPC 给 renderer）。
2. **`provider-node` 的职责边界**（`packages/provider-node/src/CONTRACT.md`）：它是「Provider 配置域的
   Node.js 运行时物化层」——ACode Builtin 源/下载/缓存/远程同步、Personal 配置文件仓库与编解码、Config/Registry
   运行时组装与运行时路径解析。**读取第三方工具配置文件不在其声明职责内**；塞进去会（a）需要为 reader 新增
   公开入口（EI-146 接口面克制），（b）需要新增 `smol-toml` 依赖（该包现无 TOML 依赖），（c）需要同步
   architecture-policy 的 `provides`/`publicEntrypoints`（`provider-node` 是 `managed: true` 严格模块）。
3. **明文位置**：明文 key 的缓存（TTL）与 RPC 面都在宿主服务层；把读取放 `provider-node` 会迫使
   明文跨模块入口传递，并把「导入候选缓存」这个纯宿主态放进物化层。
4. **写入路径不因此分叉**：无论读取在哪，写入都必须经 `ProviderSettingsFacade`（见 R6），
   `provider_config.json` 的**唯一写入漏斗仍在 `provider-node`**（repository + vaulting）。读在 services、
   写在 provider-node，符合「一个语义一份实现」。

**替代方案（Track B 原文：`provider-node` 新增 external-import 域）**：仅当要求「无 services 装配
（纯 CLI）也能导入」时才需要下移。本批次不需要。若主 agent 采纳替代方案，则须同步的
architecture-policy 变更为：

- `packages/provider-node/src/module.ts` 与 `architecture-policy.yaml` 的 `provider-node` 条目：
  `provides` 追加（如 `provider-external-import`），`publicEntrypoints` 追加新的公开入口文件；
- `packages/provider-node/package.json` 新增 `smol-toml`（Codex TOML）；根 catalog 已固定 `smol-toml@1`；
- `packages/provider-node/src/CONTRACT.md` 增补该域的职责与状态所有权；
- 若新公开入口多于一个文件，需同步 `contract.ts` 转发视图。

**主路径（services）需要的 policy 变更：无**。`services` 是 `managed: false`，新增文件只受
`maxFileLines: 400` 的「新增超限即失败」ratchet 约束；不新增跨模块依赖（services → `@acode/provider`
包根、`@acode/shared` 子路径均为既有合法面）。唯一需复核的存量文件是
`providerFacadeServices.ts`（341 行，见 R5）。

### R3 指纹与去重

- **指纹**：`providerImportFingerprint(input) = sha256(normalizeBaseUrl(baseUrl) + "\n" + (apiKey ?? ""))`，
  `normalizeBaseUrl` = trim + 去尾部 `/`（**不做**路径大小写折叠，路径大小写敏感）。sha256 只为让
  指纹可比较、可日志（**日志只允许短摘要，不得打印输入明文**）。
- **已有项**：对当前环境的个人 provider 逐个调宿主本地只读面
  `ProviderSettingsFacade.readProviderDiscoveryInput(providerId)`（水合后的 baseUrl/apiType/**apiKey**），
  算指纹。该读取**不登记 RPC、不进日志**，明文不出宿主。`baseUrl` 缺席的已有项跳过（无法比对）。
- **候选间**：按 `PROVIDER_IMPORT_SOURCES` 顺序，同一指纹首次出现者为准；其后命中的标注。
- **标签**：`duplicate: "existing" | "candidate"` + `duplicateOf`（由 `existing` 时给已有 providerName、
  `candidate` 时给先出现的 `sourceLabel`）。**去重标签是建议不是门禁**——用户仍可导入重复项
  （Fynvra 同为建议语义）；UI 默认不勾选重复项（见 R8）。
- **模型 id**：候选内按「剥 `[..]` 后缀后 trim、去空、去重」；与已有 provider 的去重**不**按模型，
  只按 provider 指纹。

### R4 脱敏视图契约与凭据硬约束

**候选视图（给 renderer，逐字段构造，绝不 `...input` 后再删 key）**：

```ts
interface ProviderImportCandidateView {
  id: string;                 // randomUUID，扫描时发出；导入时按此回换缓存
  source: ProviderImportSource;
  sourceLabel: string;        // 如 "Codex · <name>"、"CC Switch · <name>"
  name: string;               // 导入后的 provider 显示名（截断到 MAX_PROVIDER_NAME_CHARS）
  api: ProviderApiType;       // 三值之一
  baseUrl?: string;           // 非 secret，可展示
  models: { id: string; name: string }[];  // 只投影 id/name（元数据可选，不含任何凭证）
  hasApiKey: boolean;
  apiKeyHint?: string;        // 仅末 4 位；见下
  isCurrent: boolean;         // 来源里「当前在用」
  duplicate?: "existing" | "candidate";
  duplicateOf?: string;       // 名称或 sourceLabel
}
```

- `apiKeyHint` 规则：明文长度 ≥ 12 时取 `••••` + 末 4 位；长度 < 12 时只给 `••••`（不给任何可拼接片段）。
  全仓库**只有一处**实现（`providerImportApiKeyHint`），UI 不另写第二份（EI-2）。
- **逐字段构造是唯一收口点**：扫描产出的 view 由单一函数 `toCandidateView(discovered, labels)` 构造；
  负向验收断言 `Object.keys(view)` 不含 `apiKey`、`JSON.stringify(view)` 不含明文（§8 N1/N5）。
- **明文只在宿主内存且只有一条链路**：
  `reader → scan 的内部 input → 候选缓存（TTL）→ 导入写入（经写入漏斗）→ vault → 明文从内存释放`。
  明文的**唯一落盘点是 vault**（`credentials.json`），`provider_config.json` 只留 `credentialRef`。
- **禁止出现明文的四个面**：IPC 返回值（scan/import 的 RPC 结果）、任何视图、日志（含 debug）、导出
  （provider 配置导出 / 结果清单）。§8 给出可测断言。
- **本 spec 的边界（事实澄清）**：`ProviderSettingsView` 的「明文回退态」按既有 spec 允许含明文，
  本 spec **不**把它纳入断言范围；断言对象仅限导入新增的视图/结果/日志/导出。
- **凭据来源硬约束**：只从注入的 `Env`（宿主 `process.env`，由 scan 传给 reader）或凭据服务（vault）读取。
  源码、示例、fixture、测试断言里**不得出现可用凭据字面量**；所有 fixture key 一律合成
  （如 `test-anthropic-token-XXXX`），并加一条源码扫描断言（§8 N11）。

### R5 扫描 / 导入的 RPC 面与结构化结果（additive）

面落 `ServiceChannels.ProviderSettings`（`IProviderSettingsService` 新增两个方法，**参数无
`workspacePath`/`workspaceIdentity`**——provider 配置是环境级而非工作区级，与 `getView()` 同口径）：

```ts
interface IProviderSettingsService {
  // ...既有 17 个方法不变
  scanProviderImports(input?: { sources?: ProviderImportSource[] }): Promise<ProviderImportScanResult>;
  importProviderCandidates(input: { candidateIds: string[] }): Promise<ProviderImportResult>;
}

type ProviderImportSource = "claude-code" | "codex" | "cc-switch";

type ProviderImportScanResult =
  | { ok: true; candidates: ProviderImportCandidateView[]; warnings: ProviderImportWarning[] }
  | { ok: false; error: ProviderImportError };

type ProviderImportResult =
  | { ok: true; imported: ProviderImportImportedItem[]; skipped: ProviderImportSkippedItem[] }
  | { ok: false; error: ProviderImportError };

interface ProviderImportImportedItem { id: string; providerId: string; name: string; modelIds: string[] }
interface ProviderImportSkippedItem { id: string; name: string; reason: string }

interface ProviderImportWarning { code: ProviderImportWarningCode; params: Readonly<Record<string, string | number>> }
type ProviderImportErrorCode =
  | "invalid-args" | "scan-stale" | "candidate-missing" | "scan-failed" | "write-failed";
interface ProviderImportError { code: ProviderImportErrorCode; params?: Readonly<Record<string, string | number>> }
```

- **结构化不翻译**：服务层只回 `code + params`；zh/en 文案由 renderer 在
  `packages/ui/src/i18n/locales/*.ts` 映射（EI-2：文案单一真源在 i18n 文件）。这与 Fynvra 在 Main 里
  `translate()` 的做法相反，是 ACode 的既有分工，属有意差异（§9）。
- **单来源失败隔离**：各来源并行读取，单个来源（或它的一个文件）失败只产生**该来源的一条 warning**
  （`source-read-failed` / `invalid-json` / `invalid-toml` / `no-table` / `db-read-failed` …），不影响其它来源
  （`Promise.all` + 逐来源 `catch`，与 external-import 的 allSettled 语义同款）。
- **缓存**：服务实例内**单槽**缓存最近一次扫描的 `{expiresAt, byId}`（`byId` 持内部 input，含明文）；
  `scanProviderImports` 重置缓存（`cache = null` 先于扫描）；`importProviderCandidates` 按候选 id 回换。
  过期（`now() >= expiresAt`）或候选缺失 → `scan-stale` / `candidate-missing`，**不写任何文件**。
  `now` 可注入（EI-121 固定时钟测试）。
- **参数校验**（descriptor 边界 + 服务内二次）：`sources` 必须是非空、全为合法枚举的数组
  （去重后仍非空）；`candidateIds` 必须是非空、全为 UUID 的数组、长度 ≤ `MAX_CANDIDATE_IDS`；否则 `invalid-args`。
  不在 allowedMethods 的方法不可达（descriptor 唯一公开表）。

### R6 导入的写入路径（单事务，唯一漏斗）

**裁决：新增一个批量、单事务的导入写方法**，而不是「对每个候选依次 `createPersonalProvider` +
`addPersonalModels`」（后者每个 provider 两条 revision，中途失败留下半成品 provider——违反 EI-12/EI-40）。

落点（additive，provider 域）：

- `packages/provider/src/config-service-provider-ops.ts` 新增 `importPersonalProviders(context, inputs)`
  （该文件现 192 行；若接近 400 则拆新叶 `config-service-import-ops.ts`），`ProviderConfigService` 增同名方法，
  `ProviderSettingsFacade` 增 `importPersonalProviders(input)`，facade 的 mutation target 与
  `IProviderSettingsService` 透传。
- 入参（每条候选）：

```ts
interface ProviderImportInput {
  providerName: string;
  api: { type: ProviderApiType; baseUrl: string };
  apiKey?: string;                  // 明文；由写入漏斗搬到 vault
  modelIds: readonly string[];
  useRecommendedConfig?: boolean;    // 缺省 true
}
```

- **行为（单个 `updatePersonal` transform 内）**：
  - 逐条用 `nextPersonalProviderId(occupied, undefined)` 生成 id、`nextPersonalProviderLabel(seed, providers)`
    生成唯一名（重名自动加后缀——既有行为）；
  - 建 rule：`config = new ProviderConfig({ api: new ProviderApiConfig({type, baseUrl}), access: new ApiKeyAccessConfig({apiKey}) })`
    （**不带 group**，`createPersonalProvider` 既有约束；落盘 group 由缺省 `standard-personal` 补齐）；
  - `personalModelIds`/`modelOrder` 追加候选模型；模型规则 `models.setExact(providerId, modelId, new ModelConfig({enabled:true}), useRecommendedConfig)`；
  - 已存在的 model id（同 provider）**跳过该 id 并记入该条 skipped 备注**，不抛异常中断整批；
  - 整个事务失败 → `{ok:false, code:"write-failed"}`，**未写任何内容**（EI-11「明确未执行」，可安全重试）。
- **vault 迁移不在导入路径里**：导入只把明文塞进 `ApiKeyAccessConfig.apiKey`；明文→`credentialRef`
  由 `provider-node` repository 的写入漏斗（`vaultPersonalProviderApiKeys`）统一迁移。导入**不得**预先
  调 `vault.save`（会与漏斗重复写、并可能造成引用悬空）。
- **模型元数据诚实**：目录内模型走 `useRecommendedConfig` 推荐档；目录外的模型**不编造**
  `contextWindow`/`maxOutputTokens`（EI-9）——落成最小 `{enabled:true}` 由规则层补其可推导部分，其余在设置页
  以 `issues` 呈现「需要配置」而非假装精确。
- **按协议补默认模型**：候选未带模型时，按 `api` 取内置目录里首个同协议模板（对齐 Fynvra
  `withDefaultModels` 语义；`openai-chat-completions` 无内置模板则保持为空）。

### R7 MCP 导入面与 mcp-sync 的整合

**裁决（修正 Track B 原文落点）**：ACode **已有**「从外部 Agent 导入 MCP」的完整面
（settings-sync + `McpSettingsSection` 导入按钮）。因此新增来源应**扩展既有 MCP 来源表**，
而不是在 `mcp-sync` 再造一套 reader（否则同一批文件出现第二份读取实现，违反 EI-2）。

1. **来源扩展**（`packages/services/src/settings-sync/`）：`SUPPORTED_MCP_AGENT_SOURCES` 追加
   - `cursor`：`~/.cursor/mcp.json`（`mcpServers`）；
   - `gemini`：`~/.gemini/settings.json`；
   - `vscode`：win `%APPDATA%/Code/User/mcp.json` 与 `Code - Insiders`；mac `~/Library/Application Support/Code/User/mcp.json`；
     linux `$XDG_CONFIG_HOME/Code/User/mcp.json`（沿用 Fynvra `locateMcpSources` 的平台分支形状）；
   - `opencode`（已有）：补 `opencode.jsonc` 候选与 JSONC 解析；
   - `cc-switch`：`~/.cc-switch/cc-switch.db` 表 `mcp_servers`（复制后只读，与 provider 侧同一 `readCcSwitchRows` 机制）。
2. **格式扩展**：`McpConfigFormat` 追加 `"jsonc"`（解读为「先按 JSONC 去注释/尾逗号、再按 `mcpServers` 或
   `mcp` 归一」，按来源决定包装键）；`readMcpServersFromSourceFile` 增 JSONC 分支
   （解析契约见 R7.5）。来源的包装键沿用既有 `readWrappedMcpServers`/`readOpenCodeMcpServers`。
3. **单一写入漏斗**：外部来源导入的 MCP server 必须经 **`mcp-sync` 的写入漏斗**落盘——
   `ACODE_MCP_DESCRIPTOR` 路径解析 + `writeACodeServersToFile`（原子写 + `enable`→`enabled` 迁移），
   即调用 `saveMcpToUserDirectory` 的 `upsert` 语义（或把该写入抽成 mcp-sync 导出的可复用 helper，
   由 settings-sync 消费）。**禁止**继续走 settings-sync 自己的 `addMcpServerToAcodeConfig`（它是第二条
   writer，且缺 `enable` 迁移）——这是本次一并收敛的既有债。
   `~/.acode/cli/config.json` 的 `mcp.servers`（用户级）与 `<ws>/.acode/config.json`（工作区级）仍是
   **唯一 MCP 配置真源**；导入不新建任何 MCP 存储。
4. **去重**：按既有名称键归一（`normalizeMcpServerNameKey` 语义）+ 目标 scope 下已有名称；已存在的
   server 标 `importable:false` + `skipReason`（不改写、不覆盖）。
5. **JSONC 解析契约**（借用形状，自撰实现）：去掉字符串外的 `//`、`/* */` 注释与尾逗号（注释换等长空白、
   保留换行），再 `JSON.parse`；出错**只给行号**（`{ok:false, line?}`），错误文本**不含原文片段**
   （原文里可能有 env/header 凭证）；空文本视为 `undefined`（无内容）。
6. **变量引用不展开**：`${VAR}`（通用）、`${input:…}`（VS Code）、`{env:VAR}`/`{file:…}`（OpenCode）
   原样保留；产生一条**只含键名、不含值**的 warning（`variable-reference`；env 键、header 键、
   args、url 分别标位置）。
7. **明文面边界**：MCP 的 `env`/`headers` 值在 ACode 现状下**本就**随 MCP 设置视图/候选进入 renderer
   （既有契约，非本批次引入，也不在本批次改造）。**R4 的凭据硬约束只适用于 Provider API Key**；
   MCP 侧本次只要求：新增 warning 与日志**不得**带 env/header 的值，只带键名。

### R8 UI 向导（Provider 导入）

- **入口**：`ModelProviderSection` 页头。`SettingsResourceHeaderActions`（
  `packages/ui/src/settings/SettingsResourceHeaderActions.tsx`）**已支持** `onImport`/`importActionId`
  （标签 `settings.resourceActions.import`「导入」），只需给 `ModelProviderSectionLayout`
  （`SectionLayout.tsx:57-64`）补 `importLabel`/`onImport` 两个 prop，并在 `ModelProviderSection.tsx:1066` 附近接线；
  `importActionId="settings.modelProvider.import.open"`，新增 shared testid
  `TID_MODEL_PROVIDER_IMPORT_BUTTON`（与 `TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON` 同处）。
- **对话框**：新 `packages/ui/src/settings/model-provider-section/ProviderImportDialog.tsx`（≤400 行）；
  纯决策与步骤拆到子目录 `provider-import/`：
  `providerImportModel.ts`（选择键编解码、勾选态、结果规整、错误归一——纯函数）、
  `useProviderImportState.ts`（步骤与请求状态）、`ProviderImportSourcePicker.tsx`、
  `ProviderImportCandidateList.tsx`、`ProviderImportResultList.tsx`（都 ≤400 行）。
  步骤沿用既有导入向导三步形态：`sources`（来源勾选）→ `scanning` → `preview`（候选 + 去重标记 + 勾选）
  → `importing` → `result`。
- **服务访问**：经 `useServices().providerSettingsService`（`packages/ui/src/hooks/`），组件不直连
  `window.acode`、不直连服务实现（`IPlatformService` 边界）。**向导状态是组件局部态**（进 store 会与
  「服务端事实」混淆，AGENTS.md：UI 局部状态不应被误当作服务端事实）。
- **来源勾选**：默认全选；每条显示来源名与其本机路径（路径来自静态映射表——渲染侧可只显示
  `~` 形式标签，实际路径由服务定位，UI 不拼路径）。
- **预览列表**：每行 = 名称 + 来源标签 + 协议（用 `ProviderApiFormatSelect` 的同款三值文案）+ baseUrl +
  key 状态（有 key 时显示 `apiKeyHint`，无 key 显示「未检测到 Key」）+ 模型数；重复项显示徽标
  （`existing`「已存在：<名>」/ `candidate`「与 <来源> 重复」），**默认不勾选**，提供「全部勾选/全不选」。
- **结果反馈分级**（EI-98~101）：逐项结果（imported/skipped，附原因）走**对话框内列表**；仅在终态成功/失败
  的**摘要**用一次 toast（「已导入 N 个供应商」/「导入失败：<原因>」）；来源 warning 作为**对话框内**的
  一处告警区（聚合展示，不逐条 toast）；「未发现任何来源」不是错误——空态给出各来源路径说明与「重新扫描」出路。
- **诚实环境语义**（EI-9）：服务在当前环境（本地 host 或远端 host）执行；对话框须显式说明
  「从**当前主机**扫描外部工具的本地配置」（远端 workspace 时即远端主机）——与
  `provider-model-discovery` 规则 9（请求从 host 网络出口并脚注注明）同款。
- **i18n**：新增键统一前缀 `settings.modelProvider.import.*`（zh-CN 与 en-US **同批**提交，EI-107）。
- **失败态**：`invalid-args`（不出现于正常交互）/ `scan-stale`（提示重新扫描）/ `candidate-missing`（局部放弃该项）/
  `scan-failed` / `write-failed`（保留预览，允许重试；明确「未写入任何内容」）。

### R9 有界资源与日志（EI-6 / 日志纪律）

- 读取上限：单个配置文件文本 ≤ `MAX_FILE_TEXT_BYTES`（超限 → 该文件 `file-too-large` 告警并跳过，
  不整源放弃）；单个 SQLite 副本 ≤ `MAX_DB_COPY_BYTES`（超限 → 该来源 `db-too-large` 告警跳过）。
- 候选上限：单次导入 ≤ `MAX_CANDIDATE_IDS`；扫描产出候选数 ≤ `MAX_SCAN_CANDIDATES`（超出截断并给
  `candidates-truncated` 告警——不静默丢弃）。
- 缓存单槽、TTL 明确（无界缓存禁止）。
- 日志：`createServiceLogger("provider-import")`。`info` = 扫描/导入生命周期（来源名、候选数、
  导入计数、耗时）；`warn` = 单来源读取失败；`debug` = 原始解析诊断（生产不落盘）。
  **日志只允许**：来源名、文件路径（不含 query）、计数、短指纹摘要（前 8 位）、错误 code；
  **禁止**：apiKey、`credentialRef` 之外可反推明文的值、配置文件原文片段。

---

## 状态所有权

| 事实 | 所有者 | 生命周期 |
| ---- | ------ | -------- |
| 外部工具的本地配置文件 / 数据库 | 外部工具（**只读**） | 外部 |
| `DiscoveredProvider`（含明文 key） | 单次 scan 产物，宿主内存 | 单次调用 |
| 候选脱敏视图 | RPC 返回载荷 | 一次扫描 |
| 明文候选缓存（`byId` + TTL） | `provider-import` 服务实例单槽（宿主内存） | ≤10 min / 直到下次扫描 |
| `provider_config.json` | `provider-node` repository（**唯一写入漏斗**） | 持久 |
| API Key 明文真值 | vault（`credentials.json`，`ICredentialService`） | 持久 |
| MCP 配置真源 | `~/.acode/cli/config.json`（`mcp.servers`）/ `<ws>/.acode/config.json` / `.agents/mcp.json` | 持久 |
| MCP 写入漏斗 | `mcp-sync`（`saveMcpToUserDirectory` → 原子写 + 迁移） | — |
| 向导步骤 / 勾选 / 预览态 | `ProviderImportDialog` 组件局部 | 对话框打开期间 |

**不变量**：

- 全程对外部来源目录 / 数据库**只读**（SQLite 只读副本，绝不写源库）；
- `provider_config.json` 只有一条写入路径（repository 漏斗）；MCP 配置只有一条写入路径（mcp-sync 漏斗）；
- 明文 key 的唯一持久落点是 vault；renderer 侧永不可得明文（除既有的 `ProviderSettingsView` 明文回退态）；
- reader 无共享可变状态（纯函数 + 每次调用新建解析上下文）。

## 所有者与事件顺序

```
renderer（ProviderImportDialog：步骤/勾选/预览/结果 局部态）
  │ scanProviderImports({sources?})
  ▼
IProviderSettingsService.providerSettings（当前环境 host：本地或远端）
  │ scanProviderImports：cache=null
  ▼
provider-import/scan.ts ──并行──▶ locate.ts（只读：readTextIfExists / readCcSwitchRows 复制副本）
  │                                  │
  │                                  ▼ readers/*（纯函数，注入 Env）→ DiscoveredProvider[]（含明文）
  │◀── warnings（逐来源隔离）────────┘
  │ 逐条校验 + 指纹去重（readProviderDiscoveryInput 读已有项，水合 key）
  │ 构造脱敏视图（逐字段）；写单槽缓存 {expiresAt, byId(input 含明文)}
  ▼
renderer：候选视图 + warnings（无明文）
  │ 用户勾选 → importProviderCandidates({candidateIds})
  ▼
IProviderSettingsService.importProviderCandidates
  │ 缓存校验（过期/缺失 → scan-stale / candidate-missing，零写入）
  ▼
ProviderSettingsFacade.importPersonalProviders（provider 域，单事务）
  ▼
config-service-provider-ops.importPersonalProviders → updatePersonal(transform)（单 revision）
  ▼
NodePersonalProviderConfigRepository.update（文件锁 CAS → 明文→credentialRef 迁移 → 原子写 provider_config.json）
  ▼
ProviderRegistryService.refresh → ProviderSettingsView / ModelSelectionView → renderer 结果列表
  （MCP 分支：settings-sync reader → mcp-sync 写入漏斗 → ~/.acode/cli/config.json）
```

---

## 常量

| 常量 | 值 | 出处 |
| ---- | -- | ---- |
| `IMPORT_CACHE_TTL_MS` | `10 * 60_000` | R5（明文缓存 TTL） |
| `MAX_CANDIDATE_IDS` | `500` | R5 / R9 |
| `MAX_SCAN_CANDIDATES` | `500` | R9 |
| `MAX_FILE_TEXT_BYTES` | `2 MiB` | R9 |
| `MAX_DB_COPY_BYTES` | `256 MiB` | R9 |
| `MAX_PROVIDER_NAME_CHARS` | `128` | R4（与 provider 域名称上限对齐，实施时取真源） |
| `CANDIDATE_ID_PATTERN` | UUID v4/任意 UUID | R5 |
| `PROVIDER_IMPORT_SOURCES` | `["claude-code","codex","cc-switch"]` | R1（顺序 = 去重优先级） |

## 接口（全部 additive，无破坏性变更）

**services · `packages/services/src/model-provider/provider-import/`（新目录）**

- `locate.ts`：`locateProviderImportSources(home)`、`readTextIfExists(path)`（去 BOM）、
  `readCcSwitchRows(dbPath, tempRoot?)`（复制 `-wal`、`node:sqlite` 只读、`sqlite_master` 校验表、删副本）。
- `readers/common.ts`：`DiscoveredProvider`、`ReaderResult`、`Env`、`text`、`parseJsonObject`、
  `parseTomlObject`、`baseUrlOf`、`modelEntries`（`modelEntries`/`baseUrlOf` 为纯函数，单一实现）。
- `readers/claudeCode.ts`：`readAnthropicSettings(settings)`、`readClaudeCode(source)`。
- `readers/codex.ts`：`readCodexConfig(config, auth, env, defaultApi?)`、`readCodex({config, auth, env})`。
- `readers/ccSwitch.ts`：`readCcSwitch(rows, env)`。
- `scan.ts`：`scanProviderImports(sources?, options)`、`isProviderImportSource`、
  `providerImportApiKeyHint`、指纹函数（`providerImportFingerprint`）。
- `providerImporterService.ts`：`createProviderImportService(deps)`（单槽缓存 + 两个 RPC 方法实现）。
- `providerImportTypes.ts`：`ProviderImportSource`、视图/结果/warning/error 类型（R4/R5）。

**services · `providerFacadeServices.ts` / `providerFacadeServices.validators.ts`**：`IProviderSettingsService`
追加 `scanProviderImports` / `importProviderCandidates` + `allowedMethods` + 参数校验（**追加后复核
`providerFacadeServices.ts` ≤400 行**；超限则把两个方法搬进新的 descriptor 伴生文件并在原文件转发）。

**provider · `config-service-provider-ops.ts`（或新叶 `config-service-import-ops.ts`）**：
`importPersonalProviders(context, inputs)`；`config-service.ts` / `provider-settings-facade.ts` /
`provider-settings-views.ts` 增对应透传与方法签名。

**services · `settings-sync/settingsSyncService.ts`**：`SUPPORTED_MCP_AGENT_SOURCES` 追加
cursor/gemini/vscode/cc-switch；`McpConfigFormat` 追加 `"jsonc"`；`readMcpServersFromSourceFile` 增 JSONC 分支；
MCP 落盘改经 mcp-sync 写入漏斗；`jsonc.ts`（新，纯函数）落在 `settings-sync/` 或 `mcp-sync/`（二者取一，
由主 agent 依 Q1/Q2 裁决，不得两处都有）。

**services · `mcp-sync/mcpSyncService.ts`**：导出可复用的「按 descriptor 归一 + 原子写 + 迁移」写入 helper
（供 settings-sync 消费），或将该写入保持为唯一漏斗并由 settings-sync 经其接口调用。

**ui · `packages/ui/src/settings/model-provider-section/ProviderImportDialog.tsx` +
`provider-import/*`（R8）**：新组件 ≤400 行/文件；`SectionLayout.tsx`/`ModelProviderSection.tsx` 接线；
shared 增 testid；i18n zh-CN/en-US 同批。

---

## 架构与实施约束

- 新文件 ≤400 物理行（`architecture-policy.yaml` 全局，新文件零容忍）；`providerFacadeServices.ts`、
  `config-service-provider-ops.ts` 等存量文件追加后须复核上限。
- 异步文件 IO（`node:fs/promises`），不阻塞；`node:sqlite` 的 `DatabaseSync` 只在短时读副本内同步使用
  （与 Fynvra 同形态），且必须 `finally` 关闭 + 删副本（删失败只告警，不影响已读结果）。
- 跨包只用公开入口：services → `@acode/provider` 包根 / `@acode/shared` 子路径；ui →
  `@acode/services` / `@acode/shared`。不 deep import 内部文件。
- 不新增依赖（TOML 复用 `smol-toml`；SQLite 用 `node:sqlite` 内建）；不改锁文件。
- 消息/日志语言：标识符英文、注释中文，注释解释「契约与限制」，不解释逐行行为。
- 不与 `session/external-import` 合并实现（不同域、不同产物）：只对齐形状惯例（逐来源失败隔离、
  结构化 skipped、只读外部目录、自造 fixture）。
- 测试落 `packages/services/tests/provider-config-import.test.mjs`（fixture 文件树 + 合成凭据）与
  `packages/provider/test/`（`importPersonalProviders` 单事务行为）。

## 验收场景

正向（`packages/services/tests/provider-config-import.test.mjs`，fixture 全合成）：

1. **Claude Code**：合成 `~/.claude/settings.json`（含 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` +
   `model` 与 `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`）→ 1 个候选，`api="anthropic-messages"`，
   别名 `sonnet` 被忽略、`[1m]` 后缀剥离、显示名取 `*_NAME`。
2. **Codex**：合成 `config.toml`（两个 `[model_providers.*]`，一个 `wire_api="responses"` + `env_key`，
  一个 `requires_openai_auth=true`）+ `auth.json` → 协议分别 `openai-responses`/`openai-chat-completions`，
   活动项在前，`env_key` 未设置的 provider 保留 + `env-missing-key` 告警。
3. **CC Switch**：合成 SQLite 库（`providers` 表 3 行：claude/codex/gemini）→ claude/codex 产出候选、
   gemini 跳过 + `unsupported-api-format` 告警；`is_current=1` 行在同组内排前；`apiFormat` 决定协议。
4. **只读副本**：扫描后源库文件字节不变；临时目录被删除（断言 `existsSync(tempDir)` 为 false 或捕获
   `rm` 调用）；`-wal` 被复制（存在时）。
5. **去重**：两个来源产同一 `baseUrl+key` → 后者标 `duplicate:"candidate"`（`duplicateOf` 为前者来源标签）；
   与已有 provider 同指纹 → `duplicate:"existing"`。
6. **单事务写入**：导入 2 个候选后，`provider_config.json` 的 `revision` 只变一次；文件中该两个 provider 的
   `access` 只有 `credentialRef`（无 `apiKey` 明文），且 vault 中存在对应条目。
7. **模型配置诚实**：目录内模型得到推荐档；目录外模型的 provider 仍创建，其模型在设置视图中带
   `issues`（「需要配置」），且**未**伪造 `contextWindow`。
8. **来源失败隔离**：一个来源目录不可读（chmod/桩错误）→ 其它来源候选完整 + 恰一条该来源 warning，
   `ok:true`。
9. **Env 注入**：reader 通过注入的 `Env` 取 Codex `env_key`；临时改 `process.env` 不影响 reader 结果
   （断言 readers 不读全局 env）。
10. **MCP（R7）**：新增 cursor/gemini/vscode/opencode.jsonc/cc-switch 各最小 fixture → 各自候选；
    JSONC 含注释与尾逗号可解析；导入落 `~/.acode/cli/config.json` 的 `mcp.servers`，且 `enable` 旧字段被迁移；
    变量引用 `${VAR}` 原样保留 + 只带键名的 warning。
11. **UI**：入口按钮（testid）、来源勾选、预览（去重徽标默认不勾）、导入结果列表；zh/en 两个 locale 均含新键。

负向（硬门槛，与正向同批）：

- **N1** 合成明文 key 不出现在 `scanProviderImports` 的 `ok:true` 结果 JSON 中（对返回值整体
  `JSON.stringify` 后断言不含该字面量）。
- **N2** 同上，但针对 `importProviderCandidates` 返回值。
- **N3** 捕获 `createServiceLogger("provider-import")` 的全部日志（含 debug），断言不含明文 key 与
  源文件原文片段（只允许路径/计数/短摘要）。
- **N4** provider 配置导出与 MCP 导出结果不含明文 key。
- **N5** 视图对象 `Object.keys(view)` 不含 `apiKey`；`apiKeyHint` 长度 ≥12 时只含 `••••` + 末 4 位。
- **N6** 未勾选的来源其文件**不被读取**（fs spy：对未选来源路径零 `readFile`）。
- **N7** `cc-switch` 的 gemini 行不产生候选，且产生 `unsupported-api-format` 告警（不静默）。
- **N8** 缓存过期后 `importProviderCandidates` 返回 `scan-stale`，且 `provider_config.json` 的 mtime/内容不变。
- **N9** 未知 `candidateIds` → `candidate-missing`，零写入。
- **N10** 扫描全程不写外部工具文件/数据库（源库与 fixture 目录内容与 mtime 不变）。
- **N11** 仓库源码/fixture 扫描断言：测试与 fixture 目录中无可用凭据字面量（合成 key 前缀统一，
  断言不存在真实前缀形态）；`grep` 型断言 + 人工复核记录。
- **N12** 参数边界：`sources: []`、`sources` 含非法值、`candidateIds: []`、超 500 项、非 UUID → `invalid-args`，
  且未触发任何读取或写入。
- **N13** MCP 变量引用的 warning 只含键名，不含值（断言 warning params 中无 fixture 值）。
- **N14** JSONC 解析失败的错误只给行号，错误消息不含原文片段（含凭证行的 fixture 断言）。

## 未做与取舍（EI-131 强制要求）

1. **不搬 Fynvra 的 i18n-in-Main**：ACode 文案真源在 renderer i18n 文件，服务层只回
   `code + params`，无 `translate()`。
2. **不搬 Fynvra 的 Electron Main / utilityProcess / `importers.*` 命名空间**：ACode 是 stdio CLI +
   host/attachment 模型，导入落在宿主服务层 `packages/services/src/model-provider/`。
3. **不搬 Fynvra 的 `providerStore` / `ProviderUpsertInput` 预校验器**：ACode 用 provider 域的 schema +
   `ProviderSettingsFacade` 写入，不复制第二套校验（EI-2）。
4. **不做反向导出**（provider/MCP → 外部工具）；只读外部、单向导入。
5. **不做持续 / 增量同步**：一次性导入。
6. **不新增第四种协议值**（google/gemini）：CC Switch 的 gemini 行跳过 + 告警，不改协议枚举（EI-146）。
7. **不新建 MCP 配置真源、不新增第三个 MCP writer**：收敛到 `mcp-sync` 漏斗。
8. **不新增第二条 `provider_config.json` 写入路径**：收敛到 provider-node repository 漏斗（EI-2）。
9. **不为导入引入新依赖**：TOML 复用 `smol-toml`，SQLite 用 `node:sqlite` 内建。
10. **不把 `SettingsSyncCategory` 的悬空 `"providers"` 值直接拿来用**：provider 导入走
    Model Provider 设置页（该枚举值是否清理见 §开放问题 Q7）。
11. **不做 OpenCode 的 permissions/plugin 面**：MCP 导入只取 `mcp` 段。
12. **不做 `~/.claude.json` 的项目级 MCP**：仅在明确需要时另立（先取用户级 + 既有工作区级）。

## 第三方归属（署名方式）

借用的契约形状来自 **Fynvra（Apache-2.0）**：

| 借用点 | Fynvra 源路径 |
| ------ | ------------- |
| 三层 locate / readers / scan 结构；来源顺序即去重优先级 | `src/main/services/providers/import/{locate,scan}.ts`、`src/main/services/mcp/import/{locate,scan}.ts` |
| 指纹去重标签 `duplicate:'existing'|'candidate'` | `src/main/services/providers/import/scan.ts` |
| 逐字段构造的脱敏视图 `hasApiKey`/`apiKeyHint` | 同上 |
| 明文缓存 TTL（10 min）+ 候选 id 回换 + 单槽缓存 | `src/main/services/providers/import/providerImporter.ts`、`src/main/services/mcp/import/mcpImporter.ts` |
| JSONC 去注释/尾逗号 + 仅行号错误 | `src/main/services/mcp/import/jsonc.ts` |
| SQLite「复制 `db` + `-wal` 到临时目录、只读打开、删副本」 | `src/main/services/providers/import/locate.ts`、`src/main/services/mcp/import/locate.ts` |
| 变量引用不展开 + 只带键名的告警 | `src/main/services/mcp/import/scan.ts` |

署名方式：ACode 侧全部自撰实现，无代码拷贝；在（a）本 spec 本表、（b）新增文件头注一行
「契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md」记载出处与改动。
**不**写入 `THIRD-PARTY-NOTICES.md`——该文件由 `node scripts/licenses.mjs notices` 从依赖/资产图生成，
Fynvra 既非依赖也非拷贝资产，手工编辑会被下次生成覆盖。

## 开放问题（需主 agent 裁决）

- **Q1 MCP 落点**：采纳本 spec 的「扩展 settings-sync 既有 MCP 来源表 + 写经 mcp-sync 漏斗」（推荐，
  UI 入口与候选/结果形状已存在），还是采纳 Track B 原文「`mcp-sync` 新建 reader 面」？若选后者，
  须同时把 settings-sync 的 MCP 读取收敛到同一实现（否则 EI-2 违规），工作量与回归面显著更大。
- **Q2 MCP writer 收敛范围**：settings-sync `addMcpServerToAcodeConfig` 与 mcp-sync `saveMcpToUserDirectory`
  是既有双重写入（同一文件）。是否本批次一并收敛到 mcp-sync（推荐，否则新来源继续走第二条 writer）？
- **Q3 批量单事务**：新增 `importPersonalProviders`（推荐，单 revision/原子）还是复用两段 façade 调用
  （`createPersonalProvider` + `addPersonalModels`，两条 revision、可能半成品）？前者新增 provider 域 API 面，
  但符合 EI-12/EI-40；后者 API 面更小但失败语义更差。
- **Q4 CC Switch gemini**：跳过 + 告警（推荐，ACode 无该协议）还是新增 `google-generative-ai` 协议值
  （超出本 spec：涉及 resolver、模型发现、鉴权头全链）？
- **Q5 环境语义文案**：远端 workspace 时「本机」= 远端主机（与 `discoverProviderModels` 同先例），
  UI 文案是否需强提示「扫描的是远端主机」？
- **Q6 候选是否展示 baseUrl**：baseUrl 非 secret（推荐展示，否则用户无法判断来源与去重依据）；
  若产品要求更保守，可只显示主机名。
- **Q7 悬空枚举值**：`SettingsSyncCategory` 的 `"providers"`（shared/src/settings-sync.ts:21）服务端零实现；
  本批次不采用该槽，是否顺手清理该枚举值（影响 shared 类型面与 knip），还是留待将来？

## 附录 A · 实施首日需核实的本机样本（待补）

按 `external-session-import-sources.md` 附录的方法：实施首日用真实本机样本修正 fixture，差异记入本节。

**2026-11-02 实配核实结论（只记结构，不记任何值）**：在一台装有 Claude Code / Codex / CC Switch 的
Windows 主机上，用仓库真实 `locate`+`scan`+readers 跑了一次只读全量扫描（16 个 provider 候选、5 个 MCP
候选），输出仅保留脱敏摘要；扫描结果与日志中未出现任何明文凭据（对 21 个真实疑似凭据值做 deny-list 自检）。

| 来源 | 路径 | 核实结论（结构） | 与 fixture 的差异 |
| ---- | ---- | ---------------- | ----------------- |
| Claude Code | `~/.claude/settings.json` | 顶层 `model`(string) + `env`；`env` 内 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 命中，`ANTHROPIC_API_KEY` 缺席；模型键命中 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`，**无 `*_NAME` 键**（显示名回落「Claude Code」）；另有 `ANTHROPIC_SMALL_FAST_MODEL`（不在 spec 正则内，按 spec 不采）与 `DEEPSEEK_*`（非 ANTHROPIC_*，不采） | fixture 新增「无 `*_NAME`」与三档 DEFAULT 模型形态；`ANTHROPIC_SMALL_FAST_MODEL` 保持不采（spec 正则原样） |
| Codex | `~/.codex/config.toml` | 顶层键含 `model_provider`/`model`/`model_providers` 与大量非 provider 表（`projects/tui/marketplaces/plugins/skills/memories/hooks/mcp_servers` 等）；`model_providers` 仅 1 条，字段集合 `name,base_url,wire_api,requires_openai_auth,experimental_bearer_token`；`wire_api="responses"`；`requires_openai_auth=false`；**无 `env_key`**；`auth.json` **不存在** | **reader 缺陷（已修）**：实配把密钥放在 provider 表内的字面字段 `experimental_bearer_token`，原实现只认 `env_key`/`requires_openai_auth`，导致该 provider `hasApiKey=false` 且无告警。已补该字段（+别名 `bearer_token`）并优先于全局 `auth.json`；fixture 与 R1 同步 |
| CC Switch（providers） | `~/.cc-switch/cc-switch.db` | 表 `providers` 18 列，本实现用到的 `id/name/app_type/settings_config/meta/is_current` **全部命中**；`app_type` 实测集合 `claude,claude-desktop,codex,gemini,grokbuild,omp,opencode,pi`（白名单外 5 类聚合为 `unsupported-app-type`）；`is_current` 取值 `0/1`；`meta` 键含 `apiFormat`（另见 `endpointAutoSelect`/`liveConfigManaged`/`codexChatReasoning` 等）；`meta.apiFormat` 实测值集合恰为 `anthropic,openai_chat,openai_responses`（三值映射全覆盖）；`settings_config` 形态含 `{env}`（claude）、`{auth,config}`/`{config}`（codex）、`{api,apiKey,baseUrl,models,name}` 等（非白名单类）；库无 `-wal`/`-shm` | fixture 已覆盖 `{env}`/`{auth,config}`；补记 `{config}`（无 auth）与「白名单外 5 类」计数形态；`-wal` 分支仍由合成 fixture 覆盖 |
| CC Switch（mcp_servers） | 同上 | 表 `mcp_servers` 列 `id,name,server_config,description,homepage,docs,tags,enabled_{claude,codex,gemini,opencode,hermes,grokbuild,mcode,pi,agy,kimi,omp}`；`server_config` 为 JSON 文本（实测形态含 `type,url,headers`（http）与 `type,command,args,env`（stdio））；**无 `enabled`/`is_enabled` 列**，只有 per-tool 开关 | 实配 4 行全部只对 `opencode` 开启。本实现按 ACode 缺省「启用」投影（ACode 不在 per-tool 开关集合内），不读 per-tool 标志；已记于此，未被误报为缺陷 |
| Codex（MCP） | `~/.codex/config.toml` | `mcp_servers`（下划线）表存在，server 字段 `args,command,env_vars,startup_timeout_sec,env` | 与 fixture 一致（`env_vars` 为键名列表，按 spec 不展开） |
| VS Code | 平台相关 `Code/User/mcp.json` | **本机不存在** | 未核实：`servers` 包装键与 JSONC 形态仍按官方 schema 假设（见 R7.2 与下方遗留项） |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json(c)` | **本机不存在** | 未核实：`mcp` 段 `type: local/remote`、`command` 数组形态仍按假设 |
| Cursor / Gemini | `~/.cursor/mcp.json` / `~/.gemini/settings.json` | **本机不存在** | 未核实：包装键 `mcpServers` 假设未变 |
| ACode 目标 | `~/.acode/cli/config.json` | 顶层仅 `plugins`（无 `mcp` 键） | 本次只做只读扫描，未对真实目标文件执行写入；写入漏斗行为由合成夹具与临时 HOME 的集成测试覆盖 |

仍未核实的点：VS Code / OpenCode / Cursor / Gemini 的文件形态（本机未安装）；MCP 变量引用告警在真实样本中
未出现（本机 5 个 server 均无 `${…}`/`{env:…}` 引用），故该分支仍只有合成覆盖。

（ACode 无内置 `smol-toml` 之外的 TOML 依赖，故 Codex 样本必须实测；`node:sqlite` 已实测
`DatabaseSync(copy,{readOnly:true})` 与 `-wal` 副本可用，但实测机为 Node 25.9.0，`mise.toml` 固定的
24.14.0 未能在本机执行——环境无 `mise`。）

## 附录 B · 与方案假设不符的事实

1. **协议命名**：不是 `anthropic-compatible` / `openai-compatible`，而是
   `anthropic-messages` / `openai-chat-completions` / `openai-responses`（且无 google/gemini 值）。
2. **MCP 导入面已存在**：Track B 假设「`packages/services/src/mcp-sync/` 补 reader 面」，但 ACode 已有
   settings-sync 的 12 家外部 Agent MCP 导入 + `McpSettingsSection` 的导入按钮 + 三步向导 UI；
   在 mcp-sync 新建读者会造第二份读取实现。
3. **mcp-sync 的 candidate/import 通道不是「从外部工具导入」**：它是「本地 ACode/agents MCP ⇄ 远端推送」
   （`acode`/`agents` 两个 source，`listLocalUserMcpCandidates`/`exportMcpServers`/`importMcpServers`）。
4. **provider-node 无 TOML 依赖**：`smol-toml` 在 `packages/services`；Track B 原文落 provider-node 会引入
   新依赖并需改 `architecture-policy`（`provider-node` 是 `managed: true` 严格模块）。
5. **provider-node 的职责边界**：`CONTRACT.md` 明确其为 ACode Builtin/Personal 配置物化；第三方工具文件读取
   不在其声明职责内，故本 spec 落 services（与 `providerModelDiscovery` 先例一致）。
6. **`ProviderSettingsView` 明文回退态**：既有 spec 允许其在未迁移态含明文，「明文绝不出现在任何 IPC 返回值」
   不能笼统写成对 `ProviderSettingsView` 的断言；本 spec 的负向断言仅限导入新增的视图/结果/日志/导出。
7. **`SettingsSyncCategory` 已预留未实现的 `"providers"` 值**（services 端零实现）——provider 导入曾被预留为
   settings-sync 类别之一；本 spec 改走 Model Provider 设置页（见 Q7）。
8. **无共享 `asRecord`/`errorMessage` helper**：Fynvra 有 `@shared/guards`；ACode 各处自持局部 `isRecord`
   （先例 `settings-sync`/`mcp-sync`），故本 spec 不假定存在共享 guard。
9. **桌面形态不同**：Fynvra 为 Electron + utilityProcess；ACode 为 Electron + stdio CLI，SQLite 依赖 Node 内建
   `node:sqlite`（ACode 已有 `apps/acode-cli` adapters 直连先例），无第三方 SQLite 依赖。
10. **MCP 的 env/header 值现状**：它们本就随 MCP 视图/候选进入 renderer（既有契约）；R4 的凭据硬约束是
    **Provider API Key** 专属，MCP 侧本次只约束「新增 warning/日志不带值」。