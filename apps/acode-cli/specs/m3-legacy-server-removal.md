# M3 CLI legacy 协议 server 删除（「搬迁 + 删除」）

> 状态：**已完成（2026-10-29，两段式落地）**——§0 裁决已落档，两段均测试全绿。
> 核验方式：只读源码 + `git grep` / `wc -l` / `node` 实测（见 §2、§9），不抄旧文档数字。
> 上游依据：
> - `docs/reviews/2026-10-28/m3-m4-w2-dependencies.md` §A.2 启动前置 checklist、§A.3 50 文件清单
> - `docs/legacy-protocol-convergence-plan.md` M3 节（含 2026-10-28「搬迁非删除」订正）
> - `docs/reviews/2026-10-28/m2-scoping.md` §4（双链路冒烟的既有环境受限登记方式）

---

## 0. 裁决（2026-10-29，已落档）

沿用 M2 季先例（`docs/reviews/2026-10-28/m2-scoping.md` §6.3：保守无能力损失默认、标注产品可推翻）。
以下三条裁决解除 §7 的三项硬阻塞。

### 裁决 1：`sessionSubagents` 保留为幸存 legacy 面

- **裁决内容**：本批**不删** `session/subagents` 方法及其 CLI 执行面
  （`session-operations.ts` 的 `listSessionSubagents` + `subagent-session-query.ts`），
  不补 v4 subagents 协议面（那是新增协议设计 + 双链路冒烟的新功能范围，超出 M3 退役目标）。
- **依据**：M2-5 §4「保守无能力损失」先例（`pluginsReferenceCatalog` 两级回落保留同款）；
  `m2-scoping.md:73` 已实测「v4 没把 subagent 列表做成对外 RPC」。
- **产品可推翻**：长期二选一（补 v4 协议面 / 接受 UI「已结束」分组能力损失），待产品裁决。
  宿主文件保留最小形态。
- **移除条件**：v4 侧新增 `subagents` 分页 query（协议扩展批次），或产品确认下线该分组。

### 裁决 2：`pluginsCancelOperation` 保留 legacy 词（不推翻 M2-5 §4）

- **裁决内容**：不推翻 M2-5 §4 保留裁决，`plugins/cancelOperation` 作为 legacy 词保留；
  执行面（`server.ts` 的 `cancelPluginOperation` 中止注册表）随搬迁留在 v4 侧的最小幸存模块。
  `packages/shared/tests/protocol-boundary.test.mjs:304-308` 现有断言（不进 v4 面）与保留现状一致，
  **无需改 `packages/shared`**。
- **依据**：M2-5 §4 裁决 + M4 legacy-types 六 schema 幸存白名单先例（幸存面显式登记）。
- **产品可推翻**：若后续把中止注册表纳入 v4 统一面，可迁移；届时改 shared。
- **移除条件**：中止注册表与协议代际解耦的 v4 面建模完成。

### 裁决 3：`sessionSend` 附件回退路径保留为幸存面

- **裁决内容**：`acodeTaskServiceAdapter.ts:423-448` 的附件回退分支（`attachments?.length` 时走
  legacy `session/send`）**保留**；CLI 侧 `sessionSend` case 与 `sendPrompt` op 随之幸存。
- **依据**：M2-5 §4「保守无能力损失」先例；bot 附件输入（`botsService.ts:5002`）与手机
  replayable 附件输入走此路，删除即断生产。
- **产品可推翻**：待 v4 附件上传/寄存命令面（attachmentRef 引用模型的宿主发送侧）补齐后移除。
- **移除条件**：v4 附件上传/寄存命令面建模完成 + 双链路真实冒烟通过。

### 幸存清单（验收判据唯一事实源）

下列 legacy 方法 + 承载模块为 M3 幸存面，**不计入「归零」判据**：

| 方法词 | services 发送点 | CLI 执行面 | 承载模块（M3 后） |
|---|---|---|---|
| `session/subagents` | `acodeAgentService.ts:4291` | `session-operations.ts` `listSessionSubagents` | `acode-protocol-v4/subagent-session-query.ts` |
| `plugins/cancelOperation` | `acodeAgentService.ts:4776` | `server.ts` `cancelPluginOperation` | `acode-protocol-v4/server.ts`（幸存 case） |
| `session/send`（仅附件回退） | `acodeAgentService.ts:5191,5216` | `session-operations.ts` `sendPrompt` | `acode-protocol-v4/server.ts`（幸存 case） |

**验收判据重写**：所有「grep 归零」判据改为「**除本幸存清单外归零**」。
先例模式参照 M4 legacy-types 六 schema 幸存白名单
（`scripts/architecture/protocol-boundary.mjs` 的 `V4_LEGACY_TYPES_SURVIVOR_SYMBOLS`）。

