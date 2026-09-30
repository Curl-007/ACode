# jcode 对照升级交接文档（HANDOFF）

> **给接手的模型/工程师**：本文记录 jcode 对照升级（J1/J2/J3 三批次 8 个实施条目）的完整状态——逐项的 spec 落点、测试文件、门禁结果、独立评审结论、遗留风险与已知未覆盖项。读完本文即可接手后续批次，无需回溯实施会话。
>
> **最后更新**：2026-09-30。**基线**：`dev/0.0.1` @ `8b95943`；**全部改动留在工作区、未做任何 git 操作**（本轮实测 `git status --porcelain` 共 77 条改动/新增，HEAD 仍为 `8b95943`）。
>
> 计划全文见 [`docs/jcode-inspired-upgrade-plan.md`](jcode-inspired-upgrade-plan.md)（其状态头与「优先级总览」表已随本文同步）；本文件是「实施进度 + 接手须知」，与计划互补。格式参照 [`docs/security-hardening-handoff.md`](security-hardening-handoff.md)。
>
> **本轮（交付记录员）核实范围声明**：文件存在性、spec 章节结构、关键代码符号、git 工作区状态、以及个别标注「本轮实测」的命令（如 contracts dist 重建）——均已亲自核实并在文中标注。**本轮未复跑任何测试或门禁**；所有测试计数与门禁 exit 码引自「实施状态记录」（出处与可得性见 **§1.1**），接手后请按 §2 复跑确认。

---

## 0. 一眼看懂当前状态

| 项 | 状态 | spec（均已落盘，已核实） | 测试文件 | 独立评审结论 | 结论 |
|---|---|---|---|---|---|
| **J1-1** bash 目标 blast-radius 分级 | ✅ 已实施 | `apps/acode-cli/specs/bash-target-blast-radius.md` | `apps/acode-cli/tests/bash-target-blast-radius.test.mjs` | 首轮判不通过（4 条 catastrophic 绕过）；12 条 actionable findings **全部修复** | ✅ 可合并 |
| **J1-2** Confirm 反射门 | ✅ 已实施（审计落盘由评审修复轮补全） | `apps/acode-cli/specs/bash-confirm-reflexive-gate.md` | `apps/acode-cli/tests/bash-confirm-reflexive-gate.test.mjs` | 首轮判不通过（反射 prompt 被截断、审计未落盘）；随 J1 批 12 条 findings 修复闭环 | ✅ 可合并 |
| **J1-3** 压缩不变量审计与修正 | ✅ 已实施（部分受阻：B1–B5 五条边界外残留 + 一条未编号验证缺口） | `apps/acode-cli/specs/compact-invariants.md` | `apps/acode-cli/tests/compact-invariants.test.mjs` | 评审放行（「修正未触碰 contracts 共享投影」） | ✅ 可合并；B1–B5 定义见 §3、登记见 §6.1 |
| **J1-4** 配置持久化审计 + 文档同步 | ✅ 已实施（存量「去物化」迁移留产品决策） | `apps/acode-cli/specs/config-persistence-audit.md` | `packages/services/tests/settingsExplicitKeyPersistence.test.mjs` | 评审放行（「修复本体正确且测试为真行为测试」） | ✅ 可合并；观察项见 §6 |
| **J2-1** todo 置信度语义协议 | ✅ 已实施（CLI 侧闭环；协议/UI 投影为后续批次） | `apps/acode-cli/specs/todo-confidence-semantics.md` | `apps/acode-cli/tests/todo-confidence-semantics.test.mjs`、`todo-dependency-fields.test.mjs` | 评审**干净通过** | ✅ 可合并；投影 5 文件见 §6 |
| **J2-3** workflow 类型化 artifact + gate 点名 | ✅ 已实施 | `apps/acode-cli/specs/workflow-typed-artifacts.md` | `apps/acode-cli/tests/workflow-typed-artifacts.test.mjs` | 核心正确 + 2 条 medium，**均已修复** | ✅ 可合并；字面通道取舍见 §6 |
| **J3-1** Provider Doctor 分档诊断 | ✅ 已实施（3 处接线超出「仅 run.ts」字面边界，需所有者确认） | `apps/acode-cli/specs/provider-doctor.md` | `apps/acode-cli/tests/provider-doctor.test.mjs` | 首轮判「需修后再合」；3 条 actionable findings **全部修复** | ✅ 可合并；边界说明见 §6 |
| **J3-2** 记忆注入 fail-closed 重验证 | ✅ 已实施 | `apps/acode-cli/specs/memory-injection-fail-closed.md` | `apps/acode-cli/tests/memory-injection-fail-closed.test.mjs` | 骨架扎实；not-found 分类 mismatch 已修复 | ✅ 可合并；OB-2 见 §6 |
| J2-2 / J3-3 | 评估项，维持登记未实施 | — | — | 未送审（按计划不排期） | — |
| J4-1..6 | 登记不立项，维持 | — | — | 未送审 | — |

**当前状态一句话**：三批次 8 个实施条目全部落地；三轮独立评审共 26 条 findings（17 actionable）**全部核实成立并修复、无驳回**；编排脚本终验门禁全绿（§5）；**8 个条目（即全部实施条目）各有后续登记项**（§6.1 逐项表逐一对应：J1-1 paths.ts 重构、J1-2 双链路人工验证、J1-3 的 B1–B5 与 413 端到端未验证、J1-4 去物化迁移、J2-1 协议/UI 投影 5 文件、J2-3 字面通道取舍、J3-1 边界确认与出口口径、J3-2 的 OB-2——其中多数跨所有权边界），最大的两块未闭合面是 J2-1 的协议/UI 投影与 J1-3 的 413 接线点。

---

## 1. 工作区与提交状态

- 基线 `dev/0.0.1` @ `8b95943`（本轮 `git log` 已核实）。**本批全部改动留在工作区，未 commit/push/merge**（`git status --porcelain` 77 条，已核实）。
- 关键新增（均已核实存在，未入库）：
  - CLI：`core/src/tool/handlers/bash-target-risk/`（8 文件）、`core/src/permission/bash-confirm-reflex-gate.ts`、`core/src/compact/payload-recovery.ts`、`core/src/memory/recall/pending.ts`、`core/src/workflow/{typed-artifact,artifact-gate}.ts`、`adapters/src/doctor/`（18 文件）、`cli/src/provider-doctor-command.ts`、`contracts/src/tools/todo-confidence.ts`、`adapters/src/storage/session-store/migrations/0024-todo-confidence-json.ts`（已核实登记于 `migrations.ts:940`）；
  - root 侧：`packages/services/src/setting/explicitSettingsPersist.ts`、`packages/ui/src/lib/{permissionJustification,rawToolCallPayload}.ts`、`packages/ui/test/permissionJustification.test.ts`；
  - 8 篇新 spec 全部落盘 `apps/acode-cli/specs/`（已核实，各 123–489 行，含产品规则 R 条目/审计表/验收场景）。
- 修改文件覆盖 `adapters/bootstrap/cli/contracts/core` 与 `packages/{services,ui}`（含 `PermissionDialog.tsx`、i18n locale、`settingService.ts`、`security-hardening-plan.md` 状态头——后者已核实为「P2 已实施（2026-09-30 核实代码+spec 俱在）、P3 未开始」）。

### 1.1 「实施状态记录」是什么、在哪（读本文前先看）

本文所有**未**标注「已核实/本轮实测」的测试计数、门禁 exit 码、评审 findings 与修复证据，均引自同一份**实施状态 JSON**——编排脚本在本文撰写会话开工时**内联交付**的任务书附件，四段结构：`items`（逐项实施记录）、`reviews`（三轮评审 verdict + findings + 逐条修复 outcomes，含复现命令与修法取舍）、`gates`（各批与终验门禁 exit 码）、`pendingBlockers`（跨所有权登记）。

