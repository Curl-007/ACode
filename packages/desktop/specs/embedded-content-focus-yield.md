# 嵌入内容可编辑焦点让路 + 焦点归还 TTL

## 背景与冲突面（调查结论）

第三方内容面进入 ACode 窗口后，宿主级键盘通路会先于页面内容吃掉按键：

1. **应用菜单 accelerator（主冲突面）**。`desktopApplicationMenu.ts` 的可配置命令
   accelerator：newTask `CmdOrCtrl+N`、openWorkspace `CmdOrCtrl+O`、closeActiveContext
   `CmdOrCtrl+W`、zoomIn `CmdOrCtrl+=`（含隐藏 `Plus` 变体）、zoomOut `CmdOrCtrl+-`、
   resetZoom `CmdOrCtrl+0`；另有 role 项（undo/redo/cut/copy/paste/selectAll、
   togglefullscreen、minimize、toggleDevTools、quit 等）带系统隐式 accelerator。
   可视化卡片 iframe 是 `sandbox="allow-scripts"`（无 allow-same-origin，见
   `packages/ui/specs/gen-ui-visualize-card.md`），片段脚本可以创建输入框；焦点在
   卡片输入框内时 `Ctrl+N` 仍被应用菜单吃掉（菜单 accelerator 在窗口级处理，先于
   页面 keydown，且对同 WebContents 内的 sandbox iframe 同样生效）。内嵌浏览器
   `<webview>` guest（独立 WebContents）同受影响。
2. **renderer 快捷键（无冲突）**。`useAppKeyboard` 是宿主 document 的 window keydown
   capture；焦点进入跨源 iframe / webview guest 后按键不再派发给宿主 document，
   宿主快捷键天然不触发。`bindings.ts` 的 `isEditableShortcutEventTarget` 判定集缺
   IFRAME/EMBED/OBJECT（该文件归快捷键批次 W1-5，此处只登记接线需求，见文末清单）。
3. **before-input-event（现状仅一处）**。`desktopWindowChrome.ts:371` 在 guest
   webContents 上跟踪修饰键（外部浏览器打开态），不派发宿主命令。未来若在 main 用
   before-input-event 派发宿主级快捷键，必须先过可编辑焦点让路判定（本 spec §3 的
   台账谓词），否则会复刻菜单 accelerator 的吃键问题。

参考机制（还原工程证据）：preload 侧追踪 `document.activeElement`（穿透 shadowRoot；
IFRAME/FRAME/EMBED/OBJECT 因内容不可穿透**保守视为可编辑**），变化才经带布尔校验器的
IPC 上报（`coworkArtifact.js:62-125`）；main 维护可编辑焦点 webContents 集合，
before-input-event 拦宿主快捷键时若该 pane 有可编辑焦点则直接 return 放行按键
（`index.chunk-CHpJbW9_.js:244351-244456`）；导航/销毁清集合。

## 1. UI 侧：可编辑焦点上报（`packages/ui/src/lib/embeddedContentFocus.ts`）

第三方内容面的**容器组件**负责追踪焦点进出并上报，判定规则：

- 判定集：`INPUT` / `TEXTAREA` / `SELECT` / `IFRAME` / `FRAME` / `EMBED` / `OBJECT` /
  `contentEditable`，另加 **`WEBVIEW`**（Electron `<webview>` guest 对宿主 DOM 不透明，
  与 IFRAME 同理保守视为可编辑；宿主 activeElement 可能落在 WEBVIEW 自定义元素或其
  内部 OBJECT 上，两者都在集内）。
- activeElement 解析穿透 `shadowRoot.activeElement` 链（焦点可能在 shadow DOM 内的
  输入框上）。
- 监听：容器上委托 `focusin` / `focusout`（capture）+ `keydown`（capture，兜住程序化
  焦点移动）；挂载时立即同步一次。**不监听 window blur**——窗口失焦时 activeElement
  不变，误报 false 后焦点回窗不会再触发 focusin，会造成「iframe 有焦点但台账为 false」
  的假阴性。
- 变化才上报：per-surface 记住 lastReported，trailing 去抖（默认 150ms，非每帧/每键）；
  去抖窗口内翻回原值则取消上报。多 surface 并存时依赖 DOM 事件序（focusout 先于
  focusin）+ 相同去抖延时保证 main 侧收到的布尔序列终值正确，不做跨 surface 聚合。
- 上报通道：`IPlatformService.syncEmbeddedEditableFocus?(focused: boolean)`（可选方法，
  Web/静态回放无桥即 no-op）。通道常量与 preload 桥归 channels/preload 所有者，
  接线需求见文末清单；约定 channel 串为 `acode:sync-embedded-editable-focus`
  （与 main 侧 `EMBEDDED_EDITABLE_FOCUS_CHANNEL` 常量一致）。

