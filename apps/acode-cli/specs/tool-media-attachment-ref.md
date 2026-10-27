# 工具图片使用受授权附件引用（tool-media-attachment-ref）

状态：实施中（U11，2026-10-26；producer 半程 2026-10-27，默认关闭门后已接线，见 §6）
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
  的生死）。结果是工具卡退化为无图，**不是**崩溃或整条订阅失败。因此 producer 只在**默认关闭**的
  生产门后发 ref 形态（见 §6.4 / R10：安全的 client→host 协商不可达成，故不默认开启）。
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

## 6. producer 侧（R7–R10）

单一真源（三个叶子，全部在 `apps/acode-cli/packages/core/src/tool/` 下）：

| 文件                                          | 职责                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| `executor/tool-media-limits.ts`               | 上限常量、mime→扩展名、**默认关闭**的生产门与纯判据 `shouldEmitToolMediaRefs` |
| `executor/node-repl-display.ts`               | 同步 display 构造（`createNodeReplDisplay`）+ WeakMap 侧信道读取已持久化的 ref |
| `handlers/node-repl-media.ts`                 | 异步持久化（截图路径 + 图片 ref），唯一持有 `ToolExecutionContext` 的写入面 |
| `contracts/src/tools/node-repl-display.ts`    | `node_repl_images` display payload 的 **strict 镜像**（inline ∪ ref 两分支） |

拆分理由：`result-display.ts`（473 行）与 `node-repl.ts`（413 行）都已贴住 max-lines，
把 node_repl 的 display 构造与 artifact 写入各抽成一个叶子后，两个原文件都**变小**（见 §10）。

### 6.1 生产时机与数据流（R7）

```
js handler（async，context 齐全：sessionId/turnId/toolCallId/artifactStore/abortSignal/trace）
   │
   ├─ session.run(code) ──▶ runResult.images: [{base64, mimeType}]   （模型可见通道，不变）
   │
   ├─ shouldEmitToolMediaRefs({enabled, clientMode, artifactStore})   ── 否 ──▶ 不持久化，走 inline
   │        │ 是
   ├─ persistNodeReplImageRefs(...)  ── 每张图写一次 artifact ──▶ WeakMap.set(output, refs)
   │        │ 写失败（非 abort）⇒ 该张**不进** refs
   │        ▼
   └─ JsOutput { images, … }          ← 契约**不加字段**；refs 走 WeakMap 侧信道
            │  同一个 output 对象身份
            ▼
   createToolResultDisplay("js", output)     （sync 纯函数，热路径不做 IO）
            │
            └─ createNodeReplDisplay：按 index 把 images[i] 换成 ref 形态；
               没有 ref 的图（写失败 / 门关闭 / content 派生）保持 inline base64
```

规则：

- **R7.1 持久化在 handler，不在 display 构造器。** `createToolResultDisplay` 是同步纯函数、位于所有
  工具的热路径（`call-runner.ts`），把它改成 async 会让每次工具调用都为 node-repl 图片付代价。
  handler 已经是 async 且已持有 `artifactStore` 与全部标识，与既有
  `persistBrowserScreenshotPaths` 同一姿态。
- **R7.2 ref 不进模型可控通道，也不进工具输出契约。** 用 **WeakMap 侧信道**（键 = handler 返回的
  output 对象身份）把已持久化的 ref 传给同步 display 构造器，逐字照
  `handlers/read-url.ts:52-68` 的既有先例（`readUrlDisplayMetas`）。这样：
  - `JsOutputSchema` **不加字段**——它是 `.strict()` 且经 `registry.toContracts()` **对外声明给模型**
    的契约，加字段等于改模型可见面，还会让 `validateOutput` 多一条拒绝路径；
  - ref 不出现在模型正文（`formatJsModelContent` 只读 `images`），模型没有回写通道；
  - WeakMap 键身份保证只有本模块产出的 output 能命中，别的工具/伪造对象取不到 ref。
  对象身份成立的前提已核对：`executeWithTimeout` 用 `resolveOnce(result)` 原样 resolve handler 返回值
  （`executor/timeout.ts:124-129`），`call-runner.ts:563` 拿到的 `output` 与 handler 返回的是**同一个对象**，
  随后 `:648` 把它传给 `createToolResultDisplay`，中间无 clone/序列化。
  这是 §5.2「模型无法注入 `images[].ref`」在 producer 侧的落点：`nodeRepl.emitImage`
  只重建 `{base64, mimeType}` 字面量（`node-repl-session.ts:294`），模型没有写入 ref 的通道。
