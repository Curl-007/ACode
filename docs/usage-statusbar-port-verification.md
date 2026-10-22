# 用量状态栏移植独立验收报告

- 验收日期：2026-10-20
- 验收人：verifier（独立验收，未参与实现）
- 目标仓库：`D:\AnkerCodes\QYDemo\ACode1`（`dev/1.0.1` @ `38b93920` + 工作树移植改动）
- 验收范围：t-12~t-15 用量状态栏移植批；spec = `apps/acode-cli/specs/usage-statusbar-port.md`（下称 spec）。AgentTeams 批次已在 t-7/t-19 单独验收，本报告不重复判定。
- 对照基线：t-1（HEAD 干净树：typecheck 0、lint 0/166 warnings、插件 test 0）。用量批为纯 UI + additive 协议，不涉及插件版本。
- 结论：**不通过（有条件）**。R1/R2/R3/R4/R6/R7/R8 通过；**R5 布局稳定规则 3 项偏离**（脉冲点未按目标 36c28d65 改为绝对定位角标、无每段 min-w 槽位、容器字号由 `text-ui-sm` 改为 `text-ui-xs` + `font-mono`）。无 E2E 环境，视觉/人工场景按「未验证」登记。

## 1. 改动盘面（t-12 之后）

- 旧栏下线：`packages/ui/src/v4/usage-statusbar/` 12 个源文件全部删除；旧测试 `usageStatusbarModel.test.ts`、`usageStatusbarSurface.test.ts`、`usageStatusbarTooltipStability.test.ts` 删除；`usageStatusbarPreferences.test.ts` 按新 schema 重写保留。
- 新 UI：`packages/ui/src/v4/composer/usage-bar/` 15 个文件（`UsageStatusBar.tsx` 341、`usageBarModel.ts` 383、`usageBarSessionSegments.ts` 348、`UsageBarSubagentPanel.tsx` 228 等，全部 ≤400）。
- 新 helper：`v4/composer/{liveOutputRateRegistry,sessionTokenStats,useChildSessionTokenStats,useLiveOutputRate}.ts`、`hooks/useTodayAppUsage.ts`、`chat-input-toolbar/{contextUsageCost,turnMetrics}.ts`、`lib/builtInSubagentDisplay.ts`、`settings/UsageStatusbarSettingsSection.tsx`。
- 数据面：`shared/acode-protocol-v4/{rows,turn-metrics,snapshot,delta}.ts`、`shared/usage-stats.ts`、`shared/test-ids-composer-usage-bar.ts`、`contracts/.../session-store.port.ts`、`adapters/.../usage.ts`、`bootstrap/.../usage-stats-builder.ts`、`bootstrap/.../product-projection{,-usage,-turn-metrics}.ts`、`projection-state.ts`。
- 接线：`ConversationComposer.tsx`（挂新栏）、`ConversationTurnGroup.tsx`（`TurnRateFooter`）、`SubagentDirectorySidePane.tsx`（`usageBarFormat`）、`settingsPageHelpers.tsx`、`sessionDataLayer.ts`、`usageStatusbarPreferences.ts`。
- 版本/发布文件（插件 4 处版本、SEA、桌面暂存）在本批次无新增改动（仍为 AgentTeams 批的既有改动）。

## 2. 命令与真实退出码

