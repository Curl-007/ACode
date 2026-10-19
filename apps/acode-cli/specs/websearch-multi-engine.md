# WebSearch 多引擎注册表（WI-7 · omp 价值提取波1 T1#10）

移植自 oh-my-pi（MIT）`packages/coding-agent/src/web/search/**`，落点 `apps/acode-cli/packages/core/src/websearch/**` 与 WebSearch handler 的可选分支。台账依据：`zoode/ACode-价值提取-oh-my-pi.md` T1#10 + 九路报告要点存档⑥（懒加载注册表 21 纯引擎、StructuredQuery、applyQueryConstraints 后置过滤宁放宽不空结果、凭据缺失 isAvailable=false 静默跳过）。

## 1. 目标与非目标

目标：WebSearch 获得可选的多引擎层——引擎注册表（首次搜索才 import 引擎模块，启动零开销）、Google 风格结构化查询（各引擎译方言 + 统一后置过滤）、按可用性顺序的回退链（失败聚合报告）、纯 env 凭据通道。

非目标：
- 不改 WebFetch 的 provenance 门（URL 白名单纪律）；本 spec 只影响搜索结果的呈现面。
- 不移植 omp 的 6 个 grounding 后端（gemini/anthropic/codex/xai/openai/openrouter）——它们是聊天模型托管搜索，ACode 已由 provider-native 路径覆盖。
- 不移植 omp 的 authStorage 凭据 broker / 模型角色链（`web/*` catalog 模型）——见 §7 共享桶申请。

## 2. 状态所有者与模块边界

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 引擎实例 memo | `websearch/registry.ts`（`providerInstances` Map） | 每 id 一个 Promise，首次 `getSearchProvider` 才触发动态 import |
| 引擎模块已加载标记 | `websearch/loaded-engines.ts`（Set） | 仅测试观测面；引擎模块顶层注册，无行为作用 |
| 链配置 | `websearch/engine-config.ts` | 每次调用从 `process.env` 解析，无缓存（env 热改即时生效，与既有 budget env 同纪律） |
| 查询解析 | `websearch/query-parse.ts` 纯函数 | 无状态 |

依赖方向：`tool/handlers/websearch.ts → websearch/*`；websearch 不 import handlers，不 import adapters（凭据只走 env）。websearch 内部单向：providers → base/types/query/utils。

## 3. 行为

### 3.1 引擎选择与配置面（最小侵入）

- `ACODE_WEBSEARCH_ENGINES` 未设置或为空 → **现状不变**：走既有 provider-native 路径（含 model 能力检查）。这是默认且是验收红线（不破坏存量）。
- `ACODE_WEBSEARCH_ENGINES=<id,id,…>` → 走多引擎链，**替代** provider-native 路径（该请求不再要求 model 存在或 supportsNativeWebSearch）。顺序即优先级；显式点名 = omp 的 explicit 选择语义（用 `isExplicitlyAvailable` 判定，`public` 聚合引擎因此可用）。
- `ACODE_WEBSEARCH_ENGINES=auto` → 使用内置默认链（免 key 引擎在前，env-key 引擎在后，按可用性静默跳过）。
- 不新增设置文件/共享 schema；凭据一律 env（§5），**不新增明文凭据存储**。

### 3.2 回退链（`websearch/chain.ts`）

事件顺序（单次 WebSearch 调用）：
1. 解析链配置（引擎 id 列表）；空 → 回落 provider-native（仅当 env 未设置时可能）。
2. `parseSearchQuery(query)` 一次，贯穿全链。
3. 依序遍历引擎：`isExplicitlyAvailable` 为 false → **静默跳过**（不进失败清单，不打日志）。
4. `engine.search(params)` 成功 → `applyQueryConstraints` 后置过滤（§3.4）→ 组装 WebSearchOutput 返回。
5. 失败（含空结果视为失败）→ 记入 failures，继续下一个引擎；`AbortSignal` 已中止 → 立即中止整链（不吞用户取消）。
6. 全部失败 → in-band WebSearchOutput（`results=[]`、`sources=[]`、`summary=All web search engines failed: <formatSearchProviderFailures>`），模型可读失败原因清单继续工作，不进入异常恢复循环。

链执行器接受注入的 provider 解析器（测试缝）；生产默认走 registry。

### 3.3 SearchProvider 契约（`providers/base.ts`）

`isAvailable / isExplicitlyAvailable / search` 三件套照抄 omp 语义。`SearchParams` 保留 omp 的纪律注释：**recency 是纯时间过滤**——禁止改写话题范围/内容域/排序策略；引擎不支持就静默忽略，不得借 recency 改写查询。`authStorage/model/modelRegistry` 等 omp 专属字段不移植；凭据经 `resolveEngineApiKey`（env）。

### 3.4 StructuredQuery（`query-parse/format/filter.ts`）

