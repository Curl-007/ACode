# 模型 compat 标志体系（omp 价值提取波 2 · WI-12）

来源：`C:\Users\ZhuanZ\Desktop\zoode\ACode-价值提取-oh-my-pi.md` T1#4 + 「九路报告要点存档③」；
机制语义参照 oh-my-pi (MIT) `packages/catalog/src/compat/{taxonomy.ts,axes.ts,resolve.ts}`、
`packages/catalog/src/compat/rules/{classes,providers}/*.kdl`、
`packages/ai/src/providers/openai-{completions,shared}.ts`。全部 TS 表承载，不引 KDL。

核心纪律（照抄 omp AGENTS.md 成文规则）：**业务代码禁止 `id.includes("claude")` /
`startsWith("glm-")` / 模型名正则式分支；per-model 行为差异一律编目为结构化 compat 标志，
运行期只消费标志**。等秩规则给同一标志赋不同值 = 解析期抛错（omp 编译期
AmbiguousOverlapError 的运行期等价物），不允许静默覆盖。

## 范围与所有权

- `packages/shared/src/model-config.ts`：compat 标志 zod 字段族（数据合同，波 2 独占编辑）。
- `apps/acode-cli/packages/adapters/src/model/model-compat-{identity,rules,transforms,fetch}.ts`（新）。
- `apps/acode-cli/packages/adapters/src/model/model-execution.ts`：bindModel/createFactory 最小插点。
- 迁移两处存量机制：`transform.ts`（system 合并 kind-gate）、`anthropic-stream-compat.ts`
  （request 分支）；删除 `system-message-compat.ts`（唯一消费者是 transform.ts，已核实）。
- 测试：`packages/shared/test/model-compat-flags.test.ts`、
  `apps/acode-cli/tests/model-compat-{identity,rules,transforms,pipeline,discipline}.test.mjs`。
- 不改：任何 package.json（含 shared exports 面）、`packages/provider`、`packages/provider-node`、
  core、`runner-stream.ts`、contracts、i18n、knip、baseline。

**放置约束（如实记录）**：`@acode/shared` 的导出面由 package.json exports 冻结（共享桶禁改），
新增 shared 文件无法被子路径导入，index.ts 亦为共享桶。因此分类器与规则表放消费侧
adapters（与 omp 把 catalog 放 provider 消费侧同构）；shared 只承载标志词汇 schema。
波 3 若申请到 shared package.json 导出子路径，可整体上移，消费方 import 路径不变语义。

**烘焙点选择（先摸清链路后定）**：配置驱动的 properties 流需要
`packages/provider/src/config/model-config.ts` 的 `ModelPropertiesConfig`
逐字段 overlay/toJSON 透传（新字段会被静默丢弃），该包不在波 2 所有权内；因此标志解析
烘焙在 **adapters 模型构建点**（`AiSdkModelExecution.bindModel`，每模型绑定解析一次、冻结进
snapshot，请求期零字符串匹配——等价 omp resolveModelPolicy 烘焙进 Model 的语义）。
provider-node builtin 物化路径不动。配置下发（builtin.json 携带 compat 覆盖）列入波 3 队列。

---

## R1 标志词汇表（shared/model-config.ts · `modelCompatFlagsDataSchema`）

稀疏字段族：全部可选、缺省 = 通用行为（零变换）、`.strict()` 拒绝未知标志（词汇表即
schema，规则表 typo 加载即炸）。与既有 sparse 家族一致采用 `nullable().optional()`
（为波 3 配置 overlay 的 null 清除语义预留）。