命令均在目标仓库执行；退出码用 `cmd > log 2>&1; code=$?` 直接获取，无管道掩码。日志：`C:\Users\admin\AppData\Local\Temp\acode1-verify\`。

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm --dir packages/ui test` | **0** | tests 420 / pass 420 / fail 0（含 AgentTeams 团队测试，跨批无回归） |
| `node --import tsx --test test/usageBarModel.test.ts test/usageBarDetailGroup.test.ts test/turnRateFooter.test.ts test/sessionTokenStats.test.ts test/liveOutputRateRegistry.test.ts test/usageStatusbarPreferences.test.ts`（cwd=`packages/ui`） | **0** | tests 39 / pass 39 / fail 0 |
| `pnpm typecheck` | **0** | 13s；packages 7.2s / desktop-renderer 3.4s / cli 1.5s 全 done |
| `pnpm lint` | **0** | 166 warnings / 0 errors（与 t-1 基线相同，无新增 warning） |
| `pnpm architecture:check --changed` | **0** | new 0 / regrown 0；legacy over-limit 412（不增） |
| `oxfmt --check`（usage-bar 目录 + helpers + 接线 + 新测试，36 files） | **0** | All matched files use the correct format |
| `node --import tsx --test tests/usage-statusbar-projection.test.mjs` | **0** | tests 16 / pass 16 |
| `node --import tsx --test tests/usage-stats-builder-today.test.mjs` | **0** | tests 2 / pass 2 |
| `node --import tsx --test apps/acode-cli/packages/adapters/src/storage/session-store/repositories/usage.test.ts` | **0** | tests 2 / pass 2 |
| `node --import tsx --test packages/shared/test/usage-statusbar-protocol-fields.test.ts` | **0** | tests 9 / pass 9 |
| `node --import tsx --test apps/acode-cli/packages/bootstrap/src/acode-protocol/usage-stats-builder.test.ts` | 2 | 文件在目标不存在（spec §8.1 列出的路径与实际不符）；今日 builder 由 `usage-stats-builder-today.test.mjs` 覆盖 |

未执行（按要求）：全仓 `pnpm fmt:check`（基线 CRLF 红）、`knip`（基线红）。全仓 `pnpm install`、插件 gates 等 AgentTeams 项见 t-7 报告。

## 3. R1~R8 逐条核对

| 需求 | 结论 | 证据 |
| --- | --- | --- |
| R1 七段信息与交互 | PASS（静态/模型级） | 段顺序 `usageBarModel.ts:120-126` = speed/turnUsage/context/session/tools/today/subagents；速度阈值 `usageBarSegments.ts:18-20`（70/40）；工具 12 行上限 `usageBarSegments.ts:23`；错误徽标 99+ `UsageBarErrorBadge.tsx:12`；容量三档 `usageBarModel.test.ts:176-202`；明细互斥 `usageBarDetailGroup.ts` + `usageBarDetailGroup.test.ts`；hover 生命周期见 R5 |
| R2 数据面 | PASS | `turn-metrics.ts:8-36`、`snapshot.ts:569,572`、`delta.ts:69,72`、`projection-state.ts:96-108`；今日四字段 `usage-stats.ts:206-210`、`session-store.port.ts:986-1011`、`usage.ts:398-403`、`usage-stats-builder.ts:117-130,164-178`；testid `test-ids-composer-usage-bar.ts:6-18` + `index.ts:135` |
| R3 字段映射 | PASS | 复用 `usage.cumulative/contextWindow/subagents`；`usage.lastRequest` 只作旧回退（`UsageStatusBar` 主路径读 `composerTurnMetrics`）；`turnHeader.stats` 仅加 `tokensPerSecond/peakTokensPerSecond`（`rows.ts:85-86`）；`sessionTokenStats.ts:78` 明确无 `usage.inFlight` |
| R4 UI 落点与旧栏下线 | PASS | 旧目录不存在（`ls` 失败）；`grep -rn "v4/usage-statusbar\|UsageStatusbar\|TurnRateLine" packages/ui/src` = 0；新栏唯一页面挂载 `ConversationComposer.tsx:2150`；速率行 `ConversationTurnGroup.tsx:1366`；目录侧栏 `SubagentDirectorySidePane.tsx:21`；设置页 `settingsPageHelpers.tsx:35,823` |
| R5 布局与 hover | **FAIL（部分）** | hover 生命周期 PASS（`UsageBarHoverDetail.tsx:67-77,117` 仅 window mousemove + Popover 关闭，无 pointerleave/HoverCard）；但 §6.1.2/§6.1.3/§6.1.6 三项偏离，见 §5 |
| R6 i18n/设置 | PASS | 设置唯一所有者 `usageStatusbarPreferences.ts:29-90`（`enabled`/7 子项/`answerFooter`；`rateLineEnabled` 迁移 :80-85）；总开关 `usageBarModel.ts:304`、设置页 `UsageStatusbarSettingsSection.tsx:53-55`；齿轮无总开关 `UsageBarSettingsPopover.tsx:29-31`；双语 103/103 键一致（脚本比对，missing 0） |
| R7 测试 | PASS | §2 命令真实执行；39 个定向测试 + 420 UI 测试 + 29 个数据面测试全绿；18 场景见 §4 |
| R8 版本/发布 | PASS | 本批未触碰插件版本/SEA/桌面清单；`agent-teams` 仍 0.4.0（AgentTeams 批）；无新增依赖（tokenlens 已存在） |

