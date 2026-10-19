# 工具 schema 多方言归一化（omp 价值提取波 3 · WI-16）

来源：`C:\Users\ZhuanZ\Desktop\zoode\ACode-价值提取-oh-my-pi.md` T1#5 +「九路报告要点存档③」；
机制移植自 oh-my-pi (MIT) `packages/ai/src/utils/schema/{normalize,adapt,spill,draft,dereference,equality,fields,stamps,types,meta-validator,foundation-models}.ts`、
`packages/omptype/src/local-ref.ts`（解耦移植）、契约文档 `docs/ai-schema-normalize.md` +
`packages/ai/src/utils/schema/CONSTRAINTS.md`。omptype/TSchema 依赖全部降解为 ACode 的
JSON Schema 表示（`JsonObject = Record<string, unknown>`，与 contracts 的 `JsonSchema` 同构）；
无 Bun API 依赖（唯一环境读取是 `process.env`，node 原生）。

核心纪律（继承 model-compat-flags.md）：**方言路由禁止按模型 id 字符串分支**，只准消费
`model-compat-identity.ts` 的 `classifyModel` 分类结果、compat/properties 结构化标志与
wire 类型（providerKind→apiType 一一映射，波 2 spec R6 已论证）。

## 范围与所有权

- 新目录 `apps/acode-cli/packages/adapters/src/model/schema-normalize/**`：归一化内核 +
  8 方言 + 分发计划（本 spec 的实现载体）。
- 最小插点 diff：
  - `adapters/src/mcp/descriptor.ts`（MCP 工具 descriptor 物化点，inputSchema 统一归一）；
  - `adapters/src/model/tool-transform.ts`（模型请求工具定义发送点，方言分发 + Responses strict）；
  - `adapters/src/model/runner-options.ts`（给 toAiSdkTools 补传 providerId，两处 call site）。
- 新测试：`apps/acode-cli/tests/tool-schema-normalize-*.test.mjs`。
- 不改：`strict-tool-schema.ts`（评估结论见 R5，维持波 2 allowlist 登记）、
  `model-compat-{identity,rules,transforms,fetch}.ts`、`model-execution.ts`、
  core/shared/contracts、任何共享桶（package.json、knip、baseline、registry、i18n）。

## 分层图（与 compat 管道 / option-map 的边界，不许混层）

```text
工具定义发送前（物化点，本 spec）：
  MCP server tools/list ──► descriptor 物化 ──► normalizeSchemaForMCP（注册面统一归一）
  core ModelToolContract[] ──► toAiSdkTools ──► 方言分发（MFJS / Responses / none）
                                            └─► strict 资格（anthropic 折叠 / Responses enforce）

请求体序列化后（fetch 管道，波 2 spec R4，本 spec 不触碰）：
  SDK → sdk-compat fetch → compat 管道（结构修补） → option-map fetch（CEL 字段 patch）
      → business-error fetch → transport
```

- schema 归一发生在**工具定义对象**上（AI SDK 序列化之前），不是请求体 patch；
  compat transforms（id 重写 / name 回填 / system 形状）继续只管请求体，禁止触碰工具定义。
- option-map 管 reasoning/max_* 字段值映射，与 schema 归一零交集。
- 归一化内核是纯函数层（无 IO、无日志、无 SDK 依赖）；只有 `tool-transform.ts` /
  `descriptor.ts` 两个插点把内核接进真实链路，异常语义由插点决定（R4）。

## R1 方言分发表（omp ai-schema-normalize.md 分发表的 ACode 裁剪）

