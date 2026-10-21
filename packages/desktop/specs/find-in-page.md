# ACode：桌面页内查找（一期 + 二期 provider 双路）

## 背景与目标

桌面端此前**零页内查找面**：长会话、预览面板、终端输出全部是主窗口 renderer 的 DOM
内容，Electron 壳不提供浏览器式 Ctrl+F 查找。一期把 `webContents.findInPage` 封装成
可靠的查找通道，并在 renderer 提供窗内 overlay 查找栏（输入、计数、步进、关闭、焦点
编排），复用 shortcuts 内核挂 F3/Shift+F3 固定绑定。

**二期（provider 双路）**补齐一期最大缺口：虚拟化长列表的**未渲染区搜不到**——
Chromium 原生查找只见已布局 DOM。二期在 renderer 引入应用级 DOM 搜索 provider 体系
（CSS Custom Highlight API 零 DOM 变更高亮、shadow root 感知、文档序归并、
activeInRenderedWindow/loadRest 虚拟化感知），main 侧在 findInPage handler 前插
provider 判定分支形成双路协调（epoch 守卫、fail-soft 沿用一期 EMPTY_FIND_RESULT）。
机制蓝本为上游 ion 渲染层 + 多 provider 协调器（移植机制不复制代码）。

一期诚实边界（窗内 overlay 两项仍有效；单路搜索已由二期收口）：

- ~~**单路搜索**——只有 webContents DOM 搜索；renderer FindInPageProvider 双路
  （应用级 DOM 搜索，覆盖虚拟化长列表/popout 作用域）仅登记。~~ → 二期已实现
  provider 双路（见「二期产品规则」）；popout 作用域仍不做。
- **窗内 overlay**——查找栏是主 renderer 内的绝对定位浮层，不是独立 WebContentsView，
  不做跨窗迁移复用。
- 查找目标 = 发起 IPC 的 sender webContents（一期即主窗口自身）。内嵌浏览器
  `<webview>` guest 页、browser-use 受控 view 不是目标。

## 产品规则

1. **入口**：F3 打开查找栏并聚焦输入框；查找栏已开时 F3 = 下一处、Shift+F3 = 上一处。
   主菜单「页内查找」项由菜单所有者接线（点击 → main 经 `OpenFindInPage` 推给 renderer）。
   既有 Cmd/Ctrl+F（`findInTask` 轨迹搜索）不受影响。
2. **CJK 感知起搜阈值**：`query.length > 2 || /[\p{Script=Han}\p{Script=Hiragana}
   \p{Script=Katakana}\p{Script=Hangul}]/u.test(query)`——CJK 单字即搜，拉丁 3 字符
   起搜。低于阈值不发起搜索，且**自动清理既有高亮**（stopFindInPage("clearSelection")），
   计数隐藏。（上游证据的停搜过滤是 `length < 2`，与阈值函数存在 off-by-one——从 3 字符
   删到 2 字符时高亮残留；本实现统一用阈值函数收口。）
3. **增量搜索**：输入经 250ms 防抖发起 `findNext: true` 续搜；结果竞态 latest-wins，
   过期轮次的返回直接丢弃（原生序号比较，等价 switchMap 语义，不引入 RxJS）。
4. **步进导航**：Enter = 下一处，Shift+Enter = 上一处；上/下按钮等价。步进用
   `findNext: false + forward` 重搜一轮。计数为 0 或结果未回时步进按钮禁用。
5. **计数**：「第 N/共 M 处」（en：`N of M`），`role="status"` + `tabular-nums`
   数值稳定性；查询未过阈值或本轮结果未回时不显示。activeIndex 1-based；
   `{activeIndex: 0, total: 0}` = 无匹配或 fail-soft 收口。
6. **Escape 关闭**（内容窗捕获）：无修饰键、非长按 repeat、非 IME 组合中
   （isComposing/keyCode 229 不触发，Escape 此时属于输入法取消组合）。焦点位于模态
   dialog（role=dialog/alertdialog）内时不消费 Escape，让位给对话框自身的关闭语义。
   关闭后清高亮、结束会话、**焦点还给打开时的触发处**（元素已离文档则不抢）。