- **R7.3 一张图最多持久化一次。** 判据是 `runResult.images` 的下标；侧信道里的 ref 与该下标
  一一对应（`{index, ref, mimeType, bytes}`），display 构造按 index 取用，不重复写、不重复发。
- **R7.4 上限不变（R10 之外的硬约束）。** 仍是每张 ≤ `MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES`
  （200 KiB base64 字符）、每个 display ≤ 2 张。ref 形态改变字节的**存放位置**，不改变**数量**；
  超限图在 handler 侧就不持久化（自然回落 inline 再被 display 侧按既有规则标 `truncated`）。
- **R7.5 只有 `js` / `mcp__node_repl__js` 这条路径受影响。** 其它工具不查侧信道，
  热路径零新增开销（一次 WeakMap.get，且只在 node-repl 分支内发生）。
- **R7.6 第二个 producer 不产 ref。** `runtime/methods/browser-turn-screenshot.ts` 也构造
  `node_repl_images` display（轮尾自动截图，`source: "browser_turn_end"`），但它复用
  `createToolResultDisplay` 且**没有** WeakMap 侧信道条目，因此按 R7 的数据流自然全部 inline。
  本项不给它接线：那是 runtime 方法而非工具 handler，且它的图片不进工具 output 通道。

### 6.2 artifact 写入形态：必须是 data URL 文本，不是裸二进制（R8）

**R8.1（本项最重要的实现约束，已实测）**：工具图片 ref 的字节读取复用
`attachmentRead` → `host.readSessionAttachment` → `app.readPromptAttachment`
（`create-app.ts:1513-1530`）→ `artifactStore.readToolResultArtifact` →
`decodePromptAttachmentDataUrl`。最后一步**要求 artifact 正文是
`data:<mime>;base64,<payload>`**，否则抛 `fault.attachment.previewArtifactInvalid`。

而 `writeToolResultBinaryArtifact` 落盘的是**裸字节**，`readToolResultArtifact` 会把它按
`contentType`（`.png` → `image/png` → 非 text）编码成 base64 字符串返回——那个串**没有
`data:` 头**，解码必然失败。实测证据（`apps/acode-cli/tests/tool-media-ref-production.test.mjs`
用真实 `NodeToolArtifactStore` 跑往返）：

| 写入方式                                                    | 读回 contentType | `decodePromptAttachmentDataUrl` |
| ----------------------------------------------------------- | ---------------- | ------------------------------- |
| `writeToolResultBinaryArtifact(content: <裸 PNG 字节>)`     | `image/png`      | **失败** `previewArtifactInvalid` |
| `writeToolResultArtifact(content: "data:image/png;base64,…", contentType: "text/plain")` | `text/plain`     | 成功，字节逐字还原               |

因此 producer **必须**用 `writeToolResultArtifact` 写 data URL 文本（与
`writePromptAttachment`、`attachment-artifacts.ts:56` 同一形态），
**不能**照抄 `persistBrowserScreenshotPaths` 的 `writeToolResultBinaryArtifact`——
后者的消费者是模型面的文件路径（`browserScreenshotPaths`），不经过
`decodePromptAttachmentDataUrl`，两条链的写入形态因此不同。

**R8.2 ref 逐字取 store 返回的 `artifact.uri`**，producer 不手写 URI 格式
（AGENTS.md「不在业务代码中手写格式」）。store 的形态
`acode-artifact://<encodeURIComponent(sessionId)>/<encodeURIComponent(artifactId)>`
天然满足授权链 ②（authority 逐字等于 `encodeURIComponent(sessionId)`）。

