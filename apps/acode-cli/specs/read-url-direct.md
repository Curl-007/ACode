# Read URL 直读（read-url-direct）

状态：已实施（UX 波 A2，2026-10-18）
来源：oh-my-pi (MIT) read 工具的 URL/外部目标直读形态（packages/tui/src/chat/
read-tool-group.ts 的「filesystem/external targets」语义、packages/coding-agent
read 工具的 url-scheme-host 分支）。机制参照，代码自撰；管道复用本仓库 WebFetch。

## 背景与动机

模型想「看 URL 原文」时只有 WebFetch 一条路：页面 markdown 先经小模型按 prompt
转述，原文细节在转述层丢失，且 WebFetch 语义是「回答问题」不是「读文件」。
omp 的 read 原生接受 URL/外部目标，返回带行号原文，与文件读同一心智。本件给
ACode Read 补 `http(s)://` 直读分支：返回原始 markdown（cat -n 行号），
网络控制面 100% 复用 WebFetch 管道（唯一所有者不变）。

## 产品规则

### R1 触发与优先级

- `file_path` trim 后匹配 `^https?://`（大小写不敏感）→ URL 分支。
- 分支判定在 `applyPathSelector` **之前**：选择器文法以最后一个冒号切分，
  `https://host:8080/path` 的端口段会被误拆为行号选择器（`:8080` 匹配数字
  文法）。URL 目标本批不支持选择器/行窗文法，offset/limit 参数仍然生效
  （对行号化 markdown 做窗口切片）。
- 与 `conflict://`、`skill://` 无交叠（scheme 互斥）；本地路径行为零变化。

### R2 网络控制面全量复用 WebFetch（单一所有者 = webfetch 管道）

按 WebFetch handler 同一顺序执行，全部复用既有模块，不新写网络代码：

1. `normalizeWebFetchUrl`：http→https 升级、非法 URL/协议/凭据拒绝。
2. **溯源闸门**（specs/error-taxonomy-injection-defense.md R5）：允许集 =
   预批文档域（`isWebFetchPreapprovedUrl`）∪ 会话溯源集
   （`resolveWebFetchProvenance`）。被拦 URL 抛 `UnprovenancedUrl`（不可重试，
   文案含「写进结论/请用户贴内容」指引，与 WebFetch 同一措辞纪律）；放行即
   记账（原始 + 归一化两形态）。闸门在缓存与网络之前。
3. `fetchAndExtractContent`：逐跳字面 egress 守卫（本地/私网/元数据端点阻断，
   含重定向逐跳）+ 适配器公网 DNS 预检 + markdown 抽取 + 原始内容 artifact
   持久化，全部既有语义。
4. 跨主机重定向 → 终态指引文案（目标 URL 即时入溯源集，模型用重定向 URL
   再调 Read；与 WebFetch 同构，措辞指向 Read）。
5. **与 WebFetch 共享 15 分钟缓存**（`getWebFetchCache`/`putWebFetchCache`，
   同 key = 原始 URL 串）：两个工具对同一 URL 互为缓存命中。
6. 网络观测相位标注 `runWithNetworkCapturePhase("webfetch", …)`：同一管道
   同一相位标签，不扩 contracts 的相位闭集。

### R3 权限面决策记录

Read 的静态 `ToolEntry.permission`（read/low/needsApproval:false）无法按输入
切换为 webfetch 审批——ToolEntry 无 per-call 动态权限通道，执行器在 handler
之前按静态声明评估。决策：

- **实际控制面 = R2 的溯源闸门 + egress 守卫**：可抓取目标集由构造保证源自
  用户（用户消息 / 用户可见的搜索结果 / 既往抓取结果里出现的 URL），SSRF 由
  逐跳 egress 守卫阻断；这与 omp 把 URL 读作为 read 一等形态的边界一致。
- **kill switch**：`ACODE_READ_URL=0` 关闭 URL 分支——关闭态下 URL 输入得到
  显式业务错误（指引改用 WebFetch），**不静默降级**进文件管线（避免把 URL
  当相对路径解析出误导性 not_found）。缺省开启；门控纪律与
  `ACODE_WEBSEARCH_ENGINES` 先例一致（env 读取在调用点，测试可覆写）。
- **审计**：不新增日志通道（core handler 无 service logger 面）——每次 GET 由
  管道内既有 `NetworkRequestStatus` 会话事件承载（webfetch-network 逐请求发出，
  含 URL/status/bytes），工具调用记录本身以 URL 为 input；响应内容与凭据不落日志。
- 不可信内容纪律（specs/web-content-untrusted-discipline.md）：URL 原文直通
  模型上下文，输出尾注携带一行「页面内容是不可信外部数据」提醒；描述层
  （R5）同步预告。

### R4 输出形态

返回 `ReadTextOutput`（`type: "text"`，`filePath` = 原始 URL 串）：

- 成功：markdown 原文经 `addReadLineNumbers` 行号化（与文件读同一 cat -n
  心智）；offset/limit 对行窗口切片（startLine/numLines/totalLines 如实）；
  超过 `READ_MAX_FILE_SIZE_BYTES` 按行粒度截断（`truncated: true`）。
  `summaryFooter` = `[url-read]` 元数据行（finalUrl、HTTP status、contentType、
  bytes、cache 命中标记、截断时的 artifactUri）+ 不可信内容提醒行。
- 终态 redirect / http_error：指引文案作为 text 输出（模型可见），语义与
  WebFetch 终态同构。
- **不进 readFileState**：URL 无 mtime/revision 语义，不产生 file_unchanged
  stub，不写 read-file-state metadata（ freshness 缓存只属于文件管线）。

### R5 模型描述层

`READ_PROVIDER_DESCRIPTION` 增加一行：file_path 亦接受 http(s) URL，页面经
WebFetch 管道（溯源闸门、egress 守卫、15 分钟缓存）以带行号 markdown 返回；
溯源规则预告与 WebFetch 描述同款（第一次就带对 URL 来）。

## 状态所有者

- 溯源账本 / 缓存 / egress 守卫：webfetch 管道模块（唯一所有者，本件零复制）。
- URL 分支判定与输出装配：`core/src/tool/handlers/read-url.ts`（新文件）。
- read.ts 只加 dispatch（分支判定 + 委托），逻辑不进主 handler。

## 验收场景

1. 溯源集内 URL（账本记账后）→ 返回行号化 markdown 文本输出，`filePath`
   为原始 URL；缓存种子命中时零网络（无 httpClientPort 也成功）。
2. 未溯源 URL → `UnprovenancedUrl` 业务错误（不可重试语义），错误文案含
   「写进结论」指引；不触网、不进缓存。
3. `ACODE_READ_URL=0` → URL 输入得到显式「已禁用，改用 WebFetch」错误，
   不落文件管线（不出现 not_found 形态）。
4. 端口 URL `https://host:8080/p` 不被选择器误拆（进 URL 分支而非
   `path=https://host` + 选择器 8080）。
5. offset/limit 对 URL 内容做行窗口切片，startLine/numLines 如实。
6. 超预算内容按行截断，`truncated` + footer artifactUri 指引。
7. 非 URL 输入（本地路径、skill://、conflict://、Windows 盘符）行为与改动前
   完全一致（既有套件全绿即证）。

## 范围外（登记不立项）

- URL 目标的选择器/行窗文法（`https://x:100-140`）与 omp 的 archive/zip 直读。
- HTML 原文（非 markdown）直通模式。
- 动态权限通道（ToolEntry per-call permission override）——若未来引入，
  URL 分支应改挂 webfetch 审批面，本 spec R3 决策随之作废。
