# tool-search：工具按需检索与延迟加载（波 1 = local 模式闭环）

> 来源对照：上游 ZCode 3.16.1（经 ZCodium 审计同步 `c891036`，Apache-2.0 衍生层；
> 设计契约 `apps/zcode-cli/docs/design/v2/tool/19-tool-search.md`，实现参照
> `packages/{contracts,core,adapters}` 的 tool-search 文件族与 `core/src/tool/search/`）。
> 只搬机制与语义，不拷专有文案；固定模型侧说明文案自撰。本地参照 clone：
> `~/.acode/cli/scratch/ZCodium`（audit/upstream-2026-10-19 分支）。
> 立项判据：`specs/tools-schema-token-metrics.md`（tools schema token 占比 > 15%）——
> ACode 内置工具面 40+（workflow/plan/fleet/cron/off-peak 全量常驻）+ MCP 重载会话
> （实测单会话 100+ MCP 工具）远超判据场景，用户裁决直接立项（2026-10-20）。

## 目标与非目标

**波 1 交付（本 spec）**：`off | local | auto` 三值模式链 + ToolSearch / DeferredToolCall
两个控制工具 + local 请求投影（functions 容器结果位展开）+ compact 检查点提升 +
公告与持久化水合 + App 设置与 CLI 参数面。默认 **off**，不开启时零行为变化。

**非目标（登记波 2）**：native 模式实装（Anthropic `advanced-tool-use-2025-11-20`
beta 接线、deferred schema、tool_reference 原生协议）——波 1 只做能力探测与显式报错；
OpenAI 原生引用、auto:N、异步 MCP 就绪等待、搜索等待、历史调用自动补装——与上游
同款不做。

## 产品规则

### R1 模式与取值域

- `ToolSearchMode = "auto" | "native" | "local" | "off"`；`ResolvedToolSearchMode` 排除 auto。
- App 设置 `toolSearchMode: "auto" | "local" | "off"` 三值，缺省 `off`；非法值拒绝（zod）。
- CLI `--toolsearch-mode auto|native|local|off` 四值，未传默认 off；CLI 独立运行不读
  App 设置；启动覆盖支持 prompt/target/TUI/resume/continue 全入口。
- `auto` 解析：当前实际 Model 具备 native 能力（R2）→ native；否则支持普通工具调用 →
  local；都不满足 → off 并记录原因。**波 1 中 native 能力恒为 false**（见 R2），故
  auto 实际解析为 local。
- 显式 `native`（CLI）在波 1：发送前显式报错「本构建未实装 native 工具搜索」，不静默
  降级；显式 `local` 遇到模型不支持普通工具调用同样发送前报错。

### R2 能力探测

`resolveToolSearchCapability(model)` → `{ protocolSupported, defaultEnabled }`：
protocolSupported = 模型 apiType 为 anthropic-messages；**defaultEnabled 恒 false**
（ACode 无 coding-plan 商业面；上游 defaultEnabled=coding-plan 条款不移植）。
native 实装（波 2）前 `protocolSupported` 仅作登记，不参与 auto 解析。
**波 1 落点说明**：wire 层实现（capability 解析 + `anthropic-beta` 头合并，beta 值
以 contracts `TOOL_SEARCH_BETA` 为准）刻意不提前落
adapters——波 1 无真实消费方，空壳文件被 knip:gate 判死（本仓纪律：不留死桶）；
波 2 随 native 接线在 adapters 请求编码边界落地（apiType 判别在 adapters
`model-execution.ts` 的 `config.api.type`），语义以本节为准，上游参照
`packages/adapters/src/model/tool-search.ts`@c891036。core 侧
`ToolSearchModelFacts.capability` 缝已预留（缺席=不支持 native）。

### R3 策略固定与继承

- 模式在 **Runtime 创建 / 冷恢复时固定**（runtime 启动选项单一所有者）；热恢复
  （resume 已存活 runtime）不变；设置修改只写 App 设置，不广播运行态。
- fork / 子 Agent 继承父 Runtime 策略，沿现有继承链，不新增 RPC、不逐轮读取、
  不写 session、无数据库 migration。
- 辅助调用隔离：Goal verifier 用空工具目录自动降级；Memory Extraction/Dream 用调度
  时目录（不含 ToolSearch）；compact summary 保留自己的候选策略（现有
  `COMPACT_TOOL_KEEP_MAX_COUNT` 止血不动）。显式 flag 不向原本未继承的辅助调用扩散。

