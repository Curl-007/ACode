# ACode 项目升级建议（2026-10）

类型门禁已收敛为单一入口 `scripts/typecheck-gate.mjs`，本地、CI 与 release 的每个 job 都只调用它（U01 完成）；接着补真实执行故障测试，再建设交互 E2E、发布产物启动验证，随后推进现有协议与状态收敛计划。产品侧优先完成长对话导航和首次配置诊断。

本文是升级建议与立项依据，不代表以下改动已经实现，也不替代各模块 spec。实施前先更新对应 spec，明确状态所有者、接口、事件顺序和验收场景。

## 1. 调查范围与实测结果

调查日期：2026-10-09。首次调查基线：`dev/0.0.8`，commit `f4da4b0e`；同日在 commit `f9ed8961`（`dev/0.0.7`，含 2026-10-08 审查修复批一+批二 `c453fca5` 与其后三条 CI 修复）复测，下表以复测结果为准，首次调查的差异写在结论边界里。根 `package.json` 版本为 `0.0.6`；分支名不等于软件发布版本。

当前复核（2026-10-09 17:34）：基线已移到 `dev/0.0.8` HEAD `fa9d6d0c`（相对 `origin/dev/0.0.8` ahead 19，相对 `origin/main` ahead 21 / behind 0）。U01 已实现并落地：根 `pnpm typecheck` 现为单一门禁 `scripts/typecheck-gate.mjs`（packages → renderer ∥ cli），ci.yml/release.yml 的 verify/build/desktop 全部只调 `pnpm typecheck`，内联旁路已删。下表 `f9ed8961` 行中的静态检查已在本基线重跑并一致（typecheck 退出 0、lint 145 warnings / 0 errors、architecture OK 415/415 new 0），差异：lint 扫描文件 4330→4333、legacy 文件 3461→3463、managed 仍 18 模块 776 文件；全量测试从 `f9ed8961` 时的 1991 pass 升到 2004 tests / 2001 pass / 3 skip / 0 fail（增量来自 U01 门禁测试与 renderer 守护修复）。

范围包括 Desktop、手机 Web、共享 UI、services、CLI/runtime、协议、CI/release 和已有升级计划。采用当前检出源码与脚本作为事实依据；历史报告中的数量和性能数字不直接视为当前结果。