**R8.3 发布前必须过形态门**：写入成功后仍要用 `inspectToolMediaRef` 与 shared 的
`toolMediaRefImageSchema` 校验将要发布的那张 ref 图片；任一不过就**不发 ref、回落 inline**。
store 返回的 uri 理论上恒合法，但「发布一个 wire schema 会拒的 ref」等价于发布一个永久坏图，
fail-closed 比信任更便宜。

**R8.4 `bytes` 是解码后的字节数**（`Buffer.byteLength(base64, "base64")`），不是 base64 字符数：
它既用于 renderer 占位，也是 gateway `readAttachmentPayload` 的越界判定基准，两者都指真实字节。

### 6.3 失败容忍与「绝不发布悬空 ref」（R9）

- **R9.1** artifact 写入失败**不得**把一次已成功的工具运行改写成失败——逐字沿用
  `node-repl.ts:224-230` 的既有策略：`catch` 后该张图不进 `imageRefs`，display 侧自然回落 inline。
- **R9.2** 但 `context.abortSignal.aborted` 为真时**必须重新抛出**，沿用既有的取消语义；
  取消不是「持久化失败」，不能被降级吞掉。
- **R9.3 悬空 ref 不变量**：只有「写入成功 ∧ uri 形态合法 ∧ ref 图片过 wire schema」三者同时成立
  才允许把 ref 放进 display。写失败 ⇒ 无 ref ⇒ inline。一个读不到的 ref 比一张 inline 图更糟：
  它渲染成永久坏缩略图，而 inline 至少当下可见。
- **R9.4** store 缺席（`context.artifactStore === undefined`）或 `writeToolResultArtifact` 抛错，
  对调用方是同一个业务事实：本次不产 ref，全部 inline。

### 6.4 capability 协商：**默认关闭的生产门**（R10）

提案 §5.2 要求「新写入前须有明确 capability/schema 协商」。经核对现有协议面，**安全的协商在本项
不可达成**，因此 producer 落在一个默认关闭的门后。论证如下（三条都是可核对的事实）：

1. **`clientHello.capabilities` 是 `.strict()` 的**（`packages/shared/src/acode-protocol-v4/transport.ts:78-105`），
   仓库自己的注释在 `:92` 与 `packages/services/src/acode-agent/acodeAgentConnectionScope.ts:226-227`
   都写明：加一个客户端不认识的键会让**老 Host 整条 clientHello 解析失败、握不上手**。
   `workflowRunDeltas` / `interactionAnswerRoster` 之所以能作为 `.optional()` 增量加进来，
   是因为它们的声明方向是 **host→client**（在 `hello.capabilities` 里声明，客户端只**回显**）。
   U11 需要的恰好是**反方向**——Host 必须知道**客户端**认不认得 ref 形态——也就是那个不安全的方向。
   故本项**不新增任何 clientHello 键**。
2. **「producer 恒发 ref、gateway 按已协商的 `clientMode` 降级回 inline」这条路不成立**：
   `clampWorkflowRunsForLegacy` 之所以可行，是因为它是对**已在手里**的数组做纯裁剪；
   而 ref→inline 需要把外置字节**读回来**，那是异步 IO。行投影
   `product-projection-tool-display.ts:toProtocolToolCallDisplay` 是**同步纯白名单**，
   发布器的 `getWireSnapshotForSubscription` / `encodeDeltasForSubscription`
   （`conversation-topic-publisher.ts:337,353`）也都是同步的，没有 artifact store 可达。
   在投影里做降级等于把同步投影改成异步 IO，是 bootstrap 侧的大改，不是一次能力位接线。
3. **真正的偏斜向量是已持久化的 row，不是握手**（与 lead 的核对一致）：display 会写进
   tool part 的 `metadata.display`，`parseCompletedToolPartMetadata`
   （`contracts/src/tools/tool-result-metadata.ts:314-323`）在冷启动水合
   （`transcript-hydration.ts:755`）与 transcript 回放（`session-transcript.ts:210`）
   两处都会用 strict 镜像重新解析它。一个镜像里没有 ref 分支的读取方，会把**整块 display**
   丢掉（`providerStop` 事故的同款，见该文件 `:345-361` 的注释）。