| # | 方言 | 移植入口 | 路由信号 | 波 3 消费者 |
| --- | --- | --- | --- | --- |
| 1 | MCP ingest | `normalizeSchemaForMCP` | MCP descriptor 物化点无条件 | **有**（descriptor.ts） |
| 2 | OpenAI Responses | `sanitizeSchemaForOpenAIResponses` | providerKind `openai`（= apiType openai-responses） | **有**（tool-transform.ts） |
| 3 | OpenAI strict 管线 | `sanitizeSchemaForStrictMode` → `enforceStrictSchema`（`tryEnforceStrictSchema` / `adaptSchemaForStrict` 组合） | Responses wire + `contract.strict === true` | **有**（tool-transform.ts） |
| 4 | Moonshot MFJS | `normalizeSchemaForMoonshot` | `properties.requiresMfjsToolSchema === true`（配置驱动标志，GLM/Kimi 系） | **有**（tool-transform.ts，替换"只有 $ref hoist"的存量半实现） |
| 5 | Google（Gemini/Vertex） | `normalizeSchemaForGoogle` | 无（ACode 未接 Google wire） | 纯入册（懒加载 + 单测） |
| 6 | Cloud Code Assist Claude | `normalizeSchemaForCCA` | 无 | 纯入册（懒加载 + 单测） |
| 7 | grammar（llama.cpp/LM Studio/vLLM） | `sanitizeSchemaForGrammar` | 无（本地推理后端未接） | 纯入册（懒加载 + 单测） |
| 8 | Ollama | `sanitizeSchemaForOllama` | 无 | 纯入册（懒加载 + 单测） |
| 9 | Cursor 投影 | `sanitizeSchemaForCursor` | 无（Cursor 非 ACode provider） | 纯入册（懒加载 + 单测） |
| 10 | Apple Foundation Models lowering | `toFoundationModelsSchema` / `decodeFoundationModelsArguments` | 无（apple-fm 未接） | 纯入册（懒加载 + 单测） |

多信号叠加顺序（照抄 omp openai-responses.ts:1920-1930 的论证注释）：
**Responses sanitize → MFJS → strict**。MFJS 必须在 Responses sanitizer 之后：sanitizer 把
`{}` 归一为布尔 `true`（grammar 采样器语义），而 Moonshot 校验器拒绝布尔子 schema，
MFJS pass 的 permissive 布尔折叠最后把它重新对象化。

anthropic wire 不进入本分发（方言 = none）：Anthropic 的工具 schema 白名单/strict 折叠
继续走存量 `strict-tool-schema.ts`（R5），与 omp 把 anthropic 原生归一留在 provider 内一致。

## R2 统一入口

### R2.1 MCP：normalizeSchemaForMCP @ descriptor 物化点

- 插点：`adapters/src/mcp/descriptor.ts` 的 `normalizeInputSchema`——所有 MCP 工具
  descriptor（含快启门缓存回填、deferred 补注册）都经此物化，是注册/发送前的唯一收口。
- 语义（omp MCP 选项集）：升级 draft-07→2020-12、内联本地 `$defs`/`definitions` 引用、
  剥离 `$schema` 与 `nullable` 关键字；**保留**校验关键字（pattern/minLength/…）与
  `additionalProperties`，不改写 description，不折 combiner。
- `#/properties/...` 等非 `$defs` 形态的本地引用**不被** dereference 解析（omp 同语义），
  留给发送点的 MFJS hoist（R2.2）处理；两条机制职责不重叠。
- 既有投影（强制 `type:"object"` + properties record 兜底）保持在归一之后，行为不变。

### R2.2 模型请求：resolveModelToolSchemaPlan + applyModelToolSchemaDialect @ tool-transform

- 计划（plan）在 `toAiSdkTools` 入口计算一次（每请求一次，非每工具）：
  - 输入：`providerKind`、`providerId`、`modelId`、`requiresMfjsToolSchema`；
  - `classifyModel` 消费点：plan 内暴露 `modelClass`（结构化身份，供 MFJS 证据注释与
    未来 class 级路由消费；本波路由信号 = 标志 + wire，不用 class 做隐式赋值——无
    运行时证据的 class 级默认（如"kimi class 一律 MFJS"）会静默剥关键字，等配置证据再立项）；
  - providerKind→apiType 映射（波 2 R6 的一一映射）：`openai`→openai-responses、
    `anthropic`→anthropic-messages、`openai-compatible`→openai-chat-completions；
    `gateway`/`custom` → 未知 wire → 方言 none（fail-safe：不归一）。
