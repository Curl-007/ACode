# ACode：桌面平台 IPC 注册工厂（PlatformChannels 注册包装层）

## 背景与目标

来源：第三轮 E1 快赢批 T1-15（价值提取第二轮 T1-e2 eipc 类型化 IPC 工厂契约 +
T2-s8 ipc-codegen 桥范式，台账 §2-11「唯一 T1 级无处置项」）。上游形态是 52 桥 /
1,417 方法全经一个工厂，注册时声明逐参数校验器 + origin 门控（顶层帧 + origin
allowlist）+ 注册前 removeHandler 幂等重注册 + per-window dispatcher（WeakMap 按
窗口句柄隔离）。

ACode 现状差距：`PlatformChannels`（`packages/shared/src/channels.ts`）只钉通道名与
request/response 类型映射；main 侧 ~105 处 `ipcMain.handle/on` 分散约 20 个域文件，
载荷校验 per-handler 手写（部分域完全没有），sender 检查只有个别域自建
（`desktopNetworkCaptureIpc` 的 RM 窗口比对、`rendererFrameTrust` 的两条 send-only
通道），无统一的顶层帧/身份门控。当前 renderer 全本地加载，风险低；embedded
browser / 远程 renderer 面扩展时「sender 无 origin/顶层帧门控」会变成真缺口。

本 spec 定义**注册工厂**：不重做通道面（PlatformChannels/PlatformChannelMap 仍是
唯一通道词表，本工厂只读引用），把「注册时声明校验器 + sender 门控 + 幂等重注册 +
per-window dispatcher」做成 PlatformChannels 的注册包装层。**新增平台 IPC 注册必须
过工厂；存量渐进迁移**（批次见「迁移边界」）。

实现落点：`packages/desktop/src/main/platformIpcRegistry.ts`（注册工厂核心：注册即
声明 / sender 门控 / 幂等重注册 / 失败语义）+ `packages/desktop/src/main/
platformIpcPerWindowDispatcher.ts`（per-window dispatcher，R5.2；因 max-file-lines
400 行门禁拆出的姊妹模块，只依赖 electron 类型面，API 经 registry 入口 re-export，
调用面保持单一入口）。

## 机制规则

### R1 注册即声明（类型 + 运行时双面）

1. 通道名以 `keyof PlatformChannelMap` 类型约束——不在 shared 通道映射表里的通道
   无法过工厂注册（需要新通道时先改 `packages/shared/src/channels.ts`，保持词表
   单一来源）。
2. request 类型非 `void` 的通道，注册对象**必须**声明 `validate`（类型层强制）；
   `void` 通道可省略。校验器是结构化接口 `PlatformIpcValidator<T>`
   （`safeParse(input: unknown)`），与 zod schema 结构兼容——工厂不绑定 zod 具体
   实现，各域继续用自己的 zod schema。
3. 注册对象**必须**声明 `sender` 门控策略（无隐式缺省，防止「忘写=不设防」）。
4. 可选 `validateResponse`：声明后对 handler 返回值做运行时校验，失败按
   `invalid_response` fail-closed（main 侧 bug 信号，不放行脏数据）。

### R2 sender 门控策略（闭集 + 显式扩展点）

- `"app-renderer"`（标准 renderer 面）：`isTrustedRendererSenderFrame(event.senderFrame)`
  （复用 `rendererFrameTrust.ts` 既有判定：顶层帧 + file:/本机 dev origin；帧判定
  的唯一所有者是该模块，工厂不复制逻辑）**且** `BrowserWindow.fromWebContents(event.sender)`
  解析出未销毁窗口（身份解析）。二者任一不满足 → 拒绝。
- `"trusted-frame"`：只要求受信顶层帧，不要求解析出 BrowserWindow（无窗辅助面；
  注册处必须注释说明理由）。
- `{ predicate }`：自定义门控（如资源管理器窗口比对）。返回 `true` 放行；返回
  字符串 = 拒绝原因（仅进 main 日志，且必须匹配 `^[a-z0-9_]{1,64}$`，否则按
  `custom_denied` 收敛——日志不回显任意字符串）；predicate 抛错按拒绝处理
  （fail-closed，原因 `predicate_error`）。