4. **决定性的一条：生产决策是永久的，消费集合是动态的。** `clientMode` 是**每连接**属性
   （`conversation-topic-publisher.ts:237` 一个 session 一个 publisher、
   `subscriptions` 按 connectionId 多份并存），而 display 是**每 session**持久化一次的。
   同一个 session 可以同时被一个 `desktop-continuous` 连接和一个 `web-remote-replayable`
   连接观看，之后还会有版本不同的新连接回放同一批 row。因此：

   > 生产时看到什么 clientMode，**不能**证明将来谁会读这条 row。

   这使任何「按生产时的 clientMode 决定发 inline 还是 ref」的方案在**语义上就不是协商**，
   只是一个启发式：桌面连接在场时写下 ref，该 ref 就永久进了历史，稍后一个不认识 ref 形态的
   web 连接回放它时照样被剥。要把这件事做对，判据必须是**读取方**的能力（每连接），
   而读取方降级又需要异步 IO（见论证 2）——两者都指向 bootstrap 侧的结构性改动。

   这也是本项**不**把 `clientMode` 当作协商、而只当作纵深防御（R10.2）并坚持默认关闭（R10.1）
   的根本理由。

**因此本项的协商结论**：

- **R10.1 门默认关闭。** `RegisterBuiltInToolsOptions.nodeReplMediaRefs`（缺席 = 关闭），
  经 `createJsToolEntry({ nodeReplMediaRefs })` 闭包进 handler。极性沿用同族 `include*` 门
  （`includeBrowserUse` / `includeOffPeak`：只有显式 true 才开）。关闭时行为与 U11 之前
  **逐字一致**：不持久化、不发 ref、全 inline。
- **R10.2 门开时还要过 `clientMode` 判据**（纵深防御，不是替代协商）：只有
  `context.clientMode === "desktop-continuous"` 才产 ref。`web-remote-replayable` 是唯一真实的
  版本偏斜面（web bundle 与桌面 Host 可不同版），一律 inline。`clientMode` 缺席（TUI/headless）
  也 inline——那些链路没有 renderer，产 ref 只会白写盘。
  `clientMode` 已在 `ToolExecutionContext` 上（`call-runner.ts:552`），无需新增协议面。
- **R10.2a 已知接线缺口（当前使本门在生产中无法打开）**：`clientMode` 的传播链是
  `AgentRuntimeConfig.clientMode` →（`runtime-tools.ts:303`）→ `ToolExecutorDeps` →
  （`impl.ts:84`）→ `ToolExecutionContext`。链路本身完整，但**上游从未被写入**：
  `bootstrap/src/app/runtime-config.ts` 构造 `AgentRuntimeConfig` 时只 `...options.runtimeConfig`
  透传，而全仓库没有任何调用方在 `runtimeConfig` 里传 `clientMode`（v4 的 session/create
  命令族也不认识它）。因此 `context.clientMode` 今天恒为 `undefined`，按 R10.2 一律 inline。

  这是**刻意的 fail-closed**，不是缺陷掩盖：判据缺席时宁可 inline，也不能猜一个 clientMode 就外置字节。
  代价是——即便把 `nodeReplMediaRefs` 打开，生产链路仍全 inline。要真正启用，必须先补 §9 跨文件项 1
  的 bootstrap 接线（把可信 clientMode 从 host attachment 注入 `AgentRuntimeConfig`）。
  在那之前本功能的可验证面是单测（注入 `clientMode` 的 context）与门控矩阵，**不是**端到端产图。
- **R10.3 ref 必须持久化**（不能「只在实时线上发 ref、落库写 inline」）：U11-A1 断言的正是
  **冷启动恢复后** row 里没有原图 base64。落库写 inline 会让每次冷启动都退回旧字节量，
  直接违背该验收场景。
- **R10.4 不加 ref 的 scrubber。** `scrubPersistedDisplay`（`:341`）的作用是「构造侧已改、
  历史已落库」的补救；它与读取方同在一个 contracts 包里，**现在**加一个剥 ref 的 stripper
  既救不了任何旧读取方（旧包有自己的旧 scrubber），又会把本功能刚写的 row 剥掉。
  正确时机是**将来撤回 ref 形态时**，在同一处加
  `stripToolMediaRefsFromNodeReplImages`（把 ref 图片降级为无图或占位），本 spec 记下该义务。
