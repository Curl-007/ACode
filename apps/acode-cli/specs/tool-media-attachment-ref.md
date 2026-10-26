# 工具图片使用受授权附件引用（tool-media-attachment-ref）

状态：实施中（U11，2026-10-26）
来源：`docs/upgrades/product-and-support-2026-10.md` §5（U11 提案）
UI 侧对应 spec：`packages/ui/specs/tool-media-on-demand.md`（读取生命周期、缓存与降级）

## 1. 背景与动机

用户浏览图片密集历史时，应当先看到轻量行内容，图片可见或打开预览时才读取字节；重连后仍能预览；
其他 workspace/session 的媒体无法被读取。

U11 之前，`node_repl_images` display（`packages/shared/src/acode-protocol-v4/toolDisplay.ts`）只内联
base64：每张 ≤ `200 * 1024` 字符、最多两张。字节随 row 一起进 snapshot/replay/传输，
renderer 的 lazy `<img>` 只延迟**解码**，不减少 row 里承载的字节。

Gateway（`v4-gateway.ts`）当时已按两条路径授权媒体读取：权威 `userInput` 附件，以及当前 session 的
assistant Markdown artifact ref。这两条规则都不能直接用于工具 row：前者按 user row 的
`attachments[attachmentIndex]` 定位，工具产物不挂在 user row 上；后者读的是**模型可控**的
`row.text`，必须靠 session 绑定兜底。

本 spec 定义第三条授权路径：**工具 row 的媒体按当前 session 的权威工具产物授权**。

## 2. 范围

### 2.1 本项覆盖

- `node_repl_images` display 的 **ref 形态**（wire schema、形态校验、授权判据）。
- ref 形态的字节读取授权（gateway 第三条分支）。
- 与既有 inline base64 形态共存的兼容策略。

### 2.2 非目标（逐字承接提案 §5.1）

- 不恢复 fail-closed 的 CUA 表面。
- **不增加任意路径读取**：ref 只接受 `acode-artifact://` scheme，裸路径/绝对路径一律拒绝。
- **不把模型可控 Markdown 当作跨 session 授权**：工具媒体授权不读 `row.text`。
- **不提高当前 node-repl 图片生产上限**：仍是每张 ≤200 KiB base64 字符、最多两张。
- 超大媒体、流式文件 range IO、通用媒体库**另立项**。现有 chunk 读取仍是「先整文件物化再切片」，
  不是 Host 真正 range IO——本项沿用该既有语义，不宣称解决了超大文件内存。

## 3. wire metadata（shared v4）

单一真源：`packages/shared/src/acode-protocol-v4/tool-media-ref.ts`
（经 `packages/shared/src/acode-protocol-v4/index.ts` 导出；根 `packages/shared/src/index.ts` 不re-export v4，
消费方走 `@acode/shared/acode-protocol-v4` 子路径）。

`node_repl_images` 的 `images[]` 成员是**两种形态之一**，各自 `.strict()`：

```
inline（legacy，逐字保持 U11 之前的界）:
  { base64: string(1..200*1024), mimeType: /^image\/[a-z0-9.+-]+$/i }

ref（U11 新增）:
  { ref: string(形态见 §4),
    mimeType: /^image\/[a-z0-9.+-]+$/,
    bytes: int(1..PROTOCOL_V4_LIMITS.attachmentMaxBytes),   // 轻量占位 + 进度/越界判定
    width?: int(1..16384), height?: int(1..16384),           // 可选尺寸，仅占位用
    sha256?: /^[0-9a-f]{64}$/ }                              // 可选完整性校验
```

`images` 数组仍是 `.min(1).max(2).optional()`（`TOOL_MEDIA_MAX_IMAGES = 2`）：
CUA 的纯动作 cell 无截图但仍携带 `app` 身份，故 optional；上限不提高。

### 3.1 兼容策略（两种形态如何共存）