## 4. 18 个验收场景逐条判定

| # | 场景 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 首轮收口六段；无子代理不出现子智能体段 | PASS（模型级） | `usageBarModel.test.ts:128-171`（速度/本轮/上下文/会话/工具/今日各自构建）；子代理段门槛 `usageBarModel.ts:368`（`childCount > 0`）；真实首轮渲染未做 E2E |
| 2 | 流式实时估算 → 收口加权实测，与速率行逐位相等 | PASS | `usageBarModel.test.ts:128-150`；`usage-statusbar-projection.test.mjs`「turnHeader.stats carries the same tokensPerSecond/peak as composerTurnMetrics」；同源 `product-projection-usage.ts:155-161` |
| 3 | 明细无第二个速度数字；无实时样本退回实测值 | PASS | `usageBarModel.test.ts:150-156`（detail 无 tok/s 行）；`usageBarSegments.ts:75-77`（`rate = estimated ?? measuredRate`） |
| 4 | 收口档位 70/69.9/39.9；流式恒 live | PASS | `usageBarModel.test.ts:139-149` |
| 5 | 容量三档/缺失隐藏/超限建议 | PASS | `usageBarModel.test.ts:176-202`；`usageBarCapacity.ts` |
| 6 | 错误徽标（0 不渲染、>99 → 99+） | PASS | `UsageBarErrorBadge.tsx:12-27`；`usageBarSegments.ts:45-51`（errors<=0 无 badge）；`usageBarModel.test.ts` tools 用例 |
| 7 | 段/峰；旧 CLI 缺 peak 整行隐藏 | PASS | `usageBarSegments.ts:123+`；`turnRateFooter.test.ts:65-68`（缺 peak 只保留段） |
| 8 | 每工具明细排序/≤12 行/耗时缺省 | PASS | `usageBarSegments.ts:23`；`usageBarModel.test.ts` tools 用例（calls 降序/name 升序） |
| 9 | 子代理面板任务名同源/独立速度/缺名回退/不错配 | PASS（静态） | `UsageStatusBar.tsx:120-130`（running[].title）、`useChildSessionTokenStats` 按 childSessionId、`builtInSubagentDisplay.ts` 缺名回退；无 DOM E2E |
| 10 | 子代理段只算运行中；全结束只剩累计；无子代理隐藏 | PASS | `usageBarModel.ts:368`；`usageBarModel.test.ts:280-290`（running dot / endedOnly dot undefined） |
| 11 | 已结束分组仅钉住查询；三态；失败只收该组；订阅≤6 | PASS（静态） | `UsageBarSubagentPanel.tsx:78`（`enabled: pinned`）、`:97-100`（ended/loading/failed 三态）；`sessionTokenStats.ts:40,74`（MAX 6） |
| 12 | 明细互斥：钉住后打开别的段收起并清钉住 | PASS | `usageBarDetailGroup.test.ts`（last activation wins / pin included） |
| 13 | 今日分项；旧 CLI 隐藏缺失行；5s 防抖 + focus；失败隐藏 | PASS | `useTodayAppUsage.ts:13,92-116`；`usage-stats-builder-today.test.mjs` 2/2；`usageBarModel.test.ts:259-266` |
| 14 | 会话累计逐行按存在性；子会话读不到带 ≥ | PASS | `usageBarModel.test.ts` session 用例；`UsageStatusBar.tsx:92-108`（unknownCount → incompleteTotal） |
| 15 | 总开关关闭整条+速率行；子开关保留；齿轮无总开关 | PASS | `usageBarModel.ts:304`（`enabled` false → visible false）；`TurnRateFooter.tsx:97`（`enabled && answerFooter`）；`UsageStatusbarSettingsSection.tsx:53-55`；`UsageBarSettingsPopover.tsx:29-31`；`usageStatusbarPreferences.test.ts` 迁移/总开关用例 |
| 16 | 旧栏下线、无双条、外部引用改新目录 | PASS | §3 R4 证据；页面级 `<UsageStatusBar` 仅 `ConversationComposer.tsx:2150` 一处 |
| 17 | 布局/hover：指针静止常驻；稳定 key/min-w/脉冲角标；无被回退重设计 | **FAIL（部分）** | hover PASS；稳定 key PASS（`UsageStatusBar.tsx:301`）；**min-w 槽位缺失、脉冲点未做绝对定位角标、容器字号偏离**（§5）；被回退重设计 grep 0（`shortLabel/inFlight/DetailPanel/秒表`） |
| 18 | 协议兼容/冷恢复 | PASS | `usage-statusbar-protocol-fields.test.ts` 9/9（旧形状缺字段 → default null、patch 可 null/缺席）；`usage-statusbar-projection.test.mjs` 含 replay/冷恢复同值；投影键级替换 `product-projection.ts:5617,5625` |