- **R10.5 镜像只能追加、不能改名。** `nodeReplImageToolResultDisplayPayloadSchema` 的 ref 分支是
  **additive union**，inline 分支逐字不动，`kind` 名保留 `node_repl_images`
  （理由见该 schema 自己的注释：改名会让已持久化 row 整段被剥）。
  contracts 用 zod v3、shared 用 zod v4，**不能**直接 import shared schema，只能镜像；
  漂移由 `tests/tool-media-ref-contract-parity.test.mjs` 机械化挡住。

## 7. 状态所有权

| 对象               | 所有者                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| 媒体字节与持久化   | 既有 CLI/Host artifact store（`acode-artifact://<session>/<id>`）；生命周期与会话历史一致 |
| **图片持久化与 ref 生产** | node-repl handler 的 `handlers/node-repl-media.ts`（唯一持有 `ToolExecutionContext` 的写入面） |
| **同步 display 构造** | `executor/node-repl-display.ts` 的 `createNodeReplDisplay`（sync 纯函数，热路径零 IO） |
| **生产门与判据**   | `executor/tool-media-limits.ts` 的 `shouldEmitToolMediaRefs`（默认关闭；门 + clientMode） |
| wire metadata      | shared v4 `tool-media-ref.ts`（形态与上限的唯一真源）；contracts `tool-result-metadata.ts` 为 strict 镜像 |
| 读取授权           | gateway（`tool-media-authorization.ts` + `resolveReadableMediaAttachment` 接线）           |
| 字节缓存与 URL     | UI `lib/toolMediaOnDemand.ts` 的 loader（见 UI spec）；正文 store 只持 metadata            |
| identity 路由      | 既有 workspace-bound transport 贯穿 `workspaceIdentity` / `remoteSessionId`；不手写 identity key |

存储引用的寿命与会话历史一致；清理不能让仍可浏览的历史出现静默失效（提案 §5.2）。
引用失效时 UI 显示明确错误并允许按当前授权重试，不退回任意本地路径。

## 8. 验收场景

编号沿用提案 §5.4；「证据」列指明当前可自动化的部分。

| 编号   | 前提                                | 操作                     | 必须断言                                                                     | 证据                                                                       |
| ------ | ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| U11-A1 | 新格式合成图片历史，图片未进视口     | 冷启动并恢复 snapshot/replay | row 没有原图 base64；不预读原图；引用与元数据可渲染                            | `packages/shared/test/tool-media-ref.test.ts`（schema）、`packages/ui/tests/toolMediaOnDemand.test.mjs`（fetch 0 次）、`tests/tool-media-ref-production.test.mjs`（门开 ⇒ display 无 base64） |
| U11-A2 | 工具 row 的有效稳定 ref              | 进视口、打开预览、重连    | 按需读取并正确显示；重复预览复用缓存；重连重新授权                             | 同上（loader 去重/换代）；桌面与手机截图**未验证**（见 §9）                    |
| U11-A3 | 另一 session/workspace 的 ref 或伪造 target | 调用读取接口       | 明确拒绝；不能依赖 ref 出现在任意文本就授权；没有文件字节返回                   | `apps/acode-cli/tests/tool-media-authorization.test.mjs`（9 例授权矩阵）      |
| U11-A4 | 旧 inline 历史与旧客户端             | 打开旧历史，协商能力      | 旧图片可读；新 variant 不发给不支持客户端；无强制全库重写                       | inline schema 测试 + `tests/tool-media-ref-production.test.mjs`（门关 / clientMode≠desktop-continuous ⇒ 全 inline，逐字同旧行为） |
| U11-A5 | 读到一半切换会话、关闭预览或资源失效 | 继续返回旧 chunk          | 旧结果不污染新视图；URL 被释放；错误有终态，无无限读取                          | `packages/ui/tests/toolMediaOnDemand.test.mjs`（换代丢弃/dispose/error 终态）   |

### 8.1 producer 侧编号验收（本项新增，R7–R10）

