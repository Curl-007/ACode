# 权限 auto-deny reason 闭集 + 工具名防伪（WI-4）

状态：已实现（core/src/permission/auto-deny-reasons.ts + decision-log.ts + service.ts +
tool/executor/call-runner.ts + tool/handlers/invalid.ts）。

来源：价值提取第三轮 E1-C4（Claude desktop 权限裁决 auto-deny 链：deny 原因闭集逐条
度量 + forged_card_name「No such tool.」统一回应纪律）。对照证据
`zoode/claude-r3-reports/03-tree-rescan-main-native.md` C4 节；原文
`Claude-2.37337/src/beautified/main/index.chunk-CnuqahbP.js:6790-6830`。

## 背景与差距评估（现状侦察结论）

Claude 侧：auto-deny 逐条归因到闭集 reason（cloud_run_host_tool / forged_card_name /
internal_name_not_served_by_app / host_mcp_tool_switched_off）并逐条度量；其中
forged_card_name =「工具名不在 app 实际服务清单」→ 拒且统一回复「No such tool.」——
不解释不存在性细节、不确认命名猜测，防注入内容借模型伪造工具名做探测。

ACode 现状（本批前）差距，两处泄漏：

1. **dispatch registry-miss 回执泄漏服务清单**（tool/executor/call-runner.ts →
   tool/handlers/invalid.ts 的 K9 unknown-name 回执，specs/tooling-micro-additions.md
   R1）：回执回显请求名、给「Did you mean」就近建议（= 确认命名猜测的存在性 oracle）、
   无近似名时**列出注册表 provider 可见工具全集**（= 服务清单回显）。注入内容可以驱动
   模型逐个猜名，从回执差异中重建完整工具面并确认哪些猜测「接近真实」。
2. **deny 无闭集逐条归因**：决策日志（specs/permission-adjudication-batch2.md R2）
   只记自由文本 reason，无法本地聚合「哪类 auto-deny 发生了多少次」；contracts 已有
   PermissionDenialReason 闭集词表但 permission 服务未接线（该词表自注「分批接线」）。

K9 回执的「自修复」价值不成立依赖：本轮请求上下文里模型**已携带全量工具 schema**，
回执回显清单不提供模型没有的信息，只提供探测者想要的确认面——安全纪律压过呈现优化。
据此本 spec 取代 tooling-micro-additions.md R1 的 unknown-name 回执部分（schema 违例
回执**保留**：目标工具真实存在，逐字段违例不构成清单泄漏）。

## R1 auto-deny reason 闭集（词表）

按 ACode 实际拒绝类别建闭集（不照抄 Claude 的四个原因名）。token 复用 contracts
`PermissionDenialReason` 既有值（同语义同字符串，避免双词表漂移），ACode 特有类别在
core 本地扩展（`CoreAutoDenyExtraReason`），后续升格进 contracts 词表属跨域跟进项。

| ruleId（结构性来源） | reason token | 语义 |
| --- | --- | --- |
| `rule.policy.deny` | `policy_denied` | 托管策略地板 deny |
| `rule.disallowedTools` | `disallowed_tool` | 用户/策略显式禁用 |
| `rule.skillActivation.deny` | `skill_activation_denied`（本地扩展） | 技能激活期 disallowed-tools |
| `rule.project.deny` | `project_rule_denied` | 项目权限规则 deny |
| `mode.plan.nonReadOnly` | `plan_mode_requires_read_only` | plan 只读约束 |
| `mode.plan.exitOnly` | `plan_mode_transition_denied`（本地扩展） | ExitPlanMode 非 plan 态 |
| `breaker.*`（前缀） | `breaker_denied` | 旁路免疫熔断器 deny 级 |
| `gate.bashConfirmReflex.*`（前缀，判定复用 isBashReflexGateRuleId） | `reflex_gate_denied`（本地扩展） | Bash 反射门首轮 deny |
| `mode.dontAsk`（DONT_ASK_RULE_ID） | `dontask_mode_denied` | dontAsk 模式不弹卡 deny |
| `dispatch.forgedToolName`（本批新增，FORGED_TOOL_NAME_RULE_ID） | `forged_tool_name`（本地扩展） | 工具名不在实际服务清单（含空名） |

分类纪律：
- **结构性分类**（ruleId 精确匹配 + 前缀），不做自由文本正则解析——ruleId 是仓库内部
  常量，不是外部输入；
- 映射不了的 ruleId 返回 `undefined`，**不猜**（对齐 error-taxonomy-injection-defense.md
  R1 分类器纪律）；日志条目此时缺 `denyReason` 字段，自由文本 reason 照记；
- MCP 逐工具开关关闭在 ACode 表现为「名字不在注册表」，统一折叠进 `forged_tool_name`
  （回应侧本就不区分，度量侧同 token；不另设 host_mcp_tool_switched_off 类）。

### 词表扩集纪律（第二轮教训）