| 标志 | 类型 | 语义（wire 修补） | omp 对应 |
| --- | --- | --- | --- |
| `toolCallIdProfile` | `"openai-40"` \| null | tool-call id 必须满足 `^[A-Za-z0-9_-]{1,40}$`，违规 id 全 body 一致性重写 | `uses-openai-tool-call-id-limit` / `requires-mistral-tool-ids`（axes.ts:226/176） |
| `requiresToolResultName` | boolean \| null | chat wire 的 tool-role 消息必须携带 `name`（从配对 assistant tool_call 回填） | `requires-tool-result-name`（axes.ts:179；factory-droid.kdl:1066 kimi-k3） |
| `singleLeadingSystem` | boolean \| null | 端点只接受一个开头 system，多段按原顺序合并 | `supports-multiple-system-messages`=false（axes.ts:199） |
| `requiresStringSystemContent` | boolean \| null | messages[] 内 system 的 content 必须是纯字符串（单 text block 数组还原为 string） | ACode anthropic-stream-compat 存量语义（部分 Anthropic-compatible 服务） |

**调研后缓议（不发明用不上的标志）**：
- `requiresReasoningContentForToolCalls`（DeepSeek 系）：omp 修复是多层的
  （reasoningContentField 方言 + allowsSynthetic 分层 + "DeepSeek V4 拒绝合成 '.' 占位、
  校验精确值"，openai-completions.ts:2643-2676）。ACode 的 deepseek 经 opencode 网关与
  anthropic 路由接入，仓内无该 400 的运行时证据；错误占位符比缺字段更糟。等运行时失败
  证据再立项。
- `mistral-9-alnum` 档位：ACode 未接 Mistral，enum 不预置。
- reasoning effort / thinking 字段映射：option-map（CEL patch）territory，见 R4 边界。

## R2 身份分类最小面（model-compat-identity.ts · `classifyModel`）

- 输入 `{ providerId, modelId, apiType }`；`bare` = modelId 最后一个 `/` 之后的段，再小写
  （builtin id 大小写混用："GLM-5.3" 与 "glm-5.3" 同族）。
- class 词汇（最小版，覆盖 ACode 已接模板）：`claude`、`gpt`、`grok`、`glm`、`kimi`、
  `deepseek`、`qwen`、`minimax`、`mimo`、`unknown`。匹配器 rank 照抄 omp taxonomy：
  `exact(4) > bounded(3) > prefix(1) > glob(0)`（最小版无 namespace 档）；同 rank 平局取
  非通配字节更长者；仍平局且跨 class → 抛 `AmbiguousModelError`（omp AmbiguousIdentityError
  对应物）。bounded = token 后必须是串尾或 `[-_.:0-9]` 之一（omp boundedMatch 语义）。
- `family` = bare 的首个纯字母 token；`revision` = bare 中首个 `\d+(\.\d+)*`。波 2 规则不消费
  revision/family（字段解析并暴露，为波 3 区间匹配预留）。不做 omp 全 taxonomy。
- 纯函数直算，不加缓存：解析只在 bindModel 发生一次，非热路径。

## R3 规则表与解析（model-compat-rules.ts · `resolveModelCompat`）

规则形状（TS 表 = omp KDL 的语义承载）：

```ts
interface ModelCompatRule {
  apiTypes?: readonly ModelWireApiType[];   // "anthropic-messages" | "openai-responses" | "openai-chat-completions"
  providerIds?: readonly string[];           // 精确 providerId（coding-plan 场景预留）
  class?: ModelClass;                        // classifyModel 结果匹配
  model?: { kind: "exact" | "bounded" | "prefix" | "glob"; token: string };
  priority?: number;                         // 显式优先级，破同 rank 平局（omp priority=10 模式）
  flags: ModelCompatFlagsData;               // 稀疏
}
```

- 规则 rank：有 model matcher → 其 kind rank（4/3/1/0）；否则有 class → 2；否则 → -1
  （wire 级兜底）。apiTypes/providerIds 只收窄命中，不抬 rank。
- 解析：命中规则全部收集；逐 flag 取最高 rank 赋值；同 rank 取 priority 大者；同 rank 同
  priority 赋**不同值** → 抛 `AmbiguousCompatOverlapError`（fail-closed，禁止静默覆盖）；
  同值幂等合并。输出 frozen 稀疏对象。
