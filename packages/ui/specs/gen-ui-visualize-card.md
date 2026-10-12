# ACode：对话内可视化卡片（沙箱渲染）

## 背景与目标

CLI 侧把 `::visualize` 引用投影成 `artifactRow(html)`（见
`apps/acode-cli/specs/gen-ui-visualize.md`）。本 spec 定义 renderer 侧：正文里剥离
指令文本、在该位置渲染**沙箱化**交互卡片，桌面与 Web（含手机）同一实现。

## 安全设计（核心决策）

仓库纪律（`WorkflowArtifactBody.tsx:32`）禁止 iframe 的前提是
`allow-same-origin` 组合；本卡片的沙箱**不使用 allow-same-origin**：

```tsx
<iframe
  sandbox="allow-scripts"            // 仅此一项：无 same-origin/popups/forms/top-navigation
  srcDoc={wrapFragment(fragment, theme)}
/>
```

- 不透明源：无法访问应用 DOM/storage/IPC；`window.parent` 跨源不可达，仅
  `postMessage` 可通（高度上报用，父侧校验 `event.source === iframe.contentWindow`）。
- `wrapFragment` 注入两层防线（srcdoc 文档自身生效，不依赖应用 CSP）：
  1. `<meta http-equiv="Content-Security-Policy">`：`default-src 'none';
     script-src 'unsafe-inline' blob: data: <CDN 白名单>; style-src 'unsafe-inline'
     data: blob: <CDN>; img-src data: blob: <CDN>; font-src data: <CDN>;
     connect-src 'none'; form-action 'none'; base-uri 'none'`；
  2. 高度上报脚本（ResizeObserver → postMessage）与主题 CSS 变量（从卡片容器
     computed style 取当前主题 token，映射为上游技能同名的 `--background/
     --foreground/--card/--muted/...` 变量表）。
- widgetState：v1 提供**内存态** shim（`window.acodeViz.widgetState/get/set`，
  生命周期=卡片挂载期）；持久化登记为后续项。
- 卡片默认渲染高度上限 640px 内可滚动；`mode:"wide"` 占满会话栏宽。

## 挂点

- 正文剥离：`lib/assistantVisualizeReference.ts`（复用
  `assistantDirectiveParser.ts` 的 `extractAssistantDirectives`），在
  `ai-elements/message.tsx` 投影链（L1350-1365 一带）把 `::visualize{...}` 替换为
  空白（保持行结构），与 citation 投影同一模式。
- 卡片渲染：`v4/ConversationRowView.tsx` 的 `artifactRow` 分支（已有消费点 L150）
  按 `artifactType === "html"` 分派到新组件 `v4/VisualizationArtifactRow.tsx`：
  读字节（`conversationVisualizationRead` 分块拼装，≤1MiB）→ 沙箱卡片；
  读失败/超限 → 降级卡（标题 + `chat.visualize.loadFailed` + 重试）。
- 字节缓存：卡片组件内 useRef 缓存，不进全局 store（避免投影全量补拉的教训，
  见 renderer-memory-budget.md）。

## 读取 effect 的收敛纪律（防无限重渲染 + RPC 洪泛）

卡片挂载即发一次 `conversationVisualizationRead`（分块拼装）把字节读进缓存；该读取
effect 必须**收敛**——同一 `row.ref` 只读一次，读到 `ready` 后渲染 iframe。据此约束：

- `parseVisualizationArtifactRef(row.ref)` 每次调用都返回**全新的** `{ sessionId, name }`
  对象字面量（引用不稳定）。组件在渲染体里派生的 `identity` 必须用 `useMemo`（键
  `row.ref`）稳定，**不得**直接把裸调用结果放进任何 effect 依赖数组。
- 读取 effect 的依赖数组只允许**稳定原语/稳定引用**：`cacheKey`（字符串
  `${sessionId}/${name}`，已是 identity 的值代表）、宿主注入且 memo 稳定的
  `readChunk`、显式重试信号 `retryCount`。把引用不稳定的 `identity` 放进依赖 = 每次
  渲染依赖都 `Object.is` 不等 = effect 必然重跑 = cleanup 中断在途读 + `setState`
  触发下一次渲染，形成**没有不动点**的环：iframe 永远停在 loading、`fragmentCacheRef`
  永不填充、`conversationVisualizationRead`（经 gateway → NodeVisualizationFragmentStore
  真实磁盘 `readFile`）以渲染速率无界洪泛。

