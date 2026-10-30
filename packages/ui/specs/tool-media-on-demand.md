# 工具图片按需读取（tool-media-on-demand）

状态：实施中（U11，2026-10-26）
来源：`docs/upgrades/product-and-support-2026-10.md` §5（U11 提案）
契约真源：`apps/acode-cli/specs/tool-media-attachment-ref.md`（wire metadata、ref 形态校验、读取授权）

## 1. 用户目标

用户浏览图片密集历史时先看到轻量行内容；图片进入视口或打开预览时才读取字节；重连后仍能预览；
授权失败或字节缺失时看到明确降级，而不是崩溃或一块静默空白。

## 2. 状态所有权

| 对象                     | 所有者                                                              | 边界                                                    |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- |
| 图片元数据（ref/mime/bytes） | 正文投影（`ToolCallRow.display`）                                 | 只持 metadata，**不持字节**                                |
| 字节缓存与 objectURL 生命周期 | `lib/toolMediaOnDemand.ts` 的 loader（经 `lib/toolMediaRefBytes.ts` 每组件实例一份） | 唯一所有者；卸载/换代即 revoke |
| 「该不该读」的节流判据    | `lib/toolMediaOnDemand.ts` 的 `shouldFetchToolMediaBytes`（纯函数）  | 无 React、无 DOM，可单测                                  |
| 读取授权                 | gateway（见契约 spec §5）                                            | renderer 只**请求**，从不自我授权                          |
| identity 路由            | 既有 workspace-bound transport（`V4ConversationContext.attachmentRead`） | 贯穿 `workspaceIdentity`/`remoteSessionId`；本 spec 不手写 identity key |

## 3. 读取生命周期

```
row 到达（只有 metadata）
  │
  ├─ inline 形态 ──▶ 直接拼 data URL 渲染（字节已在 row；U11-A4 不回归）
  │
  └─ ref 形态 ──▶ idle（轻量占位，fetch 0 次）
                    │  IntersectionObserver（rootMargin 200px）可见 ∨ 预览打开
                    ▼
                  loading ──attachmentRead({sessionId, ref})──▶ gateway 授权
                    │                                            │
                    ├─ 就绪 ──▶ ready（objectURL）                ├─ 命中 ⇒ 行上的 mime + 字节
                    │           重复预览复用缓存，不再读           └─ 未命中/越权 ⇒ fault ⇒ error 终态
                    └─ 失败/无 context/ref 还原不出 ──▶ error（降级 + 显式 retry，不自动无限重试）
```

关键规则：

- **按需**：`shouldFetchToolMediaBytes` 要求 `kind === "ref"` ∧ 尚无字节 ∧ 未错误 ∧（可见 ∨ 预览打开）。
  inline 形态永不触发读取。未进视口的图片 fetch **0 次**（U11-A1，用计数 fetcher 断言）。
- **去重**：同一 `(sessionId, ref, generation)` 的并发请求共享同一个 in-flight promise。
- **有界**：loader 条目数受 `maxEntries` 约束，按最旧访问逐出；逐出即 revoke objectURL。
  当前默认 `24` 是保守占位——提案 §5.5 的字节预算（桌面 ≤16 MiB / 手机 ≤8 MiB）**需 fixture 校准后另立**，
  本 spec 不宣称已满足该门槛。
- **URL 生命周期**：卸载、换代、逐出都 revoke；不漏 Blob URL。

## 4. 重连行为（U11-A2 / U11-A5）

`V4ConversationContext.onRuntimeRestart`（runtime restart 或 transport 换代）触发
`loader.bumpGeneration()`：

- generation 是缓存键的一段（`sessionId \0 ref \0 generation`），换代后旧键自然失效；
- 旧代际的全部 objectURL 立即 revoke，缓存清空，in-flight 表清空；
- **在途结果被丢弃**：读取返回时若 `generation !== 发起时的 generation`，不写缓存、不更新视图
  ——「读到一半切换会话/重连」不会让旧 chunk 污染新视图（U11-A5）；
- 换代后已就绪的缩略图退回 idle，由 effect 按新代际重新拉取 ⇒ **重连后预览仍能解析**，
  且这次读取重新走一遍 gateway 授权（不是复用旧授权结论）。

这满足提案 §5.5「会话/generation 变化后旧 chunk 应用为 0」。

## 5. 降级渲染（不崩溃、不静默空白）

展示态由 `resolveToolMediaRenderState` 推导（纯函数，五态闭集）：