7. **fail-soft**：查找超时（5s）、目标销毁、渲染进程崩溃一律返回 `{activeIndex:0,
   total:0}`；main 侧任何异常不向 renderer 抛错、不悬挂 invoke。

### 二期产品规则（provider 双路）

8. **双路仲裁（互斥，不并行）**：renderer 协调器在**至少一个 scope provider 注册**时经
   `SetProviderActive(true)` 告知 main；main 的 findInPage handler 在阈值/销毁检查后、
   原生路之前插 provider 判定分支：active → 走 provider 路（dispatch 给 renderer
   协调器），否则原生路不变。provider 路激活期间**不调用** Chromium `findInPage`——
   renderer 内置 DOM 腿等价覆盖已渲染文本，双路并行会双重高亮、索引分裂。
9. **文档序归并（renderer 协调器内）**：内置 DOM 腿（`document.body` 全文搜索，排除
   provider scope 子树与查找栏自身 `[data-find-in-page-overlay]`）与各 provider 腿按
   scope 元素文档位置（`compareDocumentPosition`，shadow root 先上浮到 host）归并；
   DOM 腿的 ranges 按 scope 边界切段插入。`total` = 各腿 count 之和；`activeIndex`
   为归并序 1-based。失联 scope（`isConnected=false` / null）排尾，不参与文档序插入。
10. **epoch 守卫**：main 对每个目标维护单调 epoch，每次 provider dispatch 携带；只结算
    epoch 匹配的 report，新一轮 dispatch 立即以 `{0,0}` 结算旧 pending（latest-wins，
    与 renderer overlay 的 seq 闸同构）。renderer 协调器维护本地 epoch：clear /
    provider 注册表变动 / loadRest 等待期间被 clear → 在途搜索与重绘重试全部作废。
    会话失效链沿用一期：跨文档导航 / 崩溃 / 销毁 → 结算 pending `{0,0}`、下发
    `FindInPageClear`、**复位 providerActive**（renderer 上下文已换，待重新申报）。
11. **虚拟化感知（activeInRenderedWindow + loadRest）**：provider 可申报 `loadRest()`
    （请求宿主列表把剩余项物化进 DOM）。本轮 `total=0` 且存在带 loadRest 的 provider
    时，协调器等待全部 loadRest（每个 4s 超时封顶）后以 **grow 模式**重搜一次：active
    保持、total 只增不减。active 命中位于 provider 未渲染窗口时
    `activeInRenderedWindow=false`（provider `isMatchRendered` 申报；缺省 true）。
    列表无加载能力（未注册 loadRest）且申报 `hasUnrenderedContent()=true` 时，结果带
    `hasUnsearchableRegions=true`——**不对未渲染区作假命中**，计数只反映可搜区。
12. **高亮渲染（CSS Custom Highlight API，零 DOM 变更）**：Highlight 名
    `acode-find-in-page`（全部命中）/ `acode-find-in-page-active`（active，priority 1）；
    `::highlight()` 规则经 `adoptedStyleSheets` 注入，命中 range 位于 shadow root 时
    sheet 同步 adopt 到该 root（shadow root 感知）。颜色走
    `--color-find-highlight` / `--color-find-highlight-active` token（主题化，复用
    ModelTrajectorySearchHighlight 的视觉语言）。API 缺席（老内核）时 provider 路
    **降级不中断**：搜索与计数照常，不绘制高亮、不注入任何 DOM 兜底。
13. **重绘重试预算**：active 高亮应用后校验其 `getBoundingClientRect().height`；为 0
    （布局未就绪）则重绘并 double-rAF 重试，预算 6 次（epoch 失配即停），不无限追赶
    移动布局。
14. **fail-soft 收口沿用一期**：provider dispatch 超时（同一 timeoutMs，生产 5s）、
    destroyed、render-process-gone、renderer 未申报、report 载荷非法（运行时校验，
    不信任 renderer 输入）一律 `{activeIndex:0,total:0}`（EMPTY_FIND_RESULT），不向
    renderer 抛错。provider 腿的 count/show/loadRest 抛错按该腿 0 命中处理（safe
    call），不拖垮整轮搜索。
