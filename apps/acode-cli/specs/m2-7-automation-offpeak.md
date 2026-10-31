# M2-7 定时任务 + Off-Peak 七方法迁 v4（automation CRUD ×5 + offPeak ×2）

> 状态：**已实施**（2026-10-28）。
> 实施记录（验收节逐项证据）：
> A. `acodeProtocolMethods.` 七法在 packages/services/src 实测归零（11 → 4，−7；tokenized
>    grep 自证）；剩余 4 = sessionSubagents + pluginsCancelOperation + sessionSend×2（M4）；
>    M2-5 后登记的 pluginsReferenceCatalog 对属 −32601 回落链，不计本批。
> B. shared protocol-boundary.test.mjs 46/46 绿，其中本批 M2-7 块 4 条（1688 行起）：
>    七法名落 V4_METHODS、params parity（含 refines）、result 全对象（含 scheduleRule；
>    offPeak union 双臂）、叶无反向 import。
> C. CLI tests/m2-7-automation-offpeak.test.mjs 21/21 绿（七法 port 级双形态发送：
>    v4 命中 / −32601 回落两方向）。
> D. 套件：shared 478/478；services 578 pass/0 fail（7 skip 基线）；ui 1125/1125；
>    CLI 3205 pass/0 fail（38 skip 基线）；typecheck 32/32。
> E. lint 163w/0e（基线 164，−1）；architecture:check --changed new 0/regrown 0
>    （violations 303 = 基线，legacy 棘轮 413）。
> 关联：docs/reviews/2026-10-28/m2-scoping.md M2-7 条目；M2-4 迁移样板；automation-port.ts
> -32601 回落先例。

## 1. 范围与判据

迁移 **agent/CLI → host 方向**（inbound RPC）七个方法；M2-0 判据：`acodeProtocolMethods.` 对本七法的消费在 packages/services/src 归零（实测基线：实施时刻 11 → **4**，−7；剩余 4 = sessionSubagents + pluginsCancelOperation + sessionSend ×2，归 M4）。
载体 = `packages/shared/src/acode-protocol-v4/automation-offpeak.ts`（新建叶）+ transport.ts 登记。

| legacy 方法（agent→host） | CLI 发送点 | services 消费点 | v4 归宿 |
|---|---|---|---|
| `automation/create` | automation-port.ts `create()` | acodeAgentService.ts:2705 | `v4/automation/create`（真 RPC） |
| `automation/update` | automation-port.ts `update()` | :2967 | `v4/automation/update`（真 RPC） |
| `automation/list` | automation-port.ts `list()` | :2913 | `v4/automation/list`（真 RPC） |
| `automation/checkTaskBinding` | automation-port.ts `create()` 内 | :2939 | `v4/automation/checkTaskBinding`（真 RPC） |
| `automation/delete` | automation-port.ts `delete()` | :3009 | `v4/automation/delete`（真 RPC） |
| `offPeak/create` | offpeak-port.ts `create()` | :2766 | `v4/offPeak/create`（真 RPC） |
| `offPeak/list` | offpeak-port.ts `create()`+`list()` | :2878 | `v4/offPeak/list`（真 RPC） |

**纪律**：
- legacy 只删不增；双向协议变更按「CLI 双形态共存 → host 切换 → legacy 删除留 M3」。
- 本批七法均为纯请求/响应真 RPC（无 announce+ack、无通知面），与 M2-4 browser 四法同型。
- wire 形态 = legacy schema 逐字重声明（v4 叶）或中立叶导入；**零新词汇**。
- `automationCheckTaskBinding` 的 -32601 回落（automation-port.ts 既有）是 skew 先例——v4 迁移后该回落保留（旧 host 无 v4 方法时回落 legacy 列表筛选）。

## 2. 行为规格

### 2.1 七法：v4 先行，-32601 回落（skew 探测机制）

沿用 automation-port.ts 既有 `-32601` 回落先例：
- v4 请求先行；仅当 `ProtocolRequestError.code === -32601`（host onRequest 尾分支 `Unsupported ACode Protocol request: ${method}`）时回落 legacy 形态；其它错误照旧上抛。
- 偏斜方向：新 CLI + 旧 host（桌面宿主可旧于 CLI）。

**CLI 侧双形态发送器结构**（七法统一）：

```
try {
  result = await requestClient(V4_METHODS.automationCreate, params, resultSchema)
  return result
} catch (error) {
  if (!(error instanceof ProtocolRequestError && error.code === -32601)) throw error
  // skew 回落：旧 host 无 v4 方法（-32601）。legacy 分支保留至 M3。
  return await requestClient(acodeProtocolMethods.automationCreate, legacyParams, resultSchema)
}
```

v4 与 legacy 的 **params 逐字同形**（§2.3 表），故回落不换载荷。

### 2.2 host 侧：v4 分支 + 字面量 legacy 分支（共用核心）