- 不引入 origin allowlist 配置面：当前 renderer 全本地加载，`rendererFrameTrust`
  的本机 hostname 闭集已覆盖 dev/打包两态；remote renderer 面立项时经 predicate
  或新增策略扩展，不改调用面。

### R3 幂等重注册（显式语义）

- 模块级 `activeRegistrations: Map<channel, {kind, listener}>` 是「哪个注册在该通道
  上活跃」的唯一事实来源；`ipcMain` 是执行面。
- 重复注册同一通道 = **替换**：handle 先 `ipcMain.removeHandler(channel)`，on 先
  `removeListener(channel, 旧listener)`，再挂新注册；最后注册者胜，记一条 info。
  Electron 原生 `ipcMain.handle` 重复注册会抛错、`ipcMain.on` 会静默叠加监听器——
  两种事故形态都被替换语义收口。
- 迁移期纪律：同一通道不允许「工厂 + 直接 ipcMain」两条注册路径并存（直接注册的
  handle 会被工厂替换掉；直接注册的 on 监听器工厂无引用、无法摘除）。
- `registry.dispose()` 摘除该 registry 实例名下全部仍活跃的注册（窗口/域关闭与
  测试复位用）。

### R4 失败语义（错误码闭集）

错误码闭集：`invalid_payload` / `invalid_response` / `forbidden`（+ 日志侧原因词
`untrusted_frame` / `no_window` / `no_sender_frame` / `custom_denied` /
`predicate_error`）。`PlatformIpcError.message` 只含 `[platform-ipc] <code>: <channel>`
——**renderer 可见面只有闭集词表**，拒绝原因细节只进 main 日志（与 contentBreadcrumb
「warn 不回显帧 URL」同一日志纪律）。

- handle 通道：sender 拒绝 / 载荷校验失败 → invoke reject（`PlatformIpcError`）；
  声明了 `onInvalidPayload(context)` 的通道，载荷校验失败改为返回该信封值（保留
  存量 `{success:false,error:"invalid_payload"}` 类 renderer 契约，迁移不改行为）。
  sender 拒绝**不允许**被 `onInvalidPayload` 覆盖——伪造 sender 永远 reject。
- on 通道：任何失败 = 丢弃 + warn（send-only 无应答面）。
- 日志纪律：校验失败只记 zod issue 的 `code` + `path`（截断 8 条 / path 120 字符），
  **不记原始载荷值**；sender 拒绝记 channel + 原因词 + `event.sender.id`。

### R5 handler 上下文与 per-window dispatcher

1. handler 签名 `(context, payload)`：`context = { event, window }`，`window` 是
   sender 解析出的 `BrowserWindow | null`（`"app-renderer"` 策略下必非 null）。
2. `createPerWindowDispatcher<T>({ create, dispose? })`：`WeakMap<BrowserWindow, T>`
   隔离的 per-window 状态分发器；首次 `forWindow(window)` 创建并挂 `closed` 监听
   （关窗即 dispose + 出表，WeakMap 不阻 GC）；`disposeWindow` 供显式拆除。
   上游 eipc 的「dispatcher 按窗口句柄 WeakMap 隔离」即此形态；需要 per-window
   状态的域在 handler 内经 `context.window` 取用，工厂不强制。
3. 同步段计时（W1-6）在工厂内部统一包 `wrapIpcHandle(deriveIpcSyncLabel(channel))`
   ——注册处不再手写包装，计时归因面单一所有者不变。

## 所有权

| 事实 | 唯一所有者 |
| --- | --- |
| 通道名词表 + request/response 类型映射 | `packages/shared/src/channels.ts`（工厂只读） |
| 帧受信判定（顶层帧 + 本地 origin） | `rendererFrameTrust.ts`（工厂复用，不复制） |
| 「哪个注册在通道上活跃」 | `platformIpcRegistry.ts` 模块级 activeRegistrations |
| IPC 同步段计时归因 | `ipcSyncTiming.ts`（工厂内部接线） |
| 各域业务语义 / 校验 schema / 自定义 sender predicate | 各域 registrar 文件 |

## 不变量

1. 一个通道至多一个活跃注册（handle 与 on 互斥，后来者替换）。
2. 过工厂注册的载荷必过声明的校验器才会到达 handler；handler 收到的 payload 类型
   = `PlatformChannelMap[C]["request"]`。