**该 JSON 未作为文件落盘**（本轮已检索：工作树 `grep -rl "全量终验绿" . --include="*.json" --include="*.jsonl"` 为空；`.zcode/workflows/`、`subagents/workflows/`、`~/.zcode/workflows/` 三个常见工作流目录 `ls` 均不存在/为空）。产出 `gates` 段的检查序列由调度方在各批次完成时统一执行，**脚本名未随任务书提供**。因此：

- 需要**某条评审 finding 的复现命令或终验门禁原文**时：向编排会话/调度方索取原始 JSON（`reviews.*.fix.outcomes` 段是逐条原文的所在），或以本文 §3/§4 摘录为索引、按 §2 复跑复核；
- 本文 §3–§5 是该 JSON 在仓内的**唯一完整摘录**，本文件即是权威交接载体；
- 建议调度方后续把原始 JSON 与 run journal 一并归档，消除这个断链。

---

## 2. 如何跑门禁与测试（务必按此，否则误判）

```bash
cd /c/Users/ZhuanZ/Desktop/ACode

# CLI 测试必须 --import tsx（裸 node --test 解析不了内部 .js→.ts 导入）
node --import tsx --test apps/acode-cli/tests/<file>.test.mjs
# 全量：本轮实测 apps/acode-cli/tests 下共 37 个 *.test.mjs（ls | wc -l 核实）
node --import tsx --test apps/acode-cli/tests/*.test.mjs

# 本批两个非 CLI 测试（漏跑即漏掉 J1-4 与 J1-2 的 UI 投影部分；.ts 文件同样走 tsx loader）
node --import tsx --test packages/services/tests/settingsExplicitKeyPersistence.test.mjs   # J1-4
node --import tsx --test packages/ui/test/permissionJustification.test.ts                  # J1-2 UI 投影
# J1 修复轮记录的 UI 4 文件组合（前三个为既有 UI 回归，第四个为本批新增，均已在盘核实）：
node --import tsx --test packages/ui/test/botPermissionFallback.test.ts packages/ui/test/openExternalTarget.test.ts packages/ui/test/providerIssueWarnings.test.ts packages/ui/test/permissionJustification.test.ts

# root 门禁（与 security handoff §2 同一套）
pnpm typecheck                          # 期望 exit 0
pnpm lint                               # 期望 0 error / 76 warnings（基线值）
pnpm architecture:check -- --changed    # 期望 0 violations

# CLI 子工作区逐包 typecheck（root typecheck 不覆盖 apps/acode-cli）
cd apps/acode-cli
for p in adapters bootstrap core contracts dynamic-workflow; do
  node node_modules/typescript/bin/tsc -p packages/$p/tsconfig.json --noEmit
done
# bootstrap/cli 的 tsc 需先重建 adapters/contracts/core 的 gitignored dist（package exports 指向 dist），
# 重建命令＝上面的循环去掉 --noEmit（本轮已实测 contracts 一包 exit 0 并产出 dist/index.{js,d.ts}）：
for p in contracts core adapters; do
  node node_modules/typescript/bin/tsc -p packages/$p/tsconfig.json
done
# 注意：cli 包有 67 条既有 @acode/tui TS2307 环境红（tui/dist gitignored 未构建），非本批引入。
cd ../..
```

三个既有基线红与其它环境陷阱见 §7。

---

## 3. 逐项明细

> 每项的「验证」小节引自实施/评审修复会话的自跑记录（出处见 §1.1）；除标注「已核实/本轮实测」者外，本轮未复跑。
>
> **关于「全量 CLI」用例数序列**（371→396→381→336→453→503/508）：这些数字是**不同实施/修复会话在不同时刻的快照**——三个批次的实施会话并行工作、测试文件随批次陆续新增，各会话跑「全量」时盘上的文件集不同，因此该序列**不是单调递增的可比序列**（J1-3 会话的 336 与 J1-2 会话的 381 分属不同时刻的盘面，时序错位属正常）。状态记录未保留各快照的文件清单，**无法逐一对账**；权威口径是终验门禁（38 个文件 exit 0，§5）与盘上文件集（本轮实测：CLI 37 个测试文件 + services 1 个 + UI 1 个），接手后按 §2 复跑取当次数。

### J1-1 · bash 目标 blast-radius 风险分级 —— ✅ 已实施

- **实现**：新纯函数模块 `core/src/tool/handlers/bash-target-risk/`（三平台路径保护表、wrapper 逐层解包、`sh -c`/命令替换递归、`find -delete/-exec`、管道升级、`HOME=` 重赋值、未解析 `$` 绝不 normalize、AST 盲区词法 fallback），接线三处——`bash.ts` capability 取更严者合并（confirm/catastrophic→critical）、`bypass-immune-breakers.ts` 注册首个 **deny 级**命中类 `breaker.bashTargetCatastrophic`（已核实 `bypass-immune-breakers.ts:81`；yolo/build 均直接 deny、任何论证不解锁）、规则建议对 confirm+ 收窄为精确命令。
- **spec**：`apps/acode-cli/specs/bash-target-blast-radius.md`（347 行，R1–R6 + 验收矩阵，已核实）。
- **测试**：`apps/acode-cli/tests/bash-target-blast-radius.test.mjs`（含 `(review F0)`–`(review F8)` 评审修复用例）。
- **验证**（实施会话自跑）：新测试 35/35；全量 CLI 371/371；tsc core 通过；root lint 0 error/76 warning 与基线一致；architecture:check --changed 0 违规；knip 新模块零未用导出。
- **评审结论与修复**：首轮评审判「不通过」——catastrophic 绝对 deny 层有 4 条可复现绕过（brace 展开 `find ~/{.ssh,.gnupg} -delete`、`rm -rf C:/Users` 在 yolo 下静默 allow；`\\?\` 前缀与子壳重定向把绝对 deny 降级）。修复轮 12 条 actionable findings **全部核实成立并修复**，要点：brace 组合展开后分级（组合上限 128、深度 6，超限 fail-closed→confirm）；Windows 精确保护表补 `<盘>:/Users`；`\\?\`/`//?/` 扩展长度前缀在 glob 判定**之前**剥除；词法 fallback 分级 truncate 重定向（`>&word` 非数字等价截断写）；受信 Windows 环境变量表（%WINDIR% 等 10 项 + PowerShell `$env:`，刻意不收 %TEMP%）；文件名位 glob 三级优先级（父目录递归受保护→catastrophic）；`HOME=` 改**赋值位**判定（消除 `grep HOME= f` 误报）；ruleId 按实现统一为 `breaker.bashTargetCatastrophic`（改 spec 侧）；JS 生态删除路径入表（rimraf + npx/bunx/pnpm exec 等 wrapper）。修复轮自跑 396/396（33 文件）+ 全套门禁绿。
- **遗留风险/已知未覆盖**（spec R6 登记）：heredoc body 不评估；package.json script 体与 JS 源里的删除本层看不见；`apps/acode-cli/packages/core/src/tool/handlers/bash-target-risk/paths.ts`（保护表 + 路径比较逻辑所在）现 **980 行**（本轮 `wc -l` 实测；状态记录写作 979），超 CLI 内部 max-lines 400（该规则 core 里已被约 30 个既有文件违反、不在根门禁内）——**建议作为后续独立重构项**（§6.1），勿在本 diff 上拆（拆分有引入缺陷风险且会淹没修复 diff）。

### J1-2 · Confirm 反射门（justification 协议） —— ✅ 已实施