首个接入方：`packages/ui/src/v4/VisualizationArtifactRow.tsx`（卡片容器挂 tracker）。
内嵌浏览器 pane 容器（`BrowserViewportSurface.tsx`，非本批文件）接入同一 tracker 为
接线需求。

## 2. main 侧：可编辑焦点台账（`packages/desktop/src/main/editableFocusTracker.ts`）

- 状态所有者：`createEditableFocusLedger()` 返回的台账，唯一事实源是
  「有可编辑焦点的 webContents id 集合」。UI 上报（renderer IPC）与未来的 guest
  webContents focus 事件都经 `setEditableFocus` 写入，不允许第二份集合。
- IPC 面收窄：`registerEmbeddedEditableFocusIpc` 只接受 `typeof payload === "boolean"`，
  非布尔一律丢弃 + warn（对齐参考实现的布尔校验器）；`senderFrame` 存在且非顶层
  （`parent !== null`）时拒绝——嵌套 iframe 不得代宿主窗口上报。
- 收口（不依赖 renderer 合作，对齐录制态 `resetShortcutRecordingForWebContents` 的
  教训）：某 webContents 首次置 true 时挂 `did-navigate` / `render-process-gone` →
  清该 id，`destroyed`（once）→ 清 id 并摘监听登记。导航后旧文档的焦点事实必然失效。
- 聚合翻转事件：`onAggregateChange(listener)` 只在「集合空 ↔ 非空」翻转时触发，
  供菜单重建接线使用（避免每次逐 surface 变化都重建菜单）。
- before-input-event 让路谓词：`hasEditableFocus(webContentsId)`——宿主级快捷键在
  main 拦截前先查台账，命中即 return（不 preventDefault、不派发），按键留给页面。

## 3. 菜单 accelerator 让路：两案调研与取舍

- **案 A（选用）：动态摘挂冲突 accelerator**。台账聚合翻转为 true 时经
  `rebuildApplicationMenu({ disableShortcutAccelerators: true })` 摘掉全部**可配置**
  命令 accelerator（复用录制态既有摘除通路，`resolveMenuAccelerator` 返回 undefined，
  菜单项保留可点击）；翻回 false 时重挂。role 项不摘：edit role（undo/cut/copy/paste/
  selectAll）作用于聚焦 frame，对卡片输入框是**正确行为**；fullscreen/minimize/
  devtools/quit 是窗口管理键，用户预期全局可用。
- **案 B（否决）：依赖 before-input-event 让路**。不可行/不可靠：
  1. macOS 上 NSMenu `performKeyEquivalent` 先于 before-input-event，accelerator 命中
     时事件根本不到达 handler（本仓库录制态注释已实证「macOS 系统菜单会先于 renderer
     吃掉按键」，`bindings.ts` setShortcutRecordingActive 注释）。
  2. before-input-event 的 `preventDefault()` 只能**同时挡掉**页面 keydown 与菜单
     shortcut，不存在「放行给页面但拦住菜单」的分支——它无法表达让路，只能表达拦截。
  3. 让路语义要求菜单 accelerator 在焦点期间**不存在**，这正是案 A。
- 取舍代价（如实记录）：应用菜单是 app 级共享对象，摘除波及全部窗口（与录制态同一
  既有代价）；焦点频繁进出会以去抖后的翻转频率触发 rebuildMenu（异步读设置，
  仅在聚合翻转时发生）。可配置 accelerator 集合与录制态一致（含 zoom 三键），
  卡片内 `Ctrl+=` 等留给页面自决。

## 4. 焦点归还 TTL（`packages/desktop/src/main/cuaPipFocusRouter.ts`）

OS 级焦点归还协调器（机制移植自参考实现 `:184866-184894`），供 CUA 面板及未来
会抢占前台的浮窗使用：

- `captureForegroundBeforeShow()`：面板 show（将抢 OS 前台焦点）前记录
  `{ handle, timestamp }`。handle 经注入的 `OsWindowFocusBridge.getForegroundWindowHandle()`
  读取；bridge 缺席（当前构建无 OS 窗口句柄原生面，零新增依赖下不造假桥）、读取抛错、
  handle 为 0/null → 记录为 null，fail-soft 不阻断 show。
- `restoreForegroundAfterDismiss()`：dismiss 后归还。**`now - timestamp > 30_000ms`
  即过期丢弃、不再归还**（用户已走远，抢回焦点是打扰）；归还调用抛错只 debug 记录。
  记录一次性消费：无论归还/过期/抛错都清空，绝不重复归还。
