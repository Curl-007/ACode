# 价值提取 23737 轮 · T3 登记项对照

> **定位**：登记/对照文档，**不实施任何改动、不是 spec**。对外部研究 T3「登记项（低优先/
> 条件触发）」逐项核实 ACode 现状并给出跟进判定。其中「周期摘要 digest 与 scheduled 语义」
> 两项由本波次后续代理实施，本文只登记外部机制要点与 ACode 现状锚点供其参照（§8）。
> **机制情报来源**：对某桌面 agent 产品 2.37337 版还原工程的只读研究（T3 节及 T2-7/T2-9）。
> 证据在本地研究工程 `~/Desktop/zoode/Claude-2.37337`（受 EULA 约束，禁止再分发；本文只搬运
> 机制设计，不使用厂商内部代号，外部 env 键/配置键名一律转译为语义描述）。
> **核实基线**：分支 `feature/cli-value-extract-23737`，HEAD `8898032`。全部 `file:line`
> 以该 HEAD 的干净检出核实；本波次其他代理正在同一工作树并行改动 `apps/acode-cli`
> （permission/service、mcp、errors、hooks 等）与 `packages/ui`——**本文的个别「无对应面」
> 结论（尤其 §8 审批 TTL）在并行改动合入后会过时**，实施前必须对最新检出复核。
> **生成日期**：2026-10-15。

---

## 判定总览

| #   | 登记项                             | ACode 现状                                                                                          | 值得跟进       | 建议级别 |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------- | -------------- | -------- |
| 1   | 3P/BYO provider 配置语义           | trim/非空已实现；**无长度上限面**                                                                   | 部分           | S        |
| 2   | 逐模型 effort/能力默认表           | 机制同构且更工程化（CEL 映射）；「默认=最高档」是产品决策                                           | 是（条件触发） | 登记     |
| 3   | 子代理/workflow prompt-cache TTL   | miss 归因已落地（含疑似 TTL 过期）；无请求侧 TTL 控制面                                             | 低             | 登记     |
| 4   | env 命名规约                       | 340 个唯一 `ACODE_*` 字面量，分层自然存在但无权威注册表                                             | 是             | S        |
| 5   | access bundles（组织级命名连接集） | 无对应面；三个半成品基座（托管策略/clientConfig/官方服务开关）                                      | 条件触发       | 登记     |
| 6   | 语义层索引方法学（preload 面审计） | 无审计工具；桥面集中度数据首次盘点（§7）                                                            | 是（工具自建） | 登记-M   |
| 7   | 周期摘要 digest                    | 无 digest 面；heartbeat 决策协议已落地                                                              | 波次 3 参照    | 登记     |
| 8   | scheduled 语义细节                 | automation 轮写工具拒绝已落地；无 userActivation/迁移可撤销；审批 TTL 本波次已有并行实现（§8 预警） | 波次 3 参照    | 登记     |

---

## 1. 3P/BYO provider 配置语义（空串=未设、超限拒绝而非截断、trim）

**外部机制要点**（证据：研究工程 prompts-and-long-strings.txt 行 26107/25811）：第三方
provider 模式的配置值 3,000 字符上限、读入即 trim、**空串视为未设**、超限**拒绝而非截断**；
凭据键缺失/无效显示配置错误；含「禁用部署模式选择器」开关。

**ACode 现状**（`packages/provider/src/config/**`，已核实）：

- **trim/非空 = 已实现**：`nonBlankRequiredString`（`provider-data-schema.ts:25-28`，
  `trim().length > 0` 违规报「必填配置不能为空」+ 结构化 issueCode）；apiKey/credentialRef
  「至少一个非空」完整性约束（`:47-59`）；baseUrl 非空 + URL 校验（`:84-89`）。
- **空串=未设 = 已实现（存储层）**：`ApiKeyAccessConfig` 的 overlay 以
  `next.apiKey !== undefined` 判「用户是否提供了新值」（`provider-config.ts:68-76`）；
  落盘时「有 credentialRef 就只写 ref，绝不写 apiKey 明文」（`:91-109`，安全加固 P1-5
  已落地的互斥语义）。UI 草稿层 trim + 尾斜杠归一（`packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts:15,45,62`）。
