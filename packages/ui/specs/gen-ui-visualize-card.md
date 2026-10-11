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