- `discardPendingReturn()`：面板销毁、app 退出等异常路径丢弃记录不归还。
- blur 即 dismiss 语义对照：现有 router 的 `blurWindow(windowId)` 已实现 app 内
  「blur → publish focus-changed(null) → PiP 退场」；本协调器是其 OS 级增量——当面板
  形态升级为独立 OS 窗口（会抢前台）时，blur 触发的 dismiss 路径应同步调用
  `restoreForegroundAfterDismiss()`。当前构建的 CUA 浮层（权限拖拽面板、操作指示器）
  均为 `focusable: false` + `showInactive()`，不抢前台焦点，故暂无调用方；协调器先行
  落地并有单测锚定 TTL 边界，接线随首个抢焦点浮窗出现（见文末清单）。

## 不变量

- 台账集合的写入只有 `setEditableFocus` / 收口清理两条路径；读取方（before-input-event
  谓词、菜单接线）不得缓存派生副本。
- 上报是「变化才发」：稳态下（焦点不动）零 IPC；去抖定时器 per-surface，dispose 必清。
- 焦点归还记录至多一条、一次性消费；TTL 判定用严格大于（恰好 30_000ms 仍归还）。
- 判定集是保守方向：不可穿透面（IFRAME/FRAME/EMBED/OBJECT/WEBVIEW）宁可视为可编辑
  ——误让路（菜单 accelerator 短暂摘除）代价远小于误吃键（用户输入被宿主命令劫持）。

## 验收场景

1. 焦点进入可视化卡片 iframe（宿主 activeElement = IFRAME）→ 去抖后上报 true →
   台账含宿主窗口 webContents id → 聚合翻转 → 菜单摘除可配置 accelerator →
   卡片内 `Ctrl+N` 到达页面。
2. 焦点离开卡片回到应用 chrome → 上报 false → 台账清 → accelerator 重挂。
3. 上报期间该 webContents 导航/崩溃/销毁 → 台账自动清、聚合翻回、菜单恢复，
   不依赖 renderer 发复位。
4. IPC 收到非布尔 payload / 嵌套 frame 发送 → 丢弃 + warn，台账不变。
5. 两张卡片间直接切换焦点（focusout A → focusin B）→ main 收到 false→true 有序序列，
   终值 true。
6. TTL：show 前捕获、dismiss 于 29s → 归还；dismiss 于 31s → 丢弃不归还；重复
   dismiss → 第二次 no-op；bridge 抛错 → 不炸、记录仍被消费。

## 接线需求（非本批文件，登记给编排者）

| 落点                                                     | 需求                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/channels.ts`                        | `PlatformChannels.SyncEmbeddedEditableFocus: "acode:sync-embedded-editable-focus"`                                                                                                                                                                                                                                       |
| `packages/shared/src/platform.ts`                        | `IPlatformService.syncEmbeddedEditableFocus?(focused: boolean): void`（桌面专属，可选方法，模式对齐 `setShortcutRecordingActive?`）                                                                                                                                                                                      |
| `packages/desktop/src/preload/index.ts`                  | `syncEmbeddedEditableFocus: (focused) => ipcRenderer.send(PlatformChannels.SyncEmbeddedEditableFocus, focused)`                                                                                                                                                                                                          |
| `packages/desktop/src/main/index.ts`                     | ① 创建台账 + `registerEmbeddedEditableFocusIpc`；② `rebuildMenu` 传 `disableShortcutAccelerators: shortcutRecordingActive \|\| ledger.hasAnyEditableFocus()`；③ `ledger.onAggregateChange(() => rebuildMenu())`；④ 未来 before-input-event 宿主快捷键派发点先查 `ledger.hasEditableFocus(event.sender.id)` 命中即 return |
| `packages/ui/src/browser-use/BrowserViewportSurface.tsx` | 内嵌浏览器 pane 容器接同一 tracker（判定集已含 WEBVIEW/OBJECT）                                                                                                                                                                                                                                                          |
| `packages/ui/src/shortcuts/bindings.ts`（W1-5）          | `isEditableShortcutEventTarget` 判定集补 IFRAME/FRAME/EMBED/OBJECT/WEBVIEW + shadowRoot 穿透（可直接复用 `lib/embeddedContentFocus.ts` 的纯函数）                                                                                                                                                                        |
| CUA 浮窗接线                                             | 首个会抢 OS 前台焦点的浮窗 show/dismiss 处调用 `captureForegroundBeforeShow` / `restoreForegroundAfterDismiss`，并提供平台 `OsWindowFocusBridge` 实现（需原生面，当前缺席即 fail-soft no-op）                                                                                                                            |