- **超限拒绝而非截断 = 无对应面**：全 schema 无任何 `max` 长度约束——apiKey/baseUrl/
  headers 值多长都接受。截断风险不存在（ACode 从不截断），但「异常长值静默接受」与外部
  「超限拒绝」的输入卫生哲学有差距。

**判定**：部分值得跟进。**建议（S）**：给 apiKey/baseUrl/headers 键值加长度上限
（zod `.max()`，违规 = 结构化配置错误，不截断），上限值归口常量；与 http 明文端点告警
（security-hardening-plan P2#7）同批触碰 `provider-data-schema.ts` 时顺带落地。

## 2. 逐模型 effort/能力默认表

**外部机制要点**（证据：prompts-and-long-strings.txt 行 9210 起）：模型选择器状态配置
JSON 携带**逐模型 thinking effort 默认值**与能力开关——「每个模型的默认档」是配置数据，
不是代码分支。

**ACode 现状**（已核实）：

- 选项规格逐模型声明：`ModelOptionSpecsConfig`（reasoningLevel 枚举 + maxOutputTokens
  上限，`packages/provider/src/config/model-config.ts:246-276`）；注册表校验选中档位
  必须在 values 内（`packages/provider/src/registry.ts:133-155`）。
- **默认档 = 枚举最后一位（最高档）**：`completeNewModelSelection` 取
  `values.at(-1)`（`packages/provider/src/model-selection-config.ts:57-72`，注释明写
  「仅在用户主动选模型或全新初始化时构造最高档」）——是**全局产品决策**，不是逐模型
  默认表。
- 档位→请求体映射比外部静态表更工程化：restricted-CEL 程序编译为 JSON merge patch
  （`packages/model-option-map/src/option-maps.ts:19-34`；类型与错误
  `types.ts:9-38`），Model 创建时编译一次、每请求绑定冻结值。
- 内置配置分发已有三源同 Release 机制（Bundled/Active-LKG/Remote，
  `packages/provider-node/src/acode-builtin-provider-config-source.ts:20-24`）——
  「逐模型默认表」若引入，天然走这条内置配置通道而非代码。
- 历史值域恢复有先例（旧档位名 off/nothink 的只读解析，
  `packages/provider-node/src/legacy-reasoning-level.ts:11-13`）。

**判定**：机制同构、无需照抄；差异点仅在「默认档是全局规则还是逐模型数据」。**建议
（登记，条件触发）**：当「默认最高档对廉价模型过贵/对某些模型不适用」的反馈出现时，把
`optionSpecs` 扩一个 `defaults.reasoningLevel` 键（内置配置下发，overlay 机制现成，
`model-config.ts:259-266`），`completeNewModelSelection` 改为「逐模型默认 > 枚举最后位」。
不新增第二条配置写入路径。

## 3. 子代理/workflow prompt-cache TTL

**外部机制要点**（证据：prompts-and-long-strings.txt 行 44115）：子代理/workflow/后台
请求有**专属 prompt-cache TTL 控制**（专用 env 键族）——后台请求可以用更长/更短 TTL
与前台对话区分。

**ACode 现状**（已核实）：

- **诊断侧已落地**（旧方案 P3「prompt-cache 诊断」已消费完毕）：miss-cause 归因闭集
  （`apps/acode-cli/packages/contracts/src/events/session.events.ts:789`，spec
  `apps/acode-cli/specs/prompt-cache-diagnostics.md`）；唯一判定点 + 归因优先级
  「显式本地事件 > 换模型 > 闲置疑似 TTL > unknown」
  （`core/src/runtime/methods/turn-model-step-usage.ts:146-155、184-201`）；
  `CACHE_TTL_SUSPECT_MS = 5min` 疑似 TTL 过期（`:179-182`，UI 必须标「疑似」）；
  显式 miss 事件源含 compact/context-refresh/control-only-turn/microcompact/rewind
  （各 methods 文件头注引用 spec R1）。
- **控制侧无对应面**：请求构造统一 `EPHEMERAL_CACHE_CONTROL`
  （`core/src/context/builder.ts:150,166,180`；`core/src/agent/message-history.ts:30,63`），
  无按请求类型（子代理/workflow/后台）区分 TTL 的参数面，也无相应 env。