15. **ConversationTimeline provider 接线（WI-E2b）**：虚拟化会话列表经
    `useConversationFindInPageProvider`（packages/ui/src/v4/）注册 scope provider，
    scope = message layer 根元素（带 `data-find-provider-scope` 标记，内置 DOM 腿按
    属性排除不重复计数）。**搜索腿只数已物化 DOM**（复用 findInPageDomSearch 纯核心，
    未渲染虚拟行不在 DOM 天然不参与计数，不报假命中）；**loadRest = 批增长物化**：
    overscan 目标每批 +400 unit（`FIND_TIMELINE_MOUNT_BATCH_SIZE`）、逐 React commit
    一批（`awaitCommitted` 由宿主每次 commit 放行；目标已被既有扩展覆盖时同步放行
    防悬挂），直到全部 unit 挂载——**封顶 = 全量**，react-virtual 以 overscan=count
    保几何一次性全挂载，无独立「渲染全部行临时模式」。clear/卸载按代际作废在途
    批增长并把 overscan 复位默认窗口。**全挂载帽**：unit 总数超过
    `FIND_TIMELINE_FULL_MOUNT_CAP`（2000）时不提供 loadRest——不可控巨型 commit
    不换完整性，由 `hasUnrenderedContent()=true` 让协调器按 R11 申报
    `hasUnsearchableRegions=true`（计数只反映可搜区）。`isMatchRendered` 恒 true
    （命中全部来自已物化 DOM）。**多实例边界**：注册表为数组型多实例——同文档多
    pane 各自注册，协调器按 scope 文档序归并；全部命中高亮层 per-document 共享，
    provider 腿只 add 不清层（协调器每轮先清层再画 dom 腿），clear 时 surgical
    撤除本腿 ranges（active 层按 Highlight 对象同一性判定是否仍为本腿所画）。
    **诚实欠报边界**：窗口内已有命中时本轮不物化剩余（R11 契约 loadRest 仅
    total=0 触发），total 只反映已渲染窗口——欠报方向，不造假命中。

## 状态所有者

| 状态                     | 所有者                            | 说明                                                     |
| ------------------------ | --------------------------------- | -------------------------------------------------------- |
| 查找会话（失效链监听）   | main `findInPageMain.ts`          | per-sender-webContents 会话；导航/崩溃/销毁即失效收口     |
| 高亮存在标记             | main（WeakSet）                   | 防重复 `stopFindInPage`；只对确有高亮的目标 clearSelection |
| 查找栏开关/查询文本/计数 | renderer `FindInPageOverlay`      | 组件本地 state，不持久化、不进 store                       |
| 焦点编排标志             | renderer（refs）                  | userBlur / lastKeyAt / restoreFocus / latest-wins 序号     |
| providerActive 标志 + epoch + pending report 表 | main `findInPageProviderMain.ts`（WeakMap per-sender） | 二期双路仲裁与结算；失效链/stop/end 时结算并复位 |
| provider 注册表          | renderer `findInPageProvider.ts`（模块级） | 注册/注销即通知协调器与 main（setProviderActive）；不进 store |
| provider 路查询态（currentQuery/activeIndex/本地 epoch） | renderer `findInPageCoordinator.ts` | 协调器独占；clear/失效即重置 |
| CSS Custom Highlight 高亮 | renderer `findInPageHighlight.ts` | 唯一写入路径=协调器；per-document highlights 注册表 + adoptedStyleSheets |

高亮写入路径（互斥双路）：原生路 renderer 经 IPC 请求 → main `webContents.findInPage`，
唯一清理路径 `stopFindInPage("clearSelection")`；provider 路由 renderer 协调器直接写
CSS Custom Highlight（零 DOM 变更），唯一清理路径协调器 `clear()`（main 经
`FindInPageClear` 下发触发）。renderer 不直接触碰任何查找状态副本。