### services 侧 6 处 `acodeProtocolMethods.` 逐处处置

| 位置 | 方法 | 处置 | 依据 |
|---|---|---|---|
| `acodeAgentService.ts:4291` | `sessionSubagents` | **保留**，登记进幸存清单 | 裁决 1 |
| `acodeAgentService.ts:4776` | `pluginsCancelOperation` | **保留**，登记进幸存清单 | 裁决 2 |
| `acodeAgentService.ts:5191` | `sessionSend`（附件回退主路径） | **保留**，登记进幸存清单 | 裁决 3 |
| `acodeAgentService.ts:5216` | `sessionSend`（附件回退兼容重试） | **保留**，登记进幸存清单 | 裁决 3 |
| `pluginReferenceCatalogRequest.ts:37` | `pluginsReferenceCatalogWithCategory` | **删除**（v4 primary 已覆盖；-32601 回落仅服务 pre-v4 CLI，M3 后旧 CLI 面退役） | 裁决外——不属幸存清单 |
| `pluginReferenceCatalogRequest.ts:44` | `pluginsReferenceCatalog` | **删除**（同上） | 裁决外——不属幸存清单 |

处置后果：services 侧 `acodeProtocolMethods.` 命中从 6 降到 **4**（全部落在幸存清单），
`pluginReferenceCatalogRequest.ts` 的 `acodeProtocolMethods` import 随删除清出。

---

## 1. 范围与判据

### 1.1 原定内容

按 `m3-m4-w2-dependencies.md` §A.3：

1. 把 `server.ts` 的 76 个 v4 `case` + dispatch 装配搬入 `acode-protocol-v4/`，
   删除其中 12 个 legacy `case`；
2. 解除 v4 → legacy 反向 import（原文档记 5 处）；
3. 收编 `v4-bridge.ts` 的 6 个过渡钩子后删除桥文件；
4. 删除 `bootstrap/src/acode-protocol/` 全部 A 类文件；
5. services 侧 6 处 `acodeProtocolMethods.` 消费清零；
6. `bootstrap/src/index.ts` 只剩 v4 + 装配出口。

### 1.2 唯一所有者（搬迁后）

| 关注点 | 现值所有者 | M3 后所有者（计划） |
|---|---|---|
| wire 入口（`handleMessage`） | `acode-protocol/server.ts` | `acode-protocol-v4/server.ts`（已迁） |
| 会话注册表 `context.sessions` + `parseParams`/`ProtocolRequestError`/`requireSession` | `acode-protocol/server-types.ts` | `acode-protocol-v4/server-types.ts`（已迁，**保留原名**——它就是 v4 宿主上下文） |
| 会话 op 执行面（create/resume/read/send/subagents/usage） | `acode-protocol/server-operations.ts`（3,639 行） | `acode-protocol-v4/server-operations.ts`（已迁，删死 op 后 3,438 行） |
| legacy 事件 → wire 投影（`--output-format stream-json` 形状权威） | `acode-protocol/session-mapper.ts` | `acode-protocol-v4/session-mapper.ts`（已迁，保留原名） |
| v4 网关绑定（帧出口 / 命令执行 / 宿主能力） | `acode-protocol/v4-bridge.ts`（1,905 行） | `acode-protocol-v4/v4-binder.ts`（已迁改名，钩子收编） |
| NDJSON 连接 | `acode-protocol/transport.ts` | `acode-protocol-v4/transport.ts`（已迁，**本体保留**；legacy `sessionStop` 旁路词删除） |
| inbound 反向请求端口（permission/userInput/browser/automation/offPeak/providerHeaders/officialMcp） | `acode-protocol/*-port.ts` / `*-broker.ts` | `acode-protocol-v4/` 同名（已迁；`-32601` 回落发送器保留，属另一独立偏斜面，见 §7-E） |

> **改名最小化说明**：除 `v4-bridge.ts → v4-binder.ts`（任务硬性要求「v4-bridge.ts 本体删除」）外，
> 其余文件保留原名。搬迁是纯重定位，原名使 import 重写面最小、回归风险最低；文件名语义在
> v4 目录内自洽（`server.ts`/`server-types.ts`/`server-operations.ts` 即 v4 宿主）。
> `architecture-policy.yaml` 的协议边界守护只覆盖 shared 侧 barrel，bootstrap 目录内重命名不触门禁。

**依赖方向不变量**：搬迁完成后只允许 `acode-protocol/` → `acode-protocol-v4/`，禁止反向；
目录消失后该不变量自动成立（无 legacy 目录可指）。`scripts/architecture/protocol-boundary.mjs`
只守护 shared 侧的 barrel，不覆盖 bootstrap 目录——搬迁期间需靠本 spec §6.3 的临时 grep 判据。

---

## 2. §A.2 启动前置逐项核验（2026-10-29 实测，**实施前快照**）

