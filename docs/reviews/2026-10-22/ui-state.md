# ACode 1.0.3 深度 Review · UI 状态管理层（store / hooks / 平台边界）

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/ui/src/store/`（Zustand）、`packages/ui/src/hooks/`、平台边界（`IPlatformService`）、广播同步机制。组件层另见 [ui-components.md](ui-components.md)。

---

## 1. 层面整体评估

UI 状态管理层的**平台边界与日志纪律健康度很高**，是本次 review 中最干净的层面。`window.acode` 在 `packages/ui/src` 仅 11 处，全部是合法的局部结构类型桥接（browser-use、find-in-page、logger），没有一处绕过 `IPlatformService` 的裸调用；`console.*` 真实违规只有 1 处；hooks 无 JSX 命名违规；services 导入全部走公开入口。历史 ARCH-03（renderer 类型门禁缺失）已由 `scripts/typecheck-gate.mjs` 修复，现覆盖 desktop-renderer + CLI。广播防回环机制正确（单闭包 `applyingBroadcast` 标记 + `BROADCAST_FIELDS` 单源派生）。

**最大风险是 task meta 的多副本状态与分散写入路径**：同一份 task meta 至少存在 4 个 store 副本，40 处组件直调 `applyTaskQueryCacheMutation` 绕过收口 lib，并在同一 handler 内联写 remote store 与 optimistic 缓存。这是源码确认的结构性 drift 风险，非已复现缺陷。次要风险是 `useTheme()` 死代码仍保留一条绕过 store 广播的 theme 双写入口。

## 2. 问题清单

**[P2] task meta 四副本 + 40 处组件直调绕过 sync 收口** — `packages/ui/src/store/taskQueryCacheStore.ts:1088` / `packages/ui/src/lib/taskListMetaSync.ts`
- 描述：同一 task meta 存于 `acodeSessionStore.taskListCache`、`taskQueryCacheStore.taskMetaByEntityKey`、`remoteTimelineTaskStore`、`remotePinnedTaskStore` 四份；`taskListMetaSync.ts` 本应作为唯一收口，但组件普遍绕过它。
- 证据：`applyTaskQueryCacheMutation(` 在组件中出现 40 次（`WorkspaceTimelineTasksSection.tsx` 11、`WorkspacePinnedTasksSection.tsx` 11、`WorkspaceSidebarItem.tsx` 6、`WorkspaceHeaderSections.tsx` 6、`WorkspaceGroupedTasksSection.tsx` 3），且 `WorkspaceSidebarItem.tsx:512-521` 等处在同一 handler 内先 `upsertOptimisticTaskListItem` + `useRemoteTimelineTaskStore.upsertTask` 再 `applyTaskQueryCacheMutation`，单次用户操作触发 3-4 条独立写入。
- 建议：把 rename/pin/archive 的多 store 写入收进 `taskListMetaSync` 的单一事务函数，组件只调一个入口；明确 `taskListCache` 与 `taskQueryCacheStore` 的唯一所有者（前者若仅少数 reader 可考虑退役合并）。
- 验收：组件内 `applyTaskQueryCacheMutation` 直调点归零，一次 pin 操作在单一 lib 函数内完成全部 store 写入，并有真实 store 组合测试覆盖 rename/pin 后四副本一致。

**[P2] useTheme() 死代码保留 theme 双写旁路** — `packages/ui/src/useTheme.ts:90-117`
- 描述：`useTheme()` hook 自带 `useState` + 直接 `localStorage.setItem("acode-theme")`，绕过 `store/index.ts` 的 `setTheme`（唯一走广播防回环的写入口）；全仓无实际调用点（仅 `index.ts:28` 导出），但仍是活的旁路入口。
- 证据：`rg "= useTheme\(|useTheme\(\)"` 仅命中定义处；`packages/web/src/main.tsx:27` 与 `packages/desktop/src/renderer/src/main.tsx:73` 注释仍写「后续由 useTheme hook 接管」，而实际接管者是 store，注释误导。
- 建议：删除 `useTheme()` hook 本体（`applyTheme`/`resolveTheme`/`normalizeThemePreference` 等纯函数保留），移除 `index.ts` 导出，订正两处 main.tsx 注释指向 store。
- 验收：`useTheme()` 不再可导入，`acode-theme` 的写入点全局唯一（store.setTheme）。

**[P3] SettingsPage console.warn 违反日志纪律** — `packages/ui/src/SettingsPage.tsx:906`
- 描述：`console.warn("[settings] 回写引导记录失败", ...)` 未用 `logger.ts`，且无 `eslint-disable` 注释（区别于 `sidePaneTerminalSessionRegistry.ts:86` 的合规豁免）。
- 建议：替换为 `logger.warn`，复用文件已导入的 logger。
- 验收：`rg "console\." packages/ui/src` 除 logger.ts 实现、patchDiffPreview 注释、sidePaneTerminal 豁免外无其他命中。

**[P3] ui 模块未纳管，边界纪律无自动化守护** — `architecture-policy.yaml:159`
- 描述：`id: ui, managed: false`，AGENTS.md 的「UI 不直调 Repo/Service、禁止循环依赖、跨域实现细节」仅靠人工 review，无 architecture-check 覆盖。
- 证据：`pnpm architecture:context ui` 返回 `managed: false / requires: none / module.ts: missing`。
- 建议：按 fix-status 已定价的 checker resolver 三缺口（exports map/通配入口/asset 豁免）推进后，纳管 ui 并补 module manifest。
- 验收：`architecture:context ui` 显示 managed 且能检出人为注入的 UI→Repo 深导入。

## 3. 历史问题回归核对（对照 2026-10-08）

- **ARCH-03（CI/release 漏 Renderer 类型门禁，112 TS 错误）** — 已修复。`scripts/typecheck-gate.mjs` 现以 packages 为 barrier，并行跑 desktop-renderer（`tsconfig.renderer.json --noEmit`）+ CLI workspace，旁路已封。
- **`Window.acode` 声明未进 renderer 类型编译** — 已修复。声明在 `packages/client/src/globals.d.ts`，renderer 经 project references 读取；ui 包单独 typecheck 拿不到时用局部结构类型桥接（browser-use/find-in-page/logger），符合边界纪律。
- **「UI conversation 边界：SessionPane 等大组件承载 command/pane/provider/workflow」** — 仍在（结构性，详见 [ui-components.md](ui-components.md)）。
- **task meta 多副本 / taskListCache 与 taskQueryCacheStore 双缓存** — 新增/恶化。主 review 未单列此条，当前 40 处组件直调是本轮新发现的收口缺口。
- **广播回环（theme/locale 双写）** — 防回环机制本身健康；但 `useTheme()` 死代码是残留的旁路入口（见 P2）。

## 4. 量化（违规模式计数）

| 模式 | 计数 | 判定 |
|---|---|---|
| `window.acode` in ui/src | 11 处 | 全部合法桥接（browser-use 5、find-in-page 2、logger 1、hooks/lib 注释 3），裸调用 **0** |
| `console.*` in ui/src | 7 处 | logger.ts 4（实现）+ patchDiffPreview 1（注释）+ sidePaneTerminal 1（有 eslint-disable）+ **SettingsPage 1（真违规）** |
| hooks `.ts` 含 JSX 命名违规 | **0** | 初检命中均为泛型/`useState<T>` 误报，无真 JSX |
| `@acode/services` 非 type 导入 | 18 处 | 全走公开入口，Repo/impl 深导入 **0** |
| task meta store 副本 | **4 份** | acodeSessionStore / taskQueryCacheStore / remoteTimeline / remotePinned |
| `applyTaskQueryCacheMutation` 组件直调 | **40 处** | 绕过 taskListMetaSync 收口 |

## 5. 深挖入口

若要深入最大风险，读 `packages/ui/src/lib/taskListMetaSync.ts` 全文与 `WorkspaceTimelineTasksSection.tsx` 的 pin/archive handler，确认四副本是否在乐观失败回滚路径上会 drift。
