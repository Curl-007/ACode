# UI 本地诊断报告（U12）

契约真源：[`packages/shared/specs/local-diagnostic-report.md`](../../shared/specs/local-diagnostic-report.md)（产品规则、字段组、可用性四态、验收场景 U12-A1..A6、量化门槛、回退）。本 spec 只钉 **UI 端本地**的所有权与不变量，不重复契约。

## 范围

- `packages/ui/src/lib/localDiagnosticReport.ts` —— 组合器（纯函数）。
- `packages/ui/src/hooks/useLocalDiagnosticReport.ts` —— 采集/组合/下载编排 hook。
- `packages/ui/src/LocalDiagnosticReportDialog.tsx` —— 预览 + 范围勾选 + 下载 UI。
- `packages/ui/src/WorkspaceHelpMenuButton.tsx` —— 帮助菜单入口（桌面 + Web 都渲染）。

## 职责边界

组合器只做 **DTO 组合 + 可用性判定 + 上限强制**。它不采集（采集是各端 `platform.collectLocalDiagnostics` 的职责）、不脱敏（schema 结构性排除敏感字段名，各端只上报白名单事实）、不持有状态。这样 UI 层无需知道任何一端的实现细节，也保证「先预览后决定」看到的是**将写入文件的最终形态**。

## UI 本地不变量

1. **默认最小范围**（契约事件顺序）：`DEFAULT_DIAGNOSTIC_SCOPE` = build + connection + performance 选中，provider 与 events 默认**不**选入。理由：provider 含用户配置摘要（需显式同意），events 体积最大。
2. **可用性必须可见地区分渲染**（契约验收 U12-A4）：四态各有独立 i18n 标签与 Badge variant——`collected`=secondary、`truncated`=destructive（警示：有数据但没全放进去）、`unavailable`/`not-collected`=outline。未选入的组**缺席**（不渲染空对象），因为空对象会被误读为「查过且为空」。
3. **采集一次，重组多次**（契约验收 U12-A5「无重复后台采集」）：打开对话框时采集一次并缓存于 ref；scope 变化只做纯重组（`recompose`），下载重试复用已采集事实。关闭时释放 ref，下次打开重新采集。
4. **组合器输出恒过 schema**（契约 U12-A6）：`composeLocalDiagnosticReport` 结尾自校验 `parseLocalDiagnosticReport`，失败即 fail-loud（`phase:"error"` + 稳定码 `compose-failed`），绝不产出坏报告。
5. **大小上限确定性处理**：超 1 MiB 时按 `SIZE_DROP_ORDER`（events → provider → performance）逐组丢弃并标 `truncated`；核心最小集（build/connection）永不丢。丢弃全部可选组仍超限则抛 `local-diagnostic-report-too-large`——**不静默截断**，因为静默产出超大文件会让维护者误以为报告完整。
6. **下载不谎报成功**（契约产品规则 7 / 验收 U12-A5）：`saveDiagnosticReport` 缺席或返回 `saved:false` 时降级为剪贴板复制，并用独立 i18n 文案如实说明「当前浏览器无法直接下载」；连剪贴板都不可用时返回 `failed` + 稳定码。用户取消保存框是 `cancelled`（静默，不弹错误）。
7. **本层不创建 object URL**：桌面走 save dialog、Web 的 Blob/object URL 生命周期由 `packages/web` 拥有并保证释放（见 `packages/web/specs/local-diagnostic-report-web.md`）。UI 只传 JSON 字符串，故无临时资源需要释放。
8. **provider 摘要暂无来源**：U08（首次配置与模型故障诊断）未落地，故 `providerEntries` 恒传 `null` → 该组标 `unavailable`。这是契约允许的（「可先导出无 provider 部分」），U08 落地后只需把既有诊断结果接进来，不改本层契约。
9. **受控对话框的采集触发与关闭真源**（实现期踩坑，成文防回归）：本对话框是**受控**组件——`open` 由父级（帮助菜单 state）持有。两条不变量：
   - **采集必须由 `open` 变化驱动（`useEffect`），不能挂在 `Dialog` 的 `onOpenChange` 上**。radix 只在用户交互（Esc/点遮罩）时触发 `onOpenChange`；菜单点击把父级 `open` 置 true 时它**不会**触发，采集就永远不发生、对话框空白。
   - **关闭必须同时通知父级**（`requestClose` = `diag.close()` + `onOpenChange(false)`）。只调 `diag.close()` 的话父级 `open` 仍为 true，对话框会停在空白态——受控组件的开关真源在父级，本层状态不是真源。
10. **hook 不持有 isOpen**（AGENTS.md：避免重复状态）：对话框是受控组件，开关真源在父级；hook 再存一份 `isOpen` 就是第二真源、两者可能不同步。`open()`/`close()` 只负责采集与释放，不表达开关。
11. **采集代际守卫**（同 web 重连模块 26R2-02 的范式）：关闭再重开会让上一次采集的 promise 变成「陈旧代」。若无守卫，陈旧代晚到 resolve 会用旧事实覆盖 `factsRef` 并把 `phase` 置回 `ready`，显示过期报告。实现：`generationRef` 在 `open()` 递增、`close()` 也递增作废在途代，回调内 `isCurrent()` 不符则**不写任何 state**。

## 组件层测试边界（如实登记）

对话框组件本体（`LocalDiagnosticReportDialog.tsx`）依赖 radix `Dialog`，其内容经 Portal 渲染，本仓的 `minimal-dom-shim` 不覆盖 Portal，故**无组件级渲染测试**（与 `modelProviderDiscovery.test.ts` 同一处境，该文件亦以源码契约断言代替）。为不留下「组件层零验证」的缺口，本实现把所有可测决策逻辑抽成 `lib/localDiagnosticReport.ts` 的纯函数并**行为测试**覆盖：组合与四态可用性、条目/字节上限与丢弃顺序、下载结果决策矩阵（含「任何输入都不得把未成功保存报成 saved」的穷举守护）、可用性→标签键映射（含四态键**在 en-US 与 zh-CN 都存在**的缺译守护，缺译会把原始键名渲染给用户）、可用性→Badge variant（钉住只用既有 variant，防止再次误用不存在的 `warning`）。组件层剩余未覆盖的是渲染布局与交互（勾选、按钮禁用态），由 typecheck + 手动验证覆盖。

## 验收场景映射

| 契约编号 | UI 侧断言 | 测试 |
|---|---|---|
| U12-A3 | 组合器不引入敏感字段面，顶层键集封闭 | `tests/localDiagnosticReport.test.mjs` |
| U12-A4 | 四态可用性逐一准确；未选入/不可得的组缺席而非空对象；events 超 200 裁剪并标 truncated | 同上 |
| U12-A5 | 组合是纯函数（同输入结果稳定、不就地改入参）；采集一次重组多次 | 同上 + hook 设计 |
| U12-A6 | 输出恒过 `localDiagnosticReportSchema`；大小上限丢弃全部可选组仍超限则抛错 | 同上 |
| U12-A1/A2 | 各端事实采集与下载（离线零外联 / 桌面 zip 并存） | `packages/web/tests/webDiagnostics.test.ts`、`packages/desktop/tests/` |

## DESIGN.md 遵从

复用既有 `Dialog`/`Button`/`Badge`/`Checkbox`/`toast` 原语，不新造组件；字号用 `text-ui-sm`/`text-ui-xs`（无 `text-[Npx]`）；无裸 `<button>`；未使用 `focus-visible:ring-0`（保留焦点态）；无 `bg-white`/`text-black` 硬编码。
