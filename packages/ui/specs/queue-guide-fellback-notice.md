# 引导内联失败回退队列的可见标注（queue-guide-fellback-notice）

修 bug「引导模式失败在对话中会被吞掉」。本 spec 是行为改动的先行契约（AGENTS.md
「spec 先行」）。

## 背景（已核实的现状）

- 用户在「引导」followup 模式下、对进行中的任务发补充引导：`sendText` 经 v4 命令面
  按 `inputRouting.mode="guide"` 提交，Core `admitPrompt` 若当前轮 steerable 则内联
  steer（`core/src/runtime/methods/prompt-admission.ts:59-73`），否则走 `enqueueDeferredInput`。
- 当引导在当前轮**没有可用 model-step / tool batch 边界**可内联时（工具执行中、
  turn 纯文本收口、turn 被中断），Core 的 `fallbackPendingGuidesToQueue`
  （`core/src/runtime/methods/steering.ts:472-520`）把该引导**原地改投普通 queue**，
  并发 `TurnSteerDeliveryChanged` 事件（触发点：`turn-stop.ts:222` noToolBoundary、
  `turn.ts:774` turnInterrupted、`turn-tools.ts:462`）。
- 投影**已经**把回退事实写进 QueueItem（`bootstrap/.../product-projection.ts`
  `onTurnSteerDeliveryChanged`）：`delivery.admitted: "guide"→"queue"`、
  `delivery.fallbackReasonCode`、`steer: { state: "fellBack", reasonCode }`。
- 回退后 `delivery.admitted` 不再是 `guide`，`pendingGuideProjection.ts` 把该项从
  「等待引导当前任务…」的 `ConversationPendingGuideList` 移出、落进
  `ConversationQueuePanel`。**但 `ConversationQueuePanel` 的 `QueueRow` 从不读
  `item.steer`**（全仓 grep：`packages/ui` 对 `.steer` / `fellBack` / `fallbackReasonCode`
  零消费）。
- 结果：引导消息 ACK 已 accepted（无报错横幅），内联失败后从「引导中」静默降级成
  一条普通排队消息，用户看不到任何「引导未生效、已转排队」的说明 —— 即「被吞掉」。

**已排除**：孤儿事件 `TurnSteerRejected`（core `rejectTurnSteer` 发出、投影/映射/wire
枚举均无消费者）不在本 bug 的用户路径上 —— 用户直接 `sendText` 的 steer 拒绝走 ACK
失败路径（`prompt-turn.ts:160` → gateway failed ACK → `SessionPane.tsx:2434` send-failed
横幅），用户已有反馈。本次不动它（避免协议字段变更与内部 steer 信号外泄）。

## 产品规则

**R1 fellBack 项必须在队列面板可见标注。** `ConversationQueuePanel` 渲染 QueueItem 时，
若 `item.steer?.state === "fellBack"`，在该项文本下方渲染一条本地化提示：
「引导未生效，已转入队列」。提示是**附加说明**，不改变该项作为普通 queue 项的既有
行为（仍可拖拽排序、编辑、立即发送、删除）。

**R2 尽量带 reason 的可读映射。** `steer.reasonCode` 是有限闭集
（core 产出的三个值），逐一给可读文案：

| reasonCode | 触发时机 | 文案要点 |
| --- | --- | --- |
| `guide.noToolBoundary` | 当前轮无可用工具批次边界内联（工具执行中 / 纯文本收口） | 当前任务没有可插入引导的时机，已排队 |
| `guide.turnInterrupted` | 当前轮被中断（stop / 取消） | 当前任务已中断，引导已排队待续 |
| `guide.attachmentsUnsupported` | 引导携带附件（内联不支持附件） | 引导带附件不支持内联，已排队 |
| 其他 / 缺省 | 未知或旧投影未带 reasonCode | 通用兜底：引导未生效，已转入队列 |

无法映射的 reasonCode 一律落到通用兜底文案，不显示裸码、不报错。