**判定**：低。**建议（登记）**：TTL 是 provider 侧能力，ACode 经 AI SDK 只表达
ephemeral；在 provider 请求面暴露 TTL 档位前不跟进控制侧。诊断侧可留一个观察项：
子代理/workflow 请求的 miss 归因是否与主对话显著不同（数据已在 missCauses 里，
无需新代码）。

## 4. env 命名规约（ACODE\_\* 前缀盘点）

**外部机制要点**（证据：研究工程 docs/index/string-index.md envVars 节）：五段式前缀
分层——agent 运行时 / Electron 壳 / 测试 harness / host 契约 / 供应商，各有专属前缀；
另有子进程 env 清洗开关与后台分类器独立选模等专项键。

**ACode 现状**（抽样核实）：

- 规模：`apps/acode-cli/packages/*/src` + `packages/*/src` 内唯一 `ACODE_*` 字面量
  **340 个**（grep 去重计数）。
- 分层**自然存在但无成文规约**，抽样归类（按第二段前缀计数）：OFFPEAK(12)/CUA(9)/
  TELEMETRY(8，全部为「剔除用」遗留键，`packages/shared/src/runtimeEnv.ts:92-104`)/
  REMOTE(8)/AGENT(7)/SERVER(6)/DESKTOP(6)/PLUGIN(5)/MODEL(5)/TEST(3)/E2E(3)…
- 已有集中声明点：运行时/host 契约键集中在 `packages/shared/src/runtimeEnv.ts:8-30`
  （`ACODE_RUNTIME_ENV` / `ACODE_HTTP_PROXY` / `ACODE_REMOTE_*` / `ACODE_AGENT_CA_CERT` /
  `ACODE_TOOL_ENV_PASSTHROUGH_JSON` / `ACODE_DESKTOP_*` / `ACODE_CUA_*`）；
  托管策略键 `packages/shared/src/node/managedPolicy.ts:20`；
  子进程继承白名单键 `packages/shared/src/sensitive-env-guard.ts:15`；
  更新源键 `packages/desktop/src/main/autoUpdater.ts:24`。
- 对照差距：① 无「哪一段前缀属于哪一层」的权威注册表（340 个散在各包）；
  ② 测试键（`ACODE_E2E_*` / `ACODE_TEST_*`）与生产键无编译期/加载期隔离声明；
  ③ 外部「子进程 env 清洗开关」ACode 已等价实现且更严（默认剥离 + 白名单 opt-in，
  sensitive-env-guard.ts:1-13 头注）——此项无差距。

**判定**：值得跟进。**建议（S）**：建 `docs/env-registry.md`（或并入 CONTEXT.md 词汇）
登记「前缀段 → 层归属 → 声明文件」映射，新增 env 必须进注册表；不改任何现有键名。

## 5. access bundles（组织级命名连接集）

**外部机制要点**（证据：prompts-and-long-strings.txt 行 18884）：管理员把「外部凭据 +
代码仓库访问 + 插件 + 自定义指令」打包为**组织级命名连接集**，挂到组织/团队工作区/
按名规则挂频道——企业分发的最小单元。

**ACode 现状**（已核实）：**无组织级配置面**。三个可作基座的半成品：

- 托管策略文件：企业可达的 OS 托管路径 + strictest-wins
  （`packages/shared/src/node/managedPolicy.ts:96-111`），但词汇只有
  deny/ask/disallowedTools/disableBypassPermissionsMode——**只能收紧，不能分发能力**。
- clientConfig 服务端公开配置：1h 缓存 + 15s 超时
  （`packages/services/src/client-config/clientConfigService.ts:11-12`），快照字段仅
  `pluginStoreOrder`（`packages/shared/src/clientConfig.ts:5-7`），注释明写「首期仅
  公开配置；账户灰度不得通过此实例或缓存复用」。
- 官方服务开关：本地用户级、默认全关
  （`packages/shared/src/officialPlatformPolicy.ts:8-16,28-36`），非组织下发。
- MCP 连接配置是 per-user/per-project 文件面，无「命名连接集」抽象。