> 本表是**实施前**（裁决落地前）的核验快照。其中 ❌ 项的归属：
> ① ②④ 由 §0 裁决落地（幸存面登记）解除；⑥⑦⑧ 由本批实施解除（钩子收编 / 反向 import
> 清零 / re-export 迁 v4）。③的「双链路冒烟」为环境受限项，按 §8 登记为发布期门禁。

命令均在 worktree 根执行。**判定口径**：✅ 满足 / ⚠️ 部分 / ❌ 未满足。

| # | checklist 项 | 判定 | 实测证据（2026-10-29） |
|---|---|---|---|
| 1 | services 侧 `acodeProtocolMethods.*` 调用 = 0 | ❌ | `git grep -c "acodeProtocolMethods\." -- packages/services/src` → 6 命中 / 2 文件：`acodeAgentService.ts`(4) + `pluginReferenceCatalogRequest.ts`(2)。明细见 §2.1 |
| 2 | services 侧 legacy **方法**消费 = 0（方法名口径） | ❌ | 同上；且其中 3 个方法在 `V4_METHODS`（92 项）**无任何同名/等价条目**（见 §2.1） |
| 3 | 15 个 inbound handler 的 v4 形态协议 + 双链路冒烟 | ❌ | v4 侧 6 法 + automation/offPeak 7 法已落（`transport.ts` 92 项含 `interaction/*` 6、`automation/*` 5、`offPeak/*` 2）；但**双链路真实冒烟未跑**（headless 结构性不可跑，见 §8）。host 侧 15 条 legacy 字面量分支仍在（`acodeAgentService.ts:2535..3175`） |
| 4 | 14 个部分等价项的产品裁决 | ⚠️ | M2 scoping §6.3 已裁决 4 项（`mode:auto` 保留 / compact instructions 保留 / close≠delete 并存 / debug 保留）；`sessionSubagents` **明确记「无直接对应」但无处置裁决**（`m2-scoping.md:73`） |
| 5 | `sessionSubscribe` 迁移阻塞解除 | ✅ | v4 `session/subscribe` 已落并接线（`session-readwrite.ts:68-73`）；M1 已完成 |
| 6 | `v4-bridge.ts` 6 钩子收编、字段从 binder 接口删除 | ❌ | 6 钩子全部仍在（`v4-bridge.ts:983/995/1001/1020` + child registration + `1411`）；接口字段仍在 `commands/types.ts:211/225/231/238/290` 与 `v4-gateway.ts:228` |
| 7 | v4 → legacy 反向 import 解除（原记 5 处） | ❌ | 实测 **25 条 import / 18 个 v4 文件**，目标 10 个模块（§3.2） |
| 8 | `bootstrap/src/index.ts:71` `mapSessionEvent` re-export 迁移或退役 | ❌ | 仍在 `index.ts:71`；消费方为 CLI 的 `--output-format stream-json`（`cli-types.ts:68`、`prompt-command.ts:169-177`、`headless-workflow.ts:222,258-270`），退役需先给 CLI 另一形状权威 |
| 9 | CLI 测试基线刷新到当前实测 | ✅ | `pnpm --dir apps/acode-cli test`：**3,243 tests / 3,206 pass / 0 fail / 37 skip**（文档记 3,151，specs 记 3,205/38） |

### 2.1 services 侧 6 处消费的方法级判定（阻塞核心）

`git grep -n "acodeProtocolMethods\." -- packages/services/src` 全量 6 行：

| # | 位置 | 方法 | v4 等价物 | 判定 |
|---|---|---|---|---|
| 1 | `acodeAgentService.ts:4291` | `sessionSubagents` | **无**。v4 只有 `snapshot.subagents`（`snapshot.ts:450-456`，字段 = `revision` / `childSessionIds` / `running[]` / `endedTotal` 计数），**没有** ended 游标分页、没有 ended 明细 | **阻塞**：删除即丢「已结束子代理目录」 |
| 2 | `acodeAgentService.ts:4776` | `pluginsCancelOperation` | **决策上不迁**。`shared/src/acode-protocol-v4/{transport.ts:462,plugins.ts:8,plugins-commands.ts:14,index.ts:52}` 四处注释明写「保留 legacy 词」，且 `shared/tests/protocol-boundary.test.mjs:304-308` 断言 `!("pluginsCancelOperation" in V4_METHODS)` | **阻塞**：迁 v4 需改 `packages/shared`（本批禁令）+ 会打断 shared 测试 |
| 3 | `acodeAgentService.ts:5191` | `sessionSend`（附件回退主路径） | `sendText.payload.attachments` 只收 `attachmentRef[]`（`ref/fileName/mime/bytes`，`attachment-ref.ts:4-12`）；legacy 面收 `ACodePromptAttachment`（`kind/filename/mimeType/dataBase64/localPath`，`acode-task-types-core.ts:190-249`）。**上传/寄存命令面在宿主发送侧未建模**（`acodeTaskServiceAdapter.ts:424-427` 自述） | **阻塞**：删除即断 bot 附件输入 |
| 4 | `acodeAgentService.ts:5216` | `sessionSend`（同上，兼容重试第二发） | 同上 | **阻塞**：同上 |
| 5 | `pluginReferenceCatalogRequest.ts:37` | `pluginsReferenceCatalogWithCategory` | `V4_METHODS.pluginsReferenceCatalog` 已为 primary | ⚠️ 可删，但会去掉 pre-v4 CLI 的两级回落；M2-5 §4 显式裁决保留 |
| 6 | `pluginReferenceCatalogRequest.ts:44` | `pluginsReferenceCatalog` | 同上 | ⚠️ 同上 |

