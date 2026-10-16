# Scheduled 语义补强：远程手动触发的用户激活 + 迁移可撤销裁决（T2-7）

方案条目：`C:\Users\ZhuanZ\Desktop\zoode\ACode-价值提取-Claude-2.37337.md` §T2-7。
机制参照该文档对某桌面 agent 产品 scheduled task 语义的研究产出（`runScheduledTask`
需 userActivation；迁移可撤销 + 按钮语义进遥测），按边界纪律只搬运机制设计，
实现为 ACode 自有代码，不复制任何厂商代号/事件名。

给 ACode 补两块 scheduled 语义：**A 面**「远程发起的 automation 立即执行必须携带
用户动作凭据，纯程序化调用拒绝」；**B 面**对「迁移可撤销」做现状裁决（结论：
面形态不匹配，登记不适用，见 R7）。审批 TTL 联动（无人值守 origin 默认 7 天限期）
已由波次 1-2 在 permission 侧落地（`apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md`、
`core/src/permission/ttl-approvals.ts`），本 spec 只消费不重造。

红线：**不新造触发面**（不给模型/bot 开 runNow 通道）；**不改既有桌面本地 UI 路径的
行为**（兼容窗内 desktop renderer 直连路径零变化）；闭集 reason 全部住单一纯模块，
禁止各调用点自拼字符串。

裁剪边界：activation 凭据 v1 为声明式（attested），不可伪造凭据需要 host/relay 发行
nonce——跨 desktop/relay 面，登记后续（R6）；`restart`（失败任务重排下次运行，不立即
执行）不在本批守卫范围，登记之。

---

## 背景：已核实的现状

> 行号以 feature/cli-value-extract-23737 `2864472` 检出为准。

### 手动触发链（面存在，远程可达）

1. **RPC 面**：`IACodeAgentService.runAutomationNow`
   （`packages/services/src/acode-agent/acodeAgent.ts:711`，实现在
   `acodeAgentService.ts:4374`）→ `AutomationService.runNow`
   （`packages/services/src/session/automationService.ts:453`）→
   `AutomationRepo.runNow`（`automationRepo.ts:624`：写 `trigger='manual'` 的 run 行 +
   single-flight claim）→ `onAutomationManualRunRequested` 直派
   （desktop host 注入 `dispatchManualAutomationRun`，`packages/desktop/src/host/index.ts:2259`）。
2. **远程可达性**：`IACodeAgentService` 全量经 `RemoteServiceAccess`
   （`packages/client/src/remoteServiceAccess.ts:63,133`）暴露为 channel 代理；web 客户端
   `connectViaWebSocket`（`packages/web/src/main.tsx:350`）与手机远控（复用桌面 Host
   attachment）都拿到同一代理面。**任何能说该 channel 协议的代码都能程序化调用
   `runAutomationNow`**——参数面 `ACodeAgentAutomationIdParams` 只有 workspace target +
   automationId（`acodeAgentPluginParams.ts:146`），无 origin 标记、无用户动作凭据。
3. **风险放大面**：automation run 无人值守执行且权限模式缺省放行到高档
   （`botsService.ts:5191` 注释：off-peak/automation 默认 yolo）；波次 1-2 已给无人值守
   持久批准加 7 天默认限期（TTL 联动，已落地）。「远程一条程序化调用 → 立即唤起一次
   无人值守高档执行」是 T2-7 userActivation 机制针对的确切形状。
4. **模型侧无触发面（设计现状）**：CLI `AutomationPort` 只有 create/update/list/delete
   （`apps/acode-cli/packages/contracts/src/interfaces/automation.port.ts`）；bots 入站
   只有 createTask/sendText，automation 方向仅终态回推（`watchAutomationRun`）；v4 协议
   无 automation 管理命令（只有 sendText 的 automationId 归因标记）。**本批保持该缺席**。
5. **先例**：远程入口语义守卫已有两家——`packages/shared/src/bot-remote-guard.ts`
   （纯函数 + 闭集常量、零 import、services/UI 共用）与
   `packages/services/src/bots/botPermissionLocalApproval.ts`（发起者≠批准者收口）。
   本 spec 的守卫模块沿用同款形态。

