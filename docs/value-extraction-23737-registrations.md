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

## 9. 第二轮登记项（2.37337 六路深挖增量）

> **来源与基线**：本节来自第二轮六路深挖清册（同一还原工程 `~/Desktop/zoode/Claude-2.37337`
> 的只读研究；清册逐条记录证据行号，立项落地前以原文复核）。撰写基线：分支
> `feature/value-extract-23737-r2`，HEAD `73d0b3b`，工作区干净。格式统一为**机制一句话 +
> 价值/现状对照 + 触发条件/前置决策**。本节与全文一样**只登记、不实施**。
> **同批并行声明**：本波次其他代理（W1-4/W1-7/W1-8/W1-11/W2-M1）承接的实施面在对应条目
> 内标注；撰写本节时分支上均未见其提交/spec，合入后对应条目以其 spec 为准复核，登记不替代
> spec。

### 9.1 灰度三档范式（off/shadow/enforce）

- **机制**：交付路径上新增处理步骤的特性统一走三档灰度——off 关闭；shadow 先交付原件、
  并行执行处理只记结果（带超时）；enforce 先处理再交付，**处理失败/超时降级交付未处理
  原件，永不阻塞用户**；结果落 outcome 闭集词表（含「过大跳过」类跳过原因），延迟计量带
  冷启动标记（首次调用与稳态区分）。
- **价值/现状**：外部实例是媒体交付的内容来源签名步骤（签名本体不可移植——厂商私有签名
  后端 + no-telemetry 红线；取的是范式）。任何「先处理再交付」类步骤（签名/扫描/转码/
  脱敏）的零风险上线标准形：shadow 档先收真实延迟与失败率，用户可见行为零变化。ACode
  已有闭集词表纪律（第一轮已落地），本范式把它升级为「上线流程模板」。
- **触发条件/前置决策**：任何交付路径（日志导出、工件物化、远程资产分发）新增处理步骤时
  套用。前置决策：no-telemetry 红线下 outcome 闭集落**本地结构化日志**（debug 级），
  不做任何上报。

### 9.2 CRDT 人机并发草稿合并三态协议

- **机制**：外部内容（agent/远端写入）到达用户正在编辑的活草稿时，先做重叠检测（外部变更
  区间 × 用户未提交输入），按三态处置——本地基线缺失或已过期（ghost stale）= **拒绝合并**；
  零重叠 = 静默并入；有重叠 = 弹 hunk 级 diff 审查（变更区间高亮 + 内容哈希幂等防重复
  应用 + pending/saving/idle 状态机）。
- **价值/现状**：ACode composer 是 Lexical 全量状态替换（`packages/ui/src/LexicalChatInput.tsx`），
  草稿 renderer 本地 + CommandInbox 串行准入——当前**不存在「外部写进活草稿」场景**，
  串行准入是更简单的正确解，**不因外部有 CRDT 而追**。登记价值是协议本身：三态 + 内容
  哈希幂等 + 「无基线即拒」是该场景出现时的现成参照。
- **触发条件**：手机远控/多窗口允许外部 steering 写入桌面 composer 活草稿成为需求
  （挂 `docs/mobile-device-control-gap-audit.md` 同域裁决）。

### 9.3 会话骨架启动占位

- **机制**：启动首帧直接绘制**上次会话真实布局**的骨架矩形（形状列表 + 侧栏宽度/折叠态/
  zoom，经启动参数注入 HTML、由内联无框架脚本在首帧绘制；形状数量与值域校验、延迟持久化；
  无持久数据回退合成默认骨架），用户看到「自己的界面轮廓」而非通用 loading。
- **价值/现状**：感知启动质量直接提升（外部量级 S-M）。ACode 现有 renderer 入口 HTML 的
  `#loading` 动画遮罩 + `acode-startup-ready` 移除，及 T0-T3 启动计时
  （`packages/desktop/src/main/desktopLaunchMarks.ts`）；侧栏布局在 Zustand persist 已有
  数据源，矩形采样上报是新增小面。
- **触发条件**：桌面启动体验立项。**复核记录**：撰写本节时分支 HEAD（`73d0b3b`）无对应
  spec（boot placeholder/骨架占位类关键词零命中），按规则登记；本批 W1-7 正在实施该项——
  其 spec 合入后以 spec 为准，本条登记自动失效。

### 9.4 引导式 onboarding 机制三件套