**关键订正**：任务书称这 6 处「均带『M3 移除归属』注释」——实测
`git grep "M3 移除归属" -- packages/services/src` **零命中**。代码里的 M3 标注只有 17 条，
全部指向 **host 侧 inbound legacy 字面量分支**（15 条 `acodeAgentService.ts:2535..3175`
「偏斜期 legacy 分支：字面量匹配（legacy 常量消费归零），M3 删除」+ `:326` + `:1977`），
与这 6 处常量消费**不是同一批**。M2 各批 spec 反向登记这 6 处「归 M4」：
`m2-5-plugins.md:6-7`、`m2-3-session-readwrite.md:226`、`m2-4-inbound-interaction.md:6-7`、
`m2-7-automation-offpeak.md:22`。

### 2.2 production 路径取证（#1 与 #3）

- `sessionSubagents`：唯一生产调用链
  `packages/ui/src/hooks/useSessionSubagents.ts:72` → `acodeAgentService.listSessionSubagents`
  → 本行。挂载点两处：`app-shell/AnimatedSidePanePanel.tsx:1130`（`SubagentDirectorySidePane`）
  与 `v4/composer/usage-bar/UsageStatusBar.tsx:43`（`UsageBarSubagentPanel`）。
  hook 在方法缺席时**静默返回空页**（`useSessionSubagents.ts:64-71`）——不崩，但两个产品面板的
  「已结束」分组整体消失，属能力损失（违反「保守无能力损失」默认）。
- `sessionSend` 附件回退：`sendPrompt` 门面的**唯一**生产调用方是
  `acodeTaskServiceAdapter.ts:428`，且仅在 `params.attachments?.length` 为真时进入
  （`:423`）。附件来源实测为 bot：`botsService.ts:4982` `sendPromptInBackground`
  → `:4998` `acodeTaskService.sendPrompt`（`:5002` 传 `attachments`），两处调用点 `:5173` / `:5242`。
  desktop cron（`cronRunDispatch.ts:190`）与 offPeak（`offPeakRunDispatch.ts:333`）**不带**附件，
  不走该分支。
- `pluginsCancelOperation` 生产调用：UI `settings/RemotePluginSyncDialog.tsx:1015`
  与 `ConversationDraftSuggestedPromptsContainer.tsx:186`（经 `pluginManagementService` 转发）。

---

## 3. 实测规模与文档漂移（必须刷新，不能沿用 §A.3）

### 3.1 目录规模

| 口径 | 文档（2026-10-28） | 实测（2026-10-29） | 差异原因 |
|---|---:|---:|---|
| 文件数 | 50 | **40** | M2-2..M2-8 已删 11 文件（`caa38080`：account-provider-config / dynamic-workflow-policy / interaction-preferences / mcp / model-io-preferences / off-peak-tool-policy / plugins / process-child-processes / saved-workflows / skill-reference-catalog / workspace-hook-trust） |
| 行数 | 15,690 | **14,161** | 同上（`wc -l apps/acode-cli/packages/bootstrap/src/acode-protocol/*.ts`） |
| legacy `case acodeProtocolMethods.*` | 59 | **12** | M2 各批「消费归零后删除」 |
| v4 `case V4_METHODS.*` | 32 | **76** | M2-2..M2-8 additive 换名 |
| `PROVIDER_DIAGNOSTICS_METHODS` case | 2（`server.ts:710-713`） | **2（`server.ts:798-800`）** | 行号漂移 |
| v4 目录 | 51 文件 / 21,737 行 | **80 文件 / 25,964 行** | M2 additive 面增长 |

### 3.2 v4 → legacy 反向 import：25 条 / 18 文件 / 10 目标模块