- **实现**：`core/src/permission/bash-confirm-reflex-gate.ts` 在 PermissionService 收口处、无熔断器命中时叠加——confirm 级 Bash 首次调用 deny+四问反射 prompt（不披露阈值/级别名）；会话级挑战登记（命令 SHA-256+nonce，cap 256）防预填；重提需 ≥25 字符且非纯确认词的 justification：ask lane 收敛 ask（reason 携原文）、yolo lane 无效→breakerAsk、有效→auditedAllow+结构化审计。contracts `BashInputSchema(.strict)` 加可选 `justification(max 4000)`（已核实 `contracts/src/tools/bash.ts:76`）；UI PermissionDialog 论证展示段（`packages/ui/src/lib/permissionJustification.ts`，en/zh i18n）。
- **spec**：`apps/acode-cli/specs/bash-confirm-reflexive-gate.md`（230 行，R1–R8，已核实）。
- **测试**：`apps/acode-cli/tests/bash-confirm-reflexive-gate.test.mjs`；UI 投影 `packages/ui/test/permissionJustification.test.ts`（7 例，node:test）。
- **验证**（自跑记录）：新测试 10/10；全量 CLI 381/381（J1-1 的 autoApproveHighRisk 测试按分层语义有意更新）；tsc core+contracts 通过；root typecheck/lint/arch/knip 全绿。评审修复轮后：反射 prompt 经真实投递路径（`permission-flow.ts:162,346` 按 `isBashReflexGateRuleId` 保留原文——已核实两处调用）**等长逐字送达模型**；auditedAllow 审计经 `setBashReflexAuditSink`（已核实 `create-app.ts:204` 接线）写 info 级 Logger → NodeFileLogger JSONL 落盘，并有用真实 `createNodeLoggerFactory` 从磁盘读回的测试。
- **评审结论**：首轮判「不通过」（四问 prompt 在工具错误通道被截到 500 字符、Q2–Q4 与 justification 指令到不了模型）；随 J1 批修复闭环。原实施 blocker「审计 transport 在 bootstrap 边界外、只落 stderr」**已被修复轮按 spec R6 预告形态补完**，不再是遗留项。
- **遗留风险/已知未覆盖**：UI「渲染出来长什么样」只有源码守卫覆盖——本仓库无 React 渲染/E2E 装置（无 @testing-library/react），真实 DOM/E2E 与计划要求的 desktop-continuous / web-remote-replayable 双链路人工验证**未做**（spec R8 已登记）。

### J1-3 · 压缩不变量审计与修正 —— ✅ 已实施（部分受阻）

- **审计结论**：五条 jcode 压缩不变量逐条亲自复核后三分——I1（图片计费）与 I5（HTTP 413）为**真缺口**（实测 400KB 截图在 estimate 模式只计 7 token；413 对既有 context-exceeded/media-too-large 判定全不可见）已最小侵入修正；I2（会计归一）与 I3（切点不拆 tool 对）实跑判定成立；I4（无后台压缩）判不适用并把三条前提钉成可执行断言。
- **修正**：compact 自有估算投影加 1600/块平价（未动 contracts 共享投影）；model-errors 加精确 413 判定（4130 不误命中、裸 413 需体积语境词）；新增 `core/src/compact/payload-recovery.ts`（12MiB→0→耗尽阶梯，已核实存在）；compact-active 接独立字节轨道并复用既有聚合媒体预算投影做 oldest-first 剥离。
- **spec**：`apps/acode-cli/specs/compact-invariants.md`（456 行，每条含 file:line 证据、实跑输出、修正项、验收场景、残留风险与偏差登记，已核实）。
- **测试**：`apps/acode-cli/tests/compact-invariants.test.mjs`。
- **验证**（自跑记录）：新测试 23/23；CLI 全量 336/336；tsc core exit 0；architecture:check 0 violation；根 lint 76 warning/0 error 与 knip 基线未扩大；CLI 侧 oxlint 逐文件 4 文件 0/0（`compact-active.ts` 的 1 error+1 warning 为 HEAD 既有）。
- **评审结论**：放行（修正未触碰 contracts 共享投影）。
- **遗留风险/已知未覆盖**——状态记录把它们编号为 **B1–B5**（本节即定义处，§6.1 与 upgrade-plan 表的枚举同此口径），另有一条未编号验证缺口：
  - **B2** 普通 turn 请求的 413 恢复未接线——判定点已共享于 `core/src/runtime/helpers/model-errors.ts`，接线点 `core/src/runtime/methods/turn-model-step.ts` 在本项所有权边界外；
  - **B3** `core/src/runtime/methods/compact-summary-model-request.ts:263-271` 的 stream 回退短路清单不含 413——413 时会先把同一超大请求体以 non-streaming 再上传一遍才落到新轨道（正确性不受影响，代价一次重复上传）；边界外；
  - **B1** 媒体剥离占位文案含 media_type 但不含原始字节长度——补长度需改所有请求共用的 `core/src/runtime/helpers/media-budget.ts:253-259` 投影（边界外），本次改由日志 `compact.request.payload_too_large.media_projection` 承载字节数；
  - **B5** 预防侧聚合媒体预算 40MiB（`media-budget.ts:28`）高于 Anthropic ~32MB 请求体硬上限，预防侧无法排除 413——按「不改既有阈值常量语义」约束未动，需单独决策；
  - **B4**（状态记录同时标注为观察项 O1）usage 归一规则存在三份实现（`contracts/src/model/index.ts:571-590`、`core/src/runtime/methods/turn-model-step-usage.ts:160-182`、`core/src/agent/message-history-usage.ts:11-52`），语义一致但结构性重复——若未来 provider 改回 split accounting，三处必须同改否则显示与决策分叉；
  - **（未编号）真实 provider 的 413 端到端未验证**——仓库无该 harness、实施全程未联网，413 重试循环只有源码接线守卫覆盖。

### J1-4 · 配置持久化审计 + 文档状态同步 —— ✅ 已实施（部分受阻）

- **审计结论**：13 条配置写路径中唯一命中「读全量→改一处→写全量」冻结模式的是 `settingService.update()`（实证：单键 update 物化 33 个 schema 默认键落盘）；已修为「只写磁盘已有键 ∪ 显式 patch 键 ∪ 迁移标记键」（修后同场景 6 键，读取侧默认补齐不变）；provider 配置仓库（schemaVersion+迁移表+CAS）为良性范式；sync/mcp/plugin/desktop 各写路径 raw 透传判定通过。
- **文档同步**：`docs/security-hardening-plan.md` 状态头与 P2 两行改为「P2 已实施（2026-09-30 核实 process-policy-floor.ts、bypass-immune-breakers.ts、spec 俱在）、P3 未开始」——**本轮已核实该状态头在盘**。
- **spec**：`apps/acode-cli/specs/config-persistence-audit.md`（123 行，含 §4.1 去物化迁移修正设计，已核实）。
- **测试**：`packages/services/tests/settingsExplicitKeyPersistence.test.mjs`（已核实存在）。
- **验证**（自跑记录，环境受限）：`packages/services` 逐包 tsc 与改动文件 scoped oxlint 通过；root 全量门禁按约定留给脚本统一跑（终验绿，见 §5）；`node scripts/check-workspace-freshness.mjs` 在 git fetch 处 TLS 失败（schannel handshake）未能跑通。
- **评审结论**：放行（「配置只写显式键的修复本体正确且测试为真行为测试」）。
- **遗留风险/已知未覆盖**：存量 setting.json 已被全量物化的用户，旧默认值与显式选择不可区分，修复仅**前瞻性**生效；是否做一次性「去物化」迁移属**产品决策**（设计已写 spec §4.1，未擅动）。观察项（spec §4.2–4.4 未动刀）：一次性迁移提交路径保留全量写；`settingsSyncService.writeJsonFile` 非原子写；`desktopDeviceMid.ts:62-68` 同步 fs 违反异步 IO 约定。

### J2-1 · todo 置信度语义协议 —— ✅ 已实施（CLI 侧闭环；协议/UI 投影为后续批次）