- **机制**：agent 驱动的 onboarding 三个机制件——①beats 脚本：固定叙事节拍（角色框架→
  选择器工具→插件建议→技能试用→connector→收尾），一次一步、显式回合边界（「在此结束
  回合，用户会自己点按钮」）、可随意跳过、带 dismissal 分支；②UI 数据主权：选择器选项
  列表**硬编码在前端、不由模型供数**——防模型编造/污染选项；③技能打断-返回协议：
  onboarding 中途用户调技能是预期行为，帮完必须用桥接句拉回原节拍。
- **价值/现状**：ACode 无 agent 驱动 onboarding（仅设置页对话框）。三件套是立项时的机制
  模板；「UI 数据主权」同时是通用注入防御设计（模型输出不作为选项面数据源）。
- **触发条件**：desktop onboarding 立项（产品决策先行；机制三件套可先落 spec）。

### 9.5 playbook 型技能形态

- **机制**：大型技能三层渐进披露——极简路由 SKILL（意图→子文档路由表）→ 分语言/分场景
  README（按需只读所需层）→ 深度指南（迁移指南级大文档）；配两条写作纪律——度量口径
  声明（「以会话数计不以请求数计」式口径钉死指南的成功指标）与反总结指令（「执行步骤
  本身就是交付，禁止向用户复述指南正文」）。
- **价值/现状**：大体积技能控制常驻上下文成本的结构性范本（ACode 技能目前全文常驻）；
  度量口径与反总结指令可进技能写作规范。外部指南正文内容专有不可搬——只取形态与纪律。
- **触发条件**：技能体积超出上下文预算，或技能写作规范增补（与
  `apps/acode-cli/specs/skill-seeding-registration.md` 同批评估）。

### 9.6 轻常驻唤起窗产品面（quick-entry 四件）

- **机制**：桌面轻常驻唤起窗（全局快捷键唤起的常驻小窗：无边框/置顶/不进任务栏）产品面，
  四件独立机制——①全局快捷键**三槽位注册表**：accelerator 白名单校验（字母数字/小键盘/
  符号 + 必须含修饰键或功能键），非法值给闭集原因并**回滚到上一个可用键**，设置变更自动
  重注册；②**焦点归还带 TTL**：show 前记录前台窗口句柄 + 时间戳，dismiss 后归还，超时
  （30s 级）不再归还；③**IME 候选窗避让**：renderer 输入防抖后上报容器尺寸，main 按最近
  显示器工作区计算——放得下不动，放不下平移让位（候选窗不被遮）；④**提交身份戳**：打开
  窗口时记下当前活跃账号身份，提交时校验账号未变，变了则丢弃 payload + 聚焦主窗 + 显式
  报错（「账号变了消息没发出去」）。
- **价值/现状**：ACode 无全局快捷键面（globalShortcut 零命中）、无轻量唤起窗（仅 tray）；
  窗口持久化只存尺寸不存位置/显示器（`packages/desktop/src/main/desktopWindowSize.ts`）。
  ④是**账号时变维度**的 stale-submission 防护，与 workspaceIdentity 的空间维度身份纪律
  （AGENTS.md）同构互补，远程发送链路直接受益；③对中文输入用户直接相关；①适用于未来任何
  快捷键设置面。形态本身（是否做 quick-entry）是产品裁决，四单件可独立移植（S 级/件）。
- **触发条件**：桌面快捷唤起产品决策（形态）；单件无强触发。注：②焦点归还 TTL 由本批
  W1-8 承接实施（CUA/浮窗面），本条不重复登记——撰写时分支尚未见其提交，以其 spec 合入
  后为准。

### 9.7 sidecar 捆绑 CLI 带外更新全链

- **机制**：桌面替捆绑 CLI/agent 二进制做带外更新的完整门控链——远端开关三分解析（正常/
  畸形=完全停找更新直到修复/未知=忽略但告警前向兼容）；签名 manifest + 分离签名（域分离
  签名上下文 + 内嵌 ed25519 根公钥；流式下载带字节上限与中止）；floor 版本参与比较；
  错峰下载（安装 ID + first-seen 时间戳推导确定性延迟，未到点日志给 ISO 时间点）；门控
  原因全进闭集（签名无效/错峰等待/封顶/拉取失败类）；原子换目标；商店托管更新的打包形态
  整体禁用。同族应用本体更新器另有**版本封顶（cap）**与**宿主忙碌感知延迟检查**。