| 目标 legacy 模块 | 边数 | 导入方（v4 文件） | 迁往 |
|---|---:|---|---|
| `server-types.ts` | 14 | mcp-list-query / plugins-management / plugins-mutations / provider-process / saved-workflows-hub / session-debug-query / session-goal-query / session-header-meta-query / session-readwrite / session-runtime-preferences / skills-reference-catalog-query / workspace-hook-trust-grant / workspace-policies / workspace-runtime | v4 宿主上下文叶子（**最大单块**：`ACodeProtocolAgentServerContext` / `parseParams` / `ProtocolRequestError` / `requireSession` / `createProtocolLogger`） |
| `session-residency.ts` | 2 | goal-compact / prompt-turn | v4 |
| `session-mapper.ts` | 2 | goal-compact / session-goal-query | v4（同 `index.ts` re-export 一并决议） |
| `server-operations.ts` | 1 | session-readwrite（6 个 session query 直通） | v4（整文件） |
| `session-debug.ts` | 1 | session-debug-query | v4 |
| `slash-commands.ts` | 1 | workspace-runtime | v4 |
| `protocol-mcp-config.ts` | 1 | mcp-list-query | 中立叶 |
| `workspace-model-runtime.ts` | 1 | provider-process | v4 |
| `usage-stats-builder.ts` | 1 | usage-query（另有 `app/create-app.ts:71`、`app/session-facade.ts:33` 两处非 v4 消费） | 中立叶 |
| `model-execution.ts` | 1 | session-flow | v4 |

> 原文档口径「5 处」是 M2 前的快照。M2 各批把实体搬进 v4 目录时统一 `import type ... from
> "../acode-protocol/server-types.js"`，于是反向边从 5 条涨到 25 条。**这是 M2 的合法连带，
> 但把 M3 的搬迁量放大了约 5 倍**。

### 3.3 外部 import 面（B 类实测 19 文件，非文档的 8 个）

用脚本按「legacy 目录外是否有文件 import 该模块」实测（脚本口径见 §9）：**19 个模块有外部 importer**。

| 模块 | 行数 | legacy 目录外 importer |
|---|---:|---|
| `server-operations.ts` | 3,639 | `acode-protocol-v4/session-readwrite.ts` |
| `v4-bridge.ts` | 1,905 | 无（但被 `server.ts:112` 引用） |
| `session-mapper.ts` | 1,588 | v4 goal-compact / session-goal-query + `bootstrap/src/index.ts:71` |
| `server.ts` | 1,068 | `acode-protocol-entrypoint.ts:54` |
| `subagent-session-query.ts` | 643 | `app/subagent-observation.ts:16` |
| `server-types.ts` | 384 | 14 个 v4 文件（§3.2） |
| `usage-stats-builder.ts` | 271 | v4 usage-query + `app/create-app.ts:71` + `app/session-facade.ts:33` |
| `session-debug.ts` | 184 | v4 session-debug-query |
| `storage-startup.ts` | 147 | entrypoint:36 |
| `session-residency.ts` | 123 | v4 goal-compact / prompt-turn |
| `slash-commands.ts` | 104 | v4 workspace-runtime |
| `official-mcp-auth-port.ts` | 101 | entrypoint:45 |
| `resource-sampler.ts` | 86 | entrypoint:57 |
| `workspace-model-runtime.ts` | 86 | v4 provider-process |
| `runtime-cleanup.ts` | 66 | entrypoint:56 |
| `ai-sdk-warning-logger.ts` | 53 | entrypoint:41 |
| `protocol-mcp-config.ts` | 42 | v4 mcp-list-query |
| `startup-resource.ts` | 40 | entrypoint:58 |
| `model-execution.ts` | 27 | v4 session-flow |

其余 **21 个模块无外部 importer**，但**全部**经 `server.ts` / `server-operations.ts` /
`v4-bridge.ts` 传递可达（实测 40/40 全部可达），因此**不存在「先删 A 类」的可行子集**。

---

## 4. 搬迁计划（已执行；实例如下，改名比计划最小化）

按依赖方向「先搬被依赖者，再搬依赖者」。**实注**：除 `v4-bridge.ts → v4-binder.ts` 外全部保留原名
（改名最小化，见 §1.2 末注）；`server-types.ts` 未拆叶（它是 v4 宿主上下文的单一事实源）。

1. `server-types.ts`(384) → `acode-protocol-v4/host-context.ts`，改 14 个 v4 文件的 import。
   拆出 `parseParams` / `ProtocolRequestError` / `requireSession` 到 `protocol-error.ts` 叶子。
2. `model-execution.ts`(27) / `session-residency.ts`(123) / `session-debug.ts`(184) /
   `slash-commands.ts`(104) / `protocol-mcp-config.ts`(42) / `usage-stats-builder.ts`(271) →
   v4 或中立叶，改 6 条 v4 边 + 2 条 `app/` 边。
3. `session-mapper.ts`(1,588) → `acode-protocol-v4/session-event-mapper.ts`；
   `bootstrap/src/index.ts:71` 改为从新路径 re-export（保持 CLI stream-json 形状权威单一）。
