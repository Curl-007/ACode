# Electron 加固（安全加固 P2 #2 / #3 / #9）

- 状态：已实施（P2 第二批，分支 `feature/p2-hardening-batch2`）
- 范围：`packages/desktop` 桌面壳进程。计划原文见 `docs/security-hardening-plan.md` P2 第 2、3、9 项。
- 关联文档：`docs/security-hardening-handoff.md`（P0/P1 既有结论）、`docs/security-hardening-plan.md` P2。

本 spec 是行为变更的前置事实与规则来源。所有安全相关判断（协议白名单、权限矩阵、fuse 取值）以本文为准；实现里的中文注释引用本文小节。

---

## 1. 主特权窗导航与弹窗守卫（P2 #2a）

### 现状

`desktopWindowChrome.ts` 只在内嵌浏览器 webview guest（`did-attach-webview` → `attachEmbeddedBrowserWindowOpenHandler`）上有 `setWindowOpenHandler` / `will-navigate`；主窗自身 `webContents` 完全没有导航守卫。主窗是特权窗：持有 `window.acode` IPC 桥、`webviewTag`，被诱导导航到外部站点意味着整个 renderer 连同 IPC 面一起被换页。

### 规则

状态所有者：main 进程（`win.webContents` 事件），renderer 无裁决权。判定逻辑抽成纯函数（`desktopWebContentsGuard.ts`），Electron 接线层只消费判定结果。

`resolveMainWindowNavigationAction(currentUrl, targetUrl)`：

| current | target | 动作 |
| --- | --- | --- |
| 任意 | 解析失败 / 非 http:、https:、file: | `block`（含 acode: 深链——深链由 second-instance/协议处理链路接收，不从主帧导航进入） |
| file:（打包态页面） | file: | `allow`（应用自身页面间导航/带 query 重载） |
| http(s)（dev vite / login） | 同 origin http(s) | `allow`（dev HMR、login.html、带 query 的自导航） |
| 任意 | 其它 http(s) | `open-external`：阻止主帧导航，交给系统浏览器（`shell.openExternal`） |
| 非 file: | file: | `block`（dev 态下 file: 不是应用页面，视同越界） |

`resolveMainWindowWindowOpenAction(url)`：主窗一律 `action: "deny"`，不创建任何 `window.open` 窗口（全仓 renderer/UI 无 `window.open` 调用方）；url 为 http/https 时附带 `shell.openExternal` 兜底，其余静默 deny + 日志。辅助窗（resource-manager、cua-permission-panel、about、recorder）不经 `createBrowserWindow` 的这段逻辑，或自身已有 CSP/静态内容，不在本规则内。

初始 `loadWindow`（loadURL/loadFile）是编程式导航，不触发 `will-navigate`；Vite HMR 整页刷新走 `location.reload()`，同样不触发。守卫不影响启动路径。

### 验收

1. 主窗内 `location.href = "https://example.com"`：主窗不换页，系统浏览器打开该 URL。
2. 主窗内 `window.open("https://example.com")`：不产生新 BrowserWindow，系统浏览器打开。
3. dev 下 vite 热更新、窗口重建、login 页导航不受影响；打包态 `loadFile` 启动不受影响。

---

## 2. 全局权限请求策略（P2 #2b）

### 现状

全仓零 `setPermissionRequestHandler`：Electron 默认全部放行。内嵌浏览器（`<webview partition="persist:acode-embedded-browser">`，见 `packages/ui/src/browser-use/BrowserViewportSurface.tsx`）加载任意页面，恶意页可无确认拿 `media`（摄像头/麦克风）、`display-capture`、`geolocation`、`notifications` 等敏感权限。

### 挂载点（session 选择）

webview guest 的 session 由 partition 决定，共有三个需要覆盖的 session：

| session | 来源 | 内容 |
| --- | --- | --- |
| `defaultSession` | 主窗 renderer（特权页） | 应用自身 UI |
| `persist:acode-embedded-browser` | `EMBEDDED_BROWSER_PARTITION`（browserDataManager） | 内嵌浏览器，任意远程页面 |
| `persist:acode-coding-plan` | Coding Plan 官网 webview（原常量在 desktopCommandHandlers，现移至 `desktopSessionPermissionPolicy.ts` 导出，消除双份定义） | 可信但跨网的官网页 |