- **实现**：`completionConfidence` 四级语义枚举（可选、向后兼容、rank/门槛常量模块私有）；`confidenceHistory` 工具自有（模型自报经可写面 schema 天然 strip、每写每项最多追加一条观测、连续去重、16 条滑动窗口）；完成门槛在 handler 唯一写入路径（仅新完成转移受检 + grandfather 豁免旧存量，违规抛 InvalidInput 点名 id 且 updateTodos 零执行，文案经测试钉住不泄露枚举/阈值）；持久化参照 deps_json 加 nullable `confidence_json` 列 + migration `0024-todo-confidence-json`（已核实 `migrations.ts:940` 与迁移文件）。
- **spec**：`apps/acode-cli/specs/todo-confidence-semantics.md`（376 行，R1–R7，已核实）。
- **测试**：`apps/acode-cli/tests/todo-confidence-semantics.test.mjs`、`todo-dependency-fields.test.mjs`（D4 回归适配）。
- **验证**（自跑记录）：新测试 18/18；D4 回归 18/18；reminder-extensions 12/12；tsc contracts/core/adapters --noEmit 均 0（bootstrap 亦 0，实证零改动兼容）；root typecheck exit 0；lint 0 error/76 warning。
- **评审结论**：**干净通过**（confidenceHistory 真由工具拥有、门槛报错不泄露枚举阈值、migration 回滚安全、旧会话/旧客户端宽容解析均实证兼容）。
- **遗留风险/已知未覆盖**（协议/UI 投影按指令收缩条款登记 spec R7 为后续批次，5 个文件）：bootstrap `session-mapper.ts` mapTodoItem 透传（snapshot 通路，缺它协议永远收不到字段）；`packages/shared` todo schema 最小加宽（无前者时是死宽度）；`tool-plan-adapter.ts` + `acode-task-types-core.ts`（UI live 通路）；`packages/services` 的 `sessionTodosToPlanSteps` 投影（历史恢复通路）；UI 徽标落地时 i18n locale 排期协调。建议 (1)–(5) 同批一次做全并补 v4 双语义链路核查。

### J2-3 · workflow 类型化 artifact + gate 点名 —— ✅ 已实施

