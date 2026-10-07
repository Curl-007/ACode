# v4 上帝组件拆分计划（SessionPane / ConversationComposer）

状态：第一批已实施（2026-10-05，深度审查 P2）；其余接缝为登记在案的后续批次。
背景：`v4/SessionPane.tsx`（3,629 行，带 max-lines 豁免）与 `v4/ConversationComposer.tsx`
（2,168 行）各自混合多种职责。拆分按「耦合最浅的接缝先行」推进，每批独立验证。

## 已完成（第一批）

- **附件预览接缝**：composer 的 4 个预览 state（图片 gallery index/open、PDF target/open）
  与两个预览弹窗收口进 `v4/composerAttachmentPreview.tsx` 的 `useComposerAttachmentPreview`。
  composer 只持有 `openImagePreviewForSrc` / `openPdfPreview` 两个 controller 并渲染返回的
  dialogs JSX；topContentNode useMemo deps 同步更新（openImagePreviewForSrc 依赖
  composerMediaPreviewItems，items 变化时 controller 换引用，gallery 索引不落在过期列表上）。
  验证：`tsc -b packages/ui` 0 错、ui 测试 79/79、oxlint 触碰文件 0 警告。

## 登记的后续接缝（按耦合度从浅到深）

| 接缝 | 位置 | 前置条件 |
| --- | --- | --- |
| 提示词历史导航 | composer :1034-1039（state+effect）与 PromptHistoryPlugin | **不能只抽 state**：发送流程（:1129-1179）对 history 有 before/after 快照 + 失败回滚写入，回滚语义必须与发送编排一起迁移；先给发送失败回滚补交互测试再动 |
| 模型配置选择器 | composer configPickerState 簇 | 与草稿持久化交互面需先理清 |
| 排队确认（heldQueueConfirmation） | composer :559 一带 | 与发送控制簇共用状态，随发送编排批次处理 |
| SessionPane 命令组 | dispatchCommand/snapshotRef 闭包族 | 豁免注释自辩「拆散命令组会打散闭包纪律」——拆分前必须先为命令编排建立接缝内测试（当前 SessionPane 无组件级测试），否则不动 |

## 每批拆分的固定验收

1. 逐字迁移优先：state/回调搬进新模块，composer 侧只留 controller 与 JSX 插槽；
2. 消费方 useMemo/useCallback deps 同步更新（React hooks 完整性由 typecheck + lint 保障，deps 遗漏靠本清单第 3 条兜底）；
3. `tsc -b packages/ui` 0 错 + `pnpm --filter @acode/ui test` 全绿 + 触碰文件 oxlint 0 新增警告；
4. 涉及交互语义的批次（发送、排队、命令编排）必须先补交互测试或附人工验证记录（AGENTS.md E2E 要求）；
5. 拆分不得改变 max-lines 豁免的现状语义：新模块自身必须 <400 行（架构 ratchet），豁免只允许随拆分收窄，不允许复制到新文件。
