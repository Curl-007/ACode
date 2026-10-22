# Web 入口连接生命周期：断线重连 + 断线态 UI + active provider 校验

覆盖 `packages/web` 入口（`src/main.tsx`）WebSocket 断线后的重连编排、断线态 overlay，以及
`BrowserOAuthCredentialRepo.getActiveProvider` 的输入校验。对应 review
`docs/reviews/2026-10-22/server-web-provider.md`（R2-05 Web WS 断开无重连/无恢复 UI、
getActiveProvider 未校验强转）与 `ui-state.md`（main.tsx 主题注释误导）。

## 背景与根因

- `connectViaWebSocket(wsUrl, { onClose: () => {} })` 的 onClose 曾是空实现：WS 断开（server 重启 /
  网络抖动 / 手机切后台）后入口既不重连也不提示，用户停在死界面。
- services 侧 `web-remote-replayable` 的 snapshot/resume 语义已齐备
  （`acodeTaskServiceAdapter.ts`），缺的是入口层的重连编排与断线态 UI。**本 spec 不改 services**，
  只在入口层重挂 `Root`（经既有 replayable 快照/resume 路径恢复会话）。
- `getActiveProvider` 曾直接 `localStorage.getItem(...) as OAuthProviderId`，任意 localStorage 字符串
  （旧版本残留 / 手工写入 / 同源其它站点污染）强转成合法 provider，流入 `useAuthToken` 的
  `oauth:${activeProvider}:access_token` 键模板。

## 产品规则

### R1 指数退避重连（`src/reconnect/webSocketReconnect.ts`）

1. **触发**：仅在收到明确的 WS `close` 事件后启动重连循环。不用定时器猜测连接健康
   （AGENTS.md：不用超时掩盖同步问题）——健康由 connect() 的 resolve/reject 明确驱动。
2. **退避**：第 `attempt` 次（1-based）尝试前等待 `computeReconnectBackoffMs`：
   `base * 2**(attempt-1)`，封顶 `maxDelayMs`，叠加 full jitter（`× random[0,1)`）。
   默认 `base=500ms`、`max=15000ms`。封顶保证「有上限」；full jitter 避免大量客户端齐步重连。
3. **溢出安全**：`2**(attempt-1)` 在 attempt 较大时溢出到 `Infinity`，`Math.min(_, maxDelayMs)`
   封顶后再抖动，天然安全（`attempt=50` 仍得 `maxDelayMs`）。
4. **尝试上限**：默认 `maxAttempts = Infinity`（持续重试，退避已封顶）；传入有限值后达上限
   转 `exhausted` 态，overlay 交回手动重试。
5. **幂等启动**：`start()` 在已有循环进行中时是 no-op（`looping` 守卫），不重复调度。
6. **成功复位**：connect 成功 → `attempt` 归零、退出循环、emit `reconnected`、调 `onReconnected`。
7. **取消清理**：`cancel()` 置 `cancelled`、清挂起 timer、退出循环。卸载/页面销毁必须调用，
   防定时器泄漏（AGENTS.md 生命周期约束）。取消后已排队的 connect 回调直接丢弃。

### R2 状态机（驱动断线态 overlay）

`WebReconnectState` 闭集：`idle` | `waiting{attempt,retryInMs}` | `connecting{attempt}` |
`reconnected` | `exhausted{attempts}`。`onStateChange` 每次状态转移回调一次。

### R3 断线态 overlay（`src/reconnect/WebDisconnectOverlay.tsx`，遵守 DESIGN.md）

1. **表面**：dialog shell `rounded-2xl` + `bg-popover border-popover-border`（overlay 表面），
   覆盖 `fixed inset-0 z-50`，半透明背景 + backdrop-blur。
2. **排版**：`text-ui-*` 尺度——标题 `text-ui-lg`，说明/倒计时 `text-ui-sm`。
3. **语义色**：状态点 `bg-destructive`，配可读文案（不只靠颜色传义）；倒计时 `text-foreground-subtlest`。
4. **手动重试**：复用 `@acode/ui` 的 `Button`（与本包 `WebCallbackPage` 同一范式），primary 变体。
   仓库全局 `*:focus-visible{box-shadow:none}` 压掉 ring，故焦点态走 Button 基座的 border-color，
   不自建 focus 样式（保留可见焦点）。
5. **可访问性**：容器 `role="status"` + `aria-live="polite"`，读屏可感知断线态。
6. **倒计时**：仅 `waiting` 且 `retryInMs>0` 渲染，`Math.ceil(retryInMs/1000)` 取整（下限 1s），
   `{seconds}` 占位替换后不得残留。