4. `subagent-session-query.ts`(643) → `acode-protocol-v4/subagent-session-query.ts`，
   改 `app/subagent-observation.ts:16`。
5. `server-operations.ts`(3,639) → `acode-protocol-v4/session-operations.ts`（整文件）；
   同时把 7 个钩子执行面改成本文件内的直接调用（见 §5）。
6. `v4-bridge.ts`(1,905) → `acode-protocol-v4/v4-binder.ts`；6 钩子内联为 binder 私有函数
   （`ensureModelReady` / `afterLegacyStateMutation` / `closeSession` / `createSessionRecord` /
   child registration / `resumePersistedSession`），随后从
   `commands/types.ts:211/225/231/238/290` 与 `v4-gateway.ts:228` 删除可选字段。
7. `server.ts`(1,068) → `acode-protocol-v4/server.ts`：搬 76 个 v4 case + 2 个 provider
   diagnostics case + dispatch/outbox/requestClient 装配，**删 12 个 legacy case**。
   `acode-protocol-entrypoint.ts:349` 的 `handleMessage` 绑定改指新类。
8. `transport.ts`(295) → `acode-protocol-v4/ndjson-connection.ts`（**本体不删**）；
   删 `shouldBypassProcessingQueue` 里的 `sessionStop` legacy 词（改 `V4_METHODS` 的 stop 形态）。
9. 收尾：删 `acode-protocol/` 目录；`bootstrap/src/index.ts` 只剩 v4 + 装配出口；
   收窄 `architecture-policy.yaml` 的 cli 域条目与 `.architecture-baseline.json` 中
   `acode-protocol/*` 的 7 条 max-file-lines 记录（其中 `plugins.ts` 已是**陈旧条目**，
   §9-E 已登记）。

---

## 5. 钩子收编的语义对齐源

`server-operations.ts` 是本批钩子的**语义对齐源**，删除前必须先把它搬进 v4：

| 钩子 | 现实现（`v4-bridge.ts`） | 执行面（`server-operations.ts`） | 收编后 |
|---|---|---|---|
| `ensureModelReady` | `:983` | `ensureSessionModelAvailableForNextTurn`（`:2453`，失败即 `stateRevision++`） | v4 binder 私有函数 |
| `afterLegacyStateMutation` | `:995` | `afterStateMutation`（`:3585`）+ `autoDrainV4QueueIfReady` | v4 binder 私有函数；`state.updated` 广播面需单独裁决（见 §7-B4） |
| `closeSession` | `:1001`（内联 4 步） | legacy `closeSession` op（M2-2 已删） | v4 binder 私有函数（已是内联实现，只搬不改） |
| `createSessionRecord` | `:1020` | `createSessionRecordForV4`（`:1145`）→ `createSessionWithProjection` | v4 binder 私有函数 |
| child record registration | `registerCommittedForkBestEffort`（`:580`，调 `registerForkedSession`） | `registerForkedSession`（`:1996`） | v4 binder 私有函数 |
| `resumePersistedSession` | `:1411` | `activateSessionForResume`（`:1339`） | v4 binder 私有函数 |
| `ensureProviderAvailable` | `:987` | `hasSessionModelProvider`（`workspace-model-runtime.ts:49`） | 随 `workspace-model-runtime.ts` 搬 v4 |

**唯一所有者**：收编后这些能力由 `acode-protocol-v4/v4-binder.ts` 单点持有，
`commands/types.ts` 不再暴露钩子字段；`server.ts` 不再承载会话注册表。

---

## 6. 验收判据（前置满足后适用）

1. `apps/acode-cli/packages/bootstrap/src/acode-protocol/` **目录不存在**
   （`test ! -d ...` 退出 0）。
2. `git grep -n "v4-bridge\.js" -- apps/acode-cli` 退出码 1。
3. `git grep -n 'from "\(\.\./\)*acode-protocol/[a-z0-9-]*\.js"' -- apps/acode-cli/packages/bootstrap/src/acode-protocol-v4` 退出码 1。
4. `git grep -n "acodeProtocolMethods\." -- packages/services/src` → **仅剩幸存清单**
   （4 命中：sessionSubagents / pluginsCancelOperation / sessionSend×2，见 §0 幸存清单）。
5. `git grep -n "case acodeProtocolMethods\." -- apps/acode-cli` → **仅剩 3 幸存 case**
   （`server.ts` 的 sessionSubagents / sessionSend / pluginsCancelOperation）。
6. `pnpm --dir apps/acode-cli test` 全绿；`pnpm --filter @acode/services test` 全绿。
7. `pnpm typecheck`（或包级）在改动范围内 0 错。
8. `node scripts/architecture/architecture-check.mjs check --changed`：`new 0 / regrown 0`。
9. `acode --help` / `acode acp` 冒烟不崩。