- **价值/现状**：`packages/desktop/src/main/autoUpdater.ts` 已有通道状态机/single-flight/
  defer-skip 原因日志；无捆绑 CLI（`packages/acode-server-cli`、bundled-agents）的独立
  带外更新链，无 floor/cap/错峰/签名 sidecar。cap 封顶、忙碌感知、门控闭集三件对现有
  更新器是直接增量。
- **触发条件**：全链（L）= 桌面决定带外更新捆绑 agent/CLI。三件增量由本批 W1-11 承接
  实施——撰写时分支尚未见其提交，以其 spec 合入后为准；本条保留全链触发条件。

### 9.8 企业配置分层全层

- **机制**：managed（OS 托管源批量读；**整键无一可识别→managed 不可用且 local 层一并
  禁用**的 fail-closed）→ local（命名配置档位：档位元信息 + 键 allowlist + schema 校验
  带失败替代值记录）→ remote（服务端下发：bootstrap URL 校验 + 本地缓存回退 + 指针必须
  命中组织白名单）三层合并，合并产物**逐键溯源**（哪层给的/被拒/替代值/等待首次下发）；
  每个配置键带元数据 schema——作用域/可用版本/执行目标/failClosedValue/脱敏策略
  （哈希或保留）/警告谓词/i18n 文案/**egress 需求声明**（该键配置需要通哪些网络端点，
  变成同意 UI 里可展示可同意的文案）；**值哈希同意闭环**（同意记录存值的哈希，启动只对
  哈希不匹配的键重弹同意窗；键改名走旧名表兼容——值没变不打扰；同意库读取失败→全量重问
  fail-closed；拒绝→退出应用）。
- **价值/现状**：`packages/shared/src/node/managedPolicy.ts` 已是「只能收紧」策略地板
  （哲学对齐）但词汇只覆盖权限面；hooks 信任已有 bundle 摘要（`f0cb539`）。值哈希扩展
  （失配即重问 + 改名兼容）是其直接扩展；全层是企业版配置治理的完整蓝图。
- **触发条件**：全层（L）= 企业版立项。两件可先行单件——hooks/MCP 信任 digest 的值哈希
  扩展、每键元数据三字段（脱敏/作用域/警告谓词）在现有配置 schema 试点——由本批 W1-11
  承接实施；撰写时分支尚未见其提交，以其 spec 合入后为准。

### 9.9 模型目录下发链

- **机制**：模型清单远端下发——签名文档（schema_version/单调 version/签发时间/7 天有效期/
  key_id）+ 本地缓存（内容哈希/etag/新鲜窗 ~16min）+ 独立 floor 元数据文件 + 5-15min
  抖动轮询 + fail-closed 哨兵 URL（配置不可读→显式 `.invalid` 哨兵而非静默失败）+ 私网
  主机名拒绝 + 文档/签名字节上限；**设置词表把枚举映射为稳定数值编码**（档位 1..N、模式
  1/2/3 类），设置持久化存数字——服务端枚举改名不破坏存量设置。
- **价值/现状**：ACode 模型清单构建期内置（Bundled/Active-LKG/Remote 三源同 Release，
  `packages/provider-node`）；全链是模型目录云化时的完整范式（中远期）。**稳定数值编码
  单件可立即借鉴**——适用于任何「远端可改名枚举」的持久化面；ACode 已有历史值域只读解析
  先例（`packages/provider-node/src/legacy-reasoning-level.ts`），数值编码把「兼容改名」
  从事后补丁变成事前契约。
- **触发条件**：模型目录云端下发立项（全链）；数值编码单件无强触发——下次触碰设置持久化
  面时顺带评估。

### 9.10 ToolSearch 延迟工具加载（本体）

- **机制**：工具 schema 不默认进提示词；延迟工具只以名字出现在提醒里；经关键词检索
  （BM25 + regex 双引擎）或显式批量选择（一次取回整个工具集，避免每工具一个往返）取回全
  schema；部分未命中→MCP 刷新→重试→给 found/missing 清单；工具注册可声明不延迟；MCP
  server 可整体延迟。配套文案模式：预载例外声明（「本 server 工具已预载，勿再检索」）、
  错误教装载编舞（拒绝文案自带「用哪个查询装载哪个工具、已有状态如何复用」）、flaky
  降级阶梯、缺席即诊断。
- **价值/现状**：常驻工具 schema token 成本的结构性解法；ACode 插件生态已不小（emulator
  18 工具/agent-teams/workflows/CUA）。立项判据已钉在
  `apps/acode-cli/specs/tools-schema-token-metrics.md`——「tools schema token 占比
  > 15%」且明言不承诺实施；该 spec 的度量实现由本批 W2-M1 落地。
- **触发条件**：度量出数、判据成立→按 spec 立项（蓝图齐备，L）。三个文案模式（错误教
  装载/降级阶梯/缺席即诊断）是纯机制，可独立先行进 MCP 生命周期与工具错误规范（S）。

### 9.11 插件引擎二期：UI mod 面

- **机制**：代码级插件的 UI 面——插件拿唯一沙箱出口对象（ui/state/store/clock/tool/agent/
  model/fs/process/audio/command/session 类命名空间访问器），JSX 经注入的全局工厂函数编译，
  UI 元素表按宿主 surface 解析（一份 mod 在终端/桌面/编辑器/移动多端渲染），原子化 UI
  状态（atom read/update，每键必须在状态契约中声明并由校验钉死）；无 Node/DOM 沙箱——
  出口对象即全部能力边界。
- **价值/现状**：ACode 插件面是 manifest 贡献（skills/commands/hooks/MCP），无代码级
  hook 引擎与 UI mod 面。一期（hooks 中间件语义 + 失败可见性）已在第二轮清册的 CLI 插件
  体系簇内另行排期推进；本条登记二期 UI 面——「一份 mod 多端渲染」的元素表设计对 ACode
  多形态（desktop/CLI）有长期价值。
- **触发条件**：TUI/桌面渲染架构评估（预研登记，L）。

### 9.12 系统 OpenSSH 进程引擎

- **机制**：SSH 双引擎——内置协议库之外提供「系统 OpenSSH 进程」引擎：版本硬门槛（9.4
  级起）、组织可钉路径、解析序 managed→PATH→系统标准目录、失败原因闭集；收益是继承用户
  全量 ssh config/agent 转发/跳板机生态。安全前提是一整套验证逻辑（对方 ~15k 行量级）：
  一切交互提示全量中介到应用 UI（每连接随机命名管道 + token + asker 进程验证）、secret
  顺序闸（对端身份未经确认前任何 secret 提示不予展示）、路由拼写对拍（跳板指令展开后
  逐行等价求值验证）、host key 伪造检测。
- **价值/现状**：ACode 为 ssh2 单引擎，别名解析静默丢弃 proxy/jump 键
  （`packages/services/src/system/sshConfigAlias.ts`）——该缺口属 S 级立即修复项
  （检测 proxy/jump/Match 键→显式拒绝并解释；keyboard-interactive 停止用同一密码应答
  全部提示），已在第二轮清册的 S 级先行批排期视图内、不由本条承载；进程引擎是根治方案，
  跳板机/硬件密钥/复杂配置用户获得完整生态继承。
- **触发条件**：跳板机/ProxyCommand 用户成为远程 workspace 主流形态。**成本提示**：对方
  ~15k 行验证逻辑是该引擎的入场券——缺任何一块（例如只 spawn 进程、不做提示中介与路由
  对拍）都是倒退：把「继承用户配置」变成「继承用户攻击面」。要么整链，要么不做。

### 9.13 V8 compile cache

- **机制**：构建期在隔离环境为主 bundle 生成 V8 字节码缓存（按 arch 命名随包分发；构建
  token 比对防非发布环境缓存混入），运行期同一 hook 加载、缓存被拒计 miss、全局
  hit/miss/partial 可观测标记。
- **价值/现状**：冷启动优化（外部实例随包缓存 6.7MB）。ACode 有 T0-T3 启动计时
  （`packages/desktop/src/main/desktopLaunchMarks.ts`）承接收益验证。**前置决策**：先
  benchmark T1-T3 段（Electron main 进程段）收益再决定是否随包；CLI 侧 Node 22 的
  `module.enableCompileCache()` 官方 API 可替代自制 hook。
- **触发条件**：桌面启动性能立项（先测出数据）。

### 9.14 凭据 fail-closed 无回退（P0-4 收尾参照）

- **机制**：平台加密凭据的域分离 blob——解密必须带版本化前缀否则拒收；原生加密面不可用
  时**直接抛错，无明文/可离线推导回退**（错误文案给用户可执行出路）；配套一次性 token
  交接文件（读后零覆写再删除、弃用主动吊销、singleflight、outcome 闭集）。
- **价值/现状**：ACode P0-4 已落地——密钥来源改为每安装随机 / OS 钥匙串
  （`packages/shared/src/node/credentialMasterKey.ts` 五级解析），`enc:v1:`/`enc:v2:`
  版本化前缀与「域分离」已同构；可推导串仅剩**历史 v1 密文解密路径**
  （`packages/shared/src/node/credentialCipher.ts` 的 legacy key 派生，decrypt-only
  从不 encrypt）与钥匙串不可用时的密钥文件降级模式。外部形态更彻底：无任何 legacy 解密
  回退、原生面不可用即 fail-closed。
- **触发条件/前置决策**：P0-4 收尾裁决（`docs/security-hardening-plan.md`、
  `docs/credential-os-keychain-design.md` 关联）。移除 v1 legacy 解密有真实兼容性代价
  ——存量未迁移密文立即失效→强制重登录；降级模式是「诚实降级」vs「降级即拒」的取舍。
  **须与用户对齐迁移语义（重加密窗口 vs 强制重登录）后再动，不自行移除回退**。一次性
  token 交接文件单件可供桌面↔CLI 凭据交接面独立参照。

### 9.15 原生 Job Object 围堵 + 效果验证

- **机制**：OS 级进程作业围堵（句柄关闭即杀整棵进程树）+ **效果验证层**——首个子进程
  spawn 时原生查询该进程是否真的在作业内，不在则 error 点名归因（「join 发生在首 spawn
  之后」类），N 次失败退订防噪声；结果走 outcome 闭集。
- **价值/现状**：「下了机制 + 实测机制生效」的双段式是本体价值。ACode 现状 job object
  只覆盖 MCP stdio 子进程、失败静默回退 taskkill（`docs/vm-sandbox-roadmap.md` §3.1），
  无效果验证层；预热/备用进程面的孤儿风险是 ACode 已实证痛点（vm-sandbox-roadmap §4
  阶段一、`packages/services/specs/agent-process-prewarm.md`）。
- **触发条件**：引入/扩展 FFI 依赖的决策（现有 koffi FFI 面）。本批 W1-4 视调查结果可能
  已承接替代形态（Bash 子进程收容扩展/fail-closed 化）——实施前对表其结论，勿重复；若
  W1-4 已覆盖收容面，本条只剩「效果验证层」增量。

### 9.16 一句话登记批（七件）

| #   | 登记项                 | 机制一句话                                                                                                                        | 触发条件/备注                                                                                         |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | 音频 worklet 流式 sink | TTS/语音模态的低延迟音频输出组件（音频工作线程流式喂数）                                                                          | ACode 无语音面，仅登记；语音模态立项                                                                  |
| 2   | 渲染层特性开关 SDK     | 外部经第三方灰度 SDK 做 UI 特性开关；ACode 远端公开配置面（clientConfig/remoteAppConfig）无逐特性 flag                            | no-telemetry 红线下第三方 SDK 不可用，自建需服务端下发面；UI 灰度需求 + clientConfig 扩展裁决         |
| 3   | 富剪贴板               | 剪贴板多 MIME 写入（代码块复制为带高亮 HTML、图复制为 PNG）；ACode 现以 writeText 为主                                            | 编码 agent 价值低于消费级产品；随复制体验需求                                                         |
| 4   | tree-sitter 增量高亮   | 编辑区间增量重解析 + 流式代码块高亮；ACode shiki 一次性高亮已优秀但在主线程                                                       | 做流式代码块增量高亮或大代码块渲染 profile 瓶颈时进性能候选清单                                       |
| 5   | 渐进模糊匹配器         | typed-array 位并行模糊匹配 + 时间片构建（数百条/数 ms 级）+ 代数取消 + 构建中途可查                                               | 挂文件索引面（`packages/services/src/file/fileService.ts`）；大仓索引性能立项时与第一轮索引降级栈同批 |
| 6   | 合成 503               | 被阻断/被拒/离线的外发请求统一合成 503 响应，让上层走同一错误路径优雅降级而非网络异常                                             | 与目的驱动端点注册表同批；桌面网络策略面立项                                                          |
| 7   | 三档隐私开关           | 必要遥测/非必要遥测/非必要服务三档外发开关，企业配置键 failClosedValue=true——配置读不出按「已禁用」处理（fail-closed 向阻断方向） | ACode no-telemetry 红线下本无遥测可关，形态待定；企业版/审计版网络面立项时作参照（与端点注册表同批）  |

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
