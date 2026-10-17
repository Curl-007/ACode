# Boot Placeholder：上次会话布局骨架首帧直绘

状态：已实现（机制面），接线待落地（见 §9）。
需求源：`ACode-价值提取-Claude-2.37337-第二轮.md` T2-s3。
原版证据（还原工程 `Claude-2.37337/`，只读复核）：

- `src/beautified/main/mainWindow.js:4518-4603`（preload）：解析 `--desktop-boot-placeholder=` argv、
  校验（数值 0..1e4、shapes ≤160）、`contextBridge.exposeInMainWorld("desktopBootPlaceholder",
{ enabled, frame, shellZoomFactor: webFrame.getZoomFactor() })`。
- `src/beautified/main/index.chunk-CHpJbW9_.js:137261-137360`（main）：flag 前缀、paint 函数源串、
  校验器（`IL/fKn`）、手工合成默认骨架（`pKn`）、延迟持久化键 `bootFrameLayout`/`bootSidebarPlaceholder`、
  payload 构造（`TKn/EKn`，仅 signedIn 时带 frame）、did-finish-load 后 `executeJavaScript` sync 重放（`LL/DKn`）。
- `:141113-141131`：drag strip 切换（did-navigate 开 / dom-ready 关）。
- `:284183`：`additionalArguments: [xK(), EKn({ signedIn: c })]`（窗口创建注入点）。
- `:226533-226537`：renderer 经 window-service RPC `reportFrameLayout/reportSidebarPlaceholder` 上报，
  main 记住并立刻 sync 重放。
- `src/beautified/renderer-shell/main_window/index.html:16-89,196-269`：head/body 两相位无框架内联脚本、
  首帧 CSS（sidebar strip + rows + drag strip）、`data-boot-placeholder*` 属性驱动显隐。

## 1. 产品规则

1. 桌面主窗启动时，在 React/样式表加载完成前，用**上次会话的真实布局骨架**（侧栏 + 主要分区的
   矩形剪影）直绘首帧，替代「通用 loading 遮罩后面一片空白」的观感。
2. **恒启用判定**：原版仅登录态启用（claude.ai 壳无登录即无内容可预示）。ACode 桌面启动流程
   （`src/renderer/src/main.tsx`：database startup → `enterAppIfPrepared` → React App）没有任何
   登录墙；`WorkspaceShellLayout` 的 `user/onLogin` 只服务官方账号入口，不阻塞 shell 渲染。
   因此 ACode **不做登录态门控，恒启用**，唯一开关是桌面设置（§4）。
3. 无持久骨架数据（首装/清档）时使用**手工合成默认骨架**（§6），不显示空白。
4. 骨架必须与现有 `#loading` 遮罩协调：`#loading`（z-index 2147483647，含 `[app-region:drag]`）
   继续盖在骨架上负责品牌动画与窗口拖拽；骨架 z-index 低于它、`pointer-events:none`。
   `body.acode-startup-ready` 置位时骨架立即隐藏（CSS display:none），并随 `#loading` 一起在
   500ms 清理定时器里从 DOM 移除——不引入第二套移除时序，不做双遮罩淡出竞争。
5. 更新状态窗（`?windowKind=update-status`）复用同一 index.html，但其 `additionalArguments`
   不含占位 flag → payload 缺失 → head 相位直接 no-op（fail-safe）。
6. Web/手机端不受影响：机制全部在 desktop 包与 index.html 内联脚本中，ui 侧采样器只在桌面接线上启用。

## 2. 数据契约（唯一形状定义，main/preload/renderer 三方共享语义）

```ts
/** 单个骨架矩形：视口归一化比值。top/left/width/height 相对 innerWidth/innerHeight，
 *  radius 相对 min(innerWidth, innerHeight)。全部有限数且 0..1e4（沿用原版值域校验）。 */
type BootPlaceholderShape = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
};

type BootPlaceholderFrame = {
  shapes: BootPlaceholderShape[]; // ≤160（BOOT_PLACEHOLDER_MAX_SHAPES）
  sidebarWidth: number; // 侧栏宽 / 视口宽（0..1；collapsed 时为 0）
  collapsed: boolean; // 上次会话侧栏是否收起
  zoomFactor: number; // 采样时页面 zoom（>0 有限；溯源与契约对齐用，见 §5）
};

/** additionalArguments 注入体（--acode-boot-placeholder=<JSON>）。 */
type BootPlaceholderPayload = { enabled: boolean; frame?: BootPlaceholderFrame };

/** preload 暴露给页面的最终形态（globalThis.__ACODE_BOOT_PLACEHOLDER__）。 */
type BootPlaceholderExposed = BootPlaceholderPayload & { shellZoomFactor?: number };
```