新增/更名 token 必须全链 grep 同步，核对清单：
1. `core/src/permission/auto-deny-reasons.ts`：`CoreAutoDenyExtraReason` 常量 + 类型 +
   `AUTO_DENY_REASONS` 成员表 + `classifyAutoDenyRuleId` 映射；
2. contracts `PermissionDenialReason`（若复用/升格 token）：reasons.ts 词表 +
   reasons-classify.ts 文本分类器（如有对应文案）；
3. 消费面：decision-log 条目字段（`denyReason`）、service.ts 终局漏斗、call-runner
   forged 路径；
4. 守护测试：tests/permission-auto-deny-reasons.test.mjs 的「token 形态 + 唯一性 +
   ruleId 全覆盖」三个结构性断言（新增 deny ruleId 未配 token 时全覆盖断言红）。

当前闭集无 zod enum 面（decision-log 是本地 JSONL，不过 wire）；若 denyReason 未来
进协议面，需在 packages/shared 协议 zod schema 同步建 enum（列入扩集清单第 5 条）。

## R2 逐条本地度量（decision-log，no-telemetry 红线）

- `PermissionDecisionLogEntry` 增加可选字段 `denyReason?: string`（闭集 token）；
  自由文本 `reason` 保留（诊断通道），两者并存不互替。
- 落点唯一：`PermissionService.checkPermission` 终局漏斗（批 2 R2 既有单漏斗）——
  deny 决策逐条经 `classifyAutoDenyRuleId` 归因后写日志。
- forged 路径不经 PermissionService（registry-miss 发生在权限裁决之前），由
  `recordForgedToolNameDenial`（auto-deny-reasons.ts 导出，permission 域拥有词表与
  条目构造）在 dispatch 处逐条落日志，ruleId=`dispatch.forgedToolName`、
  mode=当前协作模式（缺席时 `dispatch`）。
- 红线不变：env `ACODE_PERMISSION_DECISION_LOG=1` 门控、本地 JSONL、零网络出口、
  写入失败静默、关闭态零 IO。**禁止**把 reason token 送任何外部遥测。
- 日志内的工具名是外部可控自由文本：forged 路径记录前截断到
  `FORGED_TOOL_NAME_LOG_MAX_CHARS`（200，对齐 reason 截断纪律），防日志膨胀；
  JSONL 序列化本身处理注入形态。

## R3 工具名防伪统一回应

模型调用的名字不在实际服务清单（registry miss，**含空名/空白名**）时：

- provider 可见回应统一为常量 `NO_SUCH_TOOL_MODEL_RESPONSE` =
  `<tool_use_error>Error: No such tool.</tool_use_error>`；
- **不回显请求名**（不确认「这个名字接近/远离真实」）、**不列注册表清单**、
  **不给就近建议**、不区分「拼错」与「伪造」、不解释 invalid 载体等内部细节；
- 失败分类（CoreErrorType.ToolNotFound）、ToolCallError 事件、遥测 span、
  「畸形调用零工具执行」不变——错误 message（`Tool not found: X`）只进本地日志/UI
  诊断通道，不是 provider 可见面；
- `invalid` entry 的 handler（模型主动调 invalid）同样返回统一回应——两条路径
  （registry-miss / 主动调载体）呈现一致，且不再借 handler 回显清单；
- invalid.ts 的 unknown-name 回执机器（formatInvalidUnknownToolReceipt /
  suggestToolNames / 编辑距离 / 清单投影）随之删除；schema 违例回执保留原样。

已知域外同类泄漏点（本批不改，跨域跟进）：
- `core/src/memory/memory-agent-loop.ts:368`：memory agent 自有 loop 的 unknown-tool
  回应仍回显名字（无清单回显，泄漏面较小）；
- dispatch 的 `deferredRejectionReason` 分支（tool-search.md R6，另一代理作用域）
  回显配置错误文案。

## 失败语义

- 分类失败（ruleId 无映射）→ 日志缺 denyReason 字段，决策本身零影响；
- 日志写入失败 → 静默（批 2 R2 既有），权限/分发链路不阻断；
- forged 回应是常量，无失败面；registry-miss 的 ToolNotFound 错误链保持
  recoverable: false。

## 验收场景

1. disallowedTools / plan 非只读 / dontAsk / 项目 deny / 策略 deny 各自产生 deny 时，
   决策日志条目带对应闭集 denyReason token；
2. 未知工具名（近似名、无近似名、空名三形态）经 executor 得到的 modelContent
   逐字节等于统一回应常量，不含请求名、不含任何注册表工具名；
3. 未知工具名调用在决策日志留下 deny + forged_tool_name 条目（含截断：>200 字符的
   名字截断记录）；
4. classifyAutoDenyRuleId 对 R1 表内全部 ruleId 返回对应 token，对未知 ruleId 返回
   undefined；全部 token 过形态白名单且互不重复；
5. 模型主动调 invalid（entry handler 直调）得到同一统一回应；
6. schema 违例回执行为不变（K9 保留面回归）。
