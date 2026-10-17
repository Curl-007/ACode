# ACode：桌面页内查找（一期）

## 背景与目标

桌面端此前**零页内查找面**：长会话、预览面板、终端输出全部是主窗口 renderer 的 DOM
内容，Electron 壳不提供浏览器式 Ctrl+F 查找。一期把 `webContents.findInPage` 封装成
可靠的查找通道，并在 renderer 提供窗内 overlay 查找栏（输入、计数、步进、关闭、焦点
编排），复用 shortcuts 内核挂 F3/Shift+F3 固定绑定。

一期诚实边界（登记不做，见「边界与登记项」）：

- **单路搜索**——只有 webContents DOM 搜索；renderer FindInPageProvider 双路
  （应用级 DOM 搜索，覆盖虚拟化长列表/popout 作用域）仅登记。
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

## 状态所有者

| 状态                     | 所有者                            | 说明                                                     |
| ------------------------ | --------------------------------- | -------------------------------------------------------- |
| 查找会话（失效链监听）   | main `findInPageMain.ts`          | per-sender-webContents 会话；导航/崩溃/销毁即失效收口     |
| 高亮存在标记             | main（WeakSet）                   | 防重复 `stopFindInPage`；只对确有高亮的目标 clearSelection |
| 查找栏开关/查询文本/计数 | renderer `FindInPageOverlay`      | 组件本地 state，不持久化、不进 store                       |
| 焦点编排标志             | renderer（refs）                  | userBlur / lastKeyAt / restoreFocus / latest-wins 序号     |

高亮唯一写入路径：renderer 经 IPC 请求 → main `webContents.findInPage`；唯一清理路径
`stopFindInPage("clearSelection")`。renderer 不直接触碰任何查找状态副本。

## 接口（IPC，packages/shared/src/channels.ts）

| 通道                            | 方向            | 载荷                                             | 返回                          |
| ------------------------------- | --------------- | ------------------------------------------------ | ----------------------------- |
| `acode:find-in-page`            | Renderer→Main   | `FindInPageRequest { text, findNext, forward? }` | `FindInPageResult \| null`    |
| `acode:stop-find-in-page`       | Renderer→Main   | void                                             | void（仅清高亮，会话保留）    |
| `acode:end-find-in-page-session`| Renderer→Main   | void                                             | void（清高亮+拆失效链）       |
| `acode:open-find-in-page`       | Main→Renderer   | void                                             | —（单向 send，菜单入口推送）  |

- `findNext: true` = 增量续搜；`false` = 重开一轮搜索（步进语义）。`forward` 缺省 true。
- 返回 `null` = 查询未过阈值 / 载荷非法 / 目标不可用，调用方按无匹配收口。
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

## renderer 侧机制（packages/ui/src/find-in-page/）

- `findInPageModel.ts`：纯规则（阈值、计数显示门、select 时机、Escape 判定、时延常量），
  node 可测。
- `useFindInPageOverlay.ts`：状态与编排 hook——250ms 防抖、latest-wins 序号闸、
  焦点编排、window capture 键盘监听（F3/Shift+F3/Escape）、平台桥探测。
- `FindInPageOverlay.tsx`：呈现组件；平台桥缺席（Web 端）时渲染 null，Web 保留浏览器
  原生 Ctrl+F。挂载点：`RootShell`（与 EmbeddedBrowserPermissionPromptHost 同层的
  窗口级宿主，接线见交付报告）。

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
- 高亮由 Chromium 原生绘制（黄底/活动橙），不走 `--color-find-highlight` token（该
  token 面向 DOM 级高亮，如轨迹搜索）；主题化高亮属双路 provider 范围，登记。
- i18n 键在 locale 文件落库前，组件内置 en 回退表（formatMessage 未命中会原样返回 id，
  以 id 往返探测后回退）；键与 en/zh 文案见交付报告。
- 已知边界：一期 overlay 与被搜内容同 webContents，Chromium 查找可能匹配到查找栏自身
  的渲染文本（如计数 "3/12"）；input 的 value/placeholder 不参与匹配，实际影响极小。
  独立 WebContentsView overlay（上游形态）在二期与 provider 双路一并评估。

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

## 边界与登记项（一期不做）

- **登记：provider 双路 DOM 搜索**——renderer FindInPageProvider（应用级搜索，虚拟化
  长列表、popout 作用域、dispatchFindRequest/reportFindResult、provider 失活时 pending
  全部 `{0,0}` 收口）。main 侧接口已按可插入形态收口（findInPage handler 单点），
  二期在 handler 前插 provider 判定分支即可。
- 登记：独立 WebContentsView overlay 跨窗迁移复用（顶部偏移按窗型、density 订阅）。
- 登记：main 下发 focusInput/blurInput 与 250ms 焦点轮询——那是「overlay 独立窗」形态
  的补偿机制；一期同窗形态退化为 DOM focus/blur 事件 + relatedTarget 判定。
- 登记：内嵌浏览器 guest / browser-use 受控 view 的页内查找（目标扩展为可指定
  webContents 时需补 sender 授权面，参照 network-capture 先例）。
- 登记：高亮颜色主题化（依赖 provider 双路的 DOM 高亮或 Chromium 能力）。