---

## 7. 阻塞点 → 已裁决（2026-10-29，见 §0）

下列四项在核验时是硬阻塞，现已按 §0 裁决落档，不再阻塞：

### A. `sessionSubagents` 无 v4 等价物且无处置裁决（原硬阻塞 #1）→ **裁决 1：保留幸存**

- 事实：`V4_METHODS`（92 项）无任何 subagent 方法；v4 snapshot 的 `subagents` 只有
  `endedTotal` 计数，无 ended 明细、无游标分页。
- 处置：**幸存**。`session/subagents` dispatch 与 `listSessionSubagents` /
  `subagent-session-query.ts` 保留；UI 两面板不受影响。长期二选一（补 v4 协议面 /
  接受能力损失）待产品裁决，见 §0 裁决 1。

### B. `pluginsCancelOperation` 被显式裁决「保留 legacy 词」（原硬阻塞 #2）→ **裁决 2：保留幸存**

- 事实：4 处 shared 注释 + `shared/tests/protocol-boundary.test.mjs:304-308` 断言
  「不进 v4 面」。
- 处置：**幸存**（不推翻 M2-5 §4），未改 shared。验收判据随之重写为「除幸存清单外归零」。

### C. `sessionSend` 附件回退是 production 路径（原硬阻塞 #3）→ **裁决 3：保留幸存**

- 事实：v4 `sendText` 的附件是**引用模型**（已上传的 `attachmentRef`），宿主发送侧没有
  上传/寄存命令面（`acodeTaskServiceAdapter.ts:424-427` 自述「尚未建模」）。
- 处置：**幸存**。`session/send` 的附件回退与 `sendPrompt` op 保留；
  bot/手机 replayable 附件输入不受影响。移除条件：v4 附件命令面补齐，见 §0 裁决 3。

### D. `pluginsReferenceCatalog` 两级回落（原可裁决项）→ **删除**

- 处置：**删除**（`pluginReferenceCatalogRequest.ts` 收敛为 v4 primary 单点）。
  M3 删除 legacy server 后，回落链只服务 pre-v4 CLI——该偏斜方向随本批退役；
  不属幸存清单。产品可推翻（若需延长 pre-v4 CLI 兼容窗口）。

### E. 15 条 inbound legacy 字面量分支（host 侧）—— **本批未动，登记为遗留**

- 这 17 条 M3 标注（15 inbound + `:326` + `:1977`）是 host 侧**接收**旧 CLI inbound 请求的
  legacy 分支，与本批的「CLI legacy server 删除」是不同面。
- 本批不动：删除它们意味着旧 CLI（带 legacy 发送端）对新 host 的权限询问/automation/
  offPeak 失联，是独立的偏斜决策，超出本批范围。**建议后续与 CLI 侧 inbound 端口
  （`automation-port.ts` 等仍带 `-32601` legacy 回落发送器）一并裁决。**

### F. `afterLegacyStateMutation` 的 `state.updated` 广播面 —— **保留（未删）**

- 钩子的副作用 `context.notify({ method: "state.updated" })`（现 `server-operations.ts` 内）
  唯一消费方是 `acodeAgentService.ts:2662` 的 legacy 通知分支。v4 投影不走它
  （`acodeTaskServiceAdapter.ts:2755` 明写 v4 handler 不发旧 `state.updated`）。
- 本批**未删**（钩子的 `afterStateMutation` 执行面仍发该通知，services 仍消费）。
  删除该通知面属另一独立裁决，登记为遗留（见实施报告遗留事项）。

---

## 8. 冒烟边界（显式环境前置条件登记）

按 `docs/reviews/2026-10-28/m2-scoping.md` §4 的既有登记方式：

- **15 个 inbound handler 的双链路真实冒烟（desktop-continuous + web-remote-replayable）
  在本 headless 环境结构性不可跑**：前者需要 Electron main 的持续通道（`desktopRemoteSessions.ts`
  绑定 Electron），后者需要外部 relay 回放回路（`verify:remote-ssh` 需 Docker 且只验 WS 升级握手）。
  与 M2-1/M2-2 同一先例：列为**发布期门禁**（`release.yml` desktop-smoke / `ci.yml` remote-ssh），
  不是本批验收依据。
- **desktop 端到端冒烟（起窗口、跑一轮对话、恢复会话）同样不可跑**，如实登记。
- headless 可跑的部分（本轮已跑）：CLI 测试 3,243 / services 585 / bootstrap typecheck /
  `architecture:check --changed`。见 §9。

---

## 9. 核验证据块（A–E）

> 本批两段均已实施并验证。A–E 记录实测终态证据。