### R4 候选目录与延迟声明

- Registry 保存完整工具目录；**Runtime 唯一负责请求决策**。候选 = 当前已注册 ∩
  作用域允许（allowlist/denylist、主子作用域、每模型可见性过滤）∩ 原有可见性规则。
- `ToolMetadata` 增加 `shouldDefer?: boolean`、`alwaysLoad?: boolean`、
  `searchHint?: string`。
- **常驻名单**（永不 defer）：`Agent、AskUserQuestion、Bash、Edit、Glob、Grep、Read、
  Skill、Write、ToolSearch、DeferredToolCall`（对照上游名单；上游 ReportFindings 本仓
  无实现，不因名单而新增）。Task 与 Agent 同工厂同语义，一并常驻。
- 其余内置工具在各自 metadata 声明 `shouldDefer: true`（workflow/plan/fleet/cron/
  off-peak/lsp/session 族等）；**全部 MCP 工具默认 defer**（`mcp__server__tool`
  解析已有 `parseMcpToolName`）。`alwaysLoad: true` 的工具永不 defer（供后续个别
  工具豁免，波 1 不预置豁免）。
- 无任何 deferred 工具，或 ToolSearch/DeferredToolCall 控制工具被作用域禁用时：
  关闭搜索、恢复全量定义、记录原因（debug 日志，一次性）。

### R5 ToolSearch 工具契约

- 名称 `ToolSearch`；readOnly、riskLevel low、needsApproval false、concurrentSafe、
  timeout 10s、maxOutput 100KB、sideEffectScope none；permission `tool.search`
  （denyPriority beforeAsk，patternSources=[toolName]）。
- 输入 `{ query: string, max_results?: number = 5 }`；`query` 支持 `select:<tool_name>`
  直选与关键词搜索。模型侧 JSON schema 将两字段都标 required（转换器会把带默认值
  字段视为可选；执行侧仍先补默认值）。
- 输出 `{ matches: string[], query: string, total_deferred_tools: number }`。
- handler：未启用即抛错（"ToolSearch is not enabled for this request."）；搜索纯读
  catalog，无副作用；`formatModelContent` 把 matches 映射为
  `{ type: "tool_reference", toolName }` 内容块序列（空结果 → 固定文案
  "No matching deferred tools found"）。
- 搜索算法（对照上游 `core/src/tool/search/search.ts`）：select 直选优先（名称/别名
  精确）；关键词按 名称 > 别名 > searchHint > description 的加权匹配，稳定排序，
  截断到 max_results；只返回当前请求允许的候选。

### R6 DeferredToolCall 包装契约

- 入参严格 `{ name: string, input: object }`，共用外层 callID；只接受**当前请求允许
  的 client-executed deferred 工具**；常驻、alwaysLoad、控制工具与 provider 原生工具
  不可转发（返回普通工具错误并提示直接调用，不执行目标 Hook/审批/handler）。
- 未搜索不是执行禁令：模型直接调用 deferred 工具名的普通路径保持现有规则。
- 包装解包后**复用普通调用的全部调度链**（校验、权限、Hook、超时、取消、后台任务、
  结果格式、媒体、turn-stop），不递归运行第二套 executor。
- 内部历史/持久化统一用**目标工具名**，包装标记仅为 part metadata 的严格字面量
  `modelCallWrapper: "DeferredToolCall"`；`tool`/`state.input` 保存目标名与内层参数；
  重存、历史复制、分支恢复必须保留；不重复存储包装 input；无数据库表列或 migration。
- 请求渲染在已有遍历中把带标记的目标调用恢复为包装形态（DeferredToolCall + 原始
  input），剥离内部标记；不新增历史扫描或 callID 缓存。
- 准入失败只保存包装失败记录。V4/UI 以目标事件定稿工具行，展示层不在各消费者解包
  （continuous/replayable 交付边界不变）。

### R7 local 请求投影

- 两次 compact 之间固定发送：常驻工具 + alwaysLoad + 已提升工具（R8）+ ToolSearch +
  DeferredToolCall；deferred 未提升工具的 schema 不进 tools。