## 接口（IPC，packages/shared/src/channels.ts）

| 通道                            | 方向            | 载荷                                             | 返回                          |
| ------------------------------- | --------------- | ------------------------------------------------ | ----------------------------- |
| `acode:find-in-page`            | Renderer→Main   | `FindInPageRequest { text, findNext, forward? }` | `FindInPageResult \| null`    |
| `acode:stop-find-in-page`       | Renderer→Main   | void                                             | void（仅清高亮，会话保留）    |
| `acode:end-find-in-page-session`| Renderer→Main   | void                                             | void（清高亮+拆失效链）       |
| `acode:open-find-in-page`       | Main→Renderer   | void                                             | —（单向 send，菜单入口推送）  |
| `acode:find-in-page-provider-active` | Renderer→Main | `{ active: boolean }`（二期：provider 注册表非空申报） | void                    |
| `acode:find-in-page-dispatch`   | Main→Renderer   | `FindInPageDispatchPayload { epoch, text, findNext, forward }` | —（单向 send，provider 路查找请求） |
| `acode:find-in-page-report`     | Renderer→Main   | `FindInPageReportPayload { epoch, result }`      | void（main 运行时校验后结算 pending） |
| `acode:find-in-page-clear`      | Main→Renderer   | void                                             | —（单向 send，清 provider 路高亮） |

- `findNext: true` = 增量续搜；`false` = 重开一轮搜索（步进语义）。`forward` 缺省 true。
- 返回 `null` = 查询未过阈值 / 载荷非法 / 目标不可用，调用方按无匹配收口。
- 二期 `FindInPageResult` 增可选 provider 维度字段（向后兼容，原生路缺席）：
  `activeInRenderedWindow?: boolean`（active 命中是否在已渲染窗口内）、
  `hasUnsearchableRegions?: boolean`（存在无加载能力的虚拟化未渲染区）。
- `OpenFindInPage` 推送与 F3 键路统一语义：查找栏未开 = 打开并聚焦；已开 = 下一处
  （菜单 accelerator 会先于 renderer keydown 吃掉 F3，两条路径必须同义）。
- preload 桥：`window.acode.findInPage / stopFindInPage / endFindInPageSession /
  onOpenFindInPage`（实现在 `preload/findInPageBridge.ts`，入口 spread 进主桥对象）。

## main 侧机制（findInPageMain.ts）

1. **requestId 匹配 + 三路竞速**：`webContents.findInPage` 返回 requestId；竞速
   `found-in-page(按 requestId 过滤，首个命中即结算) | destroyed/render-process-gone |
   5s 超时`，用原生 Promise + 监听器/定时器清理实现；非 null 路径映射
   `{activeMatchOrdinal, matches}` → `{activeIndex, total}`，其余路径 `{0,0}`。
   结算后必须摘除全部监听器（多次快速输入 = 多轮竞速并存，互不泄漏）。
2. **首查 findNext 强制**：目标尚无活动高亮（WeakSet 未命中）时强制 `findNext: true`——
   Chromium 从当前视口续搜，用户先看到视口附近匹配（与浏览器查找习惯一致）；已有高亮
   时按调用方 options 透传。
3. **WeakSet 防重复清理**：`clearSelection` 只对 WeakSet 内目标调用；重复 stop / 无查找
   的 stop 是 no-op。渲染进程崩溃后 `stopFindInPage` 可能抛错（Render frame disposed），
   fail-soft 捕获。
4. **失效链**：会话建立时对目标挂
   `did-start-navigation(isMainFrame && !isSameDocument)` / `did-redirect-navigation
   (isMainFrame)` / `did-navigate` / `render-process-gone` / `destroyed(once)` ——任一
   命中即结束会话（清高亮 + 摘全部监听 + 删会话）。same-document 导航（hash/pushState）
   不失效。
5. **install 接口**：`registerFindInPageIpc({ logger, timeoutMs? })` 注册三条 invoke
   handler（timeoutMs 仅测试注入，生产缺省 5000）；`requestFindInPageOpen(webContents)`
   供菜单接线推送打开。main/index.ts 的接线位置见交付报告（index.ts 非本 feature 所有）。
