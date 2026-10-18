# 浏览器两件：原位截图 whileDrawing + browser-relay（驱动已登录 Chrome）

状态：2026-10-18 落地（wave 1）。移植自 oh-my-pi（MIT，Copyright (c) 2025 Mario Zechner & Stencil Labs）：
`packages/coding-agent/src/tools/browser/screenshot.ts:161-193`（whileDrawing）与
`packages/coding-agent/src/tools/browser/relay/{protocol,bridge,server}.ts`、
`packages/browser-relay/extension/**`（Chrome 扩展）。移植文件头部均注明来源；Bun API
（`Bun.sleep`/`Bun.serve` websocket）降解为 node:* 定时器 + 自实现最小 RFC6455 服务端，
零新增 npm 依赖。

两件互相独立，共用本 spec：

1. **R1 原位截图 whileDrawing**（快赢）：隐藏/后台 Chromium 页停止绘制导致
   `Page.captureScreenshot` 等帧超时；截图前临时开一路 1×1 jpeg screencast 迫使绘制，
   截完立即 stopScreencast + detach；拒绝 screencast 的浏览器退化为直接截。
2. **R2 browser-relay**：Chrome 扩展（`chrome.debugger`）+ 本地 relay 服务端。服务端伪装
   Chrome 的 CDP discovery 端点（`/json/version`、`/json/list`），合成 `Target.*` 层级，
   把「单标签只能挂一个 debugger」的限制多路复用给 N 个 CDP 客户端连接；解决 Chrome 136+
   默认 profile 禁 `--remote-debugging-port` 的问题，让 agent 能驱动用户日常已登录的 Chrome
   标签。

## 背景

- ACode 走 CDP `Page.captureScreenshot` 的路径只有一条：managed headless CDP 后端的
  `adapters/src/browser/page-command.ts` `screenshot` 分支（Playwright `page.screenshot()`
  / `element.screenshot()` 底层即该命令）。core `browser-client` 的 facade 只是把
  `{ method: "screenshot" }` 命令经 transport 转发到该后端；browser-use 插件的
  `browser-client.mjs` 是同一命令面的 bundle。因此 whileDrawing 在 page-command 单点接入
  即覆盖全部截图路径（`docs/screenshot.md` 里「截图超时不要立刻重试」的告警正是这个
  症状的下游表现）。
- managed 运行时一个 session 可有多个 tab（`ManagedCdpSession`），非激活 tab 在
  Chromium 里停止合成帧；`page.screenshot()` 等新帧直到操作超时。omp 的解法是用
  DevTools screencast 强制绘制——screencast 让 Chromium 为捕获而绘制页面，不显示、不
  激活、不改变可见性。
- ACode 无任何驱动用户日常浏览器（已登录会话）的通道：managed 运行时是隔离 headless
  profile；`agent-browser --auto-connect` 依赖 `--remote-debugging-port`，而 Chrome 136+
  在默认 profile 上拒绝该开关。omp 的 browser-relay 用「扩展持 debugger + 本地服务端
  伪装 CDP 端点」绕开单 debugger 限制，值得整体移植。

## 产品规则

### R1 whileDrawing 原位截图

- **唯一所有者**：`adapters/src/browser/while-drawing.ts` 的 `whileDrawing(page, signal,
  capture, factory?)`。所有走 CDP `captureScreenshot` 的路径（现为 page-command 的
  `screenshot` 分支的 page 与 element 两种捕获）都必须经它包裹；禁止在别处复制第二份
  screencast 技巧。
- **时序**（顺序不可变）：

  ```text
  newCDPSession(page)             ──失败──▶ 降级：直接 capture（原错误吞掉）
  Page.startScreencast {jpeg,1×1} ──失败──▶ 同上（降级；会话仍保留待清理）
  capture()                       ──抛错──▶ 仍执行 stopScreencast + detach，再抛原错误
  Page.stopScreencast（吞错）
  session.detach()（吞错）
  ```

  会话一旦开出，无论 startScreencast 成败、capture 成败，finally 都执行
  stopScreencast + detach 清理（半开会话不泄漏）。

