# 不可见侧栏面板释放会话订阅与投影(hidden-pane subscription release)

renderer 内存治理项,承接 `renderer-memory-budget.md`「后续立项」中 forceMount 侧栏
一条的产品确认(2026-10-02 用户确认实施),并与 `packages/services/specs/
chat-lane-idle-reclaim.md` R6 的「UI 订阅生命周期是收益前提」呼应。

给 SessionPane 增加独立的 `subscriptionActive` 门控:不可见的侧栏会话面板释放
SessionDataLayer lease(→ 30s keep-warm → 关闭投影 store、退订 v4、释放 ≤32MB
投影窗口),重新可见时经既有 acquire 路径恢复(warm 复用或 cold snapshot)。

## 背景(起草时逐条核实)

1. **持有链**:SessionPane mount effect 无条件 `layer.acquire`
   (`packages/ui/src/v4/SessionPane.tsx:1747-1763`,deps 仅 `[layer, effectiveSessionId]`,
   与可见性无关)→ SessionDataLayer entry(refCount + 30s keep-warm,
   `v4/sessionDataLayer.ts:30,:68-112,:139-149`)→ ConversationProjectionStore
   (v4 订阅唯一 owner + 投影窗口 ≤1200 行/≤32MB,`v4/conversationProjectionStore.ts:224-225`)。
2. **forceMount 常驻**:侧栏每个 tab 的 TabsContent `forceMount` + CSS 隐藏
   (`app-shell/AnimatedSidePanePanel.tsx:1095-1099`,意图注释 :929-935——保草稿);
   面板整体收起后内容仍挂载(`hasRenderedSidePane` :434-435,:492-500)。
   N 个打开过的会话 tab = N 份投影窗口常驻,隐藏不释放。
3. **可见性信号已到位**:侧栏宿主的 `focused = isVisible && tab 为 active`
   (`AnimatedSidePanePanel.tsx:1110,:1125,:1165,:1173`;isVisible 含
   `workspaceMainView==="chat" && isSidePaneOpen`,`WorkspaceShellLayout.tsx:423`),
   且三个侧栏 SessionPane 使用点都已接收该 prop
   (`SubagentSessionSidePane.tsx:41-47`、`WorkflowActorSessionSidePane.tsx:94-99`、
   `SelectionSideChatPane.tsx:37-43`)。
4. **focused 语义分叉(关键坑)**:workbench leaf 的 `focused` 是**键盘焦点**
   (`v4/V4WorkspaceChatArea.tsx:559`,分屏下可见非焦点 pane 也是 false),
   侧栏的 `focused` 才是真可见性。门控必须用新 prop,不得直接复用 focused,
   否则分屏误释放可见 pane。
5. **恢复路径已被生产验证**:lease 释放 → 30s keep-warm 内 re-acquire 复用同一
   store(订阅未断,滚动/行高缓存保留);超 30s 走 cold 路径(新 store、
   subscribe base 水位 → CLI 裁决 resume(保留窗 2000 条内 delta 重放)或全量
   snapshot,`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/
conversation-topic-publisher.ts:794-841`)。与「关闭面板重开」「renderer 刷新恢复」
   (`usePaneSessionPersistence.ts:1-7`)同一条路径。
6. **组件不卸载**:只释放 lease、保持挂载,则 forceMount 的既有理由(草稿不丢,
   已 localStorage 持久化 `v4/composer/composerDraftStore.ts:1-30`)、draft prewarm
   绑定(`SessionPane.tsx:1770-1779`)、selection-side-chat opener 注册
   (`:1397-1409`)全部不受影响。
7. **订阅纯观察**:命令上行 `transport.sendCommand` 与订阅无关
   (`SessionPane.tsx:889`),optimistic overlay 全链 optional chaining;
   「关 pane ≠ 停 session」是既有设计(`sessionDataLayer.ts:138` 注释)。
   CLI 侧 turn 执行与 delta 日志追加不依赖订阅者存在。

## 产品规则

### R1 门控语义:subscriptionActive=false 不持有 lease

- SessionPane 新增可选 prop `subscriptionActive`(缺省 `true`,所有既有使用点
  行为不变)。acquire effect deps 加入该值:false → 不 acquire(已持有的经
  effect cleanup 释放);true → 恢复既有 acquire 逻辑。
- **只有真可见性信号可以驱动该 prop**。侧栏三个使用点传 `focused`(其语义
  即 isVisible && active tab);workbench leaf 与主聊天 pane **恒缺省 true**
  (渲染即可见:inactive group 不渲染、跨 workspace 分屏 pane 渲染即用户可见,
  其订阅属于正确持有)。
- Settings 等主视图切换使侧栏 isVisible=false → 自然释放,返回时恢复;
  不做豁免(与「不可见即不持有」单一语义一致)。