**判定**：条件触发。**建议（登记）**：企业版/团队版需求出现前不启动。启动时的架构
约束先登记：分发通道二选一（managed policy 扩词汇 vs clientConfig 扩字段），**不得**
新增第三条配置写入路径；「凭据打包分发」与 P0-4/P1-5 的加密凭据库语义冲突，凭据
只能发引用不能发值。

## 6. 语义层索引方法学（bridge 最小面 / 配对率 / 动态引用标记）

**外部机制要点**（证据：研究工程 tools/reports/{bridge-surface,ipc-map,route-table}-report.json）：
对自有 preload/IPC 面做静态审计——每窗口一个 preload、功能窗口只给最小桥面；IPC 通道
「preload 与 main 两侧都有静态证据」的**配对率**指标（85.64%，补协议推定达 98.59%）；
运行时拼名通道被显式标记为审计风险面；类型化 RPC 工厂以通道名模板收敛动态拼名。

**ACode 现状**（首次盘点，抽样核实）：

- preload 面：8 个入口文件（`packages/desktop/src/preload/`）——主桥 `acode`
  （`preload/index.ts:221`，**121 处 ipcRenderer 调用点**集中在该文件）+ 功能窗口
  各自小桥（cuaPermissionPanel/resourceManager/codingPlanWebview/
  embeddedBrowserJavaScriptDialog/oauthCallbackBridge/browserVideoRecorder/
  embeddedBrowserWheel）——**「功能窗口最小面」的形态已经存在**，无审计工具度量它。
- 通道名类型化：`PlatformChannels` 常量表（`packages/shared/src/channels.ts:152`）
  是「类型化 RPC 工厂」的同构物；main 侧注册抽样 ~92 处 ipcMain.handle/on
  （`packages/desktop/src/main/*.ts`）。
- 无配对率审计：knip/dep-refs 是导出级工具，不覆盖「通道字符串在 preload 与 main
  两侧是否都有静态引用」；UI 经 `IPlatformService` DI（`packages/shared/src/platform.ts:585`，
  AGENTS.md 禁直调 window.acode）是行为约定，无静态守护测试钉住。

**判定**：值得自建（登记，不实施）。**建议（登记-M）**：若做 preload 面审计工具，
口径直接复用外部方法学三件套——① 每窗口桥面方法数统计（最小面度量）；② 通道配对率
（PlatformChannels 常量在 preload 侧与 main 侧的双向静态引用）；③ 非 PlatformChannels
的动态拼名通道引用显式标记为风险面。产出进 `docs/reviews/` 形态的定期报告，
可先以一次性脚本形态验证口径再决定是否常驻。

## 7. 周期摘要报告（digest）——波次 3 实施参照，本文只登记

**外部机制要点**（证据：prompts-and-long-strings.txt 行 14551-17823）：HTML 摘要邮件
形态的周期汇总——threads（进度 done 态）/ attn（需要注意）/ routines（cadence 周期
标记 + paused 态）/ PRs / artifacts（to-thread 关联）/ dismissed 折叠区，浅深两套样式。
定位是「NOTIFY 单点决策之上的**周期聚合层**」：单条自动化默认安静，聚合报告定期给
用户一个总览。

**ACode 现状锚点**（供波次 3 代理参照，已核实）：

- heartbeat 单点决策协议已落地：`<automation-notice>NOTIFY|DONT_NOTIFY</automation-notice>`
  标签协议（`packages/shared/src/automation-notice.ts:9,28-29,37,46-51`）；决策持久化
  于 run 台账（`packages/shared/src/automation-types.ts:156` notifyDecision 字段）；
  默认安静（`packages/desktop/src/host/cronRunTracking.ts:176`「触发完成本身不再是
  未读理由」）。
- 任务通知格式化面：`apps/acode-cli/packages/core/src/runtime-task/notification.ts:19-30`
  （formatTaskNotification 按 taskType 分派）+ `notification-policy.ts:9-18`
  （sealed 子代理 Bash 通知抑制）——digest 若是「聚合 N 条 run 结果」，其取数面就是
  run 台账（automation-types.ts:144-163）而非 notification 格式化层。
- **无 digest 面**：automation/cron/off-peak 无周期聚合报告（grep digest 零命中）。