- **旧生产者 → 新客户端**：inline 形态原样保留，schema 分支未变，旧 CLI/agent 发的 row 照常校验通过。
- **新生产者 → 旧客户端**：旧客户端的 strict schema 不认识 ref 形态，会把**整块 display** 校验失败
  并 `.catch(undefined)` 剥掉（`toolCallRowSchema.display` 的既有语义：装饰载荷不得决定 row/帧/订阅
  的生死）。结果是工具卡退化为无图，**不是**崩溃或整条订阅失败。因此 producer 必须按 capability
  协商后才发 ref 形态（见 §6，当前未接线）。
- **同一张图不能同时携带两种形态**：union 两个分支各自 `.strict()`，既带 `base64` 又带 `ref`
  的对象在两个分支都失败 → 整块拒。
- 不强制全库重写：已持久化的 inline 历史保持可读。

## 4. ref 形态校验（R2）

`inspectToolMediaRef(ref)` 返回 `null`（合法）或稳定拒绝 code。zod schema（`toolMediaRefSchema`）
与 gateway 授权**共用这一个判据**，不各写一套。

拒绝顺序是可证明的（测试据此断言分类）：

| 顺序 | 判据                    | 拒绝 code           | 理由                                                       |
| ---- | ----------------------- | ------------------- | ---------------------------------------------------------- |
| 1    | 非字符串                | `not_string`        | 类型面                                                       |
| 2    | 空串                    | `empty`             | 无归属可言                                                   |
| 3    | > 4096 字符             | `too_long`          | 与协议其它 URI/路径字段同级                                  |
| 4    | 含 NUL                  | `nul`               | C 字符串截断面；**整串检查，先于 scheme**                    |
| 5    | 含反斜杠 `\`            | `backslash`         | Windows 路径分隔符注入面                                     |
| 6    | 非 `acode-artifact://`  | `wrong_scheme`      | 拒绝裸路径/绝对路径/`file://`/`http://`——即「不增加任意路径读取」 |
| 7    | authority 为空          | `empty_authority`   | 无 session 归属                                              |
| 8    | path 为空               | `empty_path`        | 无产物身份                                                   |
| 9    | `..` 作为完整 path 段    | `traversal`         | 目录穿越；`a..b` 这类合法 id 片段**不**拒                     |
| 10   | authority/path 含裸冒号 | `ads_colon`         | Windows ADS（`name:stream`）或第二 scheme                     |

第 4/5 步在第 6 步之前：一个带 NUL/反斜杠的串不该因为前缀正确就进后续解析。
第 9/10 步在 scheme 之后：`acode-artifact://` 里的冒号是 scheme 分隔符，只有切掉它之后
authority/path 段的裸冒号才是 ADS。

percent-encoded 冒号（`%3a`）**不在这里解码**：host 侧按整串 URI 记账、不解码 path，
故编码冒号不构成 ADS 注入面。若将来 host 改为解码 path，这条必须同步收紧。

## 5. 读取时授权（R3）—— 安全不变量的落点

单一真源：`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/tool-media-authorization.ts`
（从 `v4-gateway.ts` 拆出的纯函数叶子，理由同 `product-projection-*.ts`：gateway 已在 max-lines
既有欠账里，不再加码）。

### 5.1 授权链

```
调用方给的 ref
     │
     ├─① 形态合法吗？（inspectToolMediaRef）                     否 ⇒ null
     ├─② ref.authority == encodeURIComponent(本 session) 吗？     否 ⇒ null
     └─③ 当前 session 投影里有一条 toolCall row，其 display
          (node_repl_images) 的 images[].ref **逐字**等于它吗？     否 ⇒ null
          命中 ⇒ 返回**行上的** mimeType / bytes
```

### 5.2 为什么模型可控内容不能铸造授权

第 ③ 步的权威来源是 `ToolCallRow.display`，它由 runtime 的
`core/src/tool/executor/result-display.ts` 生产、经 `product-projection.ts` 的
`toProtocolToolCallDisplay` 白名单投影到 row 上。**模型无法注入 `images[].ref`**：
display 不是模型可写的通道。