### 迁移面盘点（B 面证据）

- automation/off-peak 台账住 `tasks-index.sqlite`，迁移是**库内 additive schema 迁移**：
  `packages/services/src/session/tasksDatabase/migrations.ts` 0001-0004，checksum 冻结、
  只增不改；0002（legacy model/provider/thought_level 三列 → model_selection JSON）
  明示「旧三列原样保留」；0004 明示「nullable、additive：回滚 = 忽略该列，无需 down
  migration」。
- 不存在「把 automation 定义从本地存储迁到远端/另一存储」的 auto-migration 事件，
  不存在迁移通知按钮面，且 ACode 有 `no-telemetry` 红线（`apps/acode-cli/specs/no-telemetry.md`、
  `packages/desktop/specs/no-telemetry.md`）——参照机制里的遥测事件族
  （auto_migrated/revert_button/manual_reenable 闭集）在 ACode 无对应载体。

## 产品规则

### R1 用户激活语义（A 面核心）

远程发起的 automation 立即执行（manual run）必须携带**用户动作凭据**（activation）；
纯程序化调用（无凭据/凭据无效）拒绝，且不产生任何 run 行。语义等价参照机制的
userActivation：立即执行只能由明确的用户动作唤起，不能被脚本/代理静默触发。

凭据形状（v1，声明式）：

```ts
interface AutomationManualRunActivation {
  /** 用户动作来源，闭集。v1 只有 UI 按钮点击。 */
  source: "ui_button";
  /** 用户动作发生时刻（epoch ms），由发起端时钟填写。 */
  activatedAt: number;
  /** 关联的交互 id（幂等/审计关联键），可选。 */
  interactionId?: string;
}
```

### R2 裁决闭集（单一事实源）

守卫纯函数 `resolveAutomationManualTriggerAdmission` 是唯一裁决点，拒绝 reason 闭集：

| reason | 触发条件 |
| --- | --- |
| `activation_required` | origin=remote 且无 activation |
| `activation_expired` | activatedAt 超出新鲜窗（过旧或超前出时钟偏差容忍） |
| `activation_source_unknown` | source 不在闭集 |
| `activation_malformed` | 形状非法（非对象/时间戳非有限数等） |

admitted 时回填归一化事实 `{ origin, activation? }` 供调用点审计日志消费。

### R3 origin 由装配层声明，不由远程调用方自报

`origin` 是**传输事实**不是入参：desktop 本地 renderer IPC 装配声明 `local_ui`；
远程 channel（web socket / relay attachment / 远程服务器装配）声明 `remote`。守卫对
origin 缺席的调用按兼容窗放行（见 R5），但**一旦装配层声明 remote，凭据强制**。
把 origin 做成 wire 参数等于让程序化调用方自己选免检——禁止。

### R4 新鲜窗

`AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS = 5 * 60_000`（点击到 RPC 落地的裕量），
时钟偏差容忍 `AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS = 60_000`（activatedAt 超前
now + skew 同样按 expired 拒——未来时间戳是伪造/时钟坏的特征，不是有效动作）。

### R5 兼容窗（默认放行的唯一理由）

现状唯一调用方是 desktop agent service（UI 按钮链路），origin 未接线前按
`origin: undefined → admitted`（compat）放行，桌面本地行为零变化。兼容窗随 WSI 接线
（RPC 层按传输注入 origin + 转发 activation）关闭；接线片段随实施报告提交。
**垃圾凭据无兼容豁免**：任何 origin 下，携带了 activation 但校验失败 → 拒绝
（带坏凭据的调用比不带凭据更可疑：那是重放或伪造的形状）。

### R6 诚实边界（登记，不在本批修）

v1 凭据是可伪造的声明（远程程序化调用方可以自造 `{source:"ui_button"}`）。本批交付的
是：语义收口点（service 咽喉）、闭集 reason、新鲜窗、以及「origin 由装配层声明」的
架构位置——接线后纯程序化调用（不经过 UI 发起代码路径）默认无凭据即拒。不可伪造
凭据需要 host 在真实用户交互时发行短效 nonce（UI/relay/desktop 面，超出本波所有权），
登记为后续批次；与 bot self-approve 边界的登记方式同款（botPermissionLocalApproval
头注先例）。