### R4 入口 i18n（`src/reconnect/webReconnectLocale.ts`）

1. overlay 由入口命令式渲染，且 WS 断开时 services 不可用 → 无法挂 `ACodeIntlProvider`
   （需 settingService/broadcastService）。沿用本包**既有入口层 i18n 约定**
   （`auth/webAuthLocale.ts`、`WebBootstrapErrorScreen`）：集中式 locale 表按语言选词，
   **不硬编码内联文案**，不新增第二份散落字符串。
2. 语言解析优先级与 `resolveWebAuthLocale` 一致：`documentElement.lang` → `navigator.language`
   → `navigator.languages[0]`；`zh*` → `zh-CN`，否则 `en-US`。守卫 `document`/`navigator`
   缺失（Node 测试环境 renderToStaticMarkup），归一 `""` → `en-US`。

### R5 入口编排（`src/main.tsx` bootstrapWebApp）

1. **首连失败**：首次 `connectViaWebSocket` reject（就绪前失败）→ 渲染 bootstrap 错误屏
   （保持既有首连失败语义，不进入重连循环）。
2. **首连成功后断开**：onClose → `controller.start()` 启动退避重连；overlay 覆盖当前 app。
3. **重连成功**：`onReconnected` 用新 services 重挂 `Root`（经既有 replayable 恢复路径），
   `reconnected` 态不再渲染 overlay（由 onReconnected 重挂，避免同帧抢渲染）。
4. **手动重试**：overlay 按钮 → 取消当前循环、建新控制器、立即 `start()`（重置退避计数）。
5. **卸载清理**：`pagehide` 事件 → `controller.cancel()`（清挂起 timer，防泄漏）。
6. **主题注释订正**：入口主题初始化注释指向 store（`packages/ui/src/store/index.ts` 的 `setTheme`，
   `acode-theme` 唯一写入口，走广播防回环），不再写「由 useTheme hook 接管」（useTheme 是死代码）。

### R6 active provider 校验（`src/auth/browserOAuthCredentialRepo.ts`）

1. `getActiveProvider` 过 `isWebOAuthProviderId`（同 `loadPendingProvider`、`loadCachedSessionState`
   的既有正确范式），非法/缺失值归一 `null`，不做强转。
2. 返回值类型仍是 `OAuthProviderId | null`（`WebOAuthProviderId ⊂ OAuthProviderId`，兼容调用方）。

## 唯一所有者

- **重连循环**：`createWebReconnectController` 闭包内 `attempt/timer/cancelled/looping`；
  唯一写入路径是 start/cancel/内部调度，不跨模块共享。
- **待重连的 wsUrl / bootstrap**：`bootstrapWebApp` 闭包捕获，重连复用同一 wsUrl
  （`web-remote-replayable` 恢复语义在 services 侧，入口不重建 workspace 身份）。
- **断线态 UI 文案**：`webReconnectLocale.ts` 集中表，overlay 是唯一消费点。

## 验收场景

1. **退避增长与封顶**：`computeReconnectBackoffMs` 随 attempt 指数增长，封顶 `maxDelayMs`，
   `attempt` 溢出仍封顶；full jitter 结果落在 `[0, cap]`。
2. **失败重试直到成功**：注入假 timer + 假 connect（前 2 次 reject、第 3 次 resolve），
   依次 emit waiting/connecting，成功后 emit reconnected、attempt 归零、无挂起 timer。
3. **幂等启动**：连接进行中连续 `start()` 只调度一次。
4. **取消无泄漏**：`cancel()` 清空挂起 timer，之后 fireAll 不触发任何 connect。
5. **有限上限**：`maxAttempts=2` 连续失败后 emit `exhausted{attempts:2}` 且不再调度。
6. **overlay 渲染**：waiting/exhausted/connecting 三态均渲染 `role=status` + 手动重试按钮；
   waiting 渲染倒计时（占位已替换）、connecting/exhausted 不渲染倒计时。
7. **active provider 校验**：写入合法 provider（zai/bigmodel）→ 原样返回；写入非法值
   （`evil-provider`/`__proto__`/空串等）或缺失 → `null`；`setActiveProvider(null)` 清除后 → `null`。

测试：`packages/web/tests/`（`node --import tsx --test`，与 provider/rpc 同范式，无需预构建、无 jsdom）。
退避重连用注入假 timer / 假 connect（无真实墙钟依赖）；overlay 用 `renderToStaticMarkup`
+ `registerHooks` 短接 `@acode/ui`（避开重图）。