codeAgentService.ts 把每个方法的既有分支体提取为**核心助手**（闭包内函数），v4 与 legacy 分支共用——语义逐点不变：
- `handleAutomationCreate(data, requestId)`: safeParse → automationService.create → taskMeta sync → respond
- `handleAutomationUpdate(data, requestId)`: safeParse → automationService.update → not-found throw → respond
- `handleAutomationList(data, requestId)`: safeParse → automationService.list → respond
- `handleAutomationCheckTaskBinding(data, requestId)`: safeParse → automationService.hasTaskBinding → respond
- `handleAutomationDelete(data, requestId)`: safeParse → automationService.delete → respond
- `handleOffPeakCreate(data, requestId)`: safeParse → resolveOffPeakTaskService → grayConfig → model validation → createTask → respond
- `handleOffPeakList(data, requestId)`: safeParse → resolveOffPeakTaskService → list/filter/sort/slice → respond

legacy 分支条件从 `acodeProtocolMethods.automationCreate` 改为字面量 `"automation/create"`（偏斜期标注，M3 删除）。

### 2.3 wire 形态表（逐字重声明 / 导入来源）

新叶 `packages/shared/src/acode-protocol-v4/automation-offpeak.ts`。**零新词汇**：

| schema | 来源裁决 |
|---|---|
| `acodeAutomationProtocolSchema`（automationId/title/cronExpr/prompt/modelSelection/mode/targetTaskId/enabled/lifecycleStatus/nextRunAt/lastRunAt/runCount/recurring/maxRuns/scheduleRule） | 逐字重声明；`modelSelectionSchema` 从中立叶 `../model-selection.js` 导入；`acodeTaskModeSchema` 从中立叶 `../acode-task-mode-schema.js` 导入 |
| `acodeAutomationScheduleRuleSchema` | 逐字重声明 |
| `acodeAutomationIntervalUnitSchema` | 逐字重声明 |
| `acodeAutomationBotDeliveryTargetSchema` | 从中立叶 `../bots.js` 导入（command.ts 已有先例） |
| `nonEmptyString` / `timestampMsSchema` | 本叶重声明（同 inbound-interaction.ts 纪律） |
| `acodeOffPeakPermissionModeSchema` | 逐字重声明 |
| `acodeOffPeakTaskSnapshotSchema` | 逐字重声明 |
| `acodeOffPeakCreateResultSchema`（discriminatedUnion "ok"） | 逐字重声明 |
| 七法 params / result schemas | 逐字重声明（引用上述组件） |

transport.ts 登记（带批次节注释，照 M2-4/M2-5 格式）：
- `V4_METHODS`: `automationCreate: "v4/automation/create"` 等五条 + `offPeakCreate: "v4/offPeak/create"` + `offPeakList: "v4/offPeak/list"`（共七条）。

`packages/shared/src/acode-protocol-v4/index.ts` 增 `export * from "./automation-offpeak.js"`。

## 3. 所有权与不变量

- **workspace 注入不变量**：workspace 由 host 从当前 session 注入（`workspace.workspacePath` / `workspace.workspaceIdentity`），不进协议参数——七法一致。
- **绑定守卫不变量**：automation create 的 targetTaskId 绑定检查（automationCheckTaskBinding）与 offPeak create 的 boundSessionId 检查（offPeakList 筛选）在 CLI 端口执行，host 侧不做二次守卫。
- **失败分类不变量**：offPeak create 的失败分类（discriminatedUnion）跨协议保真，不降级为字符串。
- **skew 方向标注不变量**：所有保留的 legacy 发送点/分支必须注释写明服务的偏斜方向（新 CLI+旧 host）与删除归属（M3）。

## 4. 失败语义表

| 失败 | v4 路径 | legacy 回落路径 | 终态 |
|---|---|---|---|
| host 无 v4 方法（旧 host） | -32601 | 回落，逐点等价 | 正常 |
| params 解析失败 | host -32602 respondError | 同（既有） | port 抛错 |
| automation service 运行时错误 | -32603 respondError | 同（既有） | port 抛错 |
| offPeak service 不可用 | -32601 respondError | 同（既有） | port 抛错 |
| offPeak 失败分类（业务） | respond `{ok:false, failureStage, errorCategory, errorCode}` | 同（核心共用） | port 返回分类 |
| automation create 超限 | respondError -32603 + AutomationCreateLimitError 映射 | 同（既有） | AutomationCreateLimitError |
| checkTaskBinding 查询失败 | fail-closed（throw BIND_SESSION_CHECK_ERROR） | 同（既有） | port 抛错 |
| 连接断开（在途） | 既有断连错误 | 同（既有） | 既有终态 |

## 5. 验收

- **A**：`acodeProtocolMethods.` 七法在 packages/services/src 实测归零（11 → 4，−7；tokenized grep 自证，排除测试文件）。
- **B**：shared 协议单测 protocol-boundary.test.mjs 全绿（含本批新增：七法 wire 形态 strict/值域钉住 + 叶无反向 import legacy barrel 断言）。
- **C**：CLI 侧 port 单测：双形态发送（v4 命中 / -32601 回落两方向）。
- **D**：套件：shared / services（broker 相关）/ CLI 受影响套件全绿。
- **E**：typecheck（shared/services/bootstrap）exit 0；oxlint 本批新文件 0w/0e；architecture:check --changed new 0 / regrown 0。