### R7 B 面裁决：迁移可撤销——面形态不匹配，不适用

参照机制的「迁移可撤销 + 按钮语义进审计」预设了「用户数据被自动迁往新存储/新归属 +
用户可见的撤销按钮 + 遥测载体」。ACode 三项全缺席：automation 存储迁移是库内
additive schema 迁移（旧列原样保留 = 旧副本天然在库，回滚 = 忽略新列，0002/0004 已把
该纪律写成冻结注释）；无 auto-migration 用户事件面；no-telemetry 红线。**裁决：不造
revert 通道、不造按钮审计**；「保留旧副本」的可撤销精神已由 additive 迁移纪律承载。
若未来出现「automation 定义迁往远程存储」类产品决策，本条自动升级为必做项，闭集
outcome 词汇届时按 ACode 形态另立（不预抄 migrated/reverted/revert_button/manual_reenable）。

### R8 模型面/bot 面触发通道保持缺席

不给 CLI AutomationPort、bots 入站命令、v4 协议新增 runNow/立即执行通道。若未来产品
要求开放，必须先过 R1 守卫同款语义（spec 先行），本条是围栏不是待办。

## 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS` | 300000 | 凭据新鲜窗 |
| `AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS` | 60000 | 超前时间戳容忍 |
| `AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES` | `["ui_button"]` | 来源闭集 |
| `AUTOMATION_MANUAL_TRIGGER_REJECT_REASONS` | 见 R2 表 | 拒绝 reason 闭集 |

## 接口

- `packages/shared/src/automation-manual-trigger.ts`（新，纯模块零 import，
  bot-remote-guard 同款形态）：R1 凭据类型、R2 闭集与
  `resolveAutomationManualTriggerAdmission(input, )`、R4 常量。
  经 `packages/shared/src/index.ts` 追加一行导出（非 CLI contracts barrel，允许面）。
- `packages/services/src/session/automationService.ts`（既有文件最小改动）：
  `runNow(automationId, scope?, trigger?)` 第三参
  `{ origin?, activation? }`；拒绝时抛 `AutomationManualTriggerRejectedError`
  （携带闭集 `reason`），在 repo claim 之前拒绝——不产生 run 行、不占 single-flight 锁。
- WSI 接线（报告提交片段，本波不改其文件）：`acodeAgentService.runAutomationNow`
  按传输注入 origin、透传 activation、把拒绝映射为结构化 RPC 结果。

## 验收场景

1. origin=remote 无 activation → 拒，reason=`activation_required`，repo.runNow 未被调用。
2. origin=remote + activatedAt 超 TTL → 拒，reason=`activation_expired`。
3. activatedAt = now + 1h（超前出容忍）→ 拒，reason=`activation_expired`。
4. source="script" → 拒，reason=`activation_source_unknown`。
5. activation="yes"（非对象）/ activatedAt=NaN → 拒，reason=`activation_malformed`。
6. origin=local_ui 无 activation → 放行（本地 UI 面即用户动作面）。
7. origin 缺席（兼容窗）无 activation → 放行，行为与现状逐字节一致。
8. origin=local_ui + 过期 activation → 拒（R5 垃圾凭据无豁免）。
9. origin=remote + 有效 activation → 放行，manual run 正常产生。

## 未做与取舍

- 不可伪造凭据（host 发行 nonce）：跨 UI/relay/desktop 所有权，R6 登记。
- `restart`/`setEnabled` 的远程守卫：非「立即执行」面，风险形状不同，登记观察。
- RPC 层结构化拒绝结果（`{status:"rejected", reason}`）：参数/结果 schema 住
  acode-agent 面（WSI 所有权），本波以 typed error 收口、接线片段进报告。
- 遥测/审计落盘：no-telemetry 红线；admitted/rejected 事实由调用点 service logger
  （warn 级）承载，不新建台账。

## 第三方归属

机制参照 zoode 研究文档 §T2-7（对某桌面 agent 产品 scheduled task 语义的逆向研究
产出）；实现为 ACode 自撰 TypeScript，未拷贝任何文件、标识符或事件名。