| 态        | 条件                                    | 渲染                                                            |
| --------- | --------------------------------------- | --------------------------------------------------------------- |
| `inline`  | inline 形态                             | data URL `<img>`（与 U11 之前逐字一致）                            |
| `idle`    | ref 形态，尚未可见/未打开预览            | shimmer 占位 + `ImageIcon`，`role="status"`、`aria-label=common.loading` |
| `loading` | 已发起读取                              | 同上                                                              |
| `ready`   | objectURL 就绪                          | `<img src={objectUrl}>`，可点开预览                                |
| `error`   | 授权失败 / 读取失败 / ref 还原不出 / 无会话上下文 | `ImageOffIcon` + `codeViewer.imageUnavailable` + `Button`（`common.retry`），`role="img"` |

`error` 是**终态**：不自动重试，只有用户点 retry 才递增 retryToken 重新读取。这满足
「错误有终态，无无限读取」。

授权失败与「字节确实不在了」对 renderer 是同一个降级形态——与 gateway「不告诉越权者猜对了哪一半」
的姿态一致，UI 不区分二者，也不回显 ref 全文（日志只记 `sessionResolved` 布尔）。

### 5.1 i18n

**复用既有键，本项不新增任何 i18n key**（en-US 与 zh-CN 均已存在，无需 locale 改动）：

| key                             | en-US                                        | zh-CN                    |
| ------------------------------- | -------------------------------------------- | ------------------------ |
| `common.loading`                | `Loading...`                                 | `加载中...`              |
| `common.retry`                  | `Retry`                                      | `重试`                   |
| `codeViewer.imageUnavailable`   | `This image preview is currently unavailable.` | `暂时无法显示这张图片。` |
| `chat.attachments.preview.open` | `Open image preview`                         | `打开图片预览`           |

## 6. 抽取路径不重叠（避免同一张图读两次）

`lib/nodeReplToolDisplay.ts` 的 `extractImages`（既有，未改）按「有 `base64`/`data` 键」判定图片，
ref 形态（只有 `ref`/`mimeType`/`bytes`）会被它**自然跳过**。新增的
`lib/toolMediaRefImages.ts` 只收 ref 形态。两条路径因此不重叠：inline 归原文件（唯一所有者不变），
ref 归新文件；grid 同时消费两者，inline 项在前、ref 项在后，`previewIndex` 按此拼接顺序定位。

抽取扫描纪律逐字照既有 `findCuaApp`：递归找 `kind === "node_repl_images"`，覆盖三种落点
（实时 `raw.result`、终态 snapshot 的 `raw.display`、`output.display`），并用 `visited` 去环。

## 7. 已知限制：renderer 侧 sessionId 的注入通道缺失（跨文件项）

**这是本项最重要的未落地部分，也是安全论证的边界，必须如实记录。**

正规设计应当由宿主把**正在渲染的那个 session** 的 id 与稳定 row target 传进 renderer：
`ConversationRowView.ToolCallRowView`（`packages/ui/src/v4/ConversationRowView.tsx:1876`）同时握有
`context.sessionId` 与原始 `row`（含 `rowId`/`entityId`），但：

- `toolCallRowToLegacyNode`（`packages/ui/src/v4/toolCallRowAdapter.ts:85`）**丢弃** `rowId`/`entityId`，
  旧 `TaskChatToolCall` 形态没有这两个字段；
- `ToolCallBlock`（`packages/ui/src/ToolCallBlocks.tsx:288` 的 `renderContext`）不透传 `sessionId`，
  也不透传 `readAttachment`；
- 这三个文件都在本项的**禁止编辑**集合（`packages/ui/src/v4/**`、`packages/ui/src/hooks/**`）里。

### 7.1 当前实现的取舍

`lib/toolMediaRefBytes.ts` 因此从 ref 自身的 `acode-artifact://<encodeURIComponent(sessionId)>/…`
authority **还原** sessionId（`decodeToolMediaSessionId`，还原不出即 fail-closed 进 error 态），
并用 `useContext(V4ConversationContext)` 自取 `attachmentRead`（该 provider 确实挂在工具渲染器之上，
`ui` 模块在 architecture-policy 里是 `managed: false`，且 `renderers/cua-group.tsx` 已有从 `@/v4/` 导入的先例）。

后果必须说清：这样 gateway 授权链的**第 ② 步（`ref.authority === encodeURIComponent(sessionId)`）
退化为恒真**，因为它比对的两个值同源。真正承重的是**第 ③ 步**——该 ref 必须逐字出现在**那个
session 的权威 toolCall row display** 里。第 ③ 步是实质授权：

- 模型可控内容仍然**不能**铸造授权（display 由 runtime 生产、经 gateway 白名单投影，模型无法写入
  `images[].ref`；ref 出现在 `output.text`/Markdown 里不算数——已有测试断言）；
- 跨 session 读取仍然失败关闭：伪造一个别的 session 的 ref，在那个 session 的投影里查不到对应
  toolCall display，返回 `null` ⇒ `previewRefNotAuthorized`；