校验规则（与原版 `hc/gc` 同构，任何一处校验失败即 fail-safe）：

- shape 条目非对象或任一值非法 → 整个 `shapes` 判无效（置 `[]`），frame 其余字段仍可成立；
- `sidebarWidth` 非法 / `collapsed` 非 boolean / `zoomFactor` 非有限正数 → 整个 frame 无效；
- frame 无效 → 回退手工合成默认骨架；
- argv JSON 解析失败 / `enabled !== true` → 不启用（head 相位 no-op）。

## 3. 状态所有权与事件顺序

| 状态                 | 所有者                                       | 说明                                                                               |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 骨架采样             | renderer（`packages/ui` 采样器）             | 只读 DOM + zoom，产出 frame；防抖后持久化                                          |
| 骨架持久化           | setting.json（AppSettings，services 写队列） | 键 `desktopBootPlaceholder`；main 只读                                             |
| 启用开关             | setting.json（AppSettings）                  | 键 `bootPlaceholderEnabled`；缺省 = 启用；main 只读                                |
| boot 期 payload 缓存 | main（index.ts 模块态，接线维护）            | bootstrap 读设置一次；SyncAppSettings 到达时可刷新（与 closeToTrayOnWindows 同款） |
| 首帧绘制/移除        | renderer index.html 内联脚本                 | head/body/sync 三相位；`acode-startup-ready` 移除                                  |

```
ui 采样器(防抖2s) ──persist──▶ setting.json ──bootstrap 读──▶ main payload 缓存
                                                              │
main createWindow ◀── additionalArguments: --acode-boot-placeholder=JSON
      │
      ▼
preload 解析+校验 ──contextBridge──▶ globalThis.__ACODE_BOOT_PLACEHOLDER__
      │
      ▼
index.html head 相位(属性+CSS变量+主题) ─▶ 首帧可见(骨架+sidebar strip)
      │
body 相位(paint shapes 进 #acode-boot-placeholder-shapes)
      │
did-finish-load ──▶ main attach：executeJavaScript(paint, "sync")
      │             （zoom 重放已settled 后按最新 innerWidth/Height 重绘）
      ▼
React commit ──▶ window "acode-react-startup-ready"
      │
index.html 启动脚本：动画完成 && react ready ──▶ body.acode-startup-ready
      ├─▶ CSS: #acode-boot-placeholder display:none（立即）
      └─▶ 500ms 后 #loading 与骨架节点一并 remove()
```

幂等边界：sync 相位发现 `body.acode-startup-ready` 已置位时清属性退出（不得复活骨架）；
paint 函数全程 try/catch，任何异常静默放弃（首帧脚本不允许抛错阻塞解析）。

## 4. 设置开关

- 新 AppSettings 键 `bootPlaceholderEnabled?: boolean`（undefined = 启用）。main 侧
  `resolveBootPlaceholderPayload` 只读该值；设置 UI 开关为接线需求（§9）。
- 关闭时 payload 为 `{enabled:false}`（不带 frame），head 相位 no-op，行为完全回到现状。

## 5. 几何归一化与 zoom 对齐（与原版的刻意差异）

原版 shapes 是**侧栏内 CSS px**，绘制时乘 `scale = frame.zoomFactor / shellZoomFactor` 做
zoom 补偿（物理尺寸钉住上次会话）。ACode 版按任务要求改为**视口比值归一化**：

- 绘制公式 `css = ratio * innerWidth/innerHeight`（radius 乘 `min(vw,vh)`），在绘制时刻读取
  视口——Chromium 页面 zoom 改变时 `innerWidth = 窗口DIP宽 / zoomFactor`，比值绘制天然随
  zoom 自洽（物理尺寸钉住），**不需要 scale 补偿**；