- **参数**：`format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1`——最小绘制代价，
  帧内容不消费，只利用「screencast 存在 ⇒ Chromium 持续合成」这一副作用。
- **降级语义**：screencast 开启失败不是错误。拒绝 screencast 的浏览器（或非 Chromium
  内核）走无 screencast 的直接捕获，行为与移植前完全一致。
- **中止**：`signal` 已中止或 capture 期间中止时抛 AbortError（复用
  `request.ts` 的 `raceWithAbort`/`abortError`），清理路径照常执行。
- 可见副作用：无。screencast 帧不落盘、不回传；session 用完即弃。

### R2 browser-relay

#### 角色与所有权（每份状态只有一个所有者）

```text
┌─ Chrome ──────────────────────┐   ┌─ relay 服务端（本进程内）─────────────┐   ┌─ CDP 客户端 ×N ─┐
│ MV3 扩展（dumb pipe）          │   │ RelayBridge = 标签注册表/会话账本/    │   │ puppeteer /     │
│  chrome.debugger 每标签 1 挂载 │◀─▶│ 分组账本；RelayServer = HTTP+WS 路由 │◀─▶│ agent-browser   │
│  chrome.tabs/tabGroups 事件流  │   │ RelayLeaseManager = 消费者租约计数   │   │ （--cdp 9224）  │
└───────────────────────────────┘   └──────────────────────────────────────┘   └─────────────────┘
      ws://127.0.0.1:9224/ext                /json/version /json/list /cdp /ext
```

- **扩展是哑管道**：只执行 relay 下发的 RPC（attach/detach/send/createTab/removeTab/
  activateTab/group/ungroup）、回推 tab 生命周期与 `chrome.debugger` 事件。全部编排状态
  （哪些标签被驱动、会话到标签的路由、Runtime 上下文账本、分组状态）都在
  `RelayBridge`，服务 worker 重启只需重新 hello，不丢编排状态。
- **`RelayBridge`**（`browser-use-plugin/src/relay/bridge.ts`）：唯一持有
  - 标签注册表：键 `<instance 码>:<chrome tabId>`，多浏览器实例（Chrome/Edge 并连同一
    relay）命名空间隔离；
  - 伪会话账本：给每个下游连接铸造 `ST<tab>.<conn>.<n>`（tab 伪会话，仅满足
    puppeteer 的 Target 层级）与 `SP<tab>.<conn>.<n>`（page 伪会话，转发到该标签根
    debugger 会话）；真实子会话（OOPIF/worker）id 由 Chrome 产生，原样透传；
  - 每标签共享 Runtime 账本：根 `Runtime.enable` 一次（disable→enable 循环 + epoch 防
    旧盖新），上下文按会话重放，`Runtime.disable` 的会话被静音；
  - 分组账本：谁 claim 了哪个标签（`OMP.claimTarget` / `Target.createTarget` 显式认领，
    不从命令流量推断）、组 RPC 串行队列（不重叠，防扩展非原子
    查询→建组→改名竞态铸出重复同名组）、用户拖出组即永久 opt-out。
- **`RelayServer`**（`src/relay/server.ts`）：唯一持有 HTTP/WS 面。node:http +
  自实现最小 RFC6455（`src/relay/websocket.ts`），绑定 127.0.0.1。路由：
  - `GET /json/version` → 扩展就绪：200 + 标准 CDP 字段（`Browser`、
    `webSocketDebuggerUrl: ws://<host>/cdp` 等）+ relay 自报字段；未就绪：503 +
    `{ acodeRelayVersion, error, extensionSeen, uptimeMs, acodeRelayCdpClients,
    disconnectedMs? }`，供客户端区分「没装扩展」与「service worker 被回收正在重拨」。
  - `GET /json`、`/json/list` → 可挂载 page 目标清单（调试辅助；不下发 per-target 端点）。
  - `WS /cdp` → 下游 CDP 客户端；带 `Origin` 头的升级一律 403（网页不得驱动 relay）。
  - `WS /ext` → 扩展；`Origin` 若存在必须 `chrome-extension://`；配置了 token 时校验
    `?token=`，不符 401。
  - Host 头校验（DNS rebinding 防护）：非法 authority 回退 `127.0.0.1:<port>`。
