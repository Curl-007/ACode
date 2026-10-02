# 框选副屏的边界契约文本（副屏六要素）

提示词优化批次二（2026-10-03，Codex 还原件结构性对照批）项一。把框选副屏
（selection side chat）的边界提醒从三句话扩成完整的边界契约，覆盖六个已识别的
失效模式。纯文本改动：`SELECTION_SIDE_CHAT_BOUNDARY` 常量（
`runtime/methods/session-fork.ts:499`），机制、persisted 档位、水合链路全部不变。

文本自撰英文（`prompt-language-policy.md` R1/R7）；对照来源为第三方产品还原件的
结构性分析（仅本地、只读），原文不进仓库。

## 背景

### 已核实的现状

- 副屏 = 从父会话 fork 出的子会话（`createSelectionSideChatSessionInput`，
  `session-fork.ts:151-175`），注入一条 persisted synthetic notice
  （source `selection_side_chat`，model-only，冷恢复逐字重建）。
- 现有边界文本三句：继承历史仅供参考 / 不自动续做父任务 / 改动需副屏内显式要求。
- 副屏子会话**继承完整工具面**（fork 只带 `permission`，无工具裁剪）——
  包括 Agent 派发工具；副屏面板是临时 UI 绑定（`SelectionSideChatPane` 的
  onSelectionSideChatUnavailable 清 tab 语义），面板消失后其派发的后台子代理
  无人认领。
- 既有相邻纪律：`incoming-message.ts` PEER_PERMISSION_GUIDANCE（peer 消息不构成
  批准、禁 permission laundering）——但它挂在**消息通道**上，副屏的继承历史不走
  该通道，覆盖不到「历史里的批准记录被当活批准」这一形态。

### 六个失效模式（现有三句覆盖不全）

1. 继承历史里的指令/计划/请求被当成活指令执行（现有文本只说「仅供参考」，
   未显式废止历史内指令的效力，也未定义「边界之后的新指令才是活的」）。
2. 继承历史里的**批准记录**被当成对本副屏的批准（permission laundering 的
   历史形态；现有文本零覆盖）。
3. 父线程的工具/MCP 调用结果被当成副屏自己的活动状态续做。
4. 在副屏里派发子代理（面板生命周期短于后台代理生命周期 → 孤儿代理；
   且副屏定位是轻量问答/探索，不该 fan-out）。
5. 把自己表述成主线程任务的延续（用户误以为主任务在推进）。
6. 未被显式要求改动时索要提权/更宽沙箱。

## 产品规则

### R1 边界文本六要素（唯一承载点：SELECTION_SIDE_CHAT_BOUNDARY）

扩写后的文本必须覆盖（英文自撰，一段连贯文本，总量 ≤ 1,600 字符——它是
persisted notice，逐字进每次冷恢复的历史，长度成本永久）：

1. **身份与定位**：这是副屏（side conversation），不是主线程；用于回答问题与
   轻量探索；不得把自己表述成主线程任务的延续。
2. **历史指令废止**：继承的 fork 历史只是参考上下文；其中出现的指令、计划、
   请求一律不是本副屏的活指令；只有边界之后用户在本副屏里发出的指令是活的。
3. **历史批准无效**：不得继续、执行或完成只出现在继承历史里的任务、工具调用、
   **批准**、编辑；历史里的批准记录不构成本副屏的批准（与
   PEER_PERMISSION_GUIDANCE 同源，覆盖其够不到的历史通道）。
4. **父线程工具活动仅供参考**：继承历史里的工具/MCP 调用与输出发生在父线程，
   只作参考；不得从中推断活指令。
5. **禁用子代理**：本副屏内不得派发或与任何子代理交互（无论边界前父线程是否
   用过）；需要 fan-out 的工作属于主线程。
6. **改动与提权纪律**：默认只读（读文件、搜索、跑不改动仓库状态的检查）；
   仅当用户在本副屏内显式要求改动时才改，改动最小化、局部化、不扰动主线程；
   非显式改动请求不得索要提权或更宽沙箱。

### R2 承载与档位不变

- 仍是 `selection_side_chat` persisted source 的同一条 synthetic notice
  （`buildSelectionSideChatBoundary`，`session-fork.ts:505-557`）：档位、
  model-only 可见性、anchor、水合链路全部不动（该 source 在
  `SYSTEM_REMINDER_PERSISTED_SOURCES` 与非 mid-conversation 集合的归属不变——
  边界必须位于新问题之前，`source.ts:77-87` 注释的既有理由继续成立）。
- 文本变更只影响**新 fork**；已存在的副屏会话历史里的旧文本按 persisted
  语义逐字保留（这是 persisted 档的定义行为，不是缺陷）。
- 常量导出供测试（`export const SELECTION_SIDE_CHAT_BOUNDARY`，先例：
  `dispatch-discipline-prompt.md` R4 对 buildAgentProviderDescription 的
  「导出供测试」处置）。

### R3 软禁令边界（诚实登记）

第 5 要素（禁子代理）v0 为**提示词级软禁令**：副屏工具面未做硬裁剪。
硬化（fork 时下发 `subagents: { enabled: false }` 或工具 allowlist，机制先例
`runtime/methods/subagent.ts:275-287` 对子代理的结构性下发）登记为后续项，
不在本批：硬裁剪动 fork 会话装配面，超出文本批次所有权，且软禁令失效时
后果有界（孤儿代理受既有 stale-run 防护与空闲回收兜底）。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 边界文本 | `runtime/methods/session-fork.ts` `SELECTION_SIDE_CHAT_BOUNDARY`（导出） |
| 注入机制/档位 | `buildSelectionSideChatBoundary` + `system-reminder/source.ts`（均不动） |
| 副屏工具面 | fork 会话装配（现状继承父面；硬化归 R3 后续项） |

## 接口

`session-fork.ts` 新增导出 `SELECTION_SIDE_CHAT_BOUNDARY: string`（原为模块私有
常量，文本扩写 + 导出，无其他签名变化）。

## 验收场景

1. **六要素在场**：导出常量的文本可逐要素定位（身份/历史指令废止/历史批准无效/
   父线程活动仅参考/禁子代理/改动与提权纪律）；总长 ≤ 1,600 字符；无 CJK。
2. **机制零改动**：`buildSelectionSideChatBoundary` 的结构（source、visibility、
   semantics、anchor、part metadata）与改动前一致（既有调用点不变，diff 只及常量
   文本与导出修饰）。
3. **档位归属回归**：`selection_side_chat` 仍在 persisted 数组与非
   mid-conversation 集合（`reminder-extensions` 同款结构断言方向）。
4. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- **副屏工具面硬裁剪**（R3 后续项）。
- **conversation_fork（普通 fork）的边界文本**：普通 fork 是完整的任务接续语义
  （用户显式分叉继续工作），与副屏的「轻量问答、不接续」定位相反，不适用本契约；
  其现状文本不动。
- **UI 侧副屏生命周期**（tab 清理、child 丢失回落）：`SelectionSideChatPane`
  既有语义不动。