- `frame.zoomFactor` 仍保留在契约内：采样溯源、payload 校验（原版同构），并为未来 px 语义扩展留位；
- `shellZoomFactor`（preload 注入）保留契约位；比值绘制不消费它；
- **sync 相位重放仍然必要**：`desktopWindowChrome.ts` 在 did-finish-load 后重放
  `setZoomFactor`（生产包 loadFile 导航后 Chromium 会重放 origin 级 zoom，覆盖创建期设置），
  head/body 相位绘制时 innerWidth 可能还是过渡 zoom 下的值；did-finish-load 后以最新视口重绘
  即「对齐 zoom」。接线必须把 attach 注册在 createWindow 内部既有 did-finish-load zoom 重放
  **之后**（createWindowInstance 里 createWindow 返回后调用即满足：同事件按注册序执行）。

## 6. 手工合成默认骨架

无持久数据时按 ACode 默认布局合成（参考视口 1200×800、默认侧栏 264px，换算成比值）：
侧栏 4 行「图标+标题」剪影 + 1 条分组头 + 5 行会话条目（点+条），主区 header 条、会话大块、
composer 条。合成结果必须通过 §2 校验（测试守护）。布局母题对齐原版 `pKn`，密度对齐 ACode 侧栏。

## 7. renderer 首帧绘制（index.html）

- **CSP 取舍（红线核查结论）**：现有 `script-src` 已含 `'unsafe-inline'`（index.html:25，
  为启动动画 module script 与 dev 态 Vite 注入放行；`desktop-hardening.test.mjs:221` 守护该面）。
  本特性的 head/body 内联**经典脚本**直接被现有策略覆盖：零 CSP 改动、零放松，不需要 hash/nonce。
- head 相位：`enabled===true` 时在 `<html>` 置 `data-acode-boot-placeholder`、按 localStorage
  `acode-theme`（原始字符串，缺省 zai-dark → dark，"system" → prefers-color-scheme）置
  `data-acode-boot-theme`，计算 collapsed、写 `--acode-boot-placeholder-sidebar-width`；
- body 相位：静态节点 `#acode-boot-placeholder`（含 `#acode-boot-placeholder-sidebar` 与
  `#acode-boot-placeholder-shapes`）位于 `#root` 之前，紧随其后的内联脚本 paint shapes；
- 颜色一律 `var(--color-*, <硬编码回退>)`：首帧样式表未加载时走回退（zai-dark #161616 /
  zai-light #f8f8f8 系），样式表加载后 sync 重放自动升级为真实 token；
- **drag strip 不移植**：原版 shell 无全屏拖拽面才需要 `data-boot-placeholder-drag`；ACode
  `#loading` 自带 `[app-region:drag]` 全屏覆盖，骨架 `pointer-events:none`，无双拖拽区冲突；
- paint 函数源在 index.html（两份内联拷贝）与 `bootPlaceholder.ts`
  （`BOOT_PLACEHOLDER_PAINT_SOURCE`，供 executeJavaScript 复用）间**逐字一致**，
  由 `tests/boot-placeholder.test.mjs` 用标记注释抽取比对，防漂移。

## 8. ui 侧采样器（packages/ui/src/app-shell/bootSkeletonSampler.ts）

- 采样门控：`[data-workspace-shell="true"]` 不存在（Welcome/设置页/更新窗）→ 返回 null，
  **不覆盖**上次持久化的好数据；
- 采样源（全部为仓库已验证的稳定 DOM 标记）：`#sidebar`（宽度/collapsed，收起阈值 8px）、
  `[data-testid="workspace-list"] > li`（≤20 行）、`[data-testid="workspace-header"]`、
  `[data-workspace-conversation-frame="true"]`、`[data-workspace-terminal-frame="true"]`、
  `[data-side-pane-tab-id]`（隐藏面板 rect 为 0 被最小尺寸过滤自然剔除）；
- 过滤/归一化：CSS px < 2 或完全出视口的 rect 丢弃；坐标 clamp 到 [0,1]；比值四舍五入 5 位；
  radius 按选择器提示 px 值归一；总数硬顶 160；