- **`RelayLeaseManager`**（`src/relay/lease.ts`）：每进程单例（按 port 键控），消费者
  `acquire()` 计数 +1（首个消费者启动服务端），`lease.release()` 计数 -1，计数归零即
  `stop()`。同一 manager 的并发 acquire 共享同一启动 promise（singleflight）；release
  与 acquire 交叠时以计数为准，不复活已停实例（见验收 A5）。
- **多路复用的幂等边界**：
  - attach：`Target.setAutoAttach`（浏览器级）/`Target.attachToTarget`（显式）对同一标签
    的重复调用各自铸造独立伪会话；扩展级 `chrome.debugger.attach` 由 `#ensureAttached`
    singleflight（`attaching` promise + attachGeneration 防废弃代次回写）。
  - detach：最后一个持有会话的下游连接关闭才真正 `chrome.debugger.detach`
    （`#detachIfUnheld`）；显式 release 最后一个会话同样触发。attach 前串行等待在途
    detach（`detaching`）。
  - 用户取消（Chrome 调试信息条点 Cancel，`canceled_by_user`）：该标签 ban 到 URL 变化
    为止，不自动重挂；其余 detach（如其他扩展帧加载）立即重新宣布。
  - `Browser.close` 永不关闭用户浏览器：ack 后忽略（护栏：page 会话不得拖垮整个浏览器）。
  - 标签关闭在途（`Target.closeTarget`）时的 detach 不当作 Chrome 主动断开（`closing`
    标记），不发 `ACODE.debuggerDetached`。
- **断连恢复**（事件顺序）：
  - 扩展 socket 断开：拒绝该实例全部在途 RPC；标签保留在注册表（浏览器可能重连），
    debugger 派生态清零（attached/runtime/children）；分组态清零（扩展断开时自解散组）。
  - 同实例新 socket hello（service worker 重启）：退役旧 socket，`ExtensionReplacedError`
    快速失败在途 RPC；按 hello 的 `attachedTabIds` 对账（只认本扩展自己的挂载——用
    `Target.getTargetInfo` 探针过滤 DevTools/其他扩展的挂载）；下游仍持有会话的标签
    best-effort 重挂。
  - hello 对账按实例 GC 标签：另一浏览器的标签不受影响（多浏览器共享一个 relay 的前提）。
  - 下游 CDP 客户端断开：其全部伪会话撤销（补发 `Target.detachedFromTarget`），其
    claim 的标签按「是否还有 claimant」决定去留分组（会话持有者不算 claimant——长驻
    registry 连接对每个标签都持会话但不驱动任何标签）。
- **标签分组可见性（安全面）**：被 agent 主动驱动的标签收进所在窗口的可见标签组
  （缺省青色「ACode」组），释放即退组，relay 与扩展断连即解散全部 relay 组；pinned 标签
  永不分组（分组会静默解 pin）；用户自己的组、用户拖出的标签永不回组。认领判定是
  显式的（`ACODE.claimTarget` 私有方法或 `Target.createTarget`），不从命令流量推断
  （目标发现会对每个页面发同样命令，推断会把全部标签卷进来）——因此 wave 1 里
  **relay 创建的标签**必入组；**原位接管的既有标签**只有发送过认领的客户端才入组，
  通用 puppeteer 客户端（agent-browser）不发送认领时，原位标签的可见性信号是 Chrome
  自身的「正在调试此浏览器」信息条（见已知限制）。
- **目标选择**：本 wave 的消费者（agent-browser 等 puppeteer 系客户端）用标准
  `Target.getTargets`/`/json/list` 按 URL/标题子串自选；无目标时接管当前可见标签且不
  抢焦点（创建标签走 `background: true` → 扩展 `active: false`）。`activateTab` 是唯一
  显式抢焦点路径（`chrome.windows.update({focused:true})` + `tabs.update`）。
