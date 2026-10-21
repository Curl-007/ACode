# 分屏面板 per-pane 错误边界隔离（split-pane-error-isolation）

修设计缺陷「分屏任一 pane render 抛错会连带主面板一起白屏成错误卡」。本 spec 是行为
改动的先行契约（AGENTS.md「改行为前先写 spec」「发现设计缺陷先与用户对齐」）。

## 背景（已核实的现状）

- 桌面主区升级为分屏宿主：`V4WorkspaceChatArea` 按 `layout.leaves` 渲染多个
  `WorkbenchLeafPane`（`packages/ui/src/v4/V4WorkspaceChatArea.tsx:561`），每个叶子面板
  是 `ChatPaneShell`（绝对定位矩形容器，`WorkbenchPane.tsx:116`）内包
  `V4PaneConversationProvider` + `SessionPane`。
- 全窗口**只有一个**覆盖对话区的错误边界：`WorkspaceShellLayout.tsx:1831` 的
  `ScopedErrorBoundary scope="workspace-chat"`，它包住**整个** `V4WorkspaceChatArea`
  （即所有 pane）。`packages/ui/src/v4/` 下 grep `ErrorBoundary` = 无 per-pane 边界。
- 后果：任一 pane（含分屏次级面板）在 render / lifecycle 抛错，会一路冒泡到
  `workspace-chat` 边界，把**主面板 + 所有分屏面板一起**替换成一张全屏错误卡
  （`appError.sectionTitle`「这块界面出了点问题」）。单个会话的组件问题被放大成整个
  对话区不可用。
- `ScopedErrorBoundary`（`packages/ui/src/ErrorBoundary.tsx:358`）已具备局部隔离能力：
  `getDerivedStateFromError` + `componentDidCatch` 收敛异常、`variant` 控制 fallback
  形态、`resetKeys` 变化时自动清空（`componentDidUpdate`），并已在 sidebar / terminal /
  side-pane / orchestration 等多处按区域使用。分屏 pane 是唯一未接的隔离单元。

用户实报「分屏打开对话，面板显示报错文字」正是此路径的可见症状之一（一次 render
throw 被 `workspace-chat` 边界捕获）。根因抛错点需运行时 Console 栈定位（不在本 spec
范围）；本 spec 只钉住**故障隔离**这一设计缺陷的修复：让抛错只影响出错的那个 pane。

## 产品规则

**R1 每个叶子 pane 拥有独立错误边界。** `WorkbenchLeafPane` 在 `ChatPaneShell` 内部、
`V4PaneConversationProvider` 之外包一层 per-pane `ScopedErrorBoundary`。任一 pane 抛错
时，只有该 pane 的内容被替换成 fallback，**同窗口其它 pane（含主面板）继续正常渲染与
交互**。

**R2 fallback 落在 pane 自己的矩形内。** 边界必须放在 `ChatPaneShell`（持有
`style={rectStyle(rect)}` 的绝对定位容器）**内部**，使 `variant="panel"` 的 fallback
卡片渲染在该 pane 的 rect 里，不破坏分屏布局、不溢出到相邻 pane。放在 `ChatPaneShell`
之外会让 fallback 失去 pane 定位，故不采用。

**R3 边界随 pane 身份切换自动重置。** `resetKeys` 用 `[sessionId, paneWorkspaceKey(scope)]`
——pane 改绑会话或换 workspace scope 时清空旧错误，让用户切走再切回不看到上一个会话的
残留错误卡（复用 `ScopedErrorBoundary` 既有 `resetKeys` 语义，不新增重置逻辑）。

**R4 不改变正常路径渲染。** 无抛错时边界透传 `children`（`render()` 里
`!this.state.error` 分支），pane 的 focus / 拖拽投放 / 恢复守卫 / SessionPane 行为零变化。
per-pane 边界是纯加法隔离层，`workspace-chat` 外层边界保留（仍是 sidebar 之外整块对话区
的兜底）。

## 状态所有者

| 事实 | 唯一所有者 | 本次变化 |
| --- | --- | --- |
| 局部 UI 故障隔离能力（捕获 + fallback + resetKeys） | `packages/ui/src/ErrorBoundary.tsx` `ScopedErrorBoundary` | 不变（复用） |
| 分屏叶子面板的渲染与 pane 身份（paneId/sessionId/scope） | `packages/ui/src/v4/WorkbenchPane.tsx` `WorkbenchLeafPane` | 新增 per-pane 边界包裹 |
| 对话区兜底边界 | `WorkspaceShellLayout.tsx:1831` `scope="workspace-chat"` | 不变（保留为外层兜底） |
| 触发 fallback 的**具体抛错根因** | 运行时（需 Console componentStack 定位） | 不在本 spec 范围 |

隔离能力是既有组件的职责；本次只把它接到分屏 pane 这一未覆盖的隔离单元，不新增第二套
错误边界实现。

## 接口

- `packages/ui/src/v4/WorkbenchPane.tsx` `WorkbenchLeafPane`：在 `ChatPaneShell` 的
  children 最外层包 `ScopedErrorBoundary`：
  - `scope={`v4-pane:${paneId}`}`（每 pane 唯一，便于日志区分是哪个面板崩了）；
  - `resetKeys={[sessionId, paneWorkspaceKey(scope)]}`；
  - `variant="panel"`（居中卡片 + 「重试此区域」/「刷新」出口，适合 pane 级矩形）；
  - `className="h-full"`（填满 pane rect，对齐 `WorkspaceShellLayout` 既有用法）。
- 复用既有 `ScopedErrorBoundary`，不新增 props、不新增组件。

## 验收场景

1. **源码契约**：`WorkbenchLeafPane` 的 return 里，`ChatPaneShell` 的直接子节点是
   `ScopedErrorBoundary`，其 `scope` 用 `v4-pane:${paneId}` 模板、`resetKeys` 含
   `sessionId` 与 `paneWorkspaceKey(scope)`；边界内才是 `V4PaneConversationProvider`。
2. **隔离层次**：`ScopedErrorBoundary` 出现在 `ChatPaneShell` 之内、
   `V4PaneConversationProvider` 之外（R2 定位 + R1 覆盖 provider 与 SessionPane 两层抛错）。
3. **外层兜底保留**：`WorkspaceShellLayout.tsx` 的 `scope="workspace-chat"` 边界不删除
   （R4，per-pane 是加法隔离层）。
4. **零回归**：`pnpm --filter @acode/ui test` 全过；`node scripts/typecheck-gate.mjs`
   packages/desktop-renderer/cli 三段全过。

## 不在本项范围

- 触发 fallback 的具体 render throw 根因定位（需真实 Electron + 用户会话数据 +
  Console componentStack；本 spec 只保证抛错被隔离在单 pane）。
- fallback 卡片内新增「关闭此 pane」入口（当前复用 `ScopedErrorBoundary` 既有
  「重试此区域」/「刷新」；如需 pane 级关闭另议）。
- 手机 Web 分屏（当前分屏是桌面宿主能力；per-pane 边界不引入平台分支）。