- 历史中的 ToolSearch 结果在**真实结果位置**展开为 functions 容器：每个 match 引用
  渲染为一个 function 块（JSON：description/name/parameters），容器与块的开闭合标签
  字面量**逐字对照上游设计文档 §Local 投影**（实现时直接引用上游原文，不在本 spec
  复刻闭合标签字节）。不跨结果或中间文本合并；保留顺序与 Hook 文本；不输出空容器；
  失效引用（工具已移除/禁用）沿用移除/占位规则。
- 原始历史与 `state.metadata.modelContent` 保存真实 tool_reference 引用，不保存
  schema 快照或重复展开正文；最终投影参与 token 估算、缓存与媒体处理；不截断
  schema JSON、不新增 schema reminder。
- **稳定前缀**：工具定义未变时，搜索新增不改旧前缀；定义/权限/可用性真实变化才允许
  改变投影。schema 编码只在请求内按工具定义复用；不同结果保持各自容器与顺序；
  下一请求重新读取定义，**不引入跨请求缓存或失效状态**。
- 请求准备先扫描有效发现集合，再以单一共用循环完成 Local/Off 的引用投影；未变化的
  entry/message/content 复用不可变引用，仅在删除或展开引用时复制对应结果。

### R8 请求准备单点与 compact 检查点提升

- 主/子 Agent、Goal、Memory、Compact 组装真实请求共享**同一请求准备入口**，内部仅
  执行一次 ToolSearch 准备，再走既有消息投影；调用方必须提供未经 deferred 裁剪的
  完整候选目录；纯展示/记录/估算投影不执行搜索准备。
- 准备结果含 executor 使用的搜索 context（mode/enabled/catalog/discovered），不生成
  新公告、不写历史/DB/全局状态；同模型传输重试复用配套请求，切换 Model 或重选
  compact 历史时从原始输入重建。
- **compact 检查点提升**：成功 compact 的发现检查点把「当前允许的已发现 deferred
  工具」提升为本上下文普通 tools（进 tools 数组）；compact 保存发现名称、重建名称
  公告；保留尾部的引用继续投影；不合成搜索结果。纯 Continue 不刷新公告。
- 模式切换（off↔local）只改请求投影：保留原始结果、公告与包装调用，不伪造直接调用。

### R9 公告（announcement）

- 启用搜索的轮次开始时，向模型公告当前 deferred 目录的名称清单变化（对照上游
  `ToolSearchAnnouncementSchema`：`{ addedNames, removedNames, readdedNames }`，
  readded ⊆ added）；公告作为持久化轨迹的一部分（冷恢复水合重建），收集时序与
  最终 provider render 使用隔离拷贝。
- 公告只包含名称与最小描述指引，不内联 schema；公告收集不产生新的网络面。

### R10 持久化与冷恢复

- ToolSearch 结果内容按 `PersistedToolSearchContentSchema`（text | tool_reference
  数组，min 1）持久化；水合失败回退 legacy 工具结果并 warn 一次（对照上游
  `hydrateToolSearchContent`）。
- compact 边界 payload 携带发现元数据（`hydrateCompactDiscovery` →
  `compactDiscoveryMetadata`）；公告水合 `hydrateToolSearchAnnouncement`。
- DeferredToolCall 的目标 part 从 pending 起在 metadata 保存严格字面量标记；冷恢复
  由持久化目标 part 重建展示身份；无表列/migration（R6）。

### R11 设置面与物化链

- App 设置键 `toolSearchMode`：**TS 类型与 zod schema 双登记**
  （`packages/shared/src/validationAppSettings.ts`——历史教训：只进类型不进 schema
  会被静默 strip）；设置 UI 行（三值单选）底部常驻实验性说明：「模型供应商未完整
  支持原生 ToolSearch 时，native 模式不可用；local 模式会改变工具投影」。
- 物化链对照上游：`Settings → Host SettingService/setting.json →
  session/requestRuntimePreferences（runtime 物化）→ runtimeConfig.toolSearch.mode
  固定 → 请求投影/执行/子 Agent 继承`。ACode 落点沿既有 dynamicWorkflow 三档物化
  模式（`packages/shared/src/dynamic-workflow-feature.ts` 为取值域/归一化参照，
  Host 侧 owner 各自消费）。旧 Host 响应缺省字段按 off。
- 本地 CLI、desktop-attached remote、手机 shared-host 使用所属 Host 的同一设置
  权威源；不逐轮读取。

### R12 失败与降级语义

- 启用判定失败（无 deferred / 控制工具被禁 / 模型不支持）→ off + 一次性 debug 原因，
  全量目录照常发送（fail-open 到现状，不 fail 请求）。