- **残余风险**：若 session A 的 runtime 在 display 里写出了 session B 的 artifact ref，则 A 的视图
  能读到 B 的字节。这需要 producer 侧缺陷（producer 只写自己 session 的 artifact），不是模型可触发的
  路径，但 defense-in-depth 要求把 sessionId 改为宿主注入的**请求方 session**。

### 7.2 给整合方的精确改法

1. `packages/ui/src/v4/toolCallRowAdapter.ts`：在 `toolCallRowToLegacyNode` 的 `raw` 里补
   `rowId: row.rowId`、`entityId: row.entityId`（`raw` 已是 `unknown`，类型面不需要动）。
2. `packages/ui/src/v4/ConversationRowView.tsx:1972` 的 `<ToolCallBlock …>` 增传
   `sessionId={context.sessionId}`、`rowTarget={{ rowId: row.rowId, entityId: row.entityId }}`、
   `readAttachment={context.readAttachment}`。
3. `packages/ui/src/ToolCallBlocks/fileSummaryTypes.ts`（本项可编辑）已具备承载位置：在
   `ToolCallBlockRenderContext` 增可选 `sessionId?: string | null`、`rowTarget?: ConversationRowTarget`、
   `readAttachment?: …`；`packages/ui/src/ToolCallBlocks.tsx:288` 的 `renderContext` useMemo 透传之。
4. 之后 `useToolMediaRefBytes` 改为接受宿主注入的 `sessionId`（不再从 ref 还原），
   并把 `rowTarget` 带进读取请求，使 gateway 第 ② 步恢复为实质校验。

在这些改动落地前，§7.1 的取舍是本项的已知边界。

## 8. 验收场景

| 编号   | 断言                                                     | 自动化证据                                                                       |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| U11-A1 | 未进视口不读字节；row 只带元数据                          | `packages/ui/tests/toolMediaOnDemand.test.mjs`（计数 fetcher：构造后 fetch 0 次；inline 永不读）；`packages/ui/tests/toolMediaRefImages.test.mjs`（只抽元数据） |
| U11-A2 | 进视口/打开预览按需读取；重复预览复用缓存；重连重新授权     | 同上（load 后 fetch 1 次、二次 load 仍 1 次、并发去重、`bumpGeneration` 后重新读取） |
| U11-A3 | 授权失败/伪造 ref ⇒ 明确降级，不崩溃                       | `resolveToolMediaRenderState` 的 error 终态 + `decodeToolMediaSessionId` fail-closed；gateway 侧见契约 spec |
| U11-A4 | 旧 inline 历史照常渲染（不回归）                          | `buildToolMediaInlineDataUrl` + 抽取路径不重叠测试；grid 在 `toolCall` 缺席时行为不变 |
| U11-A5 | 读到一半换代 ⇒ 旧结果不污染新视图；URL 释放；错误有终态     | 在途换代测试（`objectUrl === null`、缓存 0 条）、`dispose` revoke、error 不自动重试 |

### 8.1 测试方式说明（诚实标注）

本仓无 jsdom，故**行为**全部落在纯函数里测：节流判据、展示态推导、缓存键、sessionId 还原、
loader 的读取/去重/换代/URL 生命周期（用**注入的计数 fetcher** 与桩 `createObjectUrl`/`revokeObjectUrl`）。

`nodeReplImageGrid.tsx` 与 `nodeReplImageRefThumbnail.tsx` 这两个 React 组件本身**没有**行为测试
（无 DOM 环境可挂载）。本项**没有**用字符串匹配伪装成行为测试——组件的可测逻辑已全部下沉到
`lib/`，组件只做布局与事件接线。这一点是刻意的取舍，不是遗漏。

## 9. DESIGN.md 合规自查

- 无 `text-[Npx]`：字号用 `text-ui-sm`（错误态副文案）。
- 无裸 `<button>` 承载动作语义：retry 用 `Button`（`variant="link" size="xs"`）。
  缩略图触发器沿用既有 `imageThumbnailTriggerClassName` 约定（与 `markdown-image.tsx` 同一模式，
  是该画廊组件的既定契约，非本项新引入）。
- 焦点态可见：`imageThumbnailTriggerClassName` 自带 `focus-visible:ring-2 ring-ring ring-offset-2`，
  本项未加任何 `focus-visible:ring-0`。
- 无 `bg-white`/`text-black` 硬编码：颜色用语义 token（`text-foreground-subtle`）。
- 加载占位复用既有 `.markdown-image-loading-shimmer`（`styles.css:964`），未新造动画。
- 桌面与手机 Web 同一组件路径；画廊布局由既有 `ImageThumbnailGallery` 的响应式 class 负责。