**R3 只在确证的 fellBack 路径渲染，不新增兜底分支。** 非 fellBack 的 QueueItem
（`steer.state` 为 `notRequested` / `submitting` / `steering` / `guided`）渲染零变化。
`item.steer` 是 `QueueItem` 的必填字段（`conversationInputSteerSchema`，非 optional），
读取用可选链只为容忍旧快照/畸形投影，不额外造第二套状态判断。

## 状态所有者

| 事实 | 唯一所有者 | 本次变化 |
| --- | --- | --- |
| 引导回退队列的判定与 `steer.state="fellBack"` + `reasonCode` | Core `fallbackPendingGuidesToQueue` + 投影 `onTurnSteerDeliveryChanged` | 不变（已产出） |
| `QueueItem.steer` 协议字段（含 fellBack 枚举） | `packages/shared/src/acode-protocol-v4/input-intent.ts` `conversationInputSteerSchema` | 不变（已存在） |
| fellBack 的**用户可见呈现**（唯一消费者） | `packages/ui/src/v4/ConversationQueuePanel.tsx` `QueueRow` | 新增渲染分支 |
| reasonCode → i18n 文案 id 的映射 | `packages/ui/src/v4/queueSteerFellback.ts`（新增纯函数） | 新增 |

投影层是 fellBack 事实的生产者，UI 层是唯一消费者；不新增第二处回退判定。

## 接口

- `packages/ui/src/v4/queueSteerFellback.ts`（新增，纯函数、无 React 依赖）：
  `resolveGuideFellBackMessageId(reasonCode?: string): string` —— 返回 i18n message id
  （闭集三个 reasonCode 各一条 + 通用兜底一条）。抽纯函数便于 node:test 直测
  （对齐 `speedLabels.ts` 先例）。
- `ConversationQueuePanel.tsx` `QueueRow`：`item.steer?.state === "fellBack"` 时，
  文本 `<span>` 之后渲染一条 `text-ui-xs text-foreground-subtlest` 提示行，文案来自
  `intl.formatMessage({ id: resolveGuideFellBackMessageId(item.steer.reasonCode) })`。
  复用既有排版 token（DESIGN.md：弱元数据用 `text-ui-xs` + `text-foreground-subtlest`），
  不引入新组件库依赖。

## i18n 键清单

`chat.queue` 命名空间下新增（zh-CN + en-US 同批）：

- `chat.queue.turnSteer.fellBack`（通用兜底）
- `chat.queue.turnSteer.fellBack.noToolBoundary`
- `chat.queue.turnSteer.fellBack.turnInterrupted`
- `chat.queue.turnSteer.fellBack.attachmentsUnsupported`

既有死键 `chat.queue.turnSteer.steering` / `chat.message.turnSteer.guided` 本次**不激活**
（保持最小 diff；它们属于「引导中/已引导」状态呈现，与本 bug 的 fellBack 提示无关）。

## 验收场景

1. **投影往返**：Core 发 `TurnSteerQueued`（guide，steerable）→ QueueItem.steer="steering"；
   再发 `TurnSteerDeliveryChanged`（admittedDelivery="queue", fallbackReasonCode="guide.noToolBoundary"）
   → QueueItem.steer="fellBack" + reasonCode 存活；全部 delta 与 snapshot 过既有 wire schema。
2. **reasonCode 映射**：三个闭集 reasonCode 各映射到自己的文案 id；未知/缺省映射到通用兜底 id。
3. **UI 渲染分支**：`QueueRow` 源码含 `item.steer?.state === "fellBack"` 判定与
   `resolveGuideFellBackMessageId` 接线；非 fellBack 路径不渲染该提示。
4. **既有行为零回归**：fellBack 项仍是普通 queue 项（拖拽/编辑/立即发送/删除入口不变）。

## 不在本项范围

- 孤儿 `TurnSteerRejected` 的投影消费（见「已排除」；需协议字段变更，另议）。
- `chat.queue.turnSteer.steering` / `chat.message.turnSteer.guided` 死键的激活。
- 手机 Web 专属布局调整（提示行是窄文本，复用队列项既有响应式容器，无额外断点）。