对比 assistant-Markdown 那条既有分支（`v4-gateway.ts` 的 `resolveReadableMediaAttachment`）：
它读的是模型可控的 `row.text`，所以**必须**靠 `artifactRefBelongsToSession` 的 session 绑定兜底。
工具媒体这里 ② 与 ③ 双重约束，且 ③ 的来源本身不可被模型污染——这是比 Markdown 分支更强的保证。

推论（验收场景 U11-A3）：ref 出现在 `output.text`、assistant Markdown 或任何其它文本里，
**都不构成授权**。只有它出现在本 session 权威 toolCall row 的 display 上才算。

### 5.3 fail-closed 与不泄漏判据

- 越权（另一 session/workspace 的 ref）与「ref 根本不在投影里」对调用方是**同一个业务事实**：
  一律返回 `null`，由 gateway 归一成既有 `fault.attachment.previewRefNotAuthorized`，
  不告诉越权者它猜对了哪一半（与 `workflowRunArtifactRead` 的 not-found 约定同姿态）。
- 命中后返回的 `mime` 取**行上的**值，不采信 renderer 自报 MIME/bytes/path。
- inline 形态的图片不参与按需授权（它没有 ref，字节已在 row 里）。
- 读取本身复用 `attachmentRead` 的既有链（`readAttachmentPayload` → host `readSessionAttachment`），
  包括 TTL/字节预算缓存与「chunk 是切片不是真 range IO」的既有语义。

### 5.4 接线位置

`v4-gateway.ts` 的 `resolveReadableMediaAttachment` 在**ref-only 分支**（无 `target`/`attachmentIndex`）
里、既有 userInput/Markdown 扫描之前插入工具媒体判定。

选择 ref-only 分支是必需的：`v4AttachmentReadParamsSchema` 的 superRefine 要求 `target` 与
`attachmentIndex` **成对出现**，而工具媒体没有 attachmentIndex 语义。因此工具图片读取复用
`attachmentRead({ sessionId, ref })`——与 `markdown-image.tsx` 读 assistant artifact 完全同一条路径，
**不需要新增 wire method**，也不需要改 `server.ts` / services / transport。

## 6. producer 侧（跨文件项，本 spec 只定规则）

规则：**新工具图片必须先成功持久化，再发布引用**（提案 §5.2）。写入失败不得发布虚假成功引用——
此时回退 inline base64（受既有 200 KiB / 2 张上限约束），不是发布一个读不到的 ref。

producer 位置 `apps/acode-cli/packages/core/src/tool/executor/result-display.ts` 的
`createNodeReplDisplay`，其契约镜像在
`apps/acode-cli/packages/contracts/src/tools/tool-result-metadata.ts` 的
`nodeReplImageToolResultDisplayPayloadSchema`（两侧都是 strict，**必须同步**，否则 display 整块被剥）。
这两个文件不在本项的实施范围内（见 §9 跨文件项），因此**当前没有生产者发出 ref 形态**：
shared schema、gateway 授权与 UI 读取链已就绪并测试，等待 producer 接线。

capability 协商（提案 §5.2「新写入前须有明确 capability/schema 协商」）同样属 producer 接线范围：
不支持 ref 形态的旧客户端不能收到无法解析的 row。

## 7. 状态所有权

| 对象               | 所有者                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| 媒体字节与持久化   | 既有 CLI/Host artifact store（`acode-artifact://<session>/<id>`）；生命周期与会话历史一致 |
| wire metadata      | shared v4 `tool-media-ref.ts`（形态与上限的唯一真源）                                    |
| 读取授权           | gateway（`tool-media-authorization.ts` + `resolveReadableMediaAttachment` 接线）           |
| 字节缓存与 URL     | UI `lib/toolMediaOnDemand.ts` 的 loader（见 UI spec）；正文 store 只持 metadata            |
| identity 路由      | 既有 workspace-bound transport 贯穿 `workspaceIdentity` / `remoteSessionId`；不手写 identity key |

存储引用的寿命与会话历史一致；清理不能让仍可浏览的历史出现静默失效（提案 §5.2）。
引用失效时 UI 显示明确错误并允许按当前授权重试，不退回任意本地路径。