- 应用（每工具）：
  - MFJS：先跑存量 `hoistLocalJsonSchemaRefsToDefs`（`#/properties/...` → `#/$defs/...`，
    K3 只接受后者），再 `normalizeSchemaForMoonshot`（const→typed enum、oneOf 折叠、
    type 数组标量化/分支化、校验关键字剥离 + spill 进 description、布尔子 schema
    permissive 折叠）。flag 关闭时 hoist 也不跑（与存量行为一致：hoist 本来就由该 flag 门控）。
  - Responses wire：`sanitizeSchemaForOpenAIResponses`（oneOf→anyOf、object 节点补空
    `properties`、剥离 Responses 拒绝的正则 lookaround、`{}`→`true`、patternProperties
    lookaround 键回退 `.*` 合并）。
  - none：原引用直通（零变化可被引用相等断言）。
- `strict` 资格（R3）在方言归一之后判定，输入是归一后的 schema。

## R3 strict 语义（Responses strict 路径）

- `contract.strict === true` 且 wire 为 openai-responses：跑 `adaptSchemaForStrict(schema, true)`
  （= upgrade 2020-12 → `tryEnforceStrictSchema`：precheck 拒绝开放 map/无约束布尔分支 →
  sanitize（$ref 带兄弟键内联、单元素 allOf 折叠、type 数组分支化 + description 提升到
  anyOf 包装、enum/const 类型推断、default 内联进 description）→ enforce（object 全量
  `additionalProperties:false` + 全属性 required + 可选属性可空化 + 纯 union 拼接展平））。
- **只有 enforce 成功才发 `strict: true`**（omp CONSTRAINTS #1.6）；precheck 失败或 enforce
  抛错 → 返回 `{ strict:false, schema:upgraded }` 降级发非 strict 的合法 schema。降级不是
  错误：strict 是增强承诺，非 strict schema 本身合法（与存量 anthropic 路径
  `toStrictToolSchema` 返回 undefined 时原样发送同构）。
- 全局旁路：`ACODE_NO_STRICT_TOOL_SCHEMA` 环境变量（omp `PI_NO_STRICT`/$flag 的降解，
  惰性读取），置位时跳过 enforce、按非 strict 发送。
- chat wire（openai-compatible）**不启用** strict：网关对 `strict` 字段的支持未知，
  omp 用 `supportsStrictMode`/`toolStrictMode` compat 标志门控——该标志需要 shared
  schema 新字段（共享桶），登记进 R5 后续队列。
- anthropic wire：存量 `strict-tool-schema.ts` 折叠路径不动（R5）。
- 严格化结果按输入 schema 对象 memoize（omp stamps 侧表机制），重试/批量不重复走树。

## R4 fail-closed 语义（对照 model-option-map-fetch.ts:38-41 先例）

| 失败点 | 语义 | 依据 |
| --- | --- | --- |
| 发送点（tool-transform）方言归一/strict 管线抛出意外异常 | **fail-closed**：包装为 `AiSdkModelAdapterError(InvalidModelRequest)` 抛出，拒绝发送本次请求 | 宁可请求失败也不发坏 schema；异常进入既有 failure-classifier/retry 轨道 |
| MCP 注册边界（descriptor 物化）归一抛出 | **fail-closed**：异常向上传播进 mcp/index.ts 既有 connect catch，该 server 本次工具面注册失败并留档（单 server 爆炸半径，不拖垮其他 server） | 坏 schema 工具宁可不注册；对 JSON 输入归一器是全函数（循环/DAG/非对象都有守卫），实际触发面≈0 |
| strict 资格判定失败（precheck 不过 / enforce 抛） | **降级非 strict**（非错误）：发 upgraded schema、不带 strict 字段 | omp CONSTRAINTS #1.5：fail-open to non-strict，禁止发出半损坏的 strict schema |
| 归一结果是坏 JSON Schema（CCA validateAndFallback 路径） | 每工具确定性回退 `{type:"object",properties:{}}`（仅 CCA 方言启用；omp CONSTRAINTS #3.6：单工具坏不失败整请求） | 本波 CCA 无消费者，语义随方言入册 |

## R5 迁移队列处置

1. **波 2 队列 #1（strict-tool-schema.ts 的 `startsWith("claude-")`）：评估后维持登记，不迁移。**
   结论依据：`classifyModel` 的 `bare` 语义（取最后一个 `/` 后段）会**抹掉网关路由区分**——
   `anthropic/claude-x` 会被分类为 class `claude`，而存量资格判定的语义恰是"裸 `claude-`
   前缀的首方直连才算"（兼容网关可能拒绝 strict 字段）。等价迁移需要
   `supportsStrictToolSchema` compat 标志（shared `modelCompatFlagsDataSchema` 新字段 =
   共享桶，本波禁改）+ provider 能力探测证据。allowlist 条目原样保留（只减不增纪律不变）。