**登记要点（不实施）**：digest 与 heartbeat 是互补层——heartbeat 管「这一条要不要
打扰」，digest 管「一段时间内发生过什么」。ACode 若做，触发条件：自动化数量上来后
「默认安静」变成「用户不知道后台干了什么」的可见性缺口；形态建议先进 desktop 任务
列表/设置页（本地渲染），不进邮件（ACode 无邮件面且 no-telemetry 红线约束外发）。

## 8. scheduled task 语义细节——波次 3 实施参照，本文只登记

**外部机制要点**（证据：prompts-and-long-strings.txt 行 22159/25782/18231；TTL 授权
行 25234-25240）：① 创建/修改判定先行；② 远程手动触发定时任务**需 userActivation**
（真实用户手势，防远程链路伪造触发）；③ 自动化迁移**可撤销** + 撤销按钮语义进遥测；
④ 审批 TTL 联动——无人值守场景的 MCP 工具审批可给「Allow for N days」限期持久批准，
过期回询问，托管策略可整体压制。

**ACode 现状锚点**（已核实）：

- automation 轮写工具拒绝（「创建/修改判定先行」同构物）：CronCreate/Update/Delete
  在 automation 轮 handler 级硬拒（`core/src/tool/handlers/cron.ts:39-56`
  assertNotAutomationTurn，「provider denylist 只是可见性约束，handler 以本轮事实
  终拒」）；OffPeak 侧镜像防御（`off-peak.ts:39-58` assertNotOffPeakTurn，
  SendMessage/Workflow 复用，刻意放行 cron 轮派生闲时任务）。
- 触发台账与幂等：runId 编码 trigger 来源（`automation-types.ts:130-141`
  parseAutomationRunId：`automationId:manual:uuid` / `automationId:scheduledAt`）。
- **无 userActivation 语义**：manual 触发无「真实用户手势」门槛——桌面本地触发天然
  有手势，但 bot/远程链路触发的等价物缺失（对照 security-hardening-plan P0-3 的
  bot 护栏方向）。
- **无迁移可撤销面**：ACode 尚无自动化迁移场景，此项暂无落点。
- **无审批 TTL**（对基线 HEAD 而言）：allowedTools/always-allow 是永久的，无「N 天后
  回询问」；托管策略压制通道已有（managed policy ask 压过 allowedTools，
  `core/src/permission/service.ts:202,316`）。**并行改动预警**：撰写时工作树已出现
  未跟踪的 `core/src/permission/ttl-approvals.ts` 与
  `apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md`——本波次另有代理正在落地
  MCP 工具 TTL 持久授权（外部机制要点④的直接对应物）。波次 3 动手前先对表该
  spec，勿重复建设。

**登记要点（不实施）**：波次 3 若触碰 scheduled 语义，优先级建议——审批 TTL（已有
并行实现，先对表 `mcp-lifecycle-ttl-approval.md` 再决定剩余面）> 远程手动触发
userActivation（挂 bot/远程触发链路，现成挂点）> 迁移可撤销（无场景不启动）。
TTL 授权与 vm-sandbox-roadmap §4 阶段三的 kill switch 同属「托管策略词汇扩展」，
建议合并进同一 spec 讨论。

---

## 遗留问题

1. §4 env 注册表与 §6 preload 审计工具都属「审计基建」，与 knip/dep-refs/architecture:check
   的工具边界需要所有者裁决（独立脚本 vs 并入现有检查）。
2. §1 长度上限的具体数值（外部为 3,000）不宜照抄，需按 ACode 凭据库/配置文件实际
   使用面裁决。
3. §8 审批 TTL 若实施，需先裁决「TTL 过期的 always-allow 是自动删除还是标记失效」——
   涉及 allowedTools 持久化格式，属行为 spec 变更。

---

## 对外发布说明

本文只保留机制设计层面的对照结论；外部产品证据一律以「某桌面 agent 产品」指代，
不含厂商内部代号（含其 env 键/配置键/遥测事件的字面名）、专有代码或提示词正文字面。
研究工程路径以 `~/Desktop/zoode/` 相对形式引用。后续增补保持同一边界。