- 显式模式能力不符 → 发送前报错（R1），不静默降级。
- 搜索/包装执行中的错误走普通工具错误链（结果格式、重试、审批语义不变）。

### R13 后端能力剥离与闭集 retry/fail 信号（R3 先行增量 · 2026-10-20）

> 来源对照：上游 foundry「按后端能力剥离 + 显式信号」机制（能力集缺失 → 请求构造期
> 逐工具剥离 `defer_loading`/`strict` 旗标或整个移除工具，返回闭集信号
> `retry:foundry-capability-strip:<caps>`；目的工具 web_search 能力缺失 →
> `fail:foundry-purpose-request`；缺失能力按 (后端,模型) 缓存；回合原因分档
> `tool_deferred`（非错误臂）vs `tool_deferred_unavailable`（错误臂））。只搬机制
> 语义（降级永不静默、信号闭集、retry/fail 两档），不拷专有文案。证据位置见
> `C:\Users\ZhuanZ\Desktop\zoode\claude-r3-reports\04-tree-rescan-cc-prompts-ion.md` C2。

**原则**：模型后端不具备某工具所需能力时，请求构造期**显式剥离**该工具/旗标并产生
**闭集信号**；不允许静默降级或静默丢弃。失败语义只有两档（闭集）：
`retry`（剥离后重建请求可继续，调用方重规划）与 `fail`（请求目的不可达，重试无意义）。

**能力判定面（剥离判据的输入，禁止 provider/model id 字符串分支）**：

| 能力事实 | 所有者 | 判据消费点 |
|---|---|---|
| `ModelProperties.supportsToolCall` | shared model-config（zod 闭集） | core：local 投影面能否成立 |
| `ModelProperties.supportsNativeWebSearch` | shared model-config（zod 闭集） | core handler 门禁 + adapters wire 编码 |
| `ToolSearchCapability.protocolSupported`（R2 缝） | contracts | core：native 面（波 2）；波 1 只登记 |
| `providerKind`（openai/anthropic/openai-compatible/gateway/custom） | adapters 解析事实 | adapters：provider-native 工具可编码性 |

**core 请求构造侧词表**（`core/src/tool/search/capability.ts`，唯一登记处）：

- `ToolSearchStripReason` 闭集：
  - `native_not_implemented`——波 1 构建事实：native 面未实装（显式 native 与 auto
    升 native 分支发送前报错）。波 2 实装后此档退役，由协议判定档接替。→ `fail`
  - `native_protocol_unsupported`——后端缺 native tool_search 协议（apiType 非
    anthropic-messages）。**波 2 档位登记**：波 2 中 auto/native 请求面剥离 defer
    旗标后重建请求 → `retry`（对照上游 retry:foundry-capability-strip）。波 1 无
    产生路径（native 面不存在，先落 native_not_implemented）。
  - `tool_call_unsupported`——模型不支持普通工具调用：显式 local 发送前报错 →
    `fail`；auto 下不抛错，走 R12 fail-open 降级并以此值入降级原因闭集。
- `ToolSearchStripSignal = { disposition: "retry" | "fail", reason, toolName? }`；
  `ToolSearchCapabilityError extends Error` 携带 signal（message 兼容波 1 文案）。
  disposition 由 reason 的穷举 switch 单源推导（`toolSearchStripDisposition`）。
- **R12 降级原因闭集扩展**（`ToolSearchDisableReason`）：既有
  `provider_disabled | no_deferred_tools | tool_unavailable` 之上增
  `tool_call_unsupported`（auto 能力降级与用户配置 off 分档——上游
  tool_deferred/tool_deferred_unavailable 分档的同题：「配置关闭」与「能力不可得」
  在信号层可辨识）与 `native_protocol_unsupported`（波 2 档位登记）。

**adapters wire 侧词表**（`adapters/src/model/tool-capability-strip.ts`，唯一登记处；
core↔adapters 无依赖边、contracts 桶面本轮不在作用域，故两侧各自闭集、以本节对照，
波 2 如需协议/持久化面再上提 contracts——越界登记）：