2. **chat wire strict 门控**（`supportsStrictMode`/`toolStrictMode` 对应物）：需要 shared
   标志新字段，登记为共享桶申请（见下）+ 波 4 队列。
3. **`toolSchemaFlavor` 配置下发**（builtin.json 携带 MFJS/grammar flavor，替代 per-model
   properties 标志）：涉及 provider/shared/共享桶，登记波 4。
4. **spill.ts「超大 schema 外置」：不适用登记。** 核实 omp `schema/spill.ts`（43 行）的
   实际语义 = 被剥离关键字降级进节点 `description` 的 spill 格式化器（`{pattern: "…"}` /
   `(key: value)` 两种格式），已随 `liftStrippedToDescription` 机制整体移植；omp 的
   "超大内容外置"是消息侧 blob 双层外置（blob:sha256 + artifact://，台账 T2 条目），
   与 schema 面无关——schema 侧不存在对应机制，无需移植。

## R6 懒加载与启动路径

- `schema-normalize/index.ts` 静态导出面只含**有消费者**的入口（MCP、Responses、MFJS、
  strict 管线、plan/apply 分发）；google/cca/ollama/grammar/cursor/apple 六个无消费者
  方言**不进静态 import 图**，经 `loadSchemaDialect(name)` 动态 `import()` 按名加载
  （未来接线时零重构），单测直接 import 方言文件。
- 归一化内核无模块级可变状态（stamps 侧表是 WeakMap，随宿主对象生命周期），无定时器、
  无 IO；启动路径零新增工作（descriptor/tool-transform 本来就在必经路径上，插点是纯函数调用）。

## R7 omptype/TSchema 解耦对照

| omp 依赖 | ACode 降解 |
| --- | --- |
| `@oh-my-pi/omptype` 的 `parseLocalRefPointer`/`formatLocalRefPointer` | `ref-pointer.ts` 本地移植（RFC 6901 语义逐字保留） |
| omptype `TSchema`/`type.enumerated(...)` 产出物 | 不涉及：移植面只消费 JSON Schema 普通对象 |
| `@oh-my-pi/pi-utils` 的 `$flag`/`logger`/`isRecord` | `process.env` 惰性读取 / 删除（纯函数不打日志，回退路径可测）/ `isJsonObject` |
| `AIError.ValidationError` | 本地 `StrictSchemaEnforcementError`（被 `tryEnforceStrictSchema` 捕获降级，不出内核） |
| Bun API | 无（omp 该目录本身无 Bun 依赖；fingerprint/cache 章节属 catalog 域，不在移植面） |

## 验收场景（测试矩阵）

1. **内核**：draft-07→2020-12 升级（items 数组→prefixItems、dependencies 拆分、
   nullable→null union、definitions→$defs、$ref 改写）；本地 $ref 内联 + 循环引用断环；
   循环/DAG 共享子树安全；snake_case 键改名与 python-genai 碰撞语义；type 数组标量化 +
   异型关键字剔除；spill 格式化（spill/paren 两式）；meta-validator 结构校验。
2. **MCP 方言**：保留校验关键字不动 description；剥 `$schema`/`nullable`；`def` 普通属性名
   不误伤；descriptor 集成：`{type:"object",properties:{}}` 等存量形状零变化（注册面零回归）。
3. **Responses 方言**：oneOf→anyOf（与既有 anyOf 拼接）；object 节点补空 properties；
   lookaround pattern 剥离（转义 `\\(?` 不误判）；`{}`→`true`；字面载荷（enum/const/default/
   examples 内）不改写；无改写时引用相等直通。
4. **strict 管线**：sanitize 剥非结构关键字 + default 内联 description；$ref 兄弟键内联
   （兄弟键胜出）；单元素 allOf 折叠（内联键胜出）；type 数组分支化 + description 提升；
   enforce 全 required + additionalProperties:false + 可选属性可空化 + 纯 union 展平；
   precheck 拒绝 patternProperties/additionalProperties:true/无约束布尔分支 → strict:false；
   混合原始类型 enum → 降级；adaptSchemaForStrict 组合语义 + env 旁路。