- 加载期校验（"编译期"等价物）：每条规则 flags 过 `modelCompatFlagsDataSchema.parse`；
  matcher 签名相同的规则间做静态冲突检测。
- 种子规则（每条带证据注释，4 条）：
  1. `{ class: "gpt", flags: { toolCallIdProfile: "openai-40" } }` —— omp openai.kdl:115；
     ACode core 合成 tool-call id 超长：`settings-${randomUUID()}`=45 字符、
     `launch-${randomUUID()}`=43（dynamic-workflow-run-{settings,start}.ts）、
     `${id}-media-N` 后缀（tool-result-media-persistence.ts:61），随历史回放进
     OpenAI Responses（gpt-5.x/6 已接）。
  2. `{ model: { kind: "bounded", token: "kimi-k3" }, flags: { requiresToolResultName: true } }`
     —— omp factory-droid.kdl:1066；AI SDK openai-compatible 序列化 tool 消息**不发 name**
     （dist/index.js:311-315 已核实），Moonshot 系 tool 消息要求 name。
  3. `{ apiTypes: ["openai-chat-completions"], flags: { singleLeadingSystem: true } }` ——
     迁移 transform.ts:52-54 存量 kind-gate（system-message-compat.ts 注释：部分旧式
     chat template 只接受一个开头 system），赋值面与现状全等。
  4. `{ apiTypes: ["anthropic-messages"], flags: { requiresStringSystemContent: true } }` ——
     迁移 anthropic-stream-compat.ts request 分支（AI SDK 把纯文本 system 扩成单元素
     block 数组，部分 Anthropic-compatible 服务要求 string），赋值面与现状全等。

## R4 转换管道与机制边界（model-compat-transforms.ts + model-compat-fetch.ts）

- 转换器 = 纯函数 `(body: JsonObject, flags) => JsonObject`；**无修改必须返回原引用**
  （管道据此判定是否需要重新序列化）。按标志启用、固定顺序依序应用：
  `requiresStringSystemContent → singleLeadingSystem → requiresToolResultName →
  toolCallIdProfile`。顺序理由：system 形状还原先于合并；name 回填依赖原始 id 配对；
  id 重写必须最后（一致性映射覆盖 assistant tool_calls[].id / tool.tool_call_id /
  Responses function_call(.output).call_id，同 id 同映射，sha256 派生保证确定性与跨请求
  稳定——prompt cache 友好）。
- `toolCallIdProfile: "openai-40"` 重写算法：合规 id（`^[A-Za-z0-9_-]{1,40}$`）不动；
  违规 id → `"ac-" + sha256(原id).hex.slice(0,32)`（35 字符，确定性、单请求内单射、
  跨请求稳定）。
- fetch 包装（createCompatTransformFetch，模式对照 model-option-map-fetch.ts）：
  - 无标志（稀疏对象为空）→ **原样直通，不读 body**：零开销 + 字节级零变化（验收锚点）。
  - body 非 string / 非 JSON object → 直通（fail-open）。与 option-map 的 fail-closed 不同
    且有意：option-map 是 reasoning/maxOutput 字段的唯一权威，静默跳过 = 丢选项；compat
    修补失败会被 provider 显式 4xx/SSE 业务码接住，进入既有 failure-classifier/retry 轨道。
  - 所有转换器 no-op → 转发原 request（不重新序列化）。
- **位置与两套机制边界**（不许互相绕）：

```text
SDK → sdk-compat fetch（仅剩 response 侧） → compat 管道（结构/语义修补）
    → option-map fetch（CEL 字段 patch） → business-error fetch → gateway/proxy transport
```

  - option-map 管**请求体字段 patch**（thinking/reasoning*/enable_thinking/max_* 等值映射，
    CEL 权威）；compat transform 管**结构/语义修补**（id 重写、name 回填、system 形状/合并）。
  - compat 转换器**禁止触碰** option-map 权威字段；option-map 不做结构变换（merge-patch
    本来也表达不了数组行走）。位置固定：结构修补在前、字段 patch 最后写入。
