# ACode：小 UX 批——execute 命令折叠与文件类型图标

## 1. execute 工具卡命令折叠（上游 chat.toolCall.execute.expand/collapseCommand 对齐）

`ToolCallBlocks` 的 execute 系工具卡：命令文本超 2 行（≈160 字符）时折叠为单行 +
「展开」；展开后「折叠」。状态纯组件内 useState，不进 store、不进协议。i18n：
`chat.toolCall.execute.expandCommand` / `collapseCommand`（en+zh）。

## 2. 文件类型图标（上游 material-icons 1146 SVG 的 ACode 替代）

上游打包 1146 个专有文件类型图标；ACode 不拷贝还原产物，改为**复用仓库既有
lucide 图标**做一张「扩展名 → 图标+着色」映射表（~45 组：ts/tsx/js/jsx/json/md/
py/go/rs/java/c/cpp/html/css/vue/svelte/sql/sh/yaml/toml/ini/env/png/jpg/gif/svg/
webp/mp4/mp3/pdf/zip/tar/gz/lock/log/csv/xml/db/dockerfile/makefile/…，未命中回退
通用文件图标）。

- 新组件 `packages/ui/src/components/FileTypeIcon.tsx`：`<FileTypeIcon name={fileName}
  className? />`，纯展示、memo；映射表同目录 `fileTypeIconMap.ts`。
- 消费点（第一批）：`GitPaneChangeCard.tsx`、会话附件行（`attachments` 列表处）、
  workflow artifact file 卡的文件徽标。
- 颜色遵守 DESIGN.md 语义 token（不引入 raw 色值的新调色板；用
  `--color-workflow-*`/foreground 族的中性表达，图标色不承载状态语义）。

## 验收

1. 长命令折叠/展开往返不丢内容；快照回放后折叠态复位为折叠（组件态，无持久化）。
2. `FileTypeIcon` 快照测试（命中各扩展名/未命中回退）；GitPaneChangeCard 视觉手测。
3. i18n 两文件同步；`pnpm typecheck`/`lint` 过。

## 实机排查结论（2026-10-11 立项 I，终判）

settled v4 会话的工具行默认收在**两级折叠**里：turn 的「已工作 N」chevron 展开工作
项容器 → 每行紧凑摘要（终端行截断命令+状态、更改行行内 FileTypeIcon）→ 行上
「展开工具详情」（`role="button"` 的 div，非 button 元素）才挂载完整卡与
`ExecuteCommandArea`。实机终验：两级展开后 225 字符命令默认 `data-collapsed="true"`、
按钮「展开命令」；往返展开/折叠标签切换正确且正文 225 字符零丢失；FileTypeIcon 在
紧凑更改行与「N 个文件已更改」卡均真实渲染。**功能无缺陷**，初轮「settled 视图缺席」
是探针盲区（虚拟列表只挂视口行 + 两级折叠未展开）。

交互路径留档（验收脚本必备前置）：侧栏任务列表亦虚拟化（滚动才挂载 li）；展开顺序
固定为 工作项 chevron → 行详情 toggle；探针选择器须用 `[aria-label="展开工具详情"]`
（任意元素）而非 `button[...]`。