5. **MFJS 方言**：const/全 const union → typed enum；裸 enum 类型推断；oneOf 折入 anyOf；
   校验关键字剥离 + spill、default/description 保留；additionalProperties（布尔与 schema）
   与 type:null 分支保留；布尔子 schema permissive 折叠；字面载荷不走 walker。
6. **纯入册方言**：Google（不支持键剥离 + spill、type 数组→scalar+nullable、const→enum、
   object 补 properties、propertyOrdering、字符串 enum 限定）；CCA（combiner 合并/折叠、
   nullable 属性摘出 required、残留不兼容硬停 → 每工具回退）；Ollama（布尔子 schema 加宽、
   type 数组→allOf+anyOf、布尔 additionalProperties 剥除）；grammar（仅真子 schema 槽加宽、
   布尔 additionalProperties 保留）；Cursor（combiner 全消、not 含 combiner 整体丢弃、
   只加宽不收窄）；Apple（title/x-order/required 补全、不可表达节点 JSON 字符串编码 +
   encodedPaths 往返解码）。
7. **分发计划**：MFJS 标志优先于 wire；responses wire → responses 方言；chat wire → none；
   anthropic → none；gateway/custom → none；plan 不含任何 id 字符串分支（纪律守护测试
   扫描面自动覆盖新目录——model-compat-discipline.test.mjs 递归扫 adapters/src/model）。
8. **fail-closed**：归一器抛异常时 tool-transform 拒绝发送（InvalidModelRequest）；
   strict enforce 失败降级非 strict 且不带 strict 字段。

## 共享桶申请 / 新依赖

- 共享桶申请：本波**零改动即可落地**，无阻塞申请。非阻塞登记（波 4 用）：
  1. `packages/shared/src/model-config.ts` 增加 `supportsStrictToolSchema`（替代
     strict-tool-schema.ts 的 id 前缀判定，R5#1）与 `toolSchemaFlavor` 词汇
     （"moonshot-mfjs"|"grammar"|"none"，R5#3）；
  2. `apps/acode-cli/packages/adapters/package.json` exports 若需对外暴露
     schema-normalize 子路径（当前仅 adapters 包内消费，不需要）。
- 新 npm 依赖：零。

## 已知限制（如实登记）

- **MCP 工具缓存回载不经过归一**：快启门缓存（mcp-tool-cache）从磁盘回载的
  descriptor 直接进注册面（mcp/index.ts:1209-1221，本波所有权外），旧缓存条目
  携带的是归一前 schema。与波 3 之前行为完全一致（零回归），且缓存每次真实
  tools/list 成功都 best-effort 覆写为已归一集合（descriptor 物化在覆写之前），
  陈旧窗口自愈；模型发送面的 Responses/MFJS 方言仍按请求逐工具归一，wire 面
  不受缓存陈旧影响。缓存回载点补归一登记为后续增量（需 mcp/index.ts 插点授权）。
- google/cca/ollama/grammar/cursor/apple 六方言在 ACode 无真实端点验证（无消费者，
  纯函数单测锚定 omp 语义）；Responses strict 与 MFJS 路径本波未对真实 OpenAI/
  Moonshot/GLM 端点回归（无凭据环境），行为锚点 = omp 单测期望 + 契约文档。
- omp `toolWireSchema`/`normalizeEmptySchemas`（wire.ts）不在移植面：ACode 的 wire schema
  由 zod→AI SDK jsonSchema() 产出，无"空 schema 归一为 true"的上游步骤；Responses 方言
  自带 `{}`→`true` 安全网（omp 同注释），Ollama/grammar 的布尔加宽因此是防御性路径。
- omp 的 strict 结果 quarantine（findStrictToolSchemaViolation 每工具剔除）不移植：
  ACode 发送点无每工具剔除面（contract 来自 core，剔除会造成工具面静默缺员），
  fail-closed 整请求失败 + 响亮错误更符合 ACode 语义；登记差异，不静默对齐。