| 编号   | 前提                                          | 必须断言                                                                                       |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| U11-P1 | 门开 + `desktop-continuous` + store 可写      | 每张图**恰好持久化一次**；display 发 ref 形态、**无 base64**；ref 过 `inspectToolMediaRef`；authority 逐字 = `encodeURIComponent(sessionId)` |
| U11-P2 | 门开但 `writeToolResultArtifact` 抛错         | display 回落 **inline base64**（不崩溃）；**不发悬空 ref**；工具结果仍 success                  |
| U11-P3 | store 缺席（`artifactStore === undefined`）   | 全 inline，不产 ref，不写盘                                                                    |
| U11-P4 | 门关（`nodeReplMediaRefs` 缺席）              | 与 U11 之前逐字一致：不持久化、全 inline                                                       |
| U11-P5 | `clientMode === "web-remote-replayable"`（门开）| 全 inline，不产 ref（偏斜面 fail-safe）                                                        |
| U11-P6 | 上限：>2 张 / 单张 >200 KiB                   | 仍 ≤2 张、仍标 `truncated`；ref 与 inline 合计不破上限（R7.4）                                  |
| U11-P7 | abortSignal 已 aborted                        | `persistNodeReplImageArtifacts` **重抛**取消，不吞成降级（R9.2）                               |
| U11-P8 | display 产物                                   | 同一条 `node_repl_images` display **同时**过 shared `toolCallDisplaySchema` 与 contracts 镜像 `nodeReplImageToolResultDisplayPayloadSchema`（strict 双侧不漂移） |
| U11-P9 | artifact 往返（真实 `NodeToolArtifactStore`）  | data URL 写入 → `readToolResultArtifact` → `decodePromptAttachmentDataUrl` 逐字还原字节（R8.1）；裸二进制写入则解码失败（负证据） |

### 8.2 测试清单（本项实跑）

消费侧（U11 消费半程已实装，此处仅列回归）：

- `packages/shared/test/tool-media-ref.test.ts` —— ref/inline strict、traversal、ADS、NUL、
  反斜杠、错误 scheme、200 KiB 上限、≤2 张上限、形态非法 ref 使整块 display 被拒。
- `apps/acode-cli/tests/tool-media-authorization.test.mjs` —— 9 例授权矩阵。
- `packages/ui/tests/toolMediaOnDemand.test.mjs` / `toolMediaRefImages.test.mjs` —— 按需读取与抽取。

生产侧（本项新增）：

- `apps/acode-cli/tests/tool-media-ref-production.test.mjs` —— U11-P1/P2/P3/P4/P5/P6/P7/P9：
  门控矩阵、持久化恰好一次、写失败回落 inline、悬空 ref 不发、abort 重抛、上限不变、
  真实 store 的 data URL 往返（含裸二进制负证据）。注入 fake `ToolArtifactStorePort` 证明计数与降级。
- `apps/acode-cli/tests/tool-media-ref-contract-parity.test.mjs` —— U11-P8 + R10.5：
  shared `toolMediaImageSchema` 与 contracts `nodeReplImageToolResultDisplayPayloadSchema`
  对同一批正/负样本给出**相同**的接受/拒绝结论（additive union 不漂移）。

## 9. 未落地与跨文件项

1. **capability/schema 协商未做成安全增量**（§6.4）：安全的 host→client 协商方向与本项所需的
   client→host 方向相反；加 clientHello 键会破坏与老 Host 的握手。因此 producer 落在**默认关闭**的
   `nodeReplMediaRefs` 门后（R10.1），门开时再叠加 `clientMode === desktop-continuous` 判据（R10.2）。
   **待 lead 决策的跨文件项**：若要默认开启，需要一个安全的 client→host 能力位（可能要求协议版本
   bump，或在 host→client `hello.capabilities` 里先声明、client 回显，再由 gateway 在**读取**时
   按能力拒绝——但那仍不阻止 ref 被**持久化**后喂给旧读取方）。本项不擅自默认开启。
   更根本的障碍是 §6.4 论证 4：生产决策永久、消费集合动态，按生产时 clientMode 决策不构成协商。
   正确的落点是**读取侧**每连接降级，而那需要 bootstrap 的结构性改动（见下条）。
