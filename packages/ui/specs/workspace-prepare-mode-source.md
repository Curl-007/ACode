# workspacePrepareRpc 预热期 mode 来源裁决

> 状态：已裁决（2026-10-28）。本 spec 记录决策与验收场景。

## 背景

`packages/ui/src/hooks/workspacePrepareRpc.ts` 的 `prepareWorkspaceWithACodeSessionService`
是 **预热路径**：返回的 `ACodeWorkspacePrepareResult.preparedSessionId` 恒为 `""`，
调用时机正是会话尚未建立之时（`useWorkspaceSessionReload`、`useDraftConfigControl`、
`v4/SessionPane` 三处消费方均在会话启动前调用）。

函数返回值含两个看似来自协议的数据：

| 字段 | 来源 | 是否真是协议事实 |
|---|---|---|
| `configOptions`（mode 单选） | legacy `readWorkspacePresentation.mode` | **否** |
| `slashCommands` | legacy `readWorkspacePresentation.slashCommands` | 是 |

## 实测证据

### mode 不是协议事实

`apps/acode-cli/packages/bootstrap/src/acode-protocol/workspace-model-runtime.ts:19-37`
的 `readWorkspacePresentation` 对 `mode` 字段 **硬编码 `mode: "build" as const`**，
根本不读任何持久态或运行态。

**含义**：legacy 协议从来不是 mode 的权威源。把它当成「需要从某个 v4 服务读出来」
是个伪问题——它没有真实来源，本身就是个常量。

### mode 档位的权威源在 shared

`packages/shared/src/acode-agent-model-state.ts:15-42` 维护 5 档权威表：
`build / edit / plan / yolo / dontAsk`。v4 composer 的 mode 选择器
（`packages/ui/src/v4/composer/V4ComposerModeControls.tsx:62,78`）已直接使用 shared 的
`getACodeAgentAvailableModes()` / `getACodeAgentModeSelectOptions()`。

### v4 两个候选源都不成立

1. **`ModelSelectionView`**（`packages/provider/src/facades.ts:220-224`）只有
   `revision`/`providers`/`preferredSelection`，**没有 mode 也没有 slashCommands**。
2. **`workspace-config` topic** 的种子 `buildLiveWorkspaceConfigStateV4`
   （`apps/acode-cli/packages/bootstrap/src/acode-protocol/v4-workspace-config.ts:42-60`）
   在无在册会话时返回 `null`（`:49` 刻意不建 temporary app），而 prepare 是预热路径，
   恰好在无会话时调用——换成 topic 订阅会让预热拿到空目录。

## 决策

**接受 mode 是常量。**

预热期 UI 直接用 shared 权威 5 档表 + `currentValue: "build"` 硬编码，
不调 `readWorkspacePresentation.mode`。slashCommands 仍走 legacy
`readWorkspacePresentation.slashCommands`——那是真实协议事实，归 M2 切换，本决策不影响。

## 实现约定

```ts
// packages/ui/src/hooks/workspacePrepareRpc.ts
// configOptions 不再读 presentation.mode，直接给常量
const configOptions = acodeWorkspacePresentationToConfigOptions("build");
// slashCommands 仍从 legacy 读取
const { slashCommands } = await acodeSessionService.readWorkspacePresentation({ ... });
```

### 调用面收窄

`acodeSessionService.readWorkspacePresentation` 的调用面从「读 mode + slashCommands」
收窄到「只读 slashCommands」。返回类型 `ACodeWorkspacePrepareResult` 不变
（`configOptions` + `slashCommands` 两字段都还在）。

### 不变量

1. `configOptions` 必须是 shared 5 档（含 `dontAsk`），`currentValue` 恒为 `"build"`。
2. `slashCommands` 必须从协议读取（不能硬编码）。
3. `preparedSessionId` 恒为 `""`——本函数不创建会话。

## 验收场景

| 场景 | 期望 |
|---|---|
| 预热（无 live session）调用 prepare | 返回 `configOptions.length === 1`、`configOptions[0].options.length === 5`、`configOptions[0].currentValue === "build"`、`preparedSessionId === ""` |
| slashCommands 正常下发 | `slashCommands` 来自协议响应，不为空 |
| `readWorkspacePresentation` 网络/协议失败 | prepare 整体 reject（slashCommands 缺失不构成可用响应） |
| shared mode 档位表变化（如新增第 6 档） | prepare 返回的 `configOptions[0].options` 自动跟随（不需改 prepare 代码） |

## 测试锚点

`packages/ui/test/workspacePrepareRpc.test.ts` 钉住上述场景。既有
`packages/ui/test/workspaceModeConfigOptions.test.ts` 继续覆盖 mode 格式化函数本身。

## 与 M1 的关系

本决策解除 M1 的最后一处阻塞（`useActiveTaskSnapshotMeta` 之外的最后 1 个真 import）。
M1 完成判据见 `docs/legacy-protocol-convergence-plan.md` 的 M1 节。