## 5. 未通过项：R5 布局稳定规则 3 项偏离（本次引入）

1. **脉冲点未按目标 36c28d65 改为「绝对定位图标角标」**（spec §6.1.3：固定尺寸 span 绝对定位在图标右上角、恒渲染、opacity 切换、零布局占用）。
   - 现状：`packages/ui/src/v4/composer/usage-bar/usageBarSegmentView.tsx:94-99` 条件渲染 `segment.dot !== undefined ? <span className="size-1.5 shrink-0 rounded-full bg-success animate-pulse">`，在 flex 流内占位；出现/消失会挤动相邻段。
   - 目标基线对照：已删除的 `HEAD:packages/ui/src/v4/usage-statusbar/UsageStatusbarCapsule.tsx:80-81` 正是 `absolute -right-1 -top-0.5 size-1.5 ... opacity-100/opacity-0` 的恒渲染角标。
2. **无每段 `min-w` 槽位**（spec §6.1.2：按典型值紧档预留，新七段补 context 槽位；瞬态超槽允许一次性变宽）。
   - 现状：`UsageStatusBar.tsx:297` 仅容器 `tabular-nums`；`usageBarSegmentView.tsx:73-80` 段只有 `shrink-0`，无任何 per-segment `min-w-*`；`grep "min-w-\["` 仅命中 tooltip 宽度。
3. **容器字号/字体偏离紧凑视觉基线**（spec §6.1.6：`h-7`、`gap-0.5`、`px-1`、`overflow-hidden`、`text-ui-sm`）。
   - 现状：`UsageStatusBar.tsx:297` 为 `font-mono text-ui-xs`；旧实现 `HEAD:.../UsageStatusbar.tsx:167` 为 `text-ui-sm`（无 mono）。

建议：把 `segment.dot` 渲染改为在图标外包一个 `relative` 容器 + 恒渲染 `absolute` 角标（`opacity` 切换），给每段加按典型值的 `min-w-[...]`（context 新槽位），容器字号改回 `text-ui-sm`；若 `text-ui-xs`/mono 是有意设计变更，需 spec 修订并由队长裁决，否则按 spec 修。以上均为 UI 视觉/布局项，无 E2E 环境，修复后需手测确认。

## 6. 既有红与未验证