`installDesktopSessionPermissionPolicies(sessionProvider, logger)` 在 `app.whenReady()` 后对三者各挂一个 `setPermissionRequestHandler`（模块级幂等标记防重复安装）。临时 recorder partition（`acode-browser-video-recorder-*`）**不**覆盖：它是我们自己的录制页，已由 main 侧 `setDisplayMediaRequestHandler` 精确供流（`electronBrowserWebmRecorder.ts`），不属于不可信页面。

### 决策矩阵（`resolveDesktopPermissionRequestDecision`）

| 权限 | defaultSession | embedded-browser / coding-plan | 理由 |
| --- | --- | --- | --- |
| `fullscreen` | 允许 | 允许 | 视频全屏 UX；无持久副作用 |
| `clipboard-sanitized-write` | 允许 | 允许 | 用户手势下的剪贴板写入（受 sanitized 语义约束），复制功能依赖 |
| `pointerLock` | 拒绝 | 允许 | 应用 UI 不需要；网页（游戏/画布）保持浏览器对等体验 |
| `media`（摄像头/麦克风） | 拒绝 | 拒绝 | 应用自身无 getUserMedia 调用（全仓 grep 无命中）；内嵌浏览器自动化链路（CDP 录屏、desktopCapturer 供流）不依赖 guest 侧 media 权限。拒绝是最小面 |
| `display-capture` | 拒绝 | 拒绝 | 主窗 `getDisplayMedia`（prompt-input 截图附件）在 Electron 里没有 `setDisplayMediaRequestHandler` 供流，本就产生不了帧，拒绝不构成回归；recorder 走独立 partition 且自带 handler，不受影响 |
| `geolocation` / `notifications` / `midi` / `midiSysex` / `window-management` / `clipboard-read` / `openExternal` / `fileSystem` / `storage-access` / `top-level-storage-access` / `idle-detection` / `keyboardLock` / `speaker-selection` / `mediaKeySystem` / `unknown` 及未来新增 | 拒绝 | 拒绝 | 应用通知走 main 进程 `Notification` 模块；外部打开由 main 侧 `OpenExternal` IPC 统一裁决；其余无使用方 |

deny 决策统一落 info 日志（permission + requestingUrl），便于事后审计误伤。

### 验收

1. 内嵌浏览器打开任意 https 页面请求摄像头/麦克风/定位/通知：直接拒绝，无弹窗。
2. 内嵌浏览器视频全屏、复制文本正常。
3. 主窗 UI 剪贴板写入（`navigator.clipboard.writeText`）正常。

---

## 3. 主 renderer CSP（P2 #2c）

### 现状

辅助窗（aboutWindow、forceUpdatePrompt、windowsCuaOperationIndicator、recorder HTML）已有 `<meta http-equiv="Content-Security-Policy">`；主窗 `src/renderer/index.html` 缺失。

### 指令

```
default-src 'none';
script-src 'self' file: 'unsafe-inline';
style-src 'self' file: 'unsafe-inline';
img-src 'self' file: data: blob: acode-media: https: http:;
media-src 'self' file: data: blob: acode-media: https: http:;
font-src 'self' file: data:;
connect-src 'self' file: data: blob: ws: wss: http: https: acode-media:;
worker-src 'self' file: blob:;
frame-src http: https: 'self' file:;
object-src 'none';
base-uri 'none';
form-action 'none';
```

理由（与辅助窗 CSP 的差异均有对应事实）：