6. **阈值双层防御**：main 侧同样执行 CJK 阈值判定（`meetsFindInPageThreshold`，与
   renderer `findInPageModel.ts` 同构镜像——main 不能 import ui 包，两处各自单测锁定）。
   未过阈值直接返回 null，不发起 Chromium 查找。
7. **二期 provider 双路协调器**（`findInPageProviderMain.ts`，findInPageMain.ts 的姊妹
   模块——400 行 max-lines 硬闸，按 findInPageBindings.ts 同一拆分先例）：
   - per-sender 状态（WeakMap）：`{ active, epoch, pending: Map<epoch, resolver> }`。
   - `handleFindInPage` 在阈值/销毁检查与会话建立后、原生路之前判定 `active`：
     true → `dispatchProviderFind`（epoch++ → 旧 pending 全部结算 `{0,0}` →
     `webContents.send(FindInPageDispatch)` → 竞速 `report(epoch 匹配) | 超时 |
     destroyed | render-process-gone`，竞速结构与原生路同构、结算后摘净监听）；
     false → 原生路不变（首查 findNext 强制仅原生路语义）。
   - `SetProviderActive` handler：运行时校验 `{active:boolean}`；true→false 迁移时
     下发 `FindInPageClear` 并结算全部 pending。
   - `FindInPageReport` handler：运行时校验（epoch 数值、result 对象、activeIndex/
     total 数值、可选字段布尔），非法即丢弃（不结算，留给超时 fail-soft）。
   - stop / end-session / 失效链：结算 pending `{0,0}` + 下发 `FindInPageClear`
     （destroyed 守卫，fail-soft）；失效链（跨文档导航/崩溃/销毁）额外**复位
     active=false**——renderer 上下文已换，注册表由重载后的 renderer 重新申报。

## renderer 侧机制（packages/ui/src/find-in-page/）

- `findInPageModel.ts`：纯规则（阈值、计数显示门、select 时机、Escape 判定、时延常量），
  node 可测。
- `useFindInPageOverlay.ts`：状态与编排 hook——250ms 防抖、latest-wins 序号闸、
  焦点编排、window capture 键盘监听（F3/Shift+F3/Escape）、平台桥探测；二期在桥在场
  时初始化 provider 桥（`initFindInPageProviderBridge`，幂等）。
- `FindInPageOverlay.tsx`：呈现组件；平台桥缺席（Web 端）时渲染 null，Web 保留浏览器
  原生 Ctrl+F。挂载点：`RootShell`（与 EmbeddedBrowserPermissionPromptHost 同层的
  窗口级宿主，接线见交付报告）。根容器带 `data-find-in-page-overlay`——provider 路
  内置 DOM 腿排除查找栏自身（一期已知边界「Chromium 可能匹配查找栏文本」在 provider
  路收口）。
- 二期 provider 体系（同目录，均为 node 可测的纯核心 + 薄 DOM 适配层）：
  - `findInPageProvider.ts`：`FindInPageScopeProvider` 契约（getScopeEl/count/show/
    clear + 可选 isMatchRendered/loadRest/hasUnrenderedContent/surface）与模块级注册表
    （注册/注销/订阅；宿主列表组件经此接入——生产注册方为 ConversationTimeline，
    见 R15）。
  - `findInPageDomSearch.ts`：内置 DOM 腿——TreeWalker 收集文本节点（穿透 open
    shadow root；跳过 script/style/noscript/template、零 client rects 的不可见子树、
    exclude 子树），块级边界插 `\n` 哨兵防跨块假命中（inline 边界不断，`<b>` 拆分的
    命中可跨）；纯核心 = 大小写不敏感搜索 + 命中区间→跨节点 Range 映射。
  - `findInPageHighlight.ts`：CSS Custom Highlight API 封装——特性探测（`CSS.highlights`
    + `Highlight` 构造器）、per-document `adoptedStyleSheets` 注入 `::highlight()` 规则
    （`--color-find-highlight`/`-active` token）、shadow root 采纳、active priority=1、
    clear。API 缺席时全部 no-op（降级不中断）。
  - `findInPageCoordinator.ts`：协调器——文档序归并（scope 按 compareDocumentPosition
    排序、DOM 腿 ranges 按 scope 边界切段、失联 scope 排尾）、active 选择语义
    （新查询=首命中；步进=±1 循环 wrap；增量/grow=exact remap（startContainer+offset
    全等）否则序号 clamp）、loadRest grow（total=0 时触发，每个 4s 超时封顶，重搜一次
    active 保持）、重绘重试预算（double-rAF，6 次，epoch 守卫）、本地 epoch 失效。
  - `findInPageProviderBridge.ts`：window.acode 二期四成员结构类型探测（先例同一期）；
    接线注册表→`setProviderActive`、dispatch→协调器→report、clear→协调器 clear。