## 8. 验收场景

编号沿用提案 §5.4；「证据」列指明当前可自动化的部分。

| 编号   | 前提                                | 操作                     | 必须断言                                                                     | 证据                                                                       |
| ------ | ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| U11-A1 | 新格式合成图片历史，图片未进视口     | 冷启动并恢复 snapshot/replay | row 没有原图 base64；不预读原图；引用与元数据可渲染                            | `packages/shared/test/tool-media-ref.test.ts`（schema）、`packages/ui/tests/toolMediaOnDemand.test.mjs`（fetch 0 次） |
| U11-A2 | 工具 row 的有效稳定 ref              | 进视口、打开预览、重连    | 按需读取并正确显示；重复预览复用缓存；重连重新授权                             | 同上（loader 去重/换代）；桌面与手机截图**未验证**（见 §9）                    |
| U11-A3 | 另一 session/workspace 的 ref 或伪造 target | 调用读取接口       | 明确拒绝；不能依赖 ref 出现在任意文本就授权；没有文件字节返回                   | `apps/acode-cli/tests/tool-media-authorization.test.mjs`（9 例授权矩阵）      |
| U11-A4 | 旧 inline 历史与旧客户端             | 打开旧历史，协商能力      | 旧图片可读；新 variant 不发给不支持客户端；无强制全库重写                       | inline schema 测试 + `extractToolMediaRefImages` 的两路径不重叠测试；capability 协商**未接线** |
| U11-A5 | 读到一半切换会话、关闭预览或资源失效 | 继续返回旧 chunk          | 旧结果不污染新视图；URL 被释放；错误有终态，无无限读取                          | `packages/ui/tests/toolMediaOnDemand.test.mjs`（换代丢弃/dispose/error 终态）   |

### 8.1 测试清单（本项实跑）

- `packages/shared/test/tool-media-ref.test.ts` —— 17 例：ref/inline strict、traversal、ADS、NUL、
  反斜杠、错误 scheme、200 KiB 上限、≤2 张上限、形态非法 ref 使整块 display 被拒。
- `apps/acode-cli/tests/tool-media-authorization.test.mjs` —— 9 例：授权矩阵（本 session 命中、
  跨 session 拒绝、伪造 target 拒绝、文本出现不授权、inline 不授权、形态非法前置拦截、空投影、
  多 row 精确命中、belongsToSession 组合判据）。
- `packages/ui/tests/toolMediaOnDemand.test.mjs` —— 16 例：sessionId 还原 fail-closed、节流判据、
  展示态、缓存键、计数 fetcher 证明按需、并发去重、reconnect 换代、在途结果不污染、error 终态、
  dispose/逐出释放 URL、inline data URL 向后兼容。
- `packages/ui/tests/toolMediaRefImages.test.mjs` —— 12 例：三种 display 落点、元数据保真、
  非法 ref 降级、去重、上限、与 inline 路径不重叠、循环引用去环。

## 9. 未落地与跨文件项

1. **producer 未接线**（§6）：`core/src/tool/executor/result-display.ts` 与
   `contracts/src/tools/tool-result-metadata.ts` 不在本项实施范围，当前无生产者发出 ref 形态。
   链路（schema → 授权 → UI 读取）已就绪并测试。
2. **capability/schema 协商未实现**：发 ref 形态给旧客户端会导致其 display 被剥（无图卡，不崩溃）。
   接线 producer 前必须先有协商。
3. **renderer 侧 `sessionId`/`readAttachment` 的正规注入通道缺失**：见 UI spec §7。
4. **真 range IO 未实现**：沿用「整文件物化再切片」的既有语义。
5. **双链路 E2E 与预算实验未执行**（提案 §5.3 步骤 5）：传输字节减少 ≥80%、renderer/Host 内存、
   UI 缓存预算（桌面 ≤16 MiB / 手机 ≤8 MiB）都需 fixture 校准后才能进 spec。本项的 loader 默认
   `maxEntries = 24` 是保守占位，**不是**已校准的字节预算。