- `script-src 'unsafe-inline'`：index.html 内联启动动画 module script + dev 态 Vite/React-refresh 注入的内联脚本（辅助窗同款处理）。`'self'` 覆盖 dev vite 模块与打包产物 chunk；追加 `file:` 是因为打包态 `loadFile` 页面 origin 为 opaque，`'self'` 不匹配 file: 子资源。
- `connect-src ws:` 覆盖 dev HMR websocket；`http:/https:` 保留 renderer 已存在的远程取数面（UI 层 `fetch` 图片预览、发布说明等）；`blob:` 覆盖本地附件预览的 fetch。该指令从宽是刻意 tradeoff：脚本执行面（主威胁）已被 `script-src` 收紧，connect 面后续可用运行证据再收敛，先不因过严打断功能。
- `frame-src http: https:`：内嵌浏览器与 Coding Plan 都是 `<webview>` guest（frame-src 对 webview 生效）；guest 自身导航白名单仍由 main 侧 `will-attach-webview` / guest 守卫负责，本指令只约束宿主页。
- `media-src acode-media:`：本地音视频预览走 `LOCAL_MEDIA_PREVIEW_SCHEME = "acode-media"`（`packages/shared/src/platform.ts`）。
- `worker-src`：UI 层有 `new Worker(new URL(...))`（diffs / workspace 文件搜索 worker），Vite 构建产物为 self chunk，dev 可能经 blob。
- `object-src 'none'`、`base-uri 'none'`、`form-action 'none'`：封死插件、基址劫持与表单外送。

resource-manager.html / cua-permission-panel.html 属辅助窗，本轮不改（见「未决」）。

### 验收

1. dev（`pnpm dev:desktop`）主窗正常渲染、HMR 生效。
2. 打包态主窗正常渲染（file: 子资源可加载）——打包冒烟属发布流程验证项（见 §6）。

---

## 4. openExternal 收敛 file:（P2 #2d）

### 现状与调用方调查

`desktopMainIpcRemote.ts` 的 `isAllowedExternalOpenUrl` 允许 `http:`/`https:`/`file:`，`file:` 直接进 `shell.openExternal`。调用方调查结论：

- 绝大多数 UI 调用传 http(s)（文档、OAuth、发布说明、插件商店行）。
- `packages/ui/src/OpenSplitButton.tsx`：非 website 目标传**裸本地路径**（如 `C:\...\report.html`）。但 WHATWG URL 解析会把裸路径解析成 opaque `c:` 协议（实测 `new URL("C:\\x\\y.html").protocol === "c:"`），**不是** `file:`——即该调用方在现状下就被 allowlist 拒绝，本地文件「外部打开」是一个早已不可达的死链路，不是依赖 `file:` 放行的活场景。
- 真正依赖 `file:` 放行的是 renderer 直接构造的 `file://` URL：它们原样进 `shell.openExternal`（参数由 OS shell 解释，可打开任意文件/UNC 执行载体），是本项的实际收敛目标。另有专用通道 `OpenExternalFile`（`openPathInDefaultApp`：normalize + realpath + `shell.openPath`），是本地文件打开的既定硬化路径。

### 规则

`file:` 不再进入 `shell.openExternal`。新纯函数 `resolveLocalFileUrlTarget(value)`（`desktopMainIpcHelpers.ts`）：

1. `new URL(value)` 解析失败或协议非 `file:` → `null`（裸路径是 opaque `c:` 协议，天然落到这里，行为与现状 allowlist 一致，不放宽新能力）；
2. `url.host` 非 "" 且非 "localhost"（UNC 形态 `file://server/share`）→ `null`；
3. 否则 `fileURLToPath` 返回本地绝对路径。

IPC 层：`OpenExternal` 载荷若为 file: → 走 `resolveLocalFileUrlTarget` + `openPathInDefaultApp`（normalize + realpath + `shell.openPath`），与 `OpenExternalFile` 同一条硬化链路；转换失败一律拒绝并告警。http/https 行为不变；裸路径/自定义协议仍被 allowlist 拒绝（现状不变）。

`packages/ui` 的 OpenSplitButton 本地文件「外部打开」现状即不可达（WHATWG 解析为 `c:` 协议被拒），后续应改走 `openExternalFile` 修复该入口（越出本次文件所有权，见「未决」）；迁移完成后 file: 分支可整体删除。

### 验收

1. OpenSplitButton 对本地文件「系统默认应用打开」仍可用。
2. `shell.openExternal` 永远收不到 file: / UNC URL（单测覆盖判定函数）。

---

## 5. Electron fuse（P2 #3）

### 接线方式