- `WireToolStripReason` 闭集（全部 → `fail`，对照上游目的工具 fail:foundry-purpose-request）：
  - `native_web_search_model_unsupported`——`supportsNativeWebSearch=false` 仍收到
    provider-native WebSearch 编码请求（handler 门禁后的第二道防线）；
  - `native_web_search_provider_unencodable`——后端 API 面（providerKind）不编码
    provider-native web search（openai 兼容后端必然缺 native 搜索）；
  - `provider_native_tool_unregistered`——`providerNative.logicalName` 无已注册
    编码器（注册表/构建事实）。**修复现状静默丢弃洞**：`toAiSdkTools` 的
    providerNative 分支不再存在「返回空数组」路径，要么编码要么闭集报错。
- `ToolCapabilityStripError extends AiSdkModelAdapterError`：code 保持
  `InvalidModelRequest`（failure-classifier 既有归档 `retryable:false` 不变），新增
  类型化 `strip: WireToolStripSignal`（reason/disposition/toolName）并同步写入
  error context，消费方按闭集字段区分而非解析 message。
- `ModelToolContract.capability` 字段（如 web_search）是目的工具判定的登记缝
  （对照上游 O8r 按 web_search_tool 目的判 fail），波 1 由 logicalName 判定即可。

**失败语义汇总**：

| 路径 | 行为 | 信号 |
|---|---|---|
| 显式 native（波 1） | 发送前报错（R1 不变） | `ToolSearchCapabilityError{fail, native_not_implemented}` |
| 显式 local + 无 tool call | 发送前报错（R1 不变） | `ToolSearchCapabilityError{fail, tool_call_unsupported}` |
| auto + 无 tool call | fail-open 降级 off（R12 不变） | 降级原因 `tool_call_unsupported`（debug 日志） |
| provider-native 编码能力缺失 | 请求失败（fail-closed，不发坏请求） | `ToolCapabilityStripError{fail, …}` |
| strict 资格缺失 | 降级非 strict 合法 schema（既有语义，omp CONSTRAINTS #1.5） | 非剥工具面，不入本节信号 |

**词表边界（对照 permission auto-deny 闭集，禁止同义 token 重复建档）**：

- 本节词表描述**请求构造期/wire 编码期的能力事实**（剥离、降级、fail-closed
  报错），永不进权限拒绝闭集（`core/src/permission/auto-deny-reasons.ts`，
  specs/permission-auto-deny-reasons.md）。**deferred/stripped 不算 deny**：剥离
  发生在模型见到工具面之前，不存在可拒绝的调用；DeferredToolCall 准入拒绝（R6）
  走普通工具错误链（R12），同样不产生 auto-deny token。
- 与 `forged_tool_name`（dispatch 期 registry-miss：模型调用不在服务清单的名字 →
  统一回应「No such tool.」，不回显）的分界：`provider_native_tool_unregistered`
  是**已注册 contract** 的 providerNative.logicalName 缺 wire 编码器——注册表/构建
  事实，产生于请求构造期、面向调用方 fail-closed 报错，不回显任何模型输入。两者
  层级与主体不同，不合并 token。
- 本节信号不做模型可见文案的来源：R13 信号消费方是调用方重规划（换模式/换模型/
  换引擎）与本地日志分档；模型可见的拒绝文案纪律（不确认存在性细节、不回显名字）
  属执行期工具错误面（R6/R12 与 invalid-name 防伪口径），由各自所有者维护。

**波 2 边界（本节不做）**：native wire 实装、`defer_loading` 旗标与其逐工具剥离、
tool_reference 原生协议、缺失能力 (后端,模型) 缓存（上游 cBn/yEn）、provider 400
错误消息解析的事后 retry/fail 分档（上游 vI/O8r）、`retry` 档的真实产生路径、
信号上抛协议 v4 面/UI 展示（越界请求，见 R3 批报告）。词表档位已预留，波 2 扩集时
按第二轮教训全链同步（zod enum + 手维护联合 + switch 穷举一次扩齐）。

## 状态所有权与边界

```text
Registry(完整目录) ──> Runtime(唯一请求决策：启用判定/发现集合/提升)
                          │
             请求准备单点(一次 ToolSearch 准备)
                          │
        ┌─────────────────┼──────────────────┐
   tools 投影         messages 投影      搜索 context → executor
 (常驻+提升+控制)   (引用展开/包装恢复)   (准入/调度复用普通链)
                          │
                持久化(引用/标记/公告/compact 发现) → 冷恢复水合
```

不变量：发现集合唯一所有者 = Runtime 请求决策（不建第二缓存）；历史只存真实引用；
投影是纯函数（同输入同输出，稳定前缀）；DeferredToolCall 不新增执行语义。