- 解析算子：`site:`/`domain:`/`host:`、`inurl:`/`url:`/`allinurl:`、`intitle:`/`title:`/`allintitle:`、`intext:` 族、`filetype:`/`ext:`、`before:`/`until:`、`after:`/`since:`、`lang:`、引号短语、`OR`/`AND`/`NOT`、`-排除`、`+verbatim`、括号分组。未知 `name:value`（URL、`C:\path`）保持原文不误吞；`before:someday` 这类不可解析值降解为普通词。
- 各引擎按自身方言重建查询（`formatQuery` + 引擎专属 `QuerySyntax`）；引擎不支持的算子从查询串剥离，交给后置过滤。
- `applyQueryConstraints` 宽松后置过滤：逐约束维度过滤，某维度会清空全部结果时**放宽**并记入 dropped（宁放宽不空结果）。无日期的结果通过日期界（缺日期不是违规证据）。

### 3.5 输出映射

`SearchResponse.sources → WebSearchOutput`：`results=[{url,title,pageAge:publishedDate}]`、`sources=[{url,title}]`、`summary` = 引擎标签 + 可选 answer + 放宽说明（`no results matched \`site:x\`; the constraint was relaxed`）。`webSearchRequests=0`（非 provider-native）。`formatModelContent` 复用既有渲染（含零结果零来源不渲染 REMINDER 的预算包装）。`allowed_domains`/`blocked_domains` 在链上统一后置过滤（域后缀匹配），与约束过滤同缝。

## 4. 失败语义与易碎面

- HTML 抓取类引擎（duckduckgo/mojeek/startpage/ecosia/google）解析基于正则（omp 用 DOM 解析器，ACode core 无该依赖，降解为正则——移植文件头注明）。每个引擎独立单测桩（fixture HTML，`tests/websearch-multi-engine-parsers.test.mjs`）；单引擎坏只产生该引擎的 failure 条目，不拖垮注册表与其他引擎。
- DuckDuckGo 双前端降级（ACode 适配，2026-10 实测）：数据中心出口 IP 上 `html.duckduckgo.com`（POST）常被 anomaly 墙拦截，而 `lite.duckduckgo.com`（GET）通常可用——html 前端失败（非用户取消）时自动降级 lite 前端再试一次，两者都失败才报错。
- 机器人墙识别照抄 omp（`anomaly-modal`、`/sorry/`、`altcha-widget`、Cloudflare `_cf_chl_opt`、Startpage consent/captcha 壳等），报 429 + 可操作文案。
- 响应体读取有字节上限（2 MiB / 错误 8 KiB）；超限按 provider 错误处理。
- 凭据缺失：`isAvailable=false` → 链上静默跳过；无凭据存储写入路径。
- 用户取消（abort）立即中止整链且不降级为「引擎失败」；取消语义以 AbortSignal 为准（上层执行器同时会取消工具调用）。

## 5. 凭据（仅 env）

| 引擎 | env |
| --- | --- |
| brave / deepseek / exa / jina / kagi / tavily / firecrawl / perplexity / synthetic / tinyfish / parallel / zai | `<ID>_API_KEY`（如 `BRAVE_API_KEY`） |
| kimi | `KIMI_SEARCH_API_KEY` 或 `MOONSHOT_SEARCH_API_KEY`（Kimi Code 搜索服务，非 Moonshot 开放平台 key） |
| ollama | `OLLAMA_CLOUD_API_KEY` |
| searxng | `SEARXNG_ENDPOINT`（必需）+ `SEARXNG_TOKEN`（可选） |

## 6. 验收

1. StructuredQuery 全算子解析单测。
2. 注册表懒加载单测（导入 registry 后 loaded-engines 集成为空；取引擎后含该 id）。
3. 回退链单测：首选失败→次选成功 + 失败聚合；全败聚合清单。
4. `applyQueryConstraints` 后置过滤单测（含放宽路径）。
5. 凭据缺失静默跳过单测。
6. 默认路径不回归单测（env 未设 → 仍走 provider-native 分支，缺 model 报既有错误）。
7. ≥1 个免 key 引擎真实网络冒烟（不可达则如实声明）。
8. `pnpm --filter @acode/core test` / typecheck 真实执行。

## 7. 共享桶申请

- **adapters 账号设施只读复用（暂缓）**：omp zai/kimi 等引擎的凭据走 authStorage broker；ACode 对应设施在 `apps/acode-cli/packages/adapters/src/auth/`（bigmodel-oauth、provider-api-key-vault）。core→adapters 是新增跨模块入边（adapters 依赖方向与 core 相互独立，引入即成环风险），本波不接：引擎全部走 env；后续若要复用，需在 architecture-policy.yaml 登记新模块边界并给 websearch 定义凭据 port（读侧注入），届时 zai 引擎把 `resolveEngineApiKey("zai")` 换成 port 实现即可，引擎代码无需再改。

## 8. 新依赖

无。全部用 node 内建（fetch/URL/AbortSignal）与既有依赖；omp 的 `@oh-my-pi/pi-utils/dom`（HTML 解析）、`HeaderGenerator`、puppeteer 浏览器回退均降解为正则解析/静态指纹/纯 fetch，见 §4。