electron-builder 26.8.1 原生支持 `electronFuses` 配置（`app-builder-lib` `platformPackager.js`：`doAddElectronFuses` 固定在**全部 afterPack hook 之后、签名之前**执行——"the fuses MUST be flipped right before signing"）。因此不新增 `@electron/fuses` 依赖、不写自定义 afterPack fuse 逻辑，只在 `electron-builder.config.js` 挂 `electronFuses`，取值来自新纯模块 `scripts/desktop-electron-fuses.mjs`（可被配置层测试直接断言）。

### fuse 取值与两处与计划的偏离（如实记录）

| fuse | 取值 | 说明 |
| --- | --- | --- |
| `runAsNode` | **保持 true（默认），不写 false** | **与计划的冲突**：计划要求关 RunAsNode。但打包版桌面 agent 的唯一启动方式是 `acodeAgentProcessManager.ts` `resolveElectronRuntimeACodeAgentCommand` 用 `process.execPath`（Electron 二进制）+ `ELECTRON_RUN_AS_NODE=1` 执行 `resources/glm/acode.cjs`（见 extraResources 注释：「不随包内置独立 Node 二进制」）。fuse 是二进制级开关，关掉即**打包版 agent spawn 直接失败**。替代方案（随包独立 node 二进制 / bytecode 入口，仓库已有 `acode.bytecode.cjs` 试验链）属后续工程；届时再关此 fuse |
| `enableNodeOptionsEnvironmentVariable` | **保持 true（默认），不写 false** | **与计划的冲突**：该 fuse 同时控制 `NODE_OPTIONS` 与 `NODE_EXTRA_CA_CERTS`。打包版 agent 子进程同样由这个 Electron 二进制以 RUN_AS_NODE 方式运行，而 `agentProxyEnv.buildAgentCaCertEnv` 会为 agent 注入 `NODE_EXTRA_CA_CERTS`（设置页自定义 CA、app 自签 CA 的信任链，`appCaCert.ts`）——关掉即打包版 agent 的自定义 CA 信任静默失效。`acodeAgentProcessManager` 里的 `NODE_OPTIONS` 仅 E2E 覆盖率注入（测试链路，损失可接受），但 CA 链路是生产功能。与 RunAsNode 同一根因：**agent 依赖宿主 Electron 二进制的 Node 语义**，独立 node 二进制落地后两者一并关闭 |
| `onlyLoadAppFromAsar` | **true（全平台）** | 与 asar 完整性校验组合可阻止加载未校验代码；不依赖签名，安全开关 |
| `enableEmbeddedAsarIntegrityValidation` | win32：true；darwin：仅 `ACODE_ENABLE_MAC_SIGN=1` 且有签名身份时 true；linux：false（不支持） | 见下「完整性刷新」；macOS 的 asar 完整性依赖代码签名，未签名包开启会无法启动 |
| 其余 fuse | 不写 | 保持 electron-builder 默认；`generateFuseConfig` 会过滤 undefined，避免旧版 Electron 报 fuse wire 过短 |

### 完整性刷新（EnableEmbeddedAsarIntegrityValidation 与既有 afterPack 的冲突）

electron-builder 在 `beforeCopyExtraFiles` 阶段（afterPack **之前**）计算 asar header 的 SHA256 并写入产物：Windows 写进 exe 的 `INTEGRITY/ELECTRONASAR` 资源（resedit），macOS 写进 `Info.plist` 的 `ElectronAsarIntegrity`。而本包 afterPack 既有链路会**重写 app.asar**（`injectHoistedRuntimeModulesIntoAsar` 注入运行时依赖 + `stripPackagedSourcemaps`）。若不处理，开启完整性校验的包启动即校验失败（变砖）。

对策（fail-closed）：新增 `scripts/desktop-asar-integrity-refresh.mjs`，在 afterPack 所有 asar 重写完成**之后**执行：