## ACode 落点锚（实现时以当前检出为准）

| 面 | 锚点 |
|---|---|
| 契约/类型 | `apps/acode-cli/packages/contracts/src/tools/`（新增 tool-search.ts，出口经包 index） |
| 搜索算法/投影 | `apps/acode-cli/packages/core/src/tool/search/`（新目录：search/description/history/local-projection/exposure，对照上游同名文件族） |
| 能力剥离词表（R13） | core `tool/search/capability.ts`（请求构造侧闭集）+ adapters `model/tool-capability-strip.ts`（wire 侧闭集）；两侧唯一登记处，禁止第二份 |
| 工具 handler | `apps/acode-cli/packages/core/src/tool/handlers/`（tool-search.ts、deferred-tool-call.ts；注册进 handlers 索引） |
| 工具目录 | `packages/core/src/runtime/methods/config.ts:154 getTools`（候选与缓存；metric 挂钩处） |
| 请求组装 | `packages/core/src/runtime/methods/model.ts`（请求准备单点接入）；compact 侧 `compact-active.ts` / `compact-summary-model-request.ts` 保持自身策略 |
| 水合 | `packages/core/src/agent/`（tool-search-hydration.ts 对照） |
| wire 能力 | `packages/adapters/src/model/`（capability 解析；native beta header 波 2） |
| 设置 | `packages/shared/src/validationAppSettings.ts`（TS+zod 双登记）+ 设置 UI 行（`packages/ui/src/settings/`，对照 dynamicWorkflow 行样式） |
| Host 物化 | desktop host 设置服务 → runtime 物化（对照 dynamicWorkflow 三档链路） |
| CLI 参数 | `apps/acode-cli/packages/cli/src/arguments.ts` + prompt/target/TUI/resume/continue 入口传递 |
| 协议 | 仅当设置需过 v4 面时：`packages/shared/src/acode-protocol-v4/`（新命令/事件只进 v4） |

## 测试矩阵（对照上游测试族收敛）

单测（core）：搜索算法（select/关键词/加权/截断/稳定序）、投影（多引用混合文本、
顺序保持、失效引用、稳定前缀、无空容器）、启用判定与降级原因、DeferredToolCall
准入（常驻/控制/原生拒绝、目标错误链复用、标记持久化与渲染恢复）、compact 提升
（检查点后 tools 含已发现、Continue 不刷新公告）、水合（合法/非法/legacy 回退）、
公告 schema（readded ⊆ added）。
单测（core，R13）：闭集词表穷举（每个 reason 的 disposition 判定、switch 无 default
逃逸）、`ToolSearchCapabilityError` 携带 signal 与波 1 文案兼容（/not implemented/、
/tool calls/ 断言不回归）、auto+无 tool call 降级原因落 `tool_call_unsupported`
（与配置 off 的 `provider_disabled` 分档）、显式模式报错 instanceof 判定。
单测（adapters，R13）：wire 侧闭集——adapters 包波 1 无 test 基建（package.json 无
test 脚本，本轮禁改），以 typecheck+lint 与 core 侧词表对照测试代偿；
`toAiSdkProviderNativeTool` 三 fail 档经 tsx 临时脚本验证（记录在批报告）。
单测（contracts/adapters）：schema 双 required、capability 解析（anthropic-messages
→ protocolSupported true / defaultEnabled false）。
链路（bootstrap/cli）：CLI 四值解析与非法值拒绝、默认 off、全入口传递、设置三值
读写与 zod 拒绝、旧设置缺省 off、fork/子 Agent 继承。
回归红线：默认 off 时全部既有请求投影字节不变（快照对照）；`tools_schema_token_metric`
在启用后反映投影后 tools 面。

## 验收

- 默认 off：零行为变化（既有测试全绿 + 投影快照不变）。
- local 开启：MCP 重载会话 tools 数组只含常驻+控制+已提升；ToolSearch 结果位展开；
  DeferredToolCall 可执行任一已允许 deferred 工具且权限/Hook 语义与直接调用一致；
  compact 后已发现工具提升为普通 tools。
- CLI `--toolsearch-mode native` 发送前显式报错；`auto` 落 local。
- 门禁：`pnpm typecheck`、`pnpm lint`、`architecture:check --changed` new 0、
  contracts/core/adapters/bootstrap/cli 包测试全绿。
