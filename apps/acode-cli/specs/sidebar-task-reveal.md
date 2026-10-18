# 任务菜单侧栏定位（sidebar task reveal）

「任务菜单侧栏定位」功能的领域契约。功能源自 `072754e`（store + scroll hook，
主接线留待后续 PR，merge `0cc983f` 以「零消费者半成品」剔除后由本波复活补全接线）。

## 背景（已核实的现状）

- 侧栏任务区（`WorkspaceSidebar`）有四种视图：grouped / project / timeline / archived，
  外加全局 pinned 区；全部渲染在同一个滚动容器（`workspaceScrollRef`）里。
- 任务行 DOM 已带稳定定位锚点：`TaskListItem` 渲染
  `data-task-item-key="<workspaceKey>:<taskId>"`（`workspaceKey` =
  `buildTaskWorkspaceKey(workspacePath, workspaceIdentity)`），grouped 行渲染
  `data-grouped-task-key`（同键 encodeURIComponent 形态）。
- 「打开一个会话」的收口点是 `useACodeSessionStore` 的 `setActiveTaskId`
  （workspace slice）：应用内导航（`useWorkspaceTaskNavigation.handleSelectTask`）、
  任务通知点击与深链冷启动（`useRootPlatformEffects`）最终都落到它。
  这三条入口类各自直达，不经过彼此。
- 长任务列表下，从通知/深链/运行历史打开一个不在视口内的会话时，侧栏不会滚动到
  对应行，用户无法在侧栏里看到「当前会话在哪」。

## 产品规则

### R1 触发与单一写入路径

- 定位请求的唯一写入者是 `setActiveTaskId`（workspace slice）：`id` 非空时向
  `sidebarTaskRevealStore.requestReveal({ workspacePath, workspaceIdentity, taskId })`
  写一条请求；`id` 为空（关闭任务）不写。
- 任何入口（侧栏行点击、通知点击、深链冷启动、automations 运行历史、前进/后退、
  工作流打开）不再各自触发定位——它们已经全部收敛到 `setActiveTaskId`。
- `sidebarTaskRevealStore` 是请求的唯一所有者：单槽 `pendingRequest`，
  `requestId` 单调递增；新请求直接替换旧请求；只有 `requestId` 匹配的
  `consumeRequest` 才能清槽（防陈旧清理）。
- `workspaceKey` 统一由 `buildTaskWorkspaceKey` 构造，不手写 path/identity 拼接
  （Workspace Identity 纪律）。

### R2 滚动行为（hook 消费端）

- 唯一消费者是 `WorkspaceSidebar`：`useSidebarTaskRevealScroll(workspaceScrollRef,
  pendingRequest, isSidebarVisible)`。侧栏面板不可见时请求保持 pending，面板恢复
  可见后再定位。
- 定位目标行按 `data-task-item-key` / `data-grouped-task-key` 两种锚点匹配
  （覆盖 pinned / project / timeline / archived / grouped 五个区）。
- 行完整落在容器视口内 → 不滚动（侧栏行点击因此永不引发跳动）；
  行不完整可见 → 仅滚动侧栏容器把行居中，禁止 `scrollIntoView` 连带移动
  会话区与页面（容器内 `scrollTo`，`behavior: "auto"`）。
- 行在 `aria-hidden="true"` 子树内（文件树覆盖层滑入时任务列表被隐藏）→ 本轮跳过，
  请求保持 pending，等列表重新可见后的 DOM 变更再试。
- grouped 展开动画运行中（`data-grouped-group-content-id` 容器有 running animation）
  → 本轮跳过，动画结束后的变更再试。
- 行尚未渲染（任务列表加载中、group 收起、虚拟化窗口外）→ 用 MutationObserver +
  rAF + transitionend 重试，直到行出现或请求过期。
- 请求有界：15s 内无法定位即静默 consume（防「收起的 group 半小时后被展开时突兀
  跳滚」与流式期间无意义的 observer 轮询）。

### R3 高亮脉冲

- 定位成功（行找到、可见性判定完成）后，对目标行做一次短暂高亮脉冲（约 1.2s），
  视觉语言沿用 `styles.css` 既有 reveal 高亮（brand 色 color-mix 渐隐 +
  inset 描边），通过注入 `sidebar-task-reveal-highlight` class 实现，动画结束/
  超时后移除 class。
- 新动效必须双闸：`@media (prefers-reduced-motion: reduce)` 与
  `[data-acode-reduce-motion="reduce"]` 两路都置 `animation: none`（DESIGN.md
  外观轴规则；attribute 写入者唯一为 `lib/appearancePreferences.ts`）。
- 侧栏行点击也会触发脉冲（入口统一后的自然结果）：行本就可见故无滚动，脉冲视为
  选中反馈的一部分，不做来源区分（保持单写入路径，不引入「抑制标记」第二条状态线）。

### R4 状态所有者与事件顺序

```
任意打开入口 → setActiveTaskId（activeTaskId 唯一 owner）
                  └→ requestReveal（reveal store 唯一写入者，同步、幂等递增）
                        └→ WorkspaceSidebar hook（唯一消费者）
                             重试定位 → 滚动（仅当行不完整可见）→ 脉冲 → consume
```

- 请求是「一次性意图」不是持久状态：定位完成或过期后必须清槽；无持久化、无广播
  （广播/回环纪律不适用——该请求不跨窗口同步，各窗口按自己的 activeTaskId 事件
  独立产生请求）。
- 高亮为纯表现层 transient DOM class，不属于任何 store 状态。

### R5 验收场景

1. 深链/通知打开一个当前分组收起、列表滚动到中部的会话：任务列表就绪后侧栏自动
   滚动使目标行居中，并出现一次高亮脉冲；连续两个通知点击，后一次请求替换前一次，
   只定位最后一次目标。
2. 侧栏内点击一条完整可见的行：不发生滚动，行出现一次脉冲。
3. 文件树滑入覆盖任务列表期间到达的请求：树收起后自动完成定位。
4. 目标行 15s 内始终不存在（group 保持收起）：请求静默过期，之后再手动展开该
   group 不发生突兀跳滚。
5. `prefers-reduced-motion: reduce` 或应用内「减少动效」开启：仍滚动定位，
   但无脉冲动画（双闸各自独立生效）。
6. 滚动只发生在侧栏容器内：主聊天区与页面滚动位置不变。

### R6 边界

- 不扩展到搜索结果高亮（`task-search-result-highlight` 既有死 CSS 不复用、
  不删除）、不扩展到会话内 find 定位。
- 不为收起的 group 自动展开（本期不做；行不存在 → 走 R2 过期路径）。
- 不做跨窗口广播与持久化。