**焦点编排**：

1. 打开即聚焦输入框；程序性聚焦时**距上次击键 >400ms 才 select()**（不打断正在输入）。
2. 窗口 `visibilitychange`(→visible)/`focus` 后 **100ms** 延迟重聚焦，但
   **用户主动 blur 过（标志位）则不抢**；标志位仅在显式打开（F3/菜单推送）时复位——
   点击查找栏容器空白处聚焦输入框同样视为显式意图，复位标志。blur 的 relatedTarget
   落在查找栏内部（点上/下/关按钮）不算用户主动离开。
3. 关闭后焦点还给打开时记录的 `document.activeElement`（`isConnected` 校验后 focus）。

**快捷键**（packages/ui/src/shortcuts/findInPageBindings.ts——bindings.ts 受 400 行
max-lines 硬闸，按 conflicts.ts / label.ts 同一拆分先例以同目录姊妹模块承载，单向
依赖内核不成环）：`FIND_IN_PAGE_BINDINGS = { next: "F3", previous: "Shift+F3" }`
固定绑定，一期**不进** SHORTCUT_COMMANDS 可配置命令表（不可改键）。冲突过闸：

- 裸 F1–F12 在 conflicts.ts 保留键黑名单内 → 可配置命令永远无法占用 F3；
- `Shift+F3` 不在黑名单，理论上可被用户录制到某 global 命令——单测断言现有命令默认
  绑定与 F3/Shift+F3 零相交；用户改键造成的占用属已知边界（分发顺序上 useAppKeyboard
  与本监听同为 window capture，先注册者先执行）。
- 匹配复用 `matchesShortcutBinding`（IME 组合、长按 repeat、多余修饰键噪声已过滤）；
  设置页录制态（`isShortcutRecordingActive`）期间不分发。

## UI 规范（DESIGN.md）

- 浮层：`fixed top-14 right-4 z-40`（dialog 层 z-50 之下），独立 popover 容器
  `rounded-xl`、`bg-popover border-popover-border shadow-md`、`[app-region:no-drag]`；
  宽度 `w-80`、高度 `h-9`。
- 输入：透明底 `text-ui-sm`，placeholder `text-foreground-subtlest`；计数
  `text-ui-xs tabular-nums text-foreground-subtle`；按钮 ghost `icon-xs` + `size-3.5`
  图标（ArrowUp/ArrowDown/X，复用 ModelTrajectorySearchBar 的视觉语言）。
- tooltip（title）：`{动作 label}（{快捷键}）`，快捷键经 `formatShortcutBindingLabel`
  平台化；关闭按钮固定 `Esc` 字面量。
- 高亮：原生路由 Chromium 绘制（黄底/活动橙）；provider 路由 CSS Custom Highlight API
  绘制，颜色走 `--color-find-highlight` / `--color-find-highlight-active` token
  （主题化，二期收口；原「主题化高亮属双路 provider 范围」登记项闭合）。
- i18n 键在 locale 文件落库前，组件内置 en 回退表（formatMessage 未命中会原样返回 id，
  以 id 往返探测后回退）；键与 en/zh 文案见交付报告。