- **不可挂载 URL**（`chrome:`、`devtools:`、`edge:`、`view-source:`、
  `chrome-extension:`、`chrome-untrusted:`、`chrome-search:`）对下游发现完全隐藏。
- **wire 协议**（relay ↔ 扩展，`src/relay/protocol.ts`）：JSON 文本帧。relay→扩展：
  `{t:"rpc", id, op, ...}` 与 `{t:"pong"}`；扩展→relay：`hello`（含 userAgent、
  browserVersion、tabs 快照、attachedTabIds、`relayProtocol`、稳定 `instanceId`）、
  `cdpEvent`、`detached`（带 `relayInitiated` 归因）、`tabCreated/Updated/Removed`、
  `rpcResult`、`ping`。`relayProtocol: 1` 能力门：扩展与 relay 版本不匹配的实例不参与
  目标发现/自动挂载（对应 omp 的 `discardedTabsProtocol`，改名重定义）。

### 安全（硬要求，单列）

1. **显式 opt-in 才启动**：relay 不随任何进程自动启动。本 wave 唯一启动路径是显式调用
   `startRelayServer()` / `RelayLeaseManager.acquire()`；注册 CLI 子命令/设置开关属于
   共享桶（见「集成与共享桶申请」），未落地前无任何隐式启动面。
2. **仅回环**：服务端硬编码绑定 `127.0.0.1`，不提供任何绑定改址选项——能到达该端口的
   任何进程都能驱动用户已登录浏览器，这是能力边界本身。
3. **token 鉴权**：`/ext` 可配置共享密钥（`?token=`）。token 不入日志：日志调用面
   （`log(message, data)`）禁止携带 token，错误信息不含 token，服务器不打印启动参数；
   扩展侧 token 存 `chrome.storage.local`，不随 hello 上报。未配置 token 时仅靠回环
   边界（与 omp 行为一致，spec 明示残余风险）。
4. **Origin 双检**：`/cdp` 拒绝一切带 Origin 的升级（浏览器页面无法驱动）；`/ext` 仅
   接受 `chrome-extension://` 或无 Origin。
5. **标签组可见性**：被驱动的标签始终处于用户可见的「ACode」标签组中，用户随时知道
   哪些标签在被驱动；释放/断连即解散；用户拖出即永久退出分组。
6. **扩展权限最小化**：`permissions` 仅 `debugger`、`tabs`、`tabGroups`、`storage`、
   `alarms`（五个各自用途：debugger=核心挂载；tabs=标签 RPC 与生命周期事件；
   tabGroups=分组可见性；storage=instanceId 与端口/token 设置；alarms=service worker
   回收后重拨）。**无 host_permissions、无 scripting、无 activeTab、无 webRequest**；
   扩展不注入任何页面脚本，不做任何 relay 未指示的操作。
7. **护栏**：`Browser.close` 拒绝执行；pinned 标签不被分组；`chrome:*` 系页面不可挂载
   亦不可见；扩展仅拨出（MV3 service worker 不能监听端口），不开放任何入站面。
8. **失败关闭**：解析不了的扩展消息丢弃；未知 session id 报错不猜测路由；帧超限
   （64 MiB，覆盖 base64 截图）关闭连接（1009）；协议版本不匹配的实例不参与发现。

## 集成与共享桶申请

- **当前可用集成（本 wave 已交付）**：relay 服务端 + 扩展源码入仓
  （`browser-use-plugin/relay-extension/`，Chrome `chrome://extensions` → 开发者模式 →
  加载已解压）。任何 puppeteer 系客户端用 `browserURL http://127.0.0.1:9224` 或
  `agent-browser --cdp 9224` 直连 relay，即可驱动用户日常 Chrome 标签。技能文档
  （`.agents/skills/agent-browser/SKILL.md`）补充该路径与安全须知。