### R2 释放节流完全复用 keep-warm,不新增计时器

- 释放走既有 release → refCount 归零 → 30s keep-warm → close(退订+窗口随
  store 脱引用 GC)。30s 内切回 = 同 store 复用,零重订阅、零闪烁;
  竞态防护(幂等 release、stale ACK generation 守卫、CLI 同 connectionId
  订阅替换)均为既有机制。
- 隐藏期间 store 在 keep-warm 窗内仍占内存是**接受的取舍**(防抖优先);
  立即释放(断订留水位标量)列后续项,不在本轮。

### R3 恢复正确性:与重开面板同路径,不引入新状态

- 重新可见 = 既有 acquire(cold/warm/keep_warm 三态照旧);隐藏期间事件超
  保留窗(2000 条)自动降级 snapshot,正确性无损(desktop-continuous 与
  web-remote-replayable 的 resume/snapshot 走同一 profile 管线,
  `packages/shared/src/acode-protocol-v4/core.ts:34-58`)。
- **watchdog 语义变化(记录)**:释放订阅期间 `expectAcceptedInputProjection`
  恢复哨兵不在线;隐藏 pane 无新输入,释放前已受理的输入由 re-acquire 的
  snapshot/resume 权威行补齐,pendingCommandRegistry 对账走 RPC 不依赖订阅
  (`SessionPane.tsx:1737-1745`)。输入不丢,只是对账时点后移。
- 隐藏期间会话 turn 继续在 CLI 执行;徽章/列表状态来自 workspace 级
  sessions-index 订阅(连接级,不随 pane lease 释放),通知面不受影响。

### R4 收益边界(诚实声明)

- **直接收益是 renderer 内存**:每个隐藏侧栏会话 tab 在 30s 后释放 ≤32MB 投影
  窗口 + 订阅推送/delta 处理开销;N 个隐藏 tab 线性叠加。
- **对 CLI 进程空闲回收的增益是间接的**:仅当隐藏的侧栏 tab 是某 workspace
  进程的最后订阅者时才解锁回收(典型:多窗口下后台窗口的侧栏、或主聊天已关
  只剩隐藏 tab 的 workspace)。单窗口看主聊天的常规场景,该 workspace 进程本就
  因主 pane 订阅而不回收(正确行为)。
- 不做窗口级(document.visibilityState/最小化)释放:Windows 遮挡检测不可靠、
  多窗口语义复杂,列后续项。

### R5 范围外(本轮不动)

- treemapping 面板自带独立 SessionDataLayer+lease
  (`hooks/useTreemappingConversationMessage.ts:68-95`),其可见性门控独立评估;
- xterm 侧栏终端 stash 回收(仍是 `renderer-memory-budget.md` 的待产品确认项,
  本 spec 只确认 forceMount 会话面板部分);
- 协议级 `visibility: foreground|background` QoS hint
  (`packages/shared/src/acode-protocol-v4/transport.ts:116`)两端消费实现。

## 状态所有者与不变量

- 可见性事实:侧栏 = AnimatedSidePanePanel 的 focused 计算(既有,唯一来源);
  workbench = 渲染即可见(结构事实,无新状态)。
- lease/订阅/投影:SessionDataLayer 与 ConversationProjectionStore(不变)。
- SessionPane 只新增一个 prop 与 effect 门控,**不新增任何状态副本**;
  subscriptionActive 是纯输入信号,不落入 store。

## 验收

- 单测(纯逻辑,packages/ui/test 既有形态):SessionDataLayer 的
  release→keep-warm→re-acquire 复用/超时 close 行为(若既有测试未覆盖则补);
  prop 门控本身由类型与实机验证覆盖(无组件测试基建,不为此引入)。
- 门禁:`pnpm typecheck`、`pnpm lint`(改动文件)、`architecture:check --changed`。
- 实机(dev:desktop):打开子代理侧栏 tab → 收起面板/切 tab → 30s 后 renderer
  内存诊断 `projection.stores`/`projection.rows` 计数回落;切回 ≤30s 无闪烁
  (warm 复用)、>30s 经 snapshot 恢复且消息完整;主聊天流式不受影响;
  隐藏期间该会话若有 turn 在跑,重新可见后投影补齐。

## 后续立项(本轮不实现)

- store 级 `disconnect-keep-watermark`(断订+清窗口、仅留 logEpoch/seq 标量,
  re-acquire 走 resume):把释放时延从 30s 降到 0,改动面在 projection store
  新增 API;
- 窗口级可见性(最小化/遮挡)统一 hook 与释放策略;
- treemapping lease 的可见性门控;
- visibility QoS hint 的两端消费(CLI 按 background 降推送节奏)。