- 已知边界：一期 overlay 与被搜内容同 webContents，Chromium 查找可能匹配到查找栏自身
  的渲染文本（如计数 "3/12"）；input 的 value/placeholder 不参与匹配，实际影响极小。
  provider 路已收口（内置 DOM 腿排除 `[data-find-in-page-overlay]`）；原生路边界保留。
  独立 WebContentsView overlay（上游形态）仍登记。

## 验收场景

1. 输入单个汉字/假名/谚文立即（防抖后）发起查找；2 个拉丁字符不发起且清理既有高亮，
   3 个字符发起。
2. 连续快速输入只在停顿 250ms 后发一轮；旧轮次晚到的结果被丢弃，计数只反映最新查询。
3. Enter/下按钮 = 下一处，Shift+Enter/上按钮 = 上一处；total=0 时按钮禁用。
4. 计数以「第 N/共 M 处」渲染于 role=status 区域，tabular-nums 防抖动。
5. Escape（无修饰、非 repeat、非 IME）关闭查找栏：高亮清除、main 会话拆除、焦点回到
   打开前元素；模态对话框内 Escape 优先关对话框。
6. main 侧：found-in-page 只认本轮 requestId；5s 无事件 / destroyed /
   render-process-gone 三路都收口 `{0,0}`，监听器与定时器全部清理。
7. main 侧：跨文档导航（did-start-navigation 非同文档、did-redirect、did-navigate）与
   渲染进程崩溃触发失效链——clearSelection 恰好一次，重复 stop/end-session no-op；
   same-document 导航不失效。
8. 未过阈值 / 载荷非法的 invoke 返回 null 且不调用 Chromium findInPage。
9. 首查（WeakSet 未命中）强制 findNext:true；已有高亮时透传调用方 findNext。
10. 焦点编排：打开即聚焦；visibilitychange/focus 后 100ms 重聚焦；用户点内容区后
    （主动 blur）窗口重获焦点不抢回；程序性聚焦距上次击键 ≤400ms 不 select()。
11. F3/Shift+F3 与命令表默认绑定零冲突；裸 F3 被保留黑名单挡住不可被改键占用；
    IME 组合中 / repeat 的 F3 不分发；录制态不分发。
12. Web 端（无 preload 桥）组件渲染 null，不注册任何监听。

### 二期验收场景

13. 双路仲裁：`SetProviderActive(true)` 后 findInPage 不调用 Chromium `findInPage`，
    `FindInPageDispatch` 送达 `{epoch,text,findNext,forward}`；`SetProviderActive(false)`
    后回到原生路（findInPage 被调用）。
14. epoch 守卫：错误 epoch 的 report 被丢弃（pending 留待超时 `{0,0}`）；新一轮 dispatch
    立即结算旧 pending 为 `{0,0}`；正确 epoch 的 report 结算对应 invoke。
15. provider 路 fail-soft：无 report 超时 / destroyed / render-process-gone 三路都收口
    `{0,0}` 且监听器/定时器摘净；report 载荷非法（非对象、epoch 非数值、activeIndex/
    total 非数值）被丢弃不结算。
16. 失效链对 provider 路：跨文档导航/崩溃 → pending 结算 `{0,0}`、`FindInPageClear`
    下发（destroyed 后不 send）、providerActive 复位为 false。
17. stop / end-session：结算 pending、下发 `FindInPageClear`；providerActive 保留
    （能力申报与会话生命周期解耦）。
18. renderer 归并：provider scope 按文档序插入 DOM 腿切段；total=各腿之和；active
    映射回 (腿, 腿内序号)；失联 scope 排尾。新查询选首命中；步进 ±1 循环 wrap；
    增量 exact remap 失败时按序号 clamp。
19. 虚拟化感知：total=0 且存在 loadRest provider → 等待（4s 封顶）后 grow 重搜一次，
    active 保持、total 只增；active 在未渲染窗口 → `activeInRenderedWindow=false`；
    无 loadRest 且 `hasUnrenderedContent()=true` → `hasUnsearchableRegions=true`。