失败降级路径（loadFailed / oversized）是**终态**，不是这种活锁环——设计意图始终是
「读到就渲染 iframe，读不到就干净降级」，绝不能是「读到一半被自己中断，无限重来」。

## i18n（en-US + zh-CN 同步）

`chat.visualize.card / loadFailed / retry / openStandaloneHint / oversized / wide`。

## 验收场景

1. 引用卡内联渲染：iframe `sandbox` 属性仅 `allow-scripts`；`event.source` 校验
   高度上报；主题切换后卡片内 CSS 变量跟随。
2. fragment 里 `fetch()` 被 CSP `connect-src 'none'` 拦截（测试用例内联断言 CSP 串）。
3. 降级：读失败显示重试卡；>1MiB 显示 oversized 卡。
4. 桌面 dev 构建手测一轮（CDP 9229 截图），Web 端 `pnpm dev:web` 手测一轮；未执行
   须在交付说明里写明。
5. 手机布局：卡片宽 100%、高度钳制、可滚动。
6. 读取 effect 收敛（`test/genUiVisualizeCard.test.ts` 结构守护）：`identity` 经
   `useMemo` 稳定；读取 effect 依赖数组不含裸 `identity`。仓库无 DOM/组件渲染测试先例
   （无 jsdom / react-test-renderer），此不变量以源码结构断言钉住，防依赖漂移复发活锁。
7. 真机 DOM 验收（`packages/desktop/scripts/e2e-visualization-card-render.mjs`，
   `pnpm --filter @acode/desktop e2e:genui-card`）：补场景 6 的缺口——场景 6 只能做源码
   正则守护与手写 commit-loop 仿真，从未在真实 React 调度器 + 真实 Chromium DOM 下跑过
   真实组件。该 harness 用仓库已有的真 Electron（`e2e-smoke.mjs` 同一手法：本仓 Electron
   二进制 + `--user-data-dir` 隔离），把**真实 `VisualizationArtifactRow`** 连同真实
   `ACodeIntlProvider`、真实 `parseVisualizationArtifactRef` / `fetchVisualizationFragment`
   挂进真实 DOM，由真实渲染次数（`displayName` getter）、真实 RPC 计数与真实 `AbortSignal`
   观测收敛。2026-10-12 实测（Windows / Electron Chrome 146）：
   - 修复后：`renders=4`、`rpcCalls=1`、`abortedCalls=0`、`phase=ready`、iframe
     `sandbox="allow-scripts"`、`data-v4-visualization-mode="wide"`——真实 DOM 里卡片出现且
     有不动点；
   - 破坏对照 `--control`（把当前源码里的 `useMemo` 修复**机械逆回**裸调用后经内存插件构建
     进同一 harness、同一真实 DOM；对照自洽于工作树，不依赖 `git show HEAD`，因此修复与
     harness 同批提交后仍可长期复现）：2.5s 内 `renders`/`rpcCalls`/`abortedCalls` 均达两万
     量级（实测三次分别为 22722、21453、21993，具体值随调度浮动，判据是超过
     `LIVELOCK_RENDER_FLOOR=20` 即认定没有不动点）、`phase` 恒为 `loading`、无 iframe——
     活锁在真实 Chromium 下逐字复现。撤掉 `useMemo` 即红。
   临时目录与 Electron 进程树在两个方向都验证清理干净（无残留、临时目录可删）。
   harness 保真纪律：`--control` 的 HEAD 源码经 esbuild 插件（虚拟 namespace + `resolveDir`
   指向真实 `src/v4`）**只在内存里**供出，绝不写进 `src/v4`——src 树被 tsconfig include 与
   oxlint 扫描，落盘副本一旦因信号中断留在盘上会污染下一轮门禁。Electron 运行时骨架
   （二进制解析、argv、带超时 spawn、进程树清理、checkpoint 记账）与
   `e2e-network-capture-auth.mjs` 共用 `packages/desktop/scripts/e2e-electron-harness.mjs`。