1. 复用 `app-builder-lib/out/asar/integrity` 的 `computeData`（与 electron-builder 同一实现）对最终产物重算 header 哈希；
2. Windows：用 resedit（经 `createRequire` 从 app-builder-lib 解析，与其自身同源）**替换**（非追加，避免重复 `ELECTRONASAR` 条目）exe 资源里的完整性条目；
3. macOS：`parsePlistFile`/`savePlistFile` 重写 `ElectronAsarIntegrity`；
4. 任一步失败 → 抛错让打包失败，不允许带着过期完整性哈希出包（对齐仓库「无法保证收容即拒绝启动」不变量）。

签名在 fuse flip 之后进行（electron-builder 内建顺序），刷新动作不会破坏签名链。

### 验证边界

fuse 效果（含完整性校验、RUN_AS_NODE 行为）无法在不打包的本地环境验证。本批提供配置层测试（`tests/desktop-hardening.test.mjs`）：断言 fuse 解析函数在各平台矩阵下的取值、冲突 fuse 的文档化偏离；打包冒烟（安装包能启动、agent 能 spawn、篡改 asar 能被拒）属发布流程验证项，见「未决」。

---

## 6. Chrome 提权解密门（P2 #9）

### 现状

`desktopBrowserDataIpc.ts` 把 renderer IPC 载荷里的 `allowElevatedChromeDecryption` 原样传给 `importChromeBrowserData` → `chromeCookieManager.collectCookieDetails`（Windows v20 App-Bound 解密分支）。renderer 被攻陷即可无 main 进程二次确认触发 App-Bound/DPAPI 提权解密。事实补充：当前 UI（`BrowserSettingsSection.handleImport`）调用 `platform.importChromeBrowserData()` 时**从不传该字段**，提权路径自功能加入以来实际不可达——收权不构成 UX 回归。

### 规则（main 侧持有门 + 载荷不信任）

`desktopBrowserDataIpc.ts`：

1. **一律忽略**载荷中的 `allowElevatedChromeDecryption`（字段留在 shared 类型里仅供类型兼容，main 不读）。
2. 提权授权由 main 进程判定，纯函数 `resolveElevatedChromeDecryptionAuthorization({ platform, appBoundCookieRowsPresent, userConfirmed })`：仅当 `platform === "win32"` 且嗅探确认 Cookie 库确有 v20（App-Bound）行 且 用户在 main 弹出的确认框点确认，才允许提权路径。
3. 嗅探：`chromeCookieManager.hasAppBoundEncryptedCookies({ profilePath, platform, logger })`——复用既有快照/只读查询链，仅判断 v20 前缀。库缺失或读取失败返回 `null` → **fail-closed**：不弹窗、不提权，导入按无提权继续（结果仍是既有的 `chrome_cookie_elevation_required` 错误码）。
4. 用户确认：复用仓库既有 `dialog.showMessageBox(parentWindow, …)` 模式（对齐 desktopCommandHandlers 的确认框），中文文案说明将启动 Chrome 提权组件解密 App-Bound Cookie；取消则不带提权执行。
5. 提权授权是**一次性**的（本次 IPC 调用内有效），不持久化、不缓存。

shared 类型 `ChromeBrowserDataImportOptions.allowElevatedChromeDecryption` 属 `packages/shared`（本轮所有权之外）不动；spec 记录该字段在 desktop 链路上已不具授权语义。

### 验收

1. 伪造 renderer 载荷 `{allowElevatedChromeDecryption: true}`：导入仍走无提权路径（Windows v20 场景弹 main 确认框）。
2. 非 Windows / 无 v20 行 / 用户取消：不弹窗、不提权，导入结果错误码与现状一致。

---

## 未决与移交

1. **打包冒烟**：fuse（含完整性校验、agent spawn 回归）与 CSP 打包态表现需发布流程真实出包验证；本批仅配置层测试。
2. `packages/ui` OpenSplitButton 迁移到 `openExternalFile`（完成后删除 OpenExternal 的 file: 分支）——跨包所有权，移交整合方。
3. `enableNodeOptionsEnvironmentVariable`/`runAsNode` 两个 fuse 的关闭依赖「agent 独立 node 二进制」工程落地。
4. resource-manager.html / cua-permission-panel.html 的 CSP 未在本批补齐（辅助窗，任务范围外）。
5. CSP `connect-src http:/https:` 从宽，待收集 renderer 实际远端取数清单后收紧。