20. Highlight API 调用面：全部命中 range 进 `acode-find-in-page`、active range 进
    `acode-find-in-page-active`（priority=1）；shadow root 内命中 → sheet adopt 到该
    root；clear 删除两个 Highlight；API 缺席（无 CSS.highlights / 无 Highlight 构造器）
    → 搜索计数照常、零高亮零抛错。
21. provider 腿 count/show/loadRest 抛错按 0 命中 safe-call 收口，整轮搜索不失败。
22. ConversationTimeline provider（R15）：渲染窗口内命中正常计数/高亮/active 自滚进
    视口；有命中不触发 loadRest；`data-find-provider-scope` 子树不被内置 DOM 腿
    重复计数（各腿互斥）。
23. 窗口外命中：本轮 total=0 → loadRest 批增长（overscan 目标逐 commit +400 直到
    全量挂载），grow 重搜命中、active 保持；unit 总数 >2000（全挂载帽）时不提供
    loadRest → `hasUnsearchableRegions=true`，未渲染区零假命中。
24. 生命周期：unmount 先 provider.clear()（复位 overscan、surgical 撤本腿高亮）再
    注销；注册表归零后后续 dispatch 零命中、provider 腿不再被调用；clear 按代际
    作废在途批增长循环（不再发新批、不悬挂 promise）。

## 边界与登记项

- ~~登记：provider 双路 DOM 搜索~~ → **二期已实现**（机制见上）。收口形态：main 侧
  `findInPageProviderMain.ts` 双路仲裁 + renderer `find-in-page/` provider 体系。
- **登记：虚拟化列表 provider 接线** → **WI-E2b 已闭合**：`ConversationTimeline`
  （@tanstack/react-virtual）经 `useConversationFindInPageProvider` 注册 scope
  provider（规则见 R15，测试 packages/ui/test/conversationFindInPageProvider.test.ts）。
  行数据全量在 projection store（内存）与本接线正交：搜索腿走已物化 DOM，
  loadRest 批增长负责把未渲染区物化进可搜区；全挂载帽（R15）之外按
  `hasUnsearchableRegions` 诚实收口。遗留边界：窗口内已有命中时本轮不物化剩余
  （R11 契约的 total=0 触发条件），属诚实欠报方向。
- **登记：popout 作用域**——蓝本的 popoutWindowId 维度（跨窗 provider 归并）不做；
  ACode 无 popout 会话窗形态。
- 登记：独立 WebContentsView overlay 跨窗迁移复用（顶部偏移按窗型、density 订阅）。
- 登记：main 下发 focusInput/blurInput 与 250ms 焦点轮询——那是「overlay 独立窗」形态
  的补偿机制；一期同窗形态退化为 DOM focus/blur 事件 + relatedTarget 判定。
- 登记：内嵌浏览器 guest / browser-use 受控 view 的页内查找（目标扩展为可指定
  webContents 时需补 sender 授权面，参照 network-capture 先例）。
- **登记：增量重搜的 active 近似 remap**——蓝本对 DOM 变动做子树级最近邻 remap
  （exact 失败后按包含关系找最近命中）；二期只做 exact remap（startContainer+offset
  全等）否则序号 clamp。DOM 高频变动下 active 可能跳位，属体验近似项，不造假命中。
- ~~登记：高亮颜色主题化~~ → 二期闭合（provider 路走 `--color-find-highlight*` token；
  原生路仍是 Chromium 固定色，属 Chromium 能力边界）。
- **登记：loadRest 窗外命中后的初次落位**——实机手验（2026-10-21，300 轮夹具，
  dev:desktop + CDP 五断言全 PASS）：窗外词命中后 provider 的
  `scrollIntoView({block:"nearest"})` 被时间线吸底逻辑压回，视口停留底部，Enter
  步进后落位正确；R11/R13 口径达标（active 保持、层内高亮已画、计数正确）。
  跟进候选=搜索会话期内与吸底所有者协调初次落位（暂停吸底或物化 settle 后补滚），
  不实现登记。