3. sender 门控失败的请求必不触达 handler（handle reject / on 丢弃）。
4. 工厂注册的每个 handle 通道都在同步计时归因面上（label = channel 派生）。
5. renderer 可见错误面只有闭集词表（code + channel 名），无内部路径/URL/载荷回显。

## 迁移边界（存量渐进，不强行一波迁完）

样板（本批已迁）：`desktopSitePermissionIpc.ts` 全部 4 处注册过工厂——具备代表性
（handle×3 + on×1、zod 校验、信封契约经 `onInvalidPayload` 原样保留），且全部通道
已在 PlatformChannelMap。迁移后行为差异只有两处**加固**：新增 sender 门控
（`"app-renderer"`，合法调用方均为应用 renderer 窗口，不受影响）；无效载荷日志不再
回显原始 payload（改记 issue path/code）。

后续批次（各域下次被触碰时顺手迁移，或按批立项；每批独立可验收）：

- 批 2（小体量自足 registrar）：`desktopNetworkCaptureIpc`（RM 窗口比对改
  predicate 形态）、`desktopWorkflowArtifactIpc`、`desktopSaveFile`、
  `desktopPrintToPdf`、`desktopCuaPipIpc`、`databaseStartupRelay`、
  `resourceManagerStorage`。
- 批 3（已有帧门控/send-only 域）：`contentBreadcrumb`、`editableFocusTracker`、
  `findInPageMain`、`autoUpdater`、`desktopCuaPermissionIpc`、`ipcSyncTiming` 直连
  残留点。
- 批 4（浏览器面）：`desktopBrowserViewIpc`、`desktopBrowserDataIpc`、
  `desktopSitePermissionIpc` 的 controller 侧联动（如有）。
- 批 5（集中装配大文件，最后）：`desktopMainIpcPlatform`（~40 处）、
  `desktopMainIpcRemote`（~16 处）、`index.ts`（2 处）。迁移前先盘点其中不在
  PlatformChannelMap 的通道，需要补映射的走 shared 包变更（跨包，单独接线）。

判据：新增注册不过工厂 = review 拒绝项；存量文件出现行为改动（修 bug/加通道）时
同 PR 迁移该文件的注册。

## 不采纳（上游对照，登记）

- **store 三件套**（getState/getStateSync/update 主→渲染推送）：ACode 由广播 +
  Zustand 覆盖，AGENTS.md 已有回环纪律，不抄。
- **家族 UUID = 构建期契约版本 + 跨代面才运行时协商**：分层结论成立（SPA renderer
  与 main 恒同构建，无协商必要；跨代进程面已由 v4 `V4_WIRE_PROTOCOL_VERSION` +
  capability 闭集查询覆盖）。该结论进 protocol v4 与 desktop IPC 边界文档一事，
  列越域请求由编排者接线。
- **返回值三面全校验**：仅保留 opt-in `validateResponse`，不默认全量（成本/收益
  不匹配，类型面已保证大部分）。
- **同步 ipcRenderer.sendSync 模态**：上游四模态之一，ACode 平台面无此形态，不做。

## 验收场景

1. 合法 renderer 窗口 invoke 已注册通道、载荷合法 → handler 收到类型化 payload 与
   解析窗口，响应原样返回。
2. 载荷校验失败（handle）→ 默认 invoke reject，错误消息含 `invalid_payload` 与
   通道名；声明 `onInvalidPayload` 的通道返回信封值（存量契约保留）。
3. 伪造 sender（子帧 / 远程 origin / 无窗 webContents 走 `"app-renderer"`）→
   handle reject `forbidden`、on 丢弃，均不触达 handler，warn 日志含原因词且不含
   帧 URL / 载荷值。
4. 同通道重复注册不抛错不叠加：handle 替换后旧 handler 不再被调用；on 替换后一次
   send 只触达新监听器一次。
5. `validateResponse` 声明且返回脏数据 → reject `invalid_response` + error 日志。
6. per-window dispatcher：同窗口同实例、异窗口异实例、窗口 closed 后 dispose 且
   再取为新实例。
7. 样板域（站点权限）迁移后既有测试全绿；`registry.dispose()` 摘除本实例注册。