| 检查                                                                | 复测结果（`f9ed8961`）                                                                                                                                                        | 结论边界                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-workspace-freshness.mjs`                        | 通过；`dev/0.0.7` 与 `origin/dev/0.0.7` 同步，相对 `origin/main` ahead 6 / behind 0                                                                                           | 仅表示复测时本地已知引用的基线状态；首次调查在 `f4da4b0e` 记为 ahead 2                                                                                                                       |
| `pnpm typecheck`                                                    | 通过，退出码 0                                                                                                                                                                | 复测时清单仍只有 `packages/*` 与 Desktop host/main/preload/scheduler，不含 renderer 和 CLI 自身入口。**U01 实现后已改变**：该命令现在执行 `scripts/typecheck-gate.mjs` 的三个阶段            |
| `pnpm lint`                                                         | 通过，145 warnings、0 errors，扫描 4330 个文件                                                                                                                                | 存量 warning 仍存在。首次调查记为 73 warnings / 2633 文件；扫描面变大的方向与批一+批二取消整目录 ignore、把 CLI 两级 lint 配置纳入 Turbo 一致，warning 增量未逐项归因                        |
| `pnpm architecture:check`                                           | 通过；violations 415、baseline 415、new 0、regrown 0；managed 18 模块 776 文件，legacy 5 模块 3461 文件                                                                       | 首次调查记为 491/491、managed 5 模块 43 文件；批二纳管 5→18 并收紧 baseline 491→415。相对基线没有新增违规，不等于技术债归零                                                                  |
| `pnpm exec tsc -p packages/desktop/tsconfig.renderer.json --noEmit` | 通过，退出码 0；覆盖 414 个非 `node_modules` 文件                                                                                                                             | 首次调查在 `f4da4b0e` 记为 112 个诊断、退出码 2，已在批一+批二修复。`packages/desktop/src/renderer` 只有 12 个文件，renderer UI 主体在 `packages/ui`，其余来自 shared/ui/client 工程引用     |
| `pnpm --dir apps/acode-cli/packages/cli typecheck`                  | 通过，退出码 0                                                                                                                                                                | 复测时 CLI 自身入口可单独检查、已进 CI 与 release verify，但未纳入根 `pnpm typecheck` 单命令。**U01 实现后已改变**：由门禁的 `cli` 阶段经 turbo 覆盖，workflow 不再内联该命令                |
| CI 与 release 的类型步骤                                            | [ci.yml](../.github/workflows/ci.yml) 第 43/66/69 行、[release.yml](../.github/workflows/release.yml) verify job 第 58/76/79 行都跑「根 typecheck + CLI 入口 + renderer」三条 | 复测时 release.yml 的 `build` 与 `desktop` job 只跑根 `pnpm typecheck`，缺另外两条。**U01 实现后已改变**：两个 workflow 都只剩 `pnpm typecheck` 一条命令，内联步骤已删除，旁路由测试机械拦截 |
| 运行环境                                                            | Node `25.9.0`，pnpm `10.33.2`                                                                                                                                                 | `mise.toml` 固定 Node `24.14.0`；复测未在该固定 Node 下执行                                                                                                                                  |

复测只跑了上表中的静态检查与单入口类型检查，没有运行全量测试、浏览器/Electron E2E、构建、模型调用或设备测试；全量测试与 Electron smoke 的证据见 [fix-status-2026-10-09.md](./reviews/2026-10-08/fix-status-2026-10-09.md) 与 [external-e2e-2026-10-09.md](./reviews/2026-10-08/external-e2e-2026-10-09.md)。以下交互、性能和恢复收益均为待验收目标，不是复测测量结论。

## 2. 优先级与投入原则

1. **P0（已完成）：类型检查覆盖已收敛为单一入口。** `pnpm typecheck` 现在跑 `scripts/typecheck-gate.mjs` 的三个阶段（packages → renderer ∥ CLI），CI 与 release 的 verify/build/desktop 全部只调用它，注入测试与旁路扫描已进门禁。详见 U01。
2. **P0：验证真实执行与 Gateway 的失败路径。** 优先覆盖取消、超时、重复命令和进程清理。
3. **P1：建立桌面与手机交互 E2E。** 为未读、面板订阅、恢复链路和后续组件拆分提供回归依据。
4. **P1：验证发行产物能启动。** 将现有跨平台构建矩阵延伸到安装后运行验证。

其余建议分为可靠性、产品体验、长期维护三组。工作量按一名熟悉仓库的工程师有效人日估算，包含 spec、实现和针对性验证；不包含等待签名环境、真实 provider 或外部发布审核的时间。各项有共享前置工作，不能直接相加当作交付承诺。

## 3. P0：先补齐验证缺口

### U01. 完整类型门禁（已完成；原估 4–8 人日）

**已实现（`c453fca5`，对应 ARCH-03 / CLI-01）：** [ci.yml](../.github/workflows/ci.yml) 第 66/69 行与 [release.yml](../.github/workflows/release.yml) verify job 第 76/79 行新增「Typecheck CLI entry」与「Typecheck Desktop renderer」两条独立步骤；renderer 的 112 个历史诊断已修到 0，CLI 自身入口 0 诊断。CLI 就近 lint 配置消除了整目录 ignore，Turbo 纳入两级 lint 配置。

**本次实现（U01 收尾）：** 新增 [scripts/typecheck-gate.mjs](../scripts/typecheck-gate.mjs) 作为唯一类型门禁入口，阶段清单只在该脚本内声明一份：`packages`（原 `tsc -b` 工程集合，逐项照搬不改覆盖面）是 barrier，完成后 `desktop-renderer` 与 `cli`（`turbo --cwd apps/acode-cli run typecheck`，含 `@acode/cli` 自身入口，兄弟包声明顺序交给 turbo 的 `dependsOn: ["^build"]`）并行执行。根 [package.json](../package.json) 的 `typecheck` 改为调用它；[ci.yml](../.github/workflows/ci.yml) 与 [release.yml](../.github/workflows/release.yml) 删掉内联的 renderer / CLI 单入口步骤，verify、build、desktop 三处都只跑 `pnpm typecheck`，旁路消失。规则与验收写进 [CLI 独立交付门禁 spec](./specs/cli-validation-gates.md) 第 3-6 条。

**注入与旁路证据：** [apps/acode-cli/tests/typecheck-gate.test.mjs](../apps/acode-cli/tests/typecheck-gate.test.mjs) 7/7 通过——含类型错误的 fixture 阶段让门禁退出非零并指名阶段、移除注入后同一入口退出 0、依赖失败时下游显式 `skipped` 而非静默不跑、barrier 之后两阶段真实并行（`--sequential` 对照必须超时失败）、默认清单逐项覆盖三个入口、workflow 与根 `package.json` 不存在跳过 renderer/CLI 的第二条路径。另做真机注入：同时向 `packages/desktop/src/renderer/src/performanceTimelineCleanup.ts` 与 `apps/acode-cli/packages/cli/src/bootstrap-loader.ts` 各写一行 `const x: number = "..."`，单次 `pnpm typecheck` 两个阶段分别报出 TS2322 并退出码 1，撤回注入后恢复 0。

**仍未验证：** U01 已实现并在当前基线 `fa9d6d0c` 上复跑（typecheck 三阶段退出 0、renderer 与 CLI 均经单一入口），结果在 Node `25.9.0` / pnpm `10.33.2` 下取得，未在 `mise.toml` 固定的 Node `24.14.0` 下复跑；clean checkout 与三平台 runner 上的表现待 CI 首次运行确认。

**建议与所有者：** 构建/CI 入口统一维护完整类型检查集合，把三条检查收敛成一个可复用入口（脚本或 turbo pipeline），本地、CI 与 release 的 verify/build/desktop 全部调用它；不用整体关闭严格检查制造通过。

**验收：** 单一入口一次跑完三个检查集合，任一失败返回非零；在 renderer 与 CLI 自身分别注入一个类型错误，该入口与 CI、release 三条流程都必须失败；`build` 与 `desktop` job 不再只跑根 `pnpm typecheck`。承接 [技术债登记册](./tech-debt-backlog.md)，其中旧诊断数量保留日期，复测结果单独记录。

### U02. 真实执行与 V4 Gateway 故障注入（4–7 人日）

**证据：** [执行适配器](../apps/acode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts) 包含异步准备、spawn、进程树停止和停止原因归一化；[V4 Gateway](../apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/v4-gateway.ts) 装配 `CommandInbox`。现有测试检索未见直接实例化这些执行入口的行为测试。[CommandInbox 测试](../apps/acode-cli/tests/command-inbox-invariants.test.mjs) 已覆盖锁序、去重、CAS 和 LRU，建议补足的是实际执行与完整 Gateway 路径。

**建议与所有者：** adapters 继续拥有进程生命周期和执行结果；Gateway/runtime 拥有命令 admission、队列和终态事件。以受控 Node 子进程及 Gateway 夹具覆盖 spawn 前取消、运行中取消、超时、输出超限、非零退出、子进程占住 pipe 和 adapter close；Host/UI 不接管执行状态。

**验收：** 同一 `commandId` 重发至多执行一次；每条停止路径只结算一次；用户取消与超时可区分；close 后无残留执行或进程；Windows/macOS/Linux 分别留下真实进程冒烟记录。该项是已有“高风险执行链路行为测试”债务的具体落实。

## 4. P1：提高运行与发布可靠性

### U03. 可重复的桌面与手机 Web E2E（8–12 人日）

**证据：** 当前根目录、Desktop 与 UI 的测试入口主要是 `node --import tsx --test`，尚无统一可运行的 UI E2E 门禁。已有 [E2E bridge](../packages/shared/src/e2e-test-bridge.ts) 和 [Desktop 覆盖率钩子](../packages/desktop/src/main/e2eCoverage.ts) 可复用。[未读单一事实源](../packages/ui/specs/unread-single-source.md) 的 S3 与 [隐藏面板订阅释放](../packages/ui/specs/hidden-pane-subscription-release.md) 都需要交互验证。

**建议与所有者：** 测试设施维护隔离环境与固定 provider fixture；实际业务状态仍由现有服务/runtime 持有。隔离测试 workspace、`ACODE_DATA_BASE_DIR`、desktop home 和 Electron userData；仅切换 test 环境不足以保证凭据目录隔离。默认不使用真实密钥或产生模型费用。

**验收：** 仓库提供明确脚本与 CI job，覆盖发送/取消、隐藏面板恢复、未读水合及手机断线重连；分别验证 `desktop-continuous` 与 `web-remote-replayable`；失败保留截图、trace 和脱敏协议证据。该项作为现有交互收敛计划的共享前置设施。

### U04. 跨平台发行产物启动门禁（4–7 人日）

**证据：** [PR CI](../.github/workflows/ci.yml) 主要在 Ubuntu 验证；[release](../.github/workflows/release.yml) 已构建 macOS arm64/x64、Windows x64、Linux x64/arm64 五类产物，不能把跨平台打包当作缺失功能。缺口是矩阵以检查、打包、上传为主，未验证每类产物实际启动。[现有 distribution smoke](../scripts/acode-distribution-smoke.mjs) 已在仓库外验证 tarball、CLI help/version、TUI 初始化/退出和 Web 启动，但未接入根脚本或 CI。

**建议与所有者：** 发布流水线复用现有 smoke，并补足 Desktop Host/Agent 与各平台适配。在公开发布前验证下载/解包后的实际产物，保留当前全部上传成功后才公开 draft 的机制。工具链从 [mise.toml](../mise.toml) 和根 packageManager 获取精确版本，取代 workflow 中浮动 Node `24`，输出实际版本以便复现。

**验收：** CLI 发行包通过 help/version、TUI 初始化/退出和 Web 就绪 smoke；各 Desktop 目标产物通过应用及 Host/Agent 启动/退出检查。各类产物均在隔离目录运行，不依赖仓库内 `node_modules` 或源码路径；受路径、PTY、native module 影响的改动增加对应平台测试。Linux arm64 若使用模拟环境，明确标注验证方式及尚未覆盖的原生运行风险。

### U05. 按现有里程碑退役 legacy，并明确恢复策略（15–25 人日，分批）

**证据：** [acodeAgentService](../packages/services/src/acode-agent/acodeAgentService.ts) 同时调用 legacy `sessionCreate` 与 `V4_METHODS.command`；legacy bootstrap 目录当前仍有 48 个文件，services 中 legacy method/client 消费文件为 6 个。旧计划中的 7 个是历史计数。[连接 scope](../packages/services/src/acode-agent/acodeAgentConnectionScope.ts)、[task adapter](../packages/services/src/acode-agent/acodeTaskServiceAdapter.ts) 和 [Host](../packages/desktop/src/host/index.ts) 分散处理两种 delivery mode；[恢复测试](../packages/services/test/importedClaudeRecovery.test.ts) 与 [非 CLI ACP 测试](../packages/services/test/nonCliAcpRetirement.test.ts) 已有部分双模式覆盖。

**建议与所有者：** 执行 [legacy M1–M4 计划](./legacy-protocol-convergence-plan.md)，不创建竞争方案。先用恢复测试固定契约，再从可信握手生成有限的 delivery/recovery policy，明确共享规则与有意差异；策略收口可与迁移分批交付，不作为整包重构前置条件。shared 管理 wire schema，bootstrap 承担 gateway，services 适配连接；CLI/runtime 仍是已接受命令、会话与队列事实源。

**验收：** 各里程碑生成剩余消费者清单，按阶段归零；新增命令/事件仅进入 v4；本地会话、手机恢复与 ACP 入口均通过验证。增加断线、重连、runtime restart、snapshot/delta 重排、pending input/permission 恢复场景；不重复执行命令，不让旧 generation 帧污染新投影，连接释放后无残留订阅。

**必须保留的约束：** owner/lease、跨 Host 路由、stale run 防护和远程 `remoteSessionId`。身份 key 继续使用 `workspaceIdentity?.trim() || workspacePath`；路径只承担文件、cwd 与展示职责。Main/relay 只转发，手机附着桌面已有 Host，不另起 Agent。实时模式与可回放模式不能被强行统一为相同恢复行为。

下图是升级后仍须遵守的所有权与事件顺序约束，不是新增一套传输实现；Main/relay 等转发层在图中省略。

```mermaid
sequenceDiagram
    participant UI as UI 草稿与乐观显示
    participant Service as 连接服务与投影订阅
    participant Host as Host owner/lease 路由
    participant Runtime as CLI Gateway/CommandInbox/runtime
    participant Adapter as 执行适配器
    UI->>Service: 提交 commandId、workspace identity
    Service->>Host: 通过可信连接发送
    Host->>Runtime: 校验归属并路由
    Runtime->>Runtime: 去重、串行 admission、维护已接受队列
    Runtime-->>Service: 回执与权威状态
    Service-->>UI: 对齐乐观显示
    Runtime->>Adapter: 获准后执行或取消
    Adapter-->>Runtime: 执行结果，只结算一次
    Runtime-->>Service: 权威终态与投影更新
    Service-->>UI: 渲染终态
    Note over Service,Runtime: 断线不把已接受队列转移给 UI 或 Host
    UI->>Service: 重连，恢复身份与 attachment
    Service->>Host: 获取有效归属与 runtime generation
    alt desktop-continuous
        Service->>Runtime: 按实时链路契约重新订阅
    else web-remote-replayable
        Service->>Runtime: 按可回放契约恢复 snapshot 与增量
    end
    Runtime-->>Service: 返回对应链路状态
    Service->>Service: 拒绝过期 generation，按契约对齐投影
    Service-->>UI: 更新显示，不重新执行已接受命令
```

### U06. 可复现的性能回归基线（3–5 人日）

**证据：** [J5 性能报告](./j5-performance-baseline.md) 的探针位于仓库外历史 Temp 目录，报告也明确真实 LLM 轮次、Host RSS、多窗口和多 workspace 尚未测量。L1 字节码与 L4 token 估算已落地，L2/L3/L5 暂缓，不能把它们当作尚未实现或已经验证有效的统一优化包。

**建议与所有者：** 性能设施维护入库探针、固定 fixture 和机器可读结果。测量 main、renderer、host、agent 的完整启动与稳态资源，长会话流式显示延迟，以及多窗口/workspace 的增量成本；记录 commit、OS/arch、Node/Electron 和构建形态。

**验收：** 干净检出可运行同一实验；先积累稳定样本，再为可比较场景设置相对退化阈值。固定 mock provider 回归与真实 provider 人工实验分开报告。后续订阅调整、大组件拆分、依赖升级均用相同基线评价，暂缓项仅在测量支持时立项。

## 5. P1：完成已有能力的产品入口

### U07. 长对话目录索引与窗口外跳转（3–5 人日）

**证据：** 当前已经有虚拟列表、有界正文窗口与轻量 turn 索引。[projection store](../packages/ui/src/v4/conversationProjectionStore.ts) 的 `getTurnIndexEntries()` 仅被测试调用；[ConversationTimeline](../packages/ui/src/v4/ConversationTimeline.tsx) 的目录仍基于 `renderUnits`，历史加载涉及逐页扫描。[当前内存 spec](../packages/ui/specs/renderer-memory-budget.md) 的预算是正文 1200 行/32MB、turn 索引 8000 项，历史报告中的 4000 行/128MB 不适用于当前验收。

**建议与所有者：** 先完成现有 spec R3，把轻量索引接入目录。projection store 唯一管理索引、正文窗口、分页和请求有效性；目录只读索引，通过 store API 定位指定 row 附近正文。先在 spec 中明确“历史聚焦窗口”与当前连续尾部窗口不变量的关系，避免新增第二份权威窗口状态。若确需服务端分页目录，另估 4–6 人日并通过 v4 提供。

**验收：** 超过 1200 行仍可从目录定位窗口外输入；打开目录不全量拉取正文；点击后正确定位且保持内存预算；rewind/edit 后索引失效正确；切换会话拒绝迟到响应；桌面实时与手机恢复分别验证。

### U08. 首次配置与模型故障诊断（4–6 人日）

**证据：** [首次密钥表单](../packages/ui/src/login/LoginApiKeyForm.tsx) 保存 provider、选择默认模型后即标记成功，未进行可用性验证。[设置 hook](../packages/ui/src/hooks/useModelProviders.ts) 与 [connectivity service](../packages/services/src/model-provider/providerSettingsConnectivity.ts) 已有连通检查；[CLI Provider Doctor](../apps/acode-cli/packages/cli/src/provider-doctor-command.ts) 已按 [spec](../apps/acode-cli/specs/provider-doctor.md) 提供 offline/catalog/live 分档。

**建议与所有者：** GUI 整合已有诊断能力，清楚区分“已保存”与“已验证”。Registry 继续拥有 provider 配置与目录，vault 拥有凭据；诊断只读取并返回结构化 checkpoint 和修复动作。UI 通过 hook/service 公共接口访问，不直导 CLI adapters。首次配置可能还没有 workspace，不能硬复用要求 workspace 的设置页 probe。

**验收：** 默认 offline 零网络，用户可稍后验证；catalog/live 由用户选择，live 提示可能产生费用。错误密钥、无可用模型、失效凭据引用、断网/代理和策略阻断有不同结果；失败保留草稿，重试不重复创建 provider。桌面、手机和中英文状态一致。

### U09. 文档事实校准与升级/备份说明（1–2 人日）

**证据：** [中文 README](../README.zh-CN.md) 仍把 OS keychain 写作未来方向；[英文 README](../README.md)、[master key 实现](../packages/shared/src/node/credentialMasterKey.ts)、[keychain 实现](../packages/shared/src/node/credentialKeychain.ts) 和 [凭据 spec](../packages/services/specs/credential-storage.md) 已描述/实现 OS keychain、Windows DPAPI 与 Linux fallback。[安全交接文档](./security-hardening-handoff.md) 记录的是较早阶段，需要标注历史适用范围。

**建议与所有者：** 各能力的模块 spec 保持权威，README 与升级说明链接该事实源；建立简短能力/状态索引，双语内容同步更新。按实际存储模式说明同机备份、跨机迁移和回滚限制。现有 mixed-generation key 恢复与备份行为应解释清楚，不重复设计。

**验收：** 中英文对凭据保护和 fallback 的描述一致；历史报告保留日期并指向当前 spec；删除模块时同步清理指令和技能引用。不得把 OS 绑定的保护材料说成可直接跨机复制，不建议通过删除密钥或导出明文解决迁移。技术债数量来自新的检查结果，历史数保留时间标签。

## 6. P2：降低维护成本与媒体开销

### U10. Runtime 写入边界与大组件分批收敛（Runtime 首批 5–8 人日，UI 另估）

**证据：** [runtime ownership spec](../apps/acode-cli/specs/runtime-state-ownership.md) 已做类型分簇，但 [internal.ts](../apps/acode-cli/packages/core/src/runtime/internal.ts) 仍组合为扁平字段，[methods 安装入口](../apps/acode-cli/packages/core/src/runtime/methods/index.ts) 仍使用 prototype 注入。reservation、drain 防重入与 generation 防护已存在，不能据此断言当前有双 turn bug。[UI 大组件计划](../packages/ui/specs/god-component-split-plan.md) 已完成附件预览的第一批抽取，其余交互仍需回归保障。

**建议与所有者：** 先为真实 runtime 的 I1–I4 不变量补测试与 dev-only 断言，再以一簇为单位限制 admission、drain、branch generation 的写入口。core/runtime 是唯一写入方，bootstrap 只发命令、读回执。UI 在 U03 场景稳定后再拆发送、历史回滚和命令闭包，保持当前 store/service 所有权。

**验收：** 并发 prompt 只有一个 active reservation，drain 不重入，rewind 后迟到通知被 generation fencing 拒绝，一次性 flag 不反向复位；生产环境不因调试断言引入新的崩溃。拆分前后交互证据一致，架构存量项减少；baseline 只在实际债务消除后收紧，不能刷新基线掩盖新增违规。

### U11. 工具图片使用受授权附件引用（6–9 人日）

**证据：** [v4 tool display](../packages/shared/src/acode-protocol-v4/toolDisplay.ts) 的 `node_repl_images` 仍将 base64 放入 row，每张字符串上限为 `200 * 1024`、最多两张；[图片 renderer](../packages/ui/src/ToolCallBlocks/renderers/nodeReplImageGrid.tsx) 组合 data URL。lazy img 能延迟解码，不能消除 row 字符串的传输、解析和窗口占用。这也是 [内存预算 spec](../packages/ui/specs/renderer-memory-budget.md) 的后续方向。

**建议与所有者：** CLI/Host 中现有持久化 owner 管理媒体，shared v4 定义稳定引用与有界读取；UI 只保留引用、缩略图及有字节上限的 Blob 缓存。复用附件授权模式，但先明确工具 row 与 user attachment 的授权差异；renderer 提交的 ID 不能直接解释为文件路径。旧 base64 row 保持可读，新写入逐步使用引用。

**验收：** 新图片 row 的 snapshot/replay 不携带原图 base64；可见或预览时按需读取，重连后可恢复；跨 workspace/session 的引用被拒绝；缓存有上限；旧历史可预览。对图片密集历史记录桌面/手机网络字节和堆占用前后数据。当前 CUA 包保持 fail-closed，此项不包含恢复 CUA 功能。

### U12. 桌面与手机 Web 本地诊断报告（3–5 人日）

**证据：** [Web platform](../packages/web/src/main.tsx) 的 `exportLogs` 返回 unsupported；[帮助菜单动作](../packages/ui/src/lib/helpMenuActions.ts) 已定义导出能力，但 [帮助菜单按钮](../packages/ui/src/WorkspaceHelpMenuButton.tsx) 未提供该入口。[Desktop 导出](../packages/desktop/src/main/exportLogs.ts) 已具备日志整理和脱敏，项目也已有内存及 session debug 诊断，缺口在统一可用的产品入口。

**建议与所有者：** 服务提供脱敏诊断 DTO，UI 选择范围并预览，经 [IPlatformService](../packages/shared/src/platform.ts) 下载。Web 导出自己可获得的客户端 JSON；Desktop 按能力补充本机日志。复用 Provider Doctor、连接 profile、错误码和局部缓存计数，不引入自动上传或遥测，不默认采集会话正文、完整 header、凭据与机器路径。

**验收：** 手机可下载报告，离线也可生成客户端部分；报告明确未采集/不可用字段，不把无法检查显示为健康；含 token/header/路径的测试夹具通过脱敏；Desktop 现有 zip 导出保持可用。Web 不声称能够读取桌面的全部日志。

### U13. 发布台账门禁的触发面对齐与可复现性单一入口（2–3 人日）

**证据：** 三个缺口。（一）[licenses-notices.yml](../.github/workflows/licenses-notices.yml) 第 45-46 行的 `push` 只列 `branches: [main]`，**不含** `dev/**` 与 `release/**`（对照 [ci.yml](../.github/workflows/ci.yml) 第 13-17 行覆盖四类分支），台账漂移因此在 dev 线累积期间不可见，直到发布合并推送 main 才第一次被验出。（二）该文件第 29-44 行的 `pull_request.paths` 与台账 `inputs`（2869 项）逐条比对只覆盖 **455 项（15.9%）**，未覆盖的 2414 项含 `packages/ui/src/components/ai-elements/`(46)、`components/ui/`(45)、`packages/rpc/src`(22) 及 2292 个 material-icons SVG；本次 0.0.8 漂移的两个文件都在未覆盖集里，走 PR 同样拦不住——**但实现后核实：这 2414 项全是纯源文件，依赖树相关项零遗漏，手写 paths 对「触发全量重生成」这一实际职责是完备的**，故真正的缺口是「`inputs` 哈希漂移在 dev/release 线上无任何闸门」，修法是不受 paths 约束、无条件重算全部 2869 项的 inputs-only 检查（见下），而非扩大 paths。（三）[release.yml](../.github/workflows/release.yml) verify job 的八个步骤不含任何 licenses/inventory 校验，故 [git-collaboration.md](./git-collaboration.md) 第 53 行「licenses-notices 等专项闸门在 release 分支的推送上全部 success」无自动化强制。后果：由发布闸门逼出的「采用 CI Linux 规范产物替换台账」已连续三个发布同型返工（`b926b9e` 0.0.6、`390f73c` 0.0.7、`572733a` 0.0.8；另有 `34b1766`、`39f54f7` 两次属常规重生成非闸门失败）。0.0.8 现场为 main 推送 run `38202911921` 失败于「Report diff against committed ledger」（licenses-notices.yml 第 159 行），`inventory.json` 漂移 6 行而 `THIRD-PARTY-NOTICES.md` 逐字节相同。此外 [scripts/licenses.mjs](../scripts/licenses.mjs) 原本只有 `notices`/`check` 两子命令，复现性校验（重生成→diff→非空即失败）内联在 YAML 三步里，无单一入口——与 U01 收敛前「三处内联类型检查命令」同形状。

**建议与所有者：** 发布设施拥有台账生成口径、复现性校验入口与闸门触发面；各包维护者负责自己改动引入的哈希漂移。**已落地部分（2026-10-12，`dev/0.0.9`）**：判定逻辑收敛到单一入口 [scripts/third-party-reproducibility.mjs](../scripts/third-party-reproducibility.mjs)，[licenses.mjs](../scripts/licenses.mjs) 派发 `reproducibility`（`--inputs-only` 只重算 2869 源文件哈希 / `--diff-only` 跳过重生成只 diff / 默认全量重生成）与 `paths-filter [--coverage]` 两子命令；`hashBytes` 与 CRLF→LF 归一口径复用生成器同源，不另起哈希实现。ci.yml verify 接 `--inputs-only`（触发面已覆盖四类分支、零 install，实测内部 310ms），修缺口二；licenses-notices.yml 的 diff 判定改为调 `--diff-only`，YAML 不再保留第二份逻辑，修缺口一的复现性单一入口。**据实现后认识修正立项措辞**：未覆盖的 2414 项全是纯源文件、依赖树相关项零遗漏，故手写 paths 对「触发全量重生成」这一实际职责是完备的——把 `paths-filter` 的 27 条模式接进 licenses-notices.yml 反而错误（改一个 SVG 会触发约 90s 全量重生成而 SVG 不可能影响依赖树）；`paths-filter` 职责因此收窄为诊断与文档（L04 断言不变量），真正的缺口二修法是 ci.yml 那道不受 paths 约束、无条件重算 2869 项的 inputs-only 检查。能力边界如实划出：`inputs` 源文件派生可本地验，而 `packages`(814)、`noticesSha256` 派生自**已安装依赖树**，只能 CI Linux 重生成，本地探测不能完整替代闸门（L06 专门验此边界）。不改台账 schema，不把 CI 规范产物换成本机重生成产物。

**缺口三（已落地）**：release.yml verify 不含任何台账校验，故 git-collaboration.md 第 53 行「licenses-notices 等专项闸门在 release 分支的推送上全部 success」此前无自动化强制。**选定修法：把 `release/**`加进 licenses-notices.yml 的`push.branches`（原只有 `[main]`）**——第 53 行要的是这道闸门**在 release 分支上跑**，而非 release.yml 自己重跑一遍；该 workflow 分支无关（唯一 ref 引用是已按 `${{ github.ref }}`隔离的 concurrency group），加一个分支模式即让规则字面成立，并天然复用已有 musl 补丁与全量重生成、零逻辑重复。代价是 release 分支每次推送多跑约 72–102s 的 job（release 分支生命周期短、推送少，可接受）；刻意不含`dev/**`（推送频繁且中途态常改依赖会频繁红灯，dev 线的源文件哈希漂移已由 ci.yml 的 inputs-only 步覆盖）。**否决立项时列的另两个方向**：release.yml 加 `--diff-only` 是**空洞门禁**——该 job 对 `notices`/`inventory`/`licenses.mjs` 零命中、从不重生成台账，在那里 diff 等于比较两个从未被改动的东西、必然恒绿，比没门禁更糟（给出虚假安全感）；抽 composite action 共用 musl 则**不必要**，选定方案根本不需要 release.yml 跑重生成。能力边界据实现后核实修正：0.0.8 那类漂移的四个文件全在 `inputs` 里且 notices 逐字节未变，**inputs-only 即可检出**（已由 ci.yml 覆盖）；真正只能靠 musl 全量的只有**依赖树漂移**（`pnpm-lock` 变了但台账未重生成，牵动 `packages`/`noticesSha256`/notices 正文），即 0.0.7 `390f73c` 的失败类别。第 53 行规则文字在选定方案下已准确，**无需改动**——需要的是让机制追上文字。新增 L07 守卫测试机械钉住触发面（沿用 U01 `typecheck-gate.test.mjs` 扫描 workflow YAML 的先例），断言 `push.branches` 含 `release/**`且不含`dev/\*\*`、release.yml 不得出现空洞台账 diff 步骤、ci.yml 保留 inputs-only 步。

**验收：** 九个测试用例（L01 干净树 inputs-only 退出 0、2869 项全覆盖、内部 310ms；L02 改动一个当前 paths 未覆盖的被追踪源文件即红并指名；L02b 删文件报 missing 不与 mismatch 混淆；L03 `--diff-only` 在台账有 diff 时红并指名、干净树绿；L04 生成清单覆盖率 100%（2869/2869、27 条）而手写清单 15.9%；L04b 生成清单无冗余嵌套条目；L06 依赖树漂移时 inputs-only 仍绿、如实证明覆盖不到依赖树；L07 workflow 触发面守卫——`push.branches` 含 `release/**`、不含 `dev/**`、release.yml 无空洞台账 diff、ci.yml 保留 inputs-only 步；及 CRLF/LF 归一不误报）已 RED→GREEN 并跑破坏对照（移除 CRLF 归一化后 L01 与 CRLF 用例双红、移除 `release/**` 后 L07 红，还原后均复绿）。定量门槛：生成清单覆盖率 100%、inputs-only 干净树误报 0 且 ≤10s、全量 CI 预算 120s、复现性失败一律阻断（不得 `continue-on-error` 降级），修复只采用 CI Linux 重生成产物。真实 CI 已确认：licenses-notices.yml 调 `--diff-only` 的 run `38215896152` notices job success（musl 全量重生成管线内跑通）；ci.yml 新「Third-party ledger inputs freshness」步在干净 Linux checkout 上 success（run `38218018161`）。licenses-notices.yml 在 release 分支自动触发那半边需下次真实 release 分支推送时观察。细化见 [U13](./upgrades/quality-and-release-2026-10.md)。

### U14. Windows Computer Use —— 移植上游 Apache-2.0 资产 + 自写原生 producer（14–24 人日，六阶段可独立交付）

**证据：** 调查基线 `dev/0.0.9`。**这不是「从零做一个功能」，而是「填一个边界已完全画好的洞」。** 三个关键事实：（1）ACode 宿主侧基础设施已建好且已接线——按上游 `zai-org/ZCode@main` 完整 git tree 逐路径比对，CUA 相关条目 178 个中 **167 个是文件**（另 11 个为目录），其中 **ACode 已有 90 个文件**（含整套 UI 渲染层 `ToolCallBlocks/renderers/cua*.tsx`、权限 UI `cua-permission/`、shared 契约、desktop main 十个 `cua*.ts`、services 的 installer/permissionService/pipSession 与三个 `windowsCua*` 宿主文件、`node-repl-host` 的 `cua-bridge.ts`(204 行)/`cua-broker.ts`(181 行)、`official-cua-media.ts`、`computer-use-operation-event.ts`）；接线真实（[node.ts:484](../packages/services/src/node.ts) import `WindowsCuaHelperHost`，能力谓词 `node.ts:685` 已含 win32，CUA 默认 ON——`runtimeEnv.ts:41-48` 仅显式 `0`/`false`/`off` 关闭）；原生 FFI 已有范式（[windows-job-object.ts](../apps/acode-cli/packages/adapters/src/mcp/windows-job-object.ts) 202 行经 koffi 调 `kernel32.dll`，`koffi@2.15.6` 已是 adapters 依赖且 `allowBuilds` 已放行）。占位包 [acode-cua](../packages/acode-cua) v0.6.3 的 12 个导出子路径全部 fail-closed，[module-boundary.md](../packages/acode-cua/specs/module-boundary.md) 不变量 3 明写「与上游真实 CUA 包 API 兼容、**消费者零改动**」。（2）**上游 `zai-org/ZCode` 是 Apache-2.0 开源**（`Copyright 2026 Z.AI Co., Ltd`，7704 stars，ACode 即其 fork），其中约 **133 KiB 真实源码可合法移植**：CUA 客户端 `computer-use-client.mjs`（58154 B / 1203 行，真实实现非占位）、skill `SKILL.md`（14290 B）、Windows Helper 打包 `windows-cua-helper-assets.mjs`（984 行）+ `prepare-windows-cua-helper.mjs` + `computer-use-producer.mjs`、`cua-bridge.test.ts`（9461 B）与 `computer-use-onboarding.test.ts`（2627 B）、三个 services 文件（在 ACode 引用数为 0，属上游新增特性）、dev 环境脚本；另有约 **789 KiB / 54 份 CUA 规范文档**（`docs/cua/`、`docs/cua-permission-broker/`、`docs/superpowers/{plans,specs}/`）在 ACode 全缺，可移植后直接作为 producer spec 依据。（3）**真正缺的只有原生 producer**（`ax_native.node` 等价物 + `windows-helper.js` 入口 + 14 个 broker 工具处理器）——上游开源仓库、npm、逆向树**三处都没有**（全仓 code search：`binding.gyp`/`IUIAutomation`/`filename:windows-helper.js` 命中 0；`ax_native` 17 处与 `windows-helper.js` 12 处命中**全在 docs/ 里无一是源码**；`packages/ax-macos` API 返回 Not Found；npm `@zcode/zcode-cua` 404；官方 `packages/zcode-cua` 的 README 与 ACode 的**逐字相同**、同为 fail-closed 占位）。

**契约已由上游规范完整定义（无需自行设计）：** 14 个 broker 工具（`list_apps`、`list_windows`、`get_app_state`、`left_click`、`scroll`、`left_click_drag`、`type`、`set_value`、`select_text`、`key`、`perform_action`、`paste`、`request_access`、`stop_computer_control`）；其中 10 个为变更类方法（决定 `possibly_sent`「绝不重放」判定路径）；15+ 条 broker→SDK 错误码映射（未知码归 `INTERNAL`，绝不静默成功）；`PLATFORM_EXCLUDED_METHODS` 当前为空（`open_application` 已于上游删除，启动/激活并入 `get_app_state` 透明拉起）；`acodeCuaRuntime` 契约（键恰为 `["schema","windows"]`、`windows` 键恰为 `["entry","nativeAddon"]`、规范相对路径且互不相同，当前在 ACode `package.json` 缺席）；Windows 产品形态（`ELECTRON_RUN_AS_NODE=1` fork Helper entry + 加载 `ax_native.node`，发布于 `resources/tools/cua-helper`，外置依赖 `express` + `sharp`，签名走 electron-builder `signExts(.node/.dll)` 且先签名再刷新 `manifest.sha256`）；两阶段就绪（`transport_ready` → `ready`，因 Windows named pipe 无 Unix socket 原子让渡语义，warming-up 期以可重试 `broker_unavailable` 响应）。

**许可（修正立项初稿的错误判断）：** 初稿曾把 `zcode-recovered`（逆向还原树）与 `zai-org/ZCode`（官方开源仓库）混为一谈，据此判「法律阻断、不可搬运」——该结论对逆向树成立、对官方 Apache-2.0 仓库**不成立**。区分：`zcode-recovered` 是 ZCode 已签名安装产物的逆向还原（无 LICENSE/NOTICE，`plugin.json` 的 `"license": "MIT"` 是逆向产物内部自我声明），本仓 [capability-uplift-plan.md 第 5 节](./capability-uplift-plan.md) 硬约束「禁止再分发、只搬运机制设计」对它依然有效，**从该树复制源码被禁止**；`zai-org/ZCode` 是 Apache-2.0，**明确授予复制与衍生权利**，义务是保留版权/许可声明并标注修改，且本仓已有先例（`third-party/copied-components.json` 登记了 ai-elements Apache-2.0 等）。故本项从**官方仓库**移植资产、按 Apache-2.0 登记台账并过 licenses-notices 闸门；混淆二者会白白放弃 133 KiB 源码与 789 KiB 规范。

**建议与所有者：** producer 必须发布为 `@acode/acode-cua` 包身份（`windowsCuaDevRuntime.ts:9` 硬编码 `EXPECTED_PACKAGE_NAME`，三处校验，不能新建独立包）；权限/生命周期状态归 `cua-permission-broker`；桥与传输归 `node-repl-host`（已实现）；OS 判定归 `cuaOsSupport.ts`；打包归 `packages/desktop/scripts/`。六阶段：**阶段 0（2–3 人日，与选型无关、可立即开工、独立净收益）** 移植上游 `cua-bridge.test.ts`/`computer-use-onboarding.test.ts` + 为 1806 行零覆盖宿主代码补不变量测试（12 类 `WindowsCuaDevRuntimeResolutionReason`、路径逃逸、契约键精确匹配、broker token 与 1 MiB/32 MiB 上限）+ 声明 `acodeCuaRuntime` 契约；**阶段 1（1.5–2.5 人日）** 移植 54 份规范与 133 KiB 资产（登记台账）+ 裁决选型 + 写 producer spec；**阶段 2（4–7 人日）** 最小 producer（截图+鼠标+键盘，Win32 即可、不依赖 UIA）经 `ACODE_CUA_DEV_ROOT` 端到端验证；**阶段 3（4–7 人日，选型依赖）** UI 树读取（UIA 对应 macOS AX 树，`get_app_state`/`list_apps` 依赖，是风险主要来源，上游 pointer-foundation/wgc-visual-capture/native-clipboard/ax-action-state-consistency/frame-pixel-zoom-regression 五份设计可参照）；**阶段 4（1–2 人日）** 平台判定与两阶段就绪收口（`request-access-contract.d.ts:5` 的 `platform:"darwin"` 字面量扩联合、`cuaOsSupport.ts:20` 加 Windows 分支、复核 `node.ts:2182/2193`、实现 `transport_ready`→`ready`）；**阶段 5（2–3 人日）** 产品打包、签名、完整性校验（须处理 Windows Smart App Control 拒载未签名 addon）。

**三项阻塞决策（阻塞阶段 2 及以后；阶段 0 与全部决策无关）：** 一、原生层选型——A（koffi+Win32，零新增工具链但 UIA 是 COM vtable、koffi 表达困难，可能交付不了 UI 树）/ B（node-addon-api，能力完整、`node-addon-api` 与 `node-gyp` 已在树内，但引入跨 arch 预编译与签名复杂度）/ C（外部进程讲 `acode-cua-windows-dev/v1`，与现有 fork 模型吻合；但**上游实际形态是 B 的变体**——`ELECTRON_RUN_AS_NODE=1` fork + `ax_native.node` addon，偏离会同时偏离 789 KiB 规范适用性）。二、producer 包内部形态——B1 保持占位扁平布局按平台条件加载（守 `module-boundary.md` 不变量 2/4）vs B2 按上游升级为含 `src/`+构建步骤的 producer 包（与上游规范布局一致、移植无需翻译，但须改不变量 4、`architecture-policy.yaml` 的 `global.aliasRules` 与 knip 入口）；**倾向 B2**（原生 producer 必然需构建步骤，B1 的「无构建」不变量守不住），但须与 `architecture-governance` 对齐、不得绕过架构检查。三、broker 鉴权是否跟进上游 peer-identity 迁移——上游已删 token 改 native peer-identity，但其文档同时记载 Windows 侧 peer 校验**尚未落地**、自 producer `37a0c9ef` 起临时放开（`WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN`），故 ACode 保留现有 token 鉴权是当前唯一可用路径，迁移应作独立后续项、不阻塞本项。

**验收：** 十五个场景 C01–C15（宿主不变量测试全绿覆盖 12 类失败原因与路径逃逸；缺 addon 以 `missing-native-addon` 稳定失败；契约多键/`entry===nativeAddon`/含 `..` 或反斜杠以 `invalid-package`/`invalid-artifact-path` 拒；dev root 是 symlink 时准入失败且不回退安装包资源；Windows 真机模型发 CUA cell 经 broker 返回真实结果；subagent 被拒不触达原生层；截图+鼠标+键盘真实生效且可被 `stop_computer_control` 中断；10 个变更类方法失败注入均按 `possibly_sent` 不自动重放；`list_apps`/`get_app_state` 返回真实 UI 树或显式报 `ACTION_UNAVAILABLE` 而非空树冒充成功；两阶段就绪期返回可重试 `broker_unavailable`；未知错误码归 `INTERNAL`；未签名 addon 被 Smart App Control 拒时 live smoke 以退出码 2 报告不静默降级；安装包 `resources/tools/cua-helper` 的 manifest/PE/sha256/依赖闭包/realpath containment 全通过、篡改任一 `.node` 字节即 `artifact-integrity-mismatch`；非 Windows 平台 macOS 保持既有语义、Linux 明确 not-applicable；移植的 Apache-2.0 资产过 licenses-notices 闸门且台账登记完整）。安全门槛：保留 subagent 拒绝、broker 鉴权、字节上限；原生层不得接受来自模型的任意路径或 DLL 名；截图与 UI 树按 `web-content-untrusted-discipline` 同等对待（不可信输入）；`pluginAuthority` 是唯一敏感凭据、不得出现在 argv/进程标题/日志/错误文本/telemetry/UI。隐私门槛：日志只记 reason/artifact/errorName，绝不落屏幕内容。回退：producer 未就绪保持 fail-closed（`module-boundary.md` 不变量 1 硬约束），**能力真实性优先于覆盖面**——宁可少实现并显式报 `ACTION_UNAVAILABLE`，不得返回空结果冒充成功。许可门槛：从 `zai-org/ZCode` 移植的每份资产登记进 `copied-components.json`（含 source/sha256/license/provenance）+ 保留上游版权声明 + 标注修改 + 过闸门；从 `zcode-recovered` 逆向树复制源码仍被禁止；第三方原生库（`sharp` 及 `@img/*`、`express`）同样须登记。细化见 [U14](./upgrades/product-and-support-2026-10.md)。

## 7. 建议交付顺序

| 批次                  | 范围                                                                                                                             | 进入下一批的条件                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：先使问题可见       | U02、U13；并行完成 U09（U01 已完成）                                                                                             | 执行故障有稳定复现与终态断言，文档事实与当前实现对齐；台账漂移在改动分支即可见                                                                      |
| B：建立交互与发行保障 | U03、U04、U06                                                                                                                    | 桌面/手机关键交互可重复，产物在仓库外可启动，性能实验可复现                                                                                         |
| C：完成既有收敛与体验 | U05 分里程碑，U07、U08                                                                                                           | 双链路契约稳定，legacy 消费者按阶段减少，历史定位与首次配置通过交互验收                                                                             |
| D：按证据逐项优化     | U10、U11、U12                                                                                                                    | 不变量、媒体成本和用户诊断需求有明确基线，每项独立验收                                                                                              |
| E：新增最高权限能力   | U14 阶段 0 可立即开工（补 1806 行零覆盖宿主代码的测试 + 声明 `acodeCuaRuntime` 契约，与选型无关）；阶段 1–5 待技术选型裁决后推进 | 阶段 0 有独立净收益、可单独交付；阶段 2 前必须先裁决原生层选型（koffi+Win32 / node-addon-api / 外部辅助进程），因它决定 UI 树读取（阶段 3）是否可行 |

下一项具体工作：U02——为 `node-execution-adapter` 与 `ConversationV4Gateway` 建立真实子进程 fixture，先落 E01/E02（spawn 前取消、运行中取消各只结算一次），再扩到 E03-E10。其余建议先保留为待排期项，不同时启动多个跨域重构。