- 与存量 pre-SDK 机制的分工（不同字段、不同职责，非两套并行）：
  `projectToolNameForProvider`（assistant 侧空 function name 占位）继续留在 transform.ts
  （波 3 迁移队列）；`requiresToolResultName` 补的是 tool 消息 name 在场性（AI SDK 不发）。

## R5 烘焙点（model-execution.ts）

- `bindModel` 内 `resolveModelCompat({ providerId, modelId, apiType: providerConfig.api.type })`
  一次解析、`Object.freeze` 进 snapshot；`createFactory` 里
  `pipelineFetch = createCompatTransformFetch({ fetch: optionFetch, flags })`，三个 kind
  分支统一改用 pipelineFetch（anthropic/openai 的 sdk-compat fetch 包在其外，保持现有
  request-compat 先于 option-map 的相对顺序不变）。
- 解析抛错（歧义/词汇表违规）沿 bindModel 传播 → createModel fail-closed，响亮失败。

## R6 迁移等价性论证（wire 级零变化）

- S3（singleLeadingSystem）：AI SDK openai-compatible 把每条 system 独立序列化为
  `{role:"system",content:string}`（dist:130-132）；body 级按原顺序 `join("")` 合并 ≡
  pre-SDK 逻辑合并（`modelMessageContentToText` 对纯文本幂等；cacheControl 保留语义在该
  serializer 下无 wire 差异——getOpenAIMetadata 只读 providerOptions.openai）。
  赋值面：apiType openai-chat-completions ⇔ 旧 providerKind openai-compatible
  （model-execution.ts toAiSdkProviderConfig 一一映射）。
- S4（requiresStringSystemContent）：函数逐字迁移；位置不变（option-map 之前、SDK-compat
  之内→之外等价，两者之间无其他 request 写入者）。anthropic-stream-compat 保留全部
  response 侧逻辑（unsigned thinking 过滤、signature 补发、tool_result 抑制）。
- 回归锚点：存量 model-option-map/strict-tool-schema/reasoning-history **无专属测试文件**
  （全仓核实）；零回归面 = apps/acode-cli/tests 全量 + packages/{shared,provider} test。
  新增迁移等价测试直接断言 wire body 形状。

## R7 id 字符串分支守护（纪律违例检查方式）

- `apps/acode-cli/tests/model-compat-discipline.test.mjs`：扫描
  `apps/acode-cli/packages/adapters/src/model/**/*.ts` 源文本，断言不出现
  `startsWith("claude`、`includes("claude"`、`includes("glm`、`includes("kimi"`、
  `includes("deepseek"`、`includes("minimax"`、`includes("qwen"` 等模型名分支模式。
- **基线豁免（allowlist，只减不增）**：`strict-tool-schema.ts`
  （`isAnthropicFirstPartyModelId` 的 `startsWith("claude-")`，存量首方 strict 资格判定）。
  豁免理由与迁移计划见波 3 队列 #1；守护测试对 allowlist 外的任何命中 fail。
- 约定入 spec 即 lint 约定的载体（oxlint 自定义规则不在波 2 所有权内）。

## 波 3 迁移队列（本 spec 只登记不实施）

1. `strict-tool-schema.ts` id 判定 → `supportsStrictToolSchema` 标志（需先解决配置透传或表规则覆盖网关路由 id 语义）。
2. `projectToolNameForProvider` 空名占位 → `toolCallNameFallback` 标志（pre-SDK → 管道）。
3. response 侧 compat（anthropic-stream-compat 响应分支、openai-responses-json-compat）按标志门控。
4. 配置驱动 compat：packages/provider overlay 透传 + builtin.json 下发 + shared 导出子路径（共享桶申请）。
5. revision 区间匹配（glm ">=5.2 <5.3"）与 whenThinking 预编译变体。