**A. services 消费计数**
`git grep -c "acodeProtocolMethods\." -- packages/services/src` →
`acodeAgentService.ts:4`（sessionSubagents / pluginsCancelOperation / sessionSend×2，
全部落在 §0 幸存清单）、`pluginReferenceCatalogRequest.ts` **0**（catalog 两级回落已删，
`acodeProtocolMethods` import 随删清出）。合计 **4**（幸存清单内）。

**B. v4 → legacy 反向 import**
`git grep -c 'from "\(\.\./\)*acode-protocol/[a-z0-9-]*\.js"' -- apps/acode-cli/packages/bootstrap/src/acode-protocol-v4`
→ 退出码 **1**（**零命中**）。25 条边全部解除（整目录迁入 `acode-protocol-v4/`）。

**C. bootstrap legacy 目录**
`test ! -d .../acode-protocol` → **目录已删除**（40 文件全部迁入 `acode-protocol-v4/`）。
`server.ts`：`case acodeProtocolMethods.` **12 → 3**（幸存三词），`case V4_METHODS.` **76**，
`case PROVIDER_DIAGNOSTICS_METHODS.` **2**。`v4-bridge.ts` 已删除（收编为 `v4-binder.ts`）。
`server-operations.ts` 随删除收窄 **3,639 → 3,438 行**（forkSession / stopSession /
cancelBackgroundTask / setThoughtLevel 及其独有 helper resolveForkTarget / resolveTurnMessageId /
ensureNoActiveTurn / pauseActiveGoalForSessionStop / isUserVisibleSessionMessage 与 4 个
legacy params schema import 全删）。

**D. 套件（两段真跑，均全绿）**
- 纯搬迁段：`pnpm --dir apps/acode-cli test` → `tests 3243 / pass 3206 / fail 0 / skipped 37`。
- 删除段：`pnpm --dir apps/acode-cli test` → `tests 3243 / pass 3206 / fail 0 / skipped 37`
  （与搬迁段一致，**无回归**）；
  `pnpm --filter @acode/services test` → `tests 585 / pass 578 / fail 0 / skipped 7`。
- typecheck：`npx tsc --noEmit` 于 bootstrap / cli / cli-workflow / services 均 exit 0。
- `node scripts/architecture/architecture-check.mjs check --changed` → exit 0，
  搬迁后 `violations: 42 / baseline: 42 / new: 0 / regrown: 0`。
- 冒烟：`npx tsx src/main.ts --help` 正常输出；`tsx src/main.ts acp </dev/null`
  起 ACP 适配器不崩（`[acp] client connected`）；`tsx -e import(...)` 直接加载
  `acode-protocol-entrypoint.ts` 与 `acode-protocol-v4/server.ts` 均 OK。

**E. 台账与架构基线**
- 台账（只登记不自改）：`node scripts/licenses.mjs reproducibility --inputs-only` →
  **2902 项中 1 项漂移**：`packages/ui/src/components/ai-elements/markdown-table.tsx`
  （台账 `adfaad8d…` / 实际 `48309e23…`）。该漂移来自**并发 UI 代理**，不归 M3；
  按纪律不本地重生成，交发布流程 CI Linux 回补。
- `.architecture-baseline.json`：定点收窄——**删除 7 条** `acode-protocol/*` 旧路径
  max-file-lines 条目（6 条随搬迁改指 + 1 条 `plugins.ts` 陈旧条目），**新增 6 条**
  `acode-protocol-v4/*` 新路径条目（沿用仓库 fingerprint 算法，实测复算一致）。
  净 412 → 411。`architecture-policy.yaml` **零改动**（实测 cli 域无 `src/acode-protocol/`
  例外条目，无对象可收窄）。

---

## 10. 收尾说明（两段已落地）

1. **纯搬迁段**：40 文件整目录迁入 `acode-protocol-v4/`（唯一改名 `v4-bridge.ts →
   v4-binder.ts`），25 条 v4→legacy import 解除，6 钩子收编为必填原生宿主能力
   （`commands/types.ts` / `v4-gateway.ts` 字段转必填并去过渡框架），76 v4 case +
   dispatch 随 `server.ts` 迁 v4，entrypoint 只装 v4 server，`transport.ts` 迁 v4 侧。
2. **删除段**：删 9 个非幸存 legacy case（sessionStop / sessionCancelBackgroundTask /
   sessionFork / sessionSetThoughtLevel / pluginsReferenceCatalog×2 / runtimeCapabilities /
   usageStats / sessionUsage）+ 对应死 op 函数与级联 helper + services catalog 回落链 +
   `transport.ts` 的 legacy 旁路词；`acode-protocol/` 目录消失。
3. **幸存面**（3 词）收敛为最小登记模块，头注写明裁决依据与移除条件
   （`server-operations.ts` / `subagent-session-query.ts` 头注 + `server.ts` case 注释）。
4. 遗留事项见实施报告 §8。