- **实现**：`WorkflowArtifactSchema` 增可选 typed 段（findings/evidence/validation/openQuestions/confidence/whatINotChecked，路径式字段保留）；节点完成提交经 response 尾部 ```acode-artifact 围栏块接受并校验（专家子会话无 submit_result 端口，核实于 `runtime-tools.ts:56-59`/`workflow-facade.ts:289`，故 submit-result.ts 与 respond-to-coordinator.ts 均未改）；final_critic 接分档 gate——light 只强制 low-confidence 债务，deep preset（`definition.gatePolicy`）追加词边界全量点名校验（枚举封顶 20）、stale scope 与 artifact-or-nothing（requeue 一次、第二次 fail）。
- **spec**：`apps/acode-cli/specs/workflow-typed-artifacts.md`（322 行，已核实）。
- **测试**：`apps/acode-cli/tests/workflow-typed-artifacts.test.mjs`。
- **验证**（自跑记录）：新测试 36/36（含 light 八阶段端到端零回归 + 三个 prompt builder golden 字节快照）；tsc contracts/core 0 错；评审修复轮后 39/39、全量 453/453。
- **评审结论**：核心正确（词边界点名语义与 jcode 逐条对齐、三段 gate 规则同构、light 档零回归被 golden + 八阶段事件序列真钉住）；2 条 medium **均已修复**——① spec 登记的 `what_i_didnt_check` 别名未实现（已补 `typed-artifact.ts:138`，已核实，并登记 summary/references/verification 反向别名）；② deep 档对回退派发的 phase 容器节点「强制但不告知」（已改 `isArtifactGateWorkerNode` 唯一判定，已核实 `artifact-gate.ts:102` + `node-runner.ts:158` 消费，契约段与强制范围结构性一致）。
- **遗留风险/已知未覆盖**：任务书要求「走 respond-to-coordinator 既有通道」——经核实该工具只注册给 subagent_child 会话，expert workflow 的 critic 子会话是 workflow_child 且无该端口；已用**引擎侧等价通道**实现（pass 被拒→critic_failed(gateIssues)→phase 重置→下轮提示词尾部注入补充要求，封顶 maxIterations，E3/E5 钉住）并写入 spec R7。**若验收坚持字面通道，需另立边界外条目**。

### J3-1 · Provider Doctor 分档诊断 —— ✅ 已实施（3 处接线超字面边界，需所有者确认）

- **实现**：`adapters/src/doctor/` 模块（已核实 18 文件）——`acode doctor --provider[=id] [--model] [--tier=offline|catalog|live] [--coverage] [--json]`，12 个固定检查点逐档累加、轻档只记 skipped 不越档背书；本地 JSONL 覆盖账本（provider×检查点/时间戳/可计费调用计数/运行者，字段白名单、写入前拒凭据字段，凭据只验可解密与否）；出网复用 HttpClientPort(public) 与 AiSdkModelAdapter，零裸 fetch；`adapters/package.json` 增 `./doctor` subpath export（已核实 :49-51）。
- **spec**：`apps/acode-cli/specs/provider-doctor.md`（347 行，R1–R7 + 事件顺序图 + 与 jcode 的有意差异，已核实）。
- **测试**：`apps/acode-cli/tests/provider-doctor.test.mjs`（评审修复轮后含 (1e)(1f)(1g)(4g) 共 29 例）。
- **验证**（自跑记录）：新测试 25/25 → 修复轮 29 例全绿；CLI 全量 503/503 → 508/508；adapters tsc 干净；用真实用户配置跑了 offline/coverage/json/catalog 四种 CLI 冒烟——**offline exit 0** 且 blockedNetworkCalls=0、账本 grep 无凭据；**catalog 实跑 exit=1**（#7 公网出口校验失败、#8/#9 skipped、全程 0 次请求）。catalog「跑了且 exit 1」与下述「该档在本机代理环境不可用」**不矛盾**：档位执行了、结论是环境性拒绝（fake-IP DNS 被公网出口校验如实拦下），这正是 doctor 的设计行为；coverage/json 两档已执行但各自 exit 码未在状态记录中给出。
- **评审结论**：首轮判「需修后再合」；3 条 actionable findings **全部修复**——① 账号型 provider credential_available 在真实接线下永远 blocked（诊断端口缺 `accountAccess` 透传；已按「与真实路径同源」修复，修后 passed 且不再建议重登，已核实 `diagnose-provider.ts` 相关接线）；② live 档对内网/环回端点仍打三次真实模型调用（已把端点判定纳入 live 前置 `prerequisitesMet`，已核实 `diagnose-provider.ts:107,125`，修后 0 次调用 0 花费）；③ not-found 分类（归 J3-2 修复）。残留边界如实报告：off-peak 账号模型走 `requestDependencies.requestAuth.source`，contracts 无 accountAccess 字段且 standalone headers port 只服务 individual-coding-plan——独立 CLI 下 off-peak 账号确实无法鉴权，诊断报 blocked 是**如实的**；改它需动 contracts 与 standalone 运行时模式策略，未顺手扩大。
- **遗留风险/已知未覆盖**：本机 fake-IP 代理 DNS 把 open.bigmodel.cn / api.z.ai 解析成 198.18.0.x（RFC2544 保留段），公网出口校验如实拒绝 → **catalog/live 档在该代理环境不可用**（offline 不受影响）；会出现「TUI 能正常聊天、doctor catalog 档说端点被拒」组合——是否给 provider 端点开更宽出口口径属产品/安全决策，未替它决定。**边界说明（需所有者确认，改动均为附加式）**：除 `cli/src/run.ts` 外还改了 `cli/src/provider-runtime-env.ts`（doctor 分支）、新增 `cli/src/provider-doctor-command.ts`、adapters package.json subpath——均在 cli/adapters 包内但超出「仅 run.ts」字面边界。

### J3-2 · 记忆注入 fail-closed 重验证 —— ✅ 已实施

- **审计结论**：Extraction 通道有真竞态（快照在队列里可停留任意长而消费点只信调度时刻的 memoryRoot，身份源可被 resume/config 改写；清单 30 行 preview、单条失败静默过滤、渲染后与盘上零绑定）；MEMORY.md 索引通道身份维度已同步，按「预防性钉住不变量」处理不制造假问题；subagent 持久记忆 fail-open 登记为越界观察项 OB-2。
- **实现**：新增 `core/src/memory/recall/pending.ts`（已核实）——发布时绑定 identityKey（`workspaceIdentity?.trim() || workspacePath`，AGENTS.md 口径）+ memoryRoot；逐条语义签名 sha256（全文+description/type+mtime+size）；消费前重读验证，8 类拒绝原因任一命中**整体丢弃** + Logger warn `memory.recall.discarded`，无部分注入；三层去重 90s 同签名 / 180s 重叠≥0.8 / 45min 条目 TTL；渲染用 `memory_N` 位置引用 + 不可信数据声明。`project-memory-extraction.ts` 接线（scope 不一致整轮放弃 + finishCancelled("superseded")）；`memory-agent-loop.ts` 每轮 scope guard；**删除**旧 `scanMemoryManifest`/`formatMemoryManifest`/`MemoryManifestEntry` 以免留第二条无防护召回路径。
- **spec**：`apps/acode-cli/specs/memory-injection-fail-closed.md`（489 行，通道 A/B/C + R 条目 + §8 未做登记，已核实）。
- **测试**：`apps/acode-cli/tests/memory-injection-fail-closed.test.mjs`（评审修复轮后含 A8b 共 26 例）。
- **验证**（自跑记录）：新测试 25/25；全量 503/503；tsc core/adapters/bootstrap 0；改动文件 oxlint 0/0；architecture:check 0 violation；oxfmt 逐文件比对 7 文件内容层差异 0。
- **评审结论**：机制骨架扎实（offline 双重强制、host 校验 21 例全拦、账本纯本地、fail-closed 无部分注入路径）；1 条 actionable（not-found 分类只认裸 ENOENT，生产端口的 `not_found`/`is_directory` 被归成 storage-error）**已修复**——`pending.ts:588` 改为仓库既有口径（已核实），修后「删一条/换同名目录」都正确报 `entry-missing`。
- **遗留风险/已知未覆盖**：OB-2（需 subagent 域所有者）——`persistent-memory.ts:93-99` 把任何 MEMORY.md 读失败（含 EACCES/EIO）吞成空串再渲染成「currently empty」，对非 ENOENT 是 fail-open 假陈述；workspace identity-key helper 统一到 contracts 属跨包改动应另立条目；knip 基线 @acode/core unused exported types 39→50（pending.ts 协议类型在 declaration:true 下必须导出，J3-3 消费后自然消失，spec §8 已记录）。

---

## 4. 三轮独立评审与修复轮汇总

| 批次 | 首轮 verdict | findings / actionable | 修复结果 |
|---|---|---|---|
| J1（J1-1..J1-4） | J1-3/J1-4 放行；J1-1/J1-2 **不通过**（4 条 catastrophic 绕过 + 反射门 prompt 截断到 500 字符） | 16 / 12 | **12 条全部核实成立并修复，无驳回**。核验方式：node --import tsx 驱动真实模块逐条复现，修后同探针确认翻转并固化断言。修复后自跑：CLI 396/396（33 文件）、UI 4 文件 32/32（`packages/ui/test/` 下 botPermissionFallback / openExternalTarget / providerIssueWarnings / permissionJustification——前三个为既有 UI 回归、第四个为本批新增，4 个文件本轮均已核实在盘，跑法见 §2）、tsc core+bootstrap 0、root typecheck/lint/arch 绿、fmt:check 191 个全为既有、knip 新导出无标记 |
| J2（J2-1/J2-3） | J2-1 **干净通过**；J2-3 核心正确 + 2 medium（deep 档新 opt-in 面） | 2 / 2 | **2 条全部修复**（别名补映射 + spec 反向漂移登记；deep 强制范围收为 worker 节点，`isArtifactGateWorkerNode` 唯一判定）。修复后自跑：39/39、全量 453/453（35 文件）、tsc core/bootstrap 0、全套 root 门禁绿 |
| J3（J3-1/J3-2） | 骨架扎实，但 J3-1 真实接线下对账号型 provider 给错误结论且 live 档绕过自身内网硬约束、J3-2 not-found 分类与真实 FileSystemPort 不匹配，**需修后再合** | 8 / 3 | **3 条全部修复**（accountAccess 透传；live 档端点前置——环回/DNS 重绑定形态下 0 次模型调用 0 花费；not_found/is_directory 归 entry-missing）。修复后自跑：55/55、全量 508/508（全目录）、tsc adapters/core 0、全套 root 门禁绿 |

三份评审的完整 findings 清单与逐条修复证据（含复现命令、修法取舍依据、spec 同步点）保留在实施状态 JSON 的 `reviews.*.fix.outcomes` 段——**该 JSON 未落盘，逐条原文需向编排会话/调度方索取（见 §1.1）**；本文 §3 各项已摘录与接手直接相关的结论与修复要点。

---

## 5. 统一门禁结果（脚本终验）

以下为编排脚本统一门禁的记录（引自实施状态 JSON `gates` 段，脚本名未随任务书提供，见 §1.1；本轮交付记录员未复跑，接手后请按 §2 复跑确认）：

| 门禁 | J1 批 | J2 批 | J3 批 | **终验（final）** |
|---|---|---|---|---|
| root `pnpm typecheck` | exit 0 | exit 0 | exit 0 | **exit 0** |
| tsc core | exit 0 | exit 0 | exit 0 | **exit 0** |
| tsc contracts | exit 0 | exit 0 | — | **exit 0** |
| tsc adapters | — | exit 0 | exit 0 | **exit 0** |
| `pnpm lint` | exit 0 | exit 0 | exit 0 | **exit 0**（0 error / 76 warning，与基线一致） |
| `architecture:check --changed` | exit 0 | exit 0 | exit 0 | **exit 0** |
| `node --test`（文件数） | 34 文件 exit 0 | 35 文件 exit 0 | 37 文件 exit 0 | **38 文件 exit 0** |
| fixRounds | 0 | 0 | 0 | 0，`green: true` |

> - **门禁清单的边界**：上表（引自 gates 段）**不含 `pnpm fmt:check` 与 `pnpm knip`**——这两项只出现在各修复轮的自跑记录里（fmt:check 191 个被标文件全为既有基线；knip 基线即 exit 1，本批新增导出逐一核对无标记，见 §4）。**「终验全绿」不涵盖 fmt 与 knip**，接手后请按 §7.3/§7.4 自行复核。
> - **各批 node --test 文件数的构成未记录**：34→35→37→38 是 gates 段的逐批快照，未附文件清单，且与各批新增测试文件数**对不上账**（J2 批新增 2 个 CLI 测试文件而计数只 +1）。本轮无法核实各批口径差异，**不要用这四个数做算术**。
> - **终验「38 个文件」的确切构成同样未记录**：盘上与本批相关的测试文件现为 **39 个**（CLI 37 + services 1 + UI 1，本轮实测），38 无法唯一对应；权威做法是按 §2 全量复跑取当次数。

---

## 6. 遗留登记汇总（后续批次建议清单）

### 6.1 逐项登记表（§0 所说「8 个条目各有登记项」的完整清单；J1-3 占两行——B4 观察项单列）

详细逐条方案在各 spec 的 R7/未做章节；「建议归属」为按所有权划分的落点建议，非已排期承诺。

| 条目 | 登记项 | 建议归属 |
|---|---|---|
| J1-1 | `paths.ts`（980 行，本轮实测）拆分重构——保护表 + 路径比较的安全关键文件，独立于本 diff 做 | 后续独立重构批次 |
| J1-2 | desktop-continuous / web-remote-replayable **双链路审批流人工验证未做**（本仓无 React 渲染/E2E 装置，源码守卫已覆盖投影逻辑，见 §3 J1-2） | UI/desktop 批次 + 人工冒烟 |
| J1-3 | **B1** 占位字节长度（media-budget.ts 投影）、**B2** 普通 turn 413 接线（turn-model-step.ts）、**B3** stream 回退清单补 413、**B5** 聚合媒体预算 40MiB vs ~32MB 决策——定义见 §3 J1-3；**另有未编号的「真实 provider 413 端到端未验证」**（无 harness、未联网） | B2/B3 随下一 core 批次；B1/B5 需阈值决策；端到端待真实 provider 环境 |
| J1-3 (B4) | usage 归一三份实现结构性重复（观察项 O1，contracts/turn-model-step-usage/message-history-usage 三处需同改） | contracts 所有者 |
| J1-4 | 存量 setting.json「去物化」迁移（**产品决策**，设计已写 spec §4.1）；观察项：迁移提交路径全量写、settingsSyncService 非原子写（plugin-sync 有原子写范式可抄）、desktopDeviceMid 同步 fs | 产品决策 + services/desktop 批次 |
| J2-1 | **协议/UI 投影 5 文件同批做全**（最大未闭合面）：bootstrap `session-mapper.ts` mapTodoItem 透传 → `packages/shared` acodeSessionTodoItemSchema 最小加宽 → `tool-plan-adapter.ts`/`acode-task-types-core.ts`（UI live 通路）→ `packages/services` sessionTodosToPlanSteps（历史恢复通路）→ UI 徽标 + i18n 排期；补 v4 双语义链路核查 | bootstrap/shared/services/ui 联合批次 |
| J2-3 | 若验收坚持 respond-to-coordinator **字面通道**，需另立 bootstrap 装配条目（现用引擎侧等价通道，spec R7 已记录） | 验收方决策 |
| J3-1 | ① **3 处超「仅 run.ts」字面边界的附加式接线需所有者追认**（`cli/src/provider-runtime-env.ts` doctor 分支、新增 `cli/src/provider-doctor-command.ts`、adapters `./doctor` subpath export）；② provider 端点是否开比 WebFetch 更宽的公网出口口径（fake-IP 代理环境 catalog/live 可用性）——产品/安全决策；③ off-peak 账号鉴权需动 contracts + standalone 运行时模式策略 | 所有者确认 + 产品/安全决策 |
| J3-2 | OB-2：subagent MEMORY.md 非 ENOENT 读失败被渲染成「currently empty」的 fail-open 假陈述；workspace identity-key helper 统一到 contracts（另立条目）；knip unused types 39→50 随 J3-3 消费自然消失（spec §8 已记录） | subagent 域所有者 / contracts 条目 |
| 评估项 | J2-2（待 J2-1 投影落地后的真实数据）、J3-3（度量先行）——维持登记不排期 | — |

### 6.2 接手后的提交路径（77 条未提交改动如何处置）

1. **J3-1 的边界确认先行但不阻塞整体**：三处超字面边界的接线都是附加式（不删既有行为），若打算一次合入，可在提交说明中显式列出这三处请所有者复核；若要严格先确认再合，可将其余条目先行提交、J3-1 相关文件（`provider-runtime-env.ts`、`provider-doctor-command.ts`、`adapters/package.json`、`adapters/src/doctor/`）暂缓。
2. **「所有者」是谁、如何记录**：本仓没有独立的边界审批登记系统——「所有者」即**仓库所有者（用户本人）**。确认结果建议直接回写本文 §6.1 对应行（勾销或改写登记项），或立独立 spec/issue 跟踪。
3. **提交方式**沿用 upgrade-plan「实施节奏与门禁」章的既定流程：**squash 单提交合入 `dev/0.0.1`、不走 PR**，合入前跑 Mimosa 扫描（enobufs 时不宣称安全）与 `pnpm verify:pre-push`；若倾向按批次拆分（J1/J2/J3 三个 squash 提交），三个批次的文件集可按包边界在 `git status` 中切分，但 **spec + 测试必须与其实现同提交**（J1 批含跨包的 services/ui 改动，见 §1）。
4. **提交前**按 §2 复跑全量门禁与测试——本文所有绿值均为状态记录转述，本轮未复跑（§1.1）。

---

## 7. 协作陷阱与环境基线（务必知道）

1. **三个既有基线红不修不计入**（与 [`security-hardening-handoff.md`](security-hardening-handoff.md) §2 同清单）：`packages/desktop/tests/no-official-platform.test.mjs`、`packages/ui/tests/no-telemetry.test.mjs`（ENOENT 引用从未存在的 codingPlanEmbeddedWebview.ts）、`packages/ui/test/nonCliAcpRetirement.test.ts`（`@/lib` 别名裸 tsx 解析不了）。
2. **`pnpm --dir apps/acode-cli registry:check` 既有红**（"Generated Bash command registry is stale"）：输入（@withfig/autocomplete@2.692.3、生成脚本、生成文件）全部未修改，生成文件最后一次改动是 initial commit；**不要顺手重新生成**（会产生巨量无关 diff）。
3. **根 lint/format 不覆盖 apps/acode-cli**（`.oxlintrc.json` ignorePatterns + `.prettierignore` 显式排除）：CLI 自身 oxlint 有 31 处 max-lines error、oxfmt 322 个文件不合规，均落在未触碰文件；本批改动文件已逐文件比对为干净。根 `pnpm fmt:check` 的 191 个文件红全为既有基线。
4. **knip 基线**：根 `pnpm knip` 本来就 exit 1（既有）；本批新增导出经逐一核对无标记，唯一扩大项是 @acode/core unused exported types 39→50（J3-2 pending.ts 协议类型，spec §8 已记录、未用 lintignore 抑制）。
5. **Mimosa PreToolUse 钩子误报**：对 `project-memory-extraction.ts` 的 Edit 曾以「高危 · SQL 注入 · 第 7/10 行」拦截，指向的行是与 SQL 无关的既有代码 `executor.execute(toolCall, {`；实施会话按钩子反馈调整完成同样改动（未绕过检查）。后续在同文件工作会遇到同样误报。
6. **cli 包 tsc 有 67 条既有环境红**（@acode/tui TS2307 级联；tui/dist gitignored 未构建）——改动前同命令即有，非本批引入；本批该包内改动文件 0 错误。
7. **dist 是 gitignored**：bootstrap/cli 的 typecheck 需先重建 adapters/contracts/core 的 dist（package exports 指向 dist）。重建命令已写入 §2（`for p in contracts core adapters; do node node_modules/typescript/bin/tsc -p packages/$p/tsconfig.json; done`，去掉 --noEmit 即构建；本轮已实测 contracts 一包 exit 0 并产出 `dist/index.{js,d.ts}`，adapters 同款命令在 security handoff §7.5 有先例）。产物不入库。
8. **本机网络环境**：`check-workspace-freshness.mjs` 的 git fetch 在 schannel TLS 失败（J1-4 会话未能跑通基线检查）；fake-IP 代理 DNS 影响 doctor catalog/live 档（见 §3 J3-1）。

---

*本文由 2026-09-30 交付记录轮依据实施状态 JSON 撰写（该 JSON 的出处与可得性见 §1.1——未落盘，逐条评审原文需向编排会话索取）；标注「已核实/本轮实测」的事实为本轮对仓库的只读核查与个别命令实跑（ls/grep/git status/wc/contracts 构建），测试计数与门禁 exit 码均引自实施/评审修复会话的自跑记录与编排脚本统一门禁，本轮未复跑。所有 file:line 以 2026-09-30 工作区（基线 8b95943 + 未提交改动）为准，接手后请复核行号（会随提交漂移）。*

---

## 8. J1 对抗性复审与修复轮 2–4（2026-09-30 增补）

首轮交付后，用户要求对 J1 安全修复做对抗性复审。本节记录复审与后续三轮修复的最终状态；§3/§4 中 J1 相关内容以本节为准。

### 8.1 复审与修复的流程

1. **对抗性复审（3 个全新上下文只读评审员并行）**：路径文法攻击手（约 150 例探针）、反射门/投递链攻击手（lane 矩阵 18 格 + 协议攻击）、一致性/回归审计员（三方对齐矩阵 + 相邻权限族回归）。结论：首轮评审的 **12 条修复全部真实闭环**（实现/spec/测试三方对齐、每条有专属回归钉住、修复轮 1 零回归、25 项误报全套零升级），但新鲜攻击证出 **9 high + 7 medium + ~10 low** 新缺口（cd 族 cwd 跟踪、brace 引号、Win 尾点、裸重定向、`//` 根、8.3 短名、未解析 `..` 逃逸、tee/sed -i、策略 ask 地板降级 catastrophic、反射 prompt 投递、审计脱敏、会话共享预填等）。
2. **修复轮 2**（两实现者并行，所有权互斥）：分级层修 HIGH-1..8 / MEDIUM-1..4 / LOW-13..19；门禁层修 N1..N7/N9/L-3（策略 ask 地板不再绕过 deny 级熔断与反射门、审计值级脱敏、挑战键加 sessionId 会话维度、零宽字符剥离、breakerAsk 审计留痕 + resolved 日志 ruleId、justification 4000 上限、文案、spec 登记）。
3. **对抗性复核（2 个全新上下文复核员）**：确认修复轮 2 全部闭环、N3 在生产链路真实生效（子代理 executor 的 sessionId 确为子会话 id），又证出 **F-1 [high]**（fallback 层 cd 跟踪在控制词 then/do/{ 后失效，`if true; then cd ~; rm -rf .ssh; fi` yolo 静默放行）、F-2/F-3 [medium]（cp -t 形态、CDPATH 内联赋值）、门禁侧 F1 [P1]（拼接确认词 `"y"×25` 与剥离清单外 7 族不可见字符可骗过 auditedAllow）、F2/F3 [P2/P3]（脱敏清单缺口与引号保真）。
4. **修复轮 3**（两实现者并行）：分级层修 F-1..F-6——fallback 控制词边界改**消费侧**判定（刻意不改 tokenizer segmentStart，避免 `find . -name then -delete` fail-open）；附带修复解析器零 command 静默吞段的 fail-open 防护；cp -t/--target-directory + 拼接路径分级；CDPATH 重定基；busybox/toybox 入 wrapper 表；gsed；cp/mv 目录放置 vs 文件覆写两级判 + 关键系统文件清单；F-6b 噪声簇登记 R6 不放宽。门禁层修 F1/F2/F3——不可见字符剥离改 `\p{Cf}` + 视觉空白显式清单；拼接确认词用 **DP 分解**判定（刻意不用 `^(?:词|…)+$` 正则：4000 字符上限下指数回溯构成 ReDoS 面）；脱敏清单两处同步补齐（ghp_/AKIA/PEM/JSON "token"/大小写与下划线变体）；auth-scheme 值匹配保引号配对；F4/F6 spec 登记（跨 mode 挑战消费语义、hook allow 覆盖例外）。
5. **修复轮 4**（单实现者）：闭合修复轮 3 登记的层内漂移——fallback 不分级 cp/mv/sed/tee（`(cp evil /etc/passwd)` 一层括号变 safe，与 HIGH-4 同族）。修法为提取共享层 `bash-target-risk/overwrite-verbs.ts`（assessTee/assessSed/assessCopyMove），AST 主路径与词法 fallback 消费同一套函数，**零逻辑复制**；未解析目标 fail-closed confirm。

### 8.2 终验（编排会话主代理实跑，非引用）

| 检查 | 结果 |
| --- | --- |
| root `pnpm typecheck` | exit 0 |
| tsc core / contracts / adapters（--noEmit） | 均 exit 0 |
| `pnpm lint`（oxlint） | 0 error / 76 warning（基线未扩大） |
| `pnpm architecture:check --changed` | violations 0 |
| CLI 全量 `node --import tsx --test apps/acode-cli/tests/*.test.mjs` | **588/588 pass**（测试文件 30→40；新增 bash-target-risk-adversarial 46 例 + bash-reflex-gate-adversarial 29 例） |
| `packages/ui/test/permissionJustification.test.ts` | 7/7 pass |
| 主代理独立探针（22 形态 + 端到端 3 条） | 20/20 符合预期；`if-then cd`/`(cp evil /etc/passwd)`/`busybox rm -rf ~` 端到端 yolo 均 `deny breaker.bashTargetCatastrophic`；修复轮 4 登记的 fallback wrapper「残留」（`(sudo tee /etc/passwd)`、`(busybox rm -rf ~)`）实测已 catastrophic，**无需 R6 登记** |

探针脚本留存于 `C:\Users\ZhuanZ\AppData\Local\Temp\j1r4-verify-probe.mjs`（仓库外，仓库根执行 `node --import tsx <该文件>` 可复跑）。

### 8.3 本轮新增遗留登记（并入 §6 清单）

1. **F-6a 档位裁决**：`cp /etc/passwd /etc/passwd.bak` 收口为 **confirm** 而非 low/safe——目的位于 /etc 递归保护区且「新建 vs 覆写」静态不可分，low 会让 `cp /dev/null /etc/sudoers.d/x` 类形态 yolo 直通；confirm 已消除「catastrophic 永久 deny 无申诉」的核心诉求。如产品侧认为写 /etc 应视同有界破坏，再议放宽。
2. **F-6b brace/引号部分包裹噪声簇**（`~/{".ssh',x}` 等罕见形态维持 catastrophic 保守误报）：已登记 spec R6，刻意不放宽——引号处理放宽正是 HIGH-2 的藏身处。
3. **CLI 侧 oxlint max-lines error 2 处**（bash-target-risk/assess.ts 686 行、paths.ts 1024 行，上限 400）：root lint 不覆盖 apps/acode-cli 故不阻塞门禁；文件拆分属结构性重构，并入 §6 既有的 paths.ts 重构批次。
4. **RTL 展示侧缺口**（U+202E 视觉重排可让弹窗显示的论证与实际字节不同）：校验侧已剥 `\p{Cf}` 闭合裁决欺骗，展示侧警示注记维持 spec R8「登记不实施」（需新增 i18n key，随 UI 批次落地）。
5. **跨 mode 挑战消费与 hook allow 覆盖**：均已 spec 登记（R4/R7）——前者 mode 切换仅用户/宿主可驱动、非模型可自升；后者与既有 ask 的 hook 覆盖语义一致、deny 永不翻转。
6. **sed -i 首操作数语义**：无 `-e` 时首操作数按脚本跳过（`sed -i file1` 形态会漏 file1），AST 与 fallback 共用函数后两侧一致，非漂移；如需收紧随动词表迭代处理。

### 8.4 状态

J1（J1-1/J1-2）经「首轮评审→修复轮 1→对抗性复审→修复轮 2→对抗性复核→修复轮 3/4→主代理独立终验」全链闭环，三个维度（路径文法/门禁投递/一致性回归）均达**可合入**。合入前流程不变：Mimosa 扫描 → squash 进 dev/0.0.1（J1–J3 全部改动 + 两份交付文档一起）。J2/J3 的评审遗留 medium（typed-artifact 别名、deep 档 phase 节点、doctor 账号型接线、live 档 egress 前置、memory not_found 分类）已在修复轮 1 处理并经全量终验；如需对抗级复核，可按 J1 同款模式对 J2/J3 各跑一轮。

---

## 9. J2/J3 对抗性复核与修复轮（2026-09-30 增补，合入前最后一环）

按用户指令，合入前对 J2/J3 执行了 J1 同款对抗级复核。**§8.4 中「如需对抗级复核」一句已由本节落实：J2/J3 复核完成、修复闭合，J1–J3 全部达到可合入。**

### 9.1 复核（4 个全新上下文只读攻击手并行）

- **J2-1 todo 置信度**：核心性质全部实证成立（strip 完备、报错零泄露、migration 0024 升降级安全、三代宽容解析、updateTodos 唯一写入路径、生产并发不可达），但证出 **F1 [high]**——grandfather 豁免按 id-only 匹配 × 位置派生 id：「剪掉已完成项 → 后一项补位」这类**日常列表整理**即可不带任何证据标 completed 并继承前项 `["verified"]` 轨迹（跨 SQLite 重启成立；显式 id 一旦 completed 即成永久免检令牌），另 4 条 low。
- **J2-3 workflow 契约**：首轮两条 medium 确认真闭环（别名双向一致、deep phase 死路由 `isArtifactGateWorkerNode` 单一谓词收口），点名 gate 全部欺骗方向（同形字/零宽/大小写/短 id 互撞）fail-safe，requeue 计数跨 resume/reopen/跨进程持久。新证 **F-1 [medium]**：planner 扩张路径不校验空白节点 id → deep 档 critic 永不可点名的确定性死路（pre-existing 入口缺口被 deep gate 放大），另 3 条 low。
- **J3-1 provider doctor**：首轮两条 medium 确认真闭环（账号型 provider 三处协同修复、live 档 egress 前置，独立探针复证 MODEL=0/billable=0），offline 零网络结构性成立，账本隐私/降级/防注入全过。新证 4 条 medium：**F1** 共享 egress IP 表漏 NAT64（`64:ff9b::/96`）/6to4（`2002::/16`）/Teredo（`2001::/32`）——catalog 档对内嵌 169.254.169.254 的地址带凭据发请求（contracts 共享表，WebFetch 同受影响）；**F2** live 探针 transport 无 per-connection egress 复验（DNS rebinding TOCTOU + undici 跟随重定向且 x-api-key 跨源不剥）；**F3** 脱敏清单与 core 侧三处漂移（违反 spec R5 同步硬条款）；**F4** 「可粘贴执行」的建议命令裸拼远端目录 model id（恶意/被接管目录端点 = shell 注入面）；另 5 条 low。
- **J3-2 记忆防护**：fail-closed 核心性质在全部 8 类对抗攻击下实证成立（TOCTOU 无可利用窗口——全文 sha256 验证保证注入=盘上、签名覆盖 frontmatter-only/重命名/同名歧义、identity 误配只朝拒绝方向、无部分注入旁路、无日志洪泛、symlink 竞态全 fail-closed），首轮 not_found 分类确认真闭环。新证 **F1 [medium]**：target 形态文件名含换行可伪造完整清单行（仅 POSIX、仅写侧子代理受众、仍在 UNTRUSTED 块内），另 4 条 low/观察。

### 9.2 修复轮（4 实现者并行，所有权互斥，全部闭合）

| 项 | 修法 | 钉住 |
| --- | --- | --- |
| J2-1 F1 [high] | grandfather 豁免与轨迹继承统一收紧为 **id+content 双匹配**（`isSameTodoContent` 共享谓词）；内容变更 = 新完成转移重新受检 | 7 新用例；升级兼容（存量原样重发仍豁免）实证 |
| J2-3 F-1 | planner schema `id.trim().min(1)`（消费面核查确认不含持久化解析）+ `parseWorkflowPlannerResult` fail-loud 显式探测 + planner_failed 可读错误 | G1-G6（含 deep/light E2E） |
| J2-3 F-4 | typed 段长度上限（字符串 ≤100k / 数组 ≤200 项 / 条目 ≤10k，spec 登记「只可放宽不可收紧」）；快照并发窗口登记为独立后续项 | A6/D6 |
| J3-1 F1 | 共享表补三段 IPv6（doctor 与 WebFetch 同时收紧） | 双侧测试（doctor 4h + webfetch 1/3） |
| J3-1 F4 | 建议命令白名单 `[A-Za-z0-9._-]+` + 占位符路线；目录 id 解析层过滤控制字符/反引号 | 4i/4j |
| J3-1 F3 | doctor 脱敏对齐 core（JSON x-api-key/anthropic-auth-token、JWT 两段、Bearer 值类），两侧注释互指 | 3f 五形态 |
| J3-1 F5-F9 | 18 文件归属头、spec 登记 160/200 与 6 字符门槛、tier guard 扩到 models+dns、billableCalls 只计真实请求、off-peak accountAccess 透传 | 2f/2g/8 等 |
| J3-2 F1 | capture 期 `invalid-name` 剔除（Cc/Cf 文件名，条目级、warn 不落文件名本体）+ 渲染 singleLine 兜底 | C5 行为 + C6 源码钉 |
| J3-2 F2/F5 | R8 写侧行为测试（scheduleProjectMemoryExtraction + mock，生产代码零改动）、stat.kind 分支用例 | D7/A11 |
| spec 登记 | J3-1 F2（live transport 残余窗口 → 已知限制）、J2-3 F-2/F-3（confidence 归一口径如实化、preset 以 resume 时 definition 为准）、J3-2 F3/F4（TTL 微改写向量与非单调时钟 → J3-3 前置条件）、J2-1 F3/F4/F5（观察项） | — |

### 9.3 终验（编排会话主代理实跑）

root `pnpm typecheck` exit 0；tsc core/contracts/adapters 均 exit 0；`pnpm lint` 0 error / 76 warning（基线未扩大）；`architecture:check --changed` 0 violations；**CLI 全量 614/614 pass**（测试文件 40 个，较 §8.2 净增 26 用例）；UI permissionJustification 7/7。主代理独立探针（`Temp\j23-verify-probe.mjs`，可复跑）：剪枝洗白 REJECTED、存量豁免 WRITTEN、planner 空白 id fail-loud、NAT64/6to4/Teredo/环回全 BLOCKED 且公网 IPv6 ALLOW、恶意 model id 建议命令 → 占位符无注入面。

**结论：J1–J3 全部达到可合入，进入合入流程（Mimosa 扫描 → squash 进 dev/0.0.1）。**

### 9.4 合入前 Mimosa 深度扫描记录

- 主动深度扫描（异步模式，规避大 diff enobufs）：scanId `scan-2026-09-30T18-56-41.721Z-16e671c60036`，封印 `sha256:8d7952119328623996c972894b8ae0e0efe8ec4d0034c60778f163d3b6e8481c`；118 findings（88 high / 30 medium，全部 candidate、verdictEffect=none），run status inconclusive（覆盖缺口：调用图动态派发，静态边界内不可判运行时可利用性）。
- 与 2026-09-29 已分诊基线（[`security-scan-triage-2026-09-29.md`](security-scan-triage-2026-09-29.md)，同为 118 条）按稳定键（severity|title|path）对比：**净新增 1 条**——`apps/acode-cli/packages/adapters/src/doctor/defaults.ts:71`「request 是 ssrf 入口」。定性：启发式入口点标记；实际调用点是 doctor 的 HTTP 端口，显式走 `egressPolicy:"public"`（DNS 预检 + 过检解析建连 + 代理缺省拒绝，spec R4），且本轮对抗复核已实证 offline 档零网络（全端口计数）与 host 校验 21 例全拦。与基线中数十条「ssrf 入口」标记同簇同口径（candidate、不改变 verdict），随基线簇处置。**净消失 1 条**——`windowsCuaDevRuntime.ts` 的 resolveDevelopmentRuntime path-traversal（1483018 已修）。本批其余全部新增文件（bash-target-risk/、bash-confirm-reflex-gate.ts、memory/recall/pending.ts、todo-confidence.ts、typed-artifact.ts、artifact-gate.ts、payload-recovery.ts、explicitSettingsPersist.ts、permissionJustification.ts 等）**零命中**。
- commit hook 扫描因大 diff（114 文件 / 24k 行）返回 `scanner_enobufs` 未得完整结论，按 hook 兼容策略放行提交；合入前审计以上述主动扫描封印为准。**不据此宣称项目整体安全**：既有 118 条候选簇的归簇结论与 3 条残留观察项仍以 09-29 分诊记录为准，本批未做逐簇重对账。