- **既有红（非本批引入）**：全仓 `pnpm fmt:check` 仍因 643 个未改动文件的 Windows CRLF 判红（t-7 已证）；`knip` 基线红；`usage-stats-builder.test.ts` 在目标不存在（spec 路径与实际不符），今日 builder 已由 `.mjs` 测试覆盖。
- **未验证（人工/视觉）**：真实桌面/Web 下七段渲染与窄宽折叠的像素表现、hover 明细在流式期间的实际常驻、子代理固定浮层、设置页/齿轮观感、主题（亮/Zai Dark/Ember）可读性、`desktop-continuous` 与 `web-remote-replayable` 双链路。本次仅静态与模型/单测级验证。
- 本批无新增依赖、无版本/发布变更；`pnpm typecheck`/`lint`/`architecture` 与 t-1 基线对照无回归（lint 166 warnings 相同）。

## 7. R5 修复复验（t-21，2026-10-20 13:10–13:16）

复验范围：t-20 对 §5 三项 R5 偏离的修复。复验期间仅 3 个文件发生变化：`usageBarSegmentView.tsx`、`UsageStatusBar.tsx`、新增 `packages/ui/test/usageBarLayoutR5.test.ts`；无其它改动。

### 7.1 三项逐项复验

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 脉冲点为绝对定位 + opacity 恒渲染 | **PASS** | `usageBarSegmentView.tsx:100-112`：图标外包 `relative inline-flex`，角标 `absolute -right-1 -top-0.5 size-1.5 rounded-full bg-success animate-pulse`，恒渲染，`segment.dot === "live" ? "opacity-100" : "opacity-0"`。与基线 `git show HEAD:packages/ui/src/v4/usage-statusbar/UsageStatusbarCapsule.tsx:72-86` 的 `relative` 容器 + `absolute ... opacity-100/opacity-0` 结构一致；旧的条件渲染 flex 流内圆点已不存在 |
| 2 | 各段 min-w 槽位（含 context） | **PASS** | `usageBarSegmentView.tsx:39-46`：`SEGMENT_MIN_WIDTH_CLASS` 覆盖 speed/turnUsage/context/session/tools/today/subagents 七项（context = `min-w-[3.25rem]`）；`:93` 应用到段容器 |
| 3 | 容器字号 `text-ui-sm` | **PASS** | `UsageStatusBar.tsx:297`：`@container/usagebar flex h-7 w-full ... px-1 font-mono text-ui-sm ... tabular-nums`；不再出现 `text-ui-xs` |

### 7.2 hover 生命周期未回归

- `UsageBarHoverDetail.tsx:67-77` 仍只有 window `mousemove` + `getBoundingClientRect()` 命中测试；`:117` 开 = segment `pointerenter`。
- 源码无 `onPointerLeave`/`event.relatedTarget`/`hover-card` 实现（仅注释说明禁止）；`usageBarLayoutR5.test.ts` 用 `doesNotMatch` 钉住。

### 7.3 复验命令与真实退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --dir packages/ui test` | **0** | tests 424 / pass 424 / fail 0（含新增 4 条 R5 源码守卫） |
| `oxfmt --check packages/ui/src/v4/composer/usage-bar/usageBarSegmentView.tsx packages/ui/src/v4/composer/usage-bar/UsageStatusBar.tsx packages/ui/test/usageBarLayoutR5.test.ts` | **0** | 3 files correct |

### 7.4 复验结论

- R5 三项偏离全部关闭；新增 `usageBarLayoutR5.test.ts` 以源码守卫钉住脉冲角标、七段 min-w、`text-ui-sm` 与 hover 关闭路径，防止回归。
- **用量状态栏批次（t-12~t-15）验收通过**。残留仅限无 E2E 的人工/视觉项（真实桌面/Web 渲染、窄宽折叠观感、hover 实际常驻、双链路），仍为「未验证」，不构成本次代码验收失败。
- 复验未修改任何源码，仅追加本节。

## 8. 附录：日志

`C:\Users\admin\AppData\Local\Temp\acode1-verify\`：`t16-ui-test.log`、`t16-targeted-tests.log`、`t16-typecheck.log`、`t16-lint.log`、`t16-arch.log`、`t16-oxfmt.log`、`t16-projection-test.log`、`t16-today-test.log`、`t16-usage-repo-test.log`、`t16-protocol-fields-test.log`。