2. **gateway ref→inline 降级不可行**（§6.4 论证 2）：行投影是同步纯函数、无 artifact store 可达，
   不能像 `clampWorkflowRunsForLegacy` 那样纯裁剪。若将来要 per-connection 降级，需先把投影改成
   可异步、并把 store 接进 gateway——属 bootstrap 侧大改，不在本项范围。
3. **ref 撤回义务**（R10.4）：将来若撤回 ref 形态，须在 `scrubPersistedDisplay` 加
   `stripToolMediaRefsFromNodeReplImages`，否则已落库的 ref row 会在旧镜像里整块被剥。
4. **renderer 侧 `sessionId`/`readAttachment` 的正规注入通道**：见 UI spec §7。
5. **真 range IO 未实现**：沿用「整文件物化再切片」的既有语义（gateway `readAttachmentPayload`）。
6. **双链路 E2E 与预算实验未执行**（提案 §5.3 步骤 5）：传输字节减少 ≥80%、renderer/Host 内存、
   UI 缓存预算（桌面 ≤16 MiB / 手机 ≤8 MiB）都需 fixture 校准后才能进 spec；本项门默认关闭，
   未接线默认生产路径，因此这些量化门槛**尚未在真实链路上验证**。
7. **`clientMode` 从未注入 `AgentRuntimeConfig`**（R10.2a）：跨文件项，属 bootstrap。
   链路下游完整（`runtime-tools.ts:303` → `impl.ts:84` → `call-runner.ts:552` →
   `ToolExecutionContext.clientMode`），但 `bootstrap/src/app/runtime-config.ts` 构造
   `AgentRuntimeConfig` 时不写这个键，v4 session/create 命令族也不认识它，故生产中恒为 `undefined`。
   要启用本功能，需要在 host attachment / session 创建处把可信 clientMode 注入 runtimeConfig。
   注意这只解决「门能打开」，**不**解决协商正确性（§6.4 论证 4 仍在）。

## 10. 文件预算（max-lines 400）

`AGENTS.md` / `apps/acode-cli/AGENTS.md`：单文件默认 ≤400 行。oxlint 的 max-lines 配置为
`{ max: 400, skipBlankLines: true, skipComments: true }`，故有效行 = 非空非注释行。
本项对**敏感大文件**的处理是「只减不增」：把 node_repl 的 display 构造、artifact 写入、
上限与门各抽成叶子。

| 文件                                                       | 改动前 raw | 改动后 raw | 改动后有效行 | 说明                              |
| ---------------------------------------------------------- | ---------- | ---------- | ------------ | --------------------------------- |
| `core/src/tool/executor/result-display.ts`                 | 473        | **403**    | 339          | 抽出 `createNodeReplDisplay` + CUA app 读取 |
| `core/src/tool/handlers/node-repl.ts`                      | 413        | **410**    | 351          | 抽出两个 persist helper；handler 改工厂 |
| `contracts/src/tools/tool-result-metadata.ts`              | 399        | **364**    | 279          | 抽出 `node_repl_images` 镜像到叶子 |
| `core/src/tool/executor/call-runner.ts`                    | 894        | **894**    | —            | **未改动**（热路径不动）           |
| `bootstrap/.../v4-gateway.ts`                              | 3500       | **3500**   | —            | **未改动**（另一 agent 并发持有）   |
| `packages/shared/src/acode-protocol-v4/*`                  | —          | —          | —            | **未改动**（消费半程已接好 wire schema） |

新增叶子（均远低于 400 有效行）：

| 新文件                                        | raw | 有效行 |
| --------------------------------------------- | --- | ------ |
| `core/src/tool/executor/tool-media-limits.ts` | 72  | 24     |
| `core/src/tool/executor/node-repl-display.ts` | 124 | 79     |
| `core/src/tool/handlers/node-repl-media.ts`   | 240 | 141    |
| `contracts/src/tools/node-repl-display.ts`    | 91  | 56     |

`core/src/tool/handlers/index.ts` 345 → 347（+2，传一个门选项），`register-built-in-tools-options.ts`
95 → 108（+13，门选项声明与注释）。两者都不在敏感清单内且远低于 400。