- 延迟持久化：触发源（初始延迟、resize、visibilitychange、60s 兜底轮询、shell/sidebar
  属性 MutationObserver）→ 2s 防抖 → 采样 → 与上次持久化内容（不含 sampledAt）序列化比对，
  变化才写；写入经注入的 `persist` 回调（现有设置通道，见 §9），失败经 `onError` 告警不重试风暴；
- zoomFactor 经注入的 `readZoomFactor()`（接线用 `platform.getDesktopZoomLevel` /
  `onDesktopZoomLevelChanged` 维持现值；`1.1^level` 与 main `resolveDesktopZoomFactorForLevel` 同式）。

## 9. 接线需求（所有权外，报告给协调者）

1. **packages/shared**：`AppSettings` 增 `desktopBootPlaceholder?: { shapes; sidebarWidth;
collapsed; zoomFactor; sampledAt }` 与 `bootPlaceholderEnabled?: boolean`
   （protocol.ts + validationAppSettings.ts 的 appSettingsObjectSchema/appSettingsPatchSchema，
   建议配 sanitizeDesktopBootPlaceholder 坏值单键丢弃，参照 sanitizeDesktopWindowSize）。
   持久化通道复用现有 `PlatformChannels.SyncAppSettings`（"acode:sync-app-settings"）与
   settingService.update，**不新增 IPC 通道常量**。
2. **packages/desktop/src/main/desktopWindowChrome.ts** `createWindow`（~:601）：
   `additionalArguments` 追加接线方传入的 `options.bootPlaceholderArgument`（由
   `buildBootPlaceholderArgument(resolveBootPlaceholderPayload(...))` 生成）。
3. **packages/desktop/src/main/index.ts**：bootstrap 读设置处（~:1871，currentDesktopZoomLevel
   旁）缓存 `desktopBootPlaceholder`/`bootPlaceholderEnabled` 到模块态；`createWindowInstance`
   传入 argument，并在 `createWindow(...)` 返回后调用
   `attachBootPlaceholderWindow({ webContents: win.webContents, resolvePayload, logger })`
   （保证 did-finish-load 监听注册在既有 zoom 重放之后）；SyncAppSettings 消费面
   （syncImmediateAppSettings）可选刷新缓存。
4. **packages/desktop/src/preload/index.ts**：仿 `--device-id` 模式（:9-20）解析
   `--acode-boot-placeholder=`，用 `../main/bootPlaceholder.js` 导出的
   `parseBootPlaceholderArgv`（该文件零 electron 运行时导入，可安全被 preload bundle），
   `contextBridge.exposeInMainWorld("__ACODE_BOOT_PLACEHOLDER__", { ...parsed,
shellZoomFactor: webFrame.getZoomFactor() })`——必须在任何页面脚本前暴露（同 device-id 位置）。
5. **packages/ui 接线**：WorkspaceShellLayout（或 App 桌面分支）挂载后调用
   `startBootSkeletonReporting({ persist, readZoomFactor, onError })`；persist 建议
   `settingService.update({ desktopBootPlaceholder })` + `platform.syncAppSettings(同 patch)`
   （useSettings().update 同款双写）；卸载时 dispose。
6. **设置页**：`bootPlaceholderEnabled` 开关（桌面设置面，缺省开）。

## 10. 验收场景

1. 有持久骨架：冷启动首帧（React 前）即出现侧栏 strip + 骨架矩形，主题与上次会话一致；
   startup-ready 后骨架与 #loading 一并消失，无双遮罩闪烁。
2. 无持久骨架：首帧显示合成默认骨架，仍满足场景 1 的消失时序。
3. `bootPlaceholderEnabled=false` 或 payload 缺失/损坏（非法 JSON、超界值）：head 相位 no-op，
   启动表现与现状完全一致（fail-safe，不抛错、不白屏）。
4. update-status 窗：不绘制骨架。
5. zoom 变更（设置档位改动后重启）：did-finish-load sync 重放后骨架与最终 zoom 的视口对齐。
6. 采样器：非 workspace shell 页面不写库；布局无变化不重复写；变化后 ≤2s 防抖落盘一次；
   shapes 恒 ≤160 且每值 0..1e4。
7. CSP：index.html 的 CSP meta 与改动前逐字一致（desktop-hardening 既有测试守护）。
8. paint 源一致性：index.html 两份内联拷贝与 main 常量逐字一致（测试守护）。