- **共享桶申请（未实施）**：
  1. `apps/acode-cli/package.json`（CLI 入口/命令注册表）：申请注册显式启动入口
     （如 `acode browser relay` 子命令或 dev 脚本），替代「调用方手写几行启动代码」，
     并承载 `--token`/`--no-group`/`--port` 旗标。
  2. `packages/browser-use-plugin/package.json`（插件依赖/入口清单）：若 relay 服务端
     需要成为插件可执行产物（`scripts/relay-server.mjs` 由 build.mjs 二次 esbuild
     打包），申请在该 package.json 登记（当前实现放 `src/relay/`，类型检查经插件自身
     tsc，运行入口可由消费方直接 import 源内模块，暂不需要新依赖登记）。
  3. core `daemon broker`（未来）：omp 用全局守护 broker 按租约跨进程保活 relay；
     ACode wave 1 的租约是**进程内**的——relay 活在首个消费者所在进程里，该进程退出
     relay 即停（扩展自动重连下一个启动 relay 的进程）。跨进程 broker 属架构级新面，
     另行立项，不在本 wave 边界内。
- **新依赖申请：零**。WS 服务端为 ~200 行自实现 RFC6455 子集（文本帧、分片重组、
  ping/pong/close、掩码校验、64MiB 上限），仅服务本回环受控面；客户端一律用现成
  WebSocket（扩展用 SW 原生、测试用 Node 24 全局）。不引入 `ws`。

## 验收场景（均已按桩/回环实测）

- A1 whileDrawing 时序：桩 CDP 会话断言 `startScreencast → capture → stopScreencast →
  detach` 严格顺序；capture 抛错仍清理；降级（startScreencast 拒绝）照常捕获。
- A2 whileDrawing 中止：先中止再调用抛 AbortError 且不开 screencast。
- A3 discovery 合成：扩展 hello 前 `/json/version` 503（`extensionSeen:false`）；hello 后
  200 且 `webSocketDebuggerUrl` 指向 `/cdp`；`/json/list` 返回 hello 里的可挂载标签、
  隐藏 `chrome:*` 页。
- A4 Target 多路复用：两个下游连接各自 `Target.setDiscoverTargets` 收到成对
  tab/page `targetCreated`；`Target.setAutoAttach` 各自收到独立 minted 会话；`Runtime.
  enable` 后共享根 `executionContextCreated` 重放 + 后续事件双路分发且 sessionId 各归
  各；`Runtime.evaluate` 命令转发到扩展 RPC；token 错误 401；`/cdp` 带 Origin 403。
- A5 租约计数：首个 acquire 启动服务端、重复 acquire 共享同一实例（不重复 bind）、
  release 归零停止、release 与在途 acquire 交叠不复活、多 port 键控互不影响。

## 已知限制（如实声明）

- **真实 Chrome E2E 未跑**（本环境无 Chrome 显示面）：扩展↔relay 全链路、Chrome 调试
  信息条交互、tabGroups 实际分组/解散、service worker 回收重拨，均未在真实浏览器验证；
  协议层用「假扩展 WS + 真下游 WS」回环桩覆盖（A3/A4）。
- **原位标签的组可见性依赖客户端认领**：omp 通过自家 patch 过的客户端发送
  `OMP.claimTarget`；ACode wave 1 的消费者是未打补丁的通用 puppeteer 客户端，只有
  `Target.createTarget` 创建的标签必然入组，原位接管的标签在客户端显式发送
  `ACODE.claimTarget` 前不入组（Chrome 原生调试信息条仍可见）。后续若做插件侧
  browser 面集成，把认领写入 ACode 自己的客户端即可闭合此缺口。
- 租约为进程内语义（见上），无跨进程保活；多 CLI 进程并发消费时，后来者若首占端口会
  得到「端口被占」错误（omp 由 broker 化解，ACode 待共享桶申请）。
- `agent-browser`（外部 npm 工具）对 `/cdp` 的实际兼容性未验证（其 `--cdp` 走标准
  discovery，理论兼容）。
- 分片 WebSocket 帧、超 64MiB 消息、二进制 CDP 载荷（base64 截图走文本）未单测，
  实现为防御式关闭而非静默损坏。
