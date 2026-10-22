# AgentTeams 0.4.0 移植独立验收报告

- 验收日期：2026-10-20
- 验收人：verifier（独立验收，未参与实现）
- 目标仓库：`D:\AnkerCodes\QYDemo\ACode1`
- 分支 / HEAD：`dev/1.0.1` @ `38b93920`
- 对照基线：t-1（同一仓库，HEAD 干净、插件 0.1.0 时采集）
- 验收范围：**仅 AgentTeams 移植批**——`agent-teams-plugin`、`pluginStates` 宿主链路（contracts/adapters/bootstrap/shared protocol）、`packages/ui` 团队卡/侧栏/审批相关文件。验收快照采集于 11:00–11:25；此后启动的 usage-bar 并行批次（t-12~t-15：`packages/ui/src/v4/composer/usage-bar/**`、旧状态栏下线、composerTurnMetrics/sessionToolStats 协议与 CLI 投影、composerUsageBar 设置）**不属于本报告范围，未验收**，其改动不参与本报告的通过/失败判定。
- 改动盘面：121 个 git status 条目（74 modified、1 deleted、46 untracked）；验收执行前后逐行一致，验收人仅新增本报告文件，未改任何源码
- 结论：**不通过（有条件）**。核心能力与门禁大部分通过；但存在 **2 项本次引入的测试红**（发布描述 parity、第三方台账可复现性）与 **4 个改动文件的真实格式偏差**，另有 **S6 运行时行为与 S14 双链路手工场景未验证**。

## 1. 门禁结果（真实退出码）

所有命令均在目标仓库根目录执行；退出码用 `cmd > log 2>&1; code=$?` 直接获取，未使用管道掩码。日志目录：`C:\Users\admin\AppData\Local\Temp\acode1-verify\`。

| # | 命令 | 退出码 | 结果摘要 |
| --- | --- | --- | --- |
| 1 | `node scripts/check-workspace-freshness.mjs --no-fetch` | 0 | `dev/1.0.1` 与 origin 同步；ahead 21 / behind 0。普通（带 fetch）命令因网络 `git fetch` 挂起被终止，改用 `--no-fetch` 取确定性结果 |
| 2 | `pnpm --filter @acode/agent-teams-plugin build` | 0 | 3s；tsc + build.mjs |
| 3 | `pnpm --filter @acode/agent-teams-plugin typecheck` | 0 | `tsc --noEmit` |
| 4 | `pnpm --filter @acode/agent-teams-plugin lint` | 0 | 0 warnings / 0 errors，30 files |
| 5 | `pnpm --filter @acode/agent-teams-plugin test` | 0 | tests 96 / pass 96 / fail 0 |
| 6 | `pnpm --filter @acode/agent-teams-plugin smoke` | 0 | `SMOKE OK`（含多团队、归档、adopt、panel 端点） |
| 7 | `pnpm typecheck` | 0 | 三阶段 done：packages 3.8s / desktop-renderer 2.5s / cli 0.9s（增量与 turbo 缓存，内容哈希已随最终改动更新） |
| 8 | `pnpm lint` | 0 | Found 166 warnings and 0 errors（与 t-1 基线 166 相同，无新增 warning） |
| 9 | `pnpm fmt:check` | **1** | 648 files flagged；其中 643 个未改动文件的既有红，4 个改动文件存在真实格式偏差（见 §4.1） |
| 10 | `pnpm architecture:check --changed` | 0 | violations 358 / baseline 358 / **new 0 / regrown 0** |
| 11 | `pnpm verify:pre-push` | 0 | lint + architecture 总闸通过 |
| 12 | `node node_modules/turbo/bin/turbo --cwd apps/acode-cli run lint` | 0 | 17/17 tasks successful（warnings only，如 @acode/core 19 warnings） |
| 13 | `pnpm --dir apps/acode-cli test` | **1** | tests 2935 / pass 2891 / fail 8 / skipped 36（逐项归因见 §4.2） |
| 14 | `pnpm --filter @acode/shared test` | 0 | tests 267 / pass 267 / fail 0 |
| 15 | `pnpm --filter @acode/ui test` | 0 | tests 424 / pass 424 / fail 0（含全部新增团队模型/组件测试） |
| 16 | `node --import tsx --test tests/agent-teams-registration-parity.test.mjs`（cwd=`apps/acode-cli`） | 0 | tests 6 / pass 6 / fail 0 |
| 17 | `pnpm install --offline`（基线阶段） | 1 | `ERR_PNPM_NO_OFFLINE_TARBALL`：缺 `shell-quote-1.11.0.tgz` |
| 18 | `pnpm install`（联网，基线阶段） | 0 | 156s；cpu-features gyp 失败与 bin WARN 均非致命 |

注：`pnpm --dir apps/acode-cli lint` 直接运行会以 `'turbo' 不是内部或外部命令` 失败（既有环境问题，见 `apps/acode-cli/scripts/typecheck-gate.mjs:33-34` 的注释）；因此改用第 12 行的 node 入口跑同一 turbo lint，退出码 0。

### 1.1 与 t-1 基线对照

| 项 | t-1 基线（插件 0.1.0、干净树） | 本次最终树 | 判定 |
| --- | --- | --- | --- |
| `pnpm typecheck` | exit 0，255s | exit 0 | 无回归 |
| `pnpm lint` | exit 0，166 warnings / 0 errors | exit 0，166 warnings / 0 errors | 无回归 |
| 插件包 test | exit 0，65 pass / 0 fail | exit 0，96 pass / 0 fail | 通过，+31 用例 |
| `pnpm fmt:check` | 基线未执行（t-1 范围外）；本次用未改动文件证明既有红 | **exit 1**，648 files | 既有环境红 + 4 个改动文件真实偏差 |
| `pnpm architecture:check --changed` | 基线未执行 | exit 0，new 0 | 通过 |

## 2. 验收项结论（t-7 acceptance）

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 每条验收标准有 pass/fail 与证据（命令、退出码、失败摘要、文件:行号） | PASS | 本报告 §1、§3、§4 |
| 门禁结果与 t-1 基线对照，区分既有红与本次引入 | PASS | §1.1、§4.2 |
| 版本四处一致与 17 工具清单逐项核对 | PASS | §3.1、§3.2；parity 测试 6/6 通过 |
| trust-wrapper 读边界（status/claim/captain unread）逐处核对 | PASS | §3.3 |
| 插件目录与 UI 新增文件无 zcode 命名残留 | PASS | §3.4 |
| 所有新增文件 ≤400 物理行，既有文件增长有说明 | PASS（有保留） | §3.5：生产/UI 新增文件全部 ≤400；新增测试 `worktree.test.ts` 519 行、`multi-team.test.ts` 457 行超出，但 spec §3.5 与 architecture 策略明确测试文件不参与 ratchet |
| 报告写入 `docs/agent-teams-port-verification.md`（只写该报告文件） | PASS | 本文件 |
| 未修改任何源码文件 | PASS | 验收执行前后 121 条工作树条目逐行一致；验收人新增仅本报告 `docs/agent-teams-port-verification.md`（git status 122 条） |

## 3. 静态核对

### 3.1 版本四处一致 = 0.4.0（PASS）

| # | 文件:行 | 值 |
| --- | --- | --- |
| 1 | `apps/acode-cli/packages/agent-teams-plugin/package.json:4` | `0.4.0` |
| 2 | `apps/acode-cli/packages/agent-teams-plugin/.acode-plugin/plugin.json:3` | `0.4.0` |
| 3 | `apps/acode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:329` | `0.4.0`（`defaultEnabled: true` 与 `requiredSeedPaths` 保持不变） |
| 4 | `apps/acode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs:65` | `0.4.0`（`requiresRuntime: true`、requiredRuntimePaths 与 seed 清单镜像） |
| 附 | `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:73` | MCP server `acode-agent-teams` / `0.4.0` |

`agent-teams-registration-parity.test.mjs` 6/6 通过，包含「版本四处一致」「requiredSeedPaths 镜像」「远端合同」「桌面/预构建/SEA 入口」「knip 入口」。

### 3.2 17 工具与权限矩阵（PASS）

实际导入 `src/tools/*` 组合出的 registry 后逐项打印，`count=17`：

| 工具 | memberAllowed | 工具 | memberAllowed |
| --- | --- | --- | --- |
| `agent_teams_create` | false | `agent_teams_create_task` | false |
| `agent_teams_approve_plan` | false | `agent_teams_amend_task` | false |
| `agent_teams_status` | true | `agent_teams_reassign_task` | false |
| `agent_teams_resume` | false | `agent_teams_claim_task` | true |
| `agent_teams_delete` | false | `agent_teams_update_task` | true |
| `agent_teams_adopt_team` | false | `agent_teams_send_message` | true |
| `agent_teams_add_member` | false | `agent_teams_wait_for_work` | true |
| `agent_teams_bind_member` | false | `agent_teams_merge_member_worktree` | false |
| `agent_teams_remove_member` | false | — | — |

证据：`src/server.ts:26-33` 的 `ALL_TOOLS` 组合；`tests/tools.test.ts:592-628` 钉死 17 个名称与权限矩阵；`tests/worktree.test.ts`、`tests/multi-team.test.ts` 覆盖新工具行为；插件测试 96/96 通过。

### 3.3 trust-wrapper 读边界（PASS）

- member `status`：`src/tools/team-status.ts:90-91`，`unread_messages: wrapTeamMessageBodies(messages)` + `trust_note: TEAM_TRUST_NOTE`。
- captain `status`：`src/tools/team-status.ts:147-148`，`unread.captain` 同样包装 + `trust_note`；成员未读只给计数，无正文，无需包装。
- `claim_task`：`src/tools/tasks-progress.ts:118-119`，认领返回的未读正文包装 + `trust_note`。
- 磁盘 mailbox 存原文：`tests/trust-wrapper.test.ts:195-207` 断言落盘 JSON 等于原文；包装只发生在读边界。
- 框架行/缩进/伪造框架行中和：`src/trust-wrapper.ts:60-84`；`tests/trust-wrapper.test.ts:172-241` 全绿。
- 源 0.4.0 新增的 `team-status.ts` 接线来自旧 `team.ts` status 分支迁移，`trust-wrapper.ts` 与测试保留未被覆盖。

### 3.4 命名残留（PASS）

- 插件目录（`src/`、`tests/`、docs、manifest、skill/command/agent）grep `zcode|ZCODE_|@zcode/|zcode-plugin-state|zcode/wt|.zcode/worktrees`：**0 命中**。
- 全部 46 个 UI 新增文件 grep 同上：**0 命中**。
- 全改动清单仅剩两类允许项：`apps/acode-cli/specs/agent-teams-port-0.4.0.md` 的映射表（spec 本身讨论 ZCode→ACode），以及 `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 中 `HEAD` 已存在的 `ACode/ZCode server` 注释（`git show HEAD:` 可证，非本次引入）。
- worktree 命名：`src/worktree/naming.ts:8-10` 为 `.acode/worktrees`、`/.acode/worktrees/`、`acode/wt/`；归属判据只认 `acode/wt/` 前缀与 `<repoRoot>/.acode/worktrees/` 路径。

### 3.5 400 行 ratchet（PASS，带说明）

- 插件生产源码最大：`server.ts` 387、`store.ts` 369、`panel.ts` 353、`merge.ts` 286；**无任何 >400**。
- UI 新增生产文件最大：`teamPanelModel.ts` 374；**无任何 >400**。
- `packages/ui/src/v4/conversationStatusPanelModel.ts` 385 → **399**（≤400，仅余 1 行余量，后续改动需先抽离）。
- 既有大文件增长均属 spec R4 预期：`ConversationStatusPanel.tsx` 2099→2246（+149）、`SessionPane.tsx` 3719→3760（+41）、`workspaceSidePane.ts` 2304→2376（+72）、`ConversationTimeline.tsx` 1903→1918（+15）、`AnimatedSidePanePanel.tsx` 1401→1422（+21）、i18n en +111 / zh +109 行。`architecture:check --changed` 报 `new 0 / regrown 0`。
- 新增测试超 400：`tests/worktree.test.ts` 519、`tests/multi-team.test.ts` 457。spec §3.5 明确「测试文件不参与」且 architecture 策略同样豁免，故不判失败；若要求字面意义全文件 ≤400，则这两项需拆分。

## 4. 未通过项与建议修复

### 4.1 P2：`pnpm fmt:check` 对 4 个改动文件存在真实格式偏差（本次引入）

整体 exit 1、648 files。用 `tr -d '\r'` 后经 `oxfmt --stdin-filepath` 复验，区分「CRLF 环境噪声」与「真实格式偏差」：

| 文件:行 | 现象 | 归因 |
| --- | --- | --- |
| `packages/ui/test/teamApprovalCard.gaps.test.ts:24` | `type ... = import(...).ConversationStatusPanelTeam;` 超过行宽，oxfmt 要求换行 | 本次新增文件 |
| `packages/ui/test/teamPanelModel.test.ts:104` | `assert.equal(isTeamEnded({...}), false)` 超过行宽，oxfmt 要求多行 | 本次新增文件 |
| `packages/ui/src/i18n/locales/en-US.ts:6829` | 新增团队键块尾部多出一个空行（`6830 };` 前） | 本次新增行 |
| `packages/ui/src/i18n/locales/zh-CN.ts:6547` | 同上（`6548 };` 前） | 本次新增行 |
| `packages/ui/src/styles.css` | 去 CR 后格式正确，仅 CRLF 触发 | 既有环境噪声，非格式问题 |

其余 643 个 flagged 文件均未被本次改动（如 `tsconfig.base.json`、`packages/web/index.html`、`third-party/README.md`，抽查去 CR 后格式正确）；本 checkout `core.autocrlf=true`、全仓 CRLF，`pnpm fmt:check` 在基线上即为红（未改动文件同样被判失败即可证明）。**建议**：只对上述 4 个改动文件运行 `oxfmt` 修正，不要为过门禁而全仓 `pnpm fmt`（会改写 600+ 无关文件）；仓级 fmt 红作为既有环境问题单独登记。

### 4.2 P1：`apps/acode-cli test` 8 个失败中 2 个为本次引入

完整结果：tests 2935 / pass 2891 / fail 8 / skipped 36。逐项归因：

| 失败测试 | 归因 | 证据 |
| --- | --- | --- |
| `plugin-registration-description-parity.test.mjs:44` 描述漂移 | **本次引入** | `plugin.json:8` 的 zh-CN 缺「与成员工作树隔离」，而 `official-plugin-definitions.ts:305` 已加。事实源按测试是 plugin.json。单独重跑 exit 1 |
| `third-party-reproducibility.test.mjs:84-86` L01 | **本次引入** | 台账 `third-party/inventory.json:242`（agent-teams package.json）与 `:1562`（ui/styles.css）记录的 sha256 分别等于 **HEAD** 内容哈希，不等于当前工作树哈希；即本次两文件改动后未重生成台账。实测 recorded=HEAD=`641178b0…`/`d45758c6…`，worktree=`f27685c8…`/`d1b95c82…`。两处均在 AgentTeams 范围内：package.json 为版本/描述变更，styles.css 新增 `.wf-pill-tall/.wf-pill-sub` 两行团队药丸样式（`git diff` 可证） |
| `generate-visualize-design-tokens.test.mjs` ×3（产物漂移 / --check / @generated 头） | 既有环境红 | 失败差异全部是 `\r\n` vs `\n`；产物文件 `apps/acode-cli/packages/bundled-skills/skills/visualize/references/design-tokens.md` 未被本次改动（`git diff --quiet` exit 0）且带 CRLF |
| `mcp-crash-storm-probe-ladder.test.mjs:413`（退避 40 vs 80） | 波动 | 单独重跑 exit 0（6/6 pass） |
| `mcp-startup-gate-deferred-tools.test.mjs:305`（connecting vs connected） | 波动 | 单独重跑 exit 0（9/9 pass） |
| `skill-seeding-integration.test.mjs:84`（browser-use marker ENOENT） | 既有环境红 + 测试自身缺陷 | `scripts/browser-client.mjs` 是 `.gitignore` 产物（`browser-use-plugin/.gitignore:2`），HEAD 无此文件；`resolveOfficialPluginRoots()` 返回 `string[]`（`bundled-plugins.ts:265-293`），测试却在 `skill-seeding-integration.test.mjs:89-90` 对返回项取 `.name`，导致失败集合恒为空、随后在 `:109` 读 browser-use marker 必然 ENOENT |

**建议修复（按优先级）**：
1. 同步 `plugin.json` 的 zh-CN description（事实源）与 `official-plugin-definitions.ts:305`，然后重跑 `agent-teams-registration-parity.test.mjs` 与 `plugin-registration-description-parity.test.mjs`。
2. 重新生成第三方台账（仓库既有入口 `node scripts/licenses.mjs notices`，会更新 `third-party/inventory.json` / `THIRD-PARTY-NOTICES.md`），确认只包含本次两文件哈希变化后提交。
3. 修正 §4.1 的 4 个格式偏差。

### 4.3 未验证项（必须如实标注）

- **S6 `agent_teams_wait_for_work` 运行时行为未验证**：代码审阅通过（`src/tools/member-wait.ts:16-17,76-149`：8 分钟上限、2 秒轮询、`manageOwnLock`、`team_archived`/`caller_not_member` 冒泡、`waitingUntil` 标记与清理；`src/scheduler.ts:51-62` 等待期不派 wake），但 `tests/` 中没有任何 wait 行为用例（grep `wait_for_work` 仅命中 prompt-contract 与 17 工具清单）。建议补：ready 理由三态、8 分钟 `ready:false`、归档/移出错误码、waitingUntil 抑制 wake。
- **S14 双链路与手工 UI 未验证**：无 E2E/桌面环境。`desktop-continuous` 实时更新、`web-remote-replayable` 重连/冷恢复、主题可读性、真实面板交互均未执行。宿主机理有单测覆盖（投影幂等/冷恢复重放、池路由、wire 兼容），但不等同于端到端。
- **并行批次未验收**：usage-bar 批次（t-12 规格 → t-13 数据面 → t-14 UI → t-15 接线/旧状态栏下线）在本次验收快照之后启动，其文件与门禁结果不在本报告通过/失败判定内。若后续门禁红来自这些文件，应归因并行批次。
- **DOM 渲染**：`packages/ui/test/ConversationTeamStatusPanel.test.ts` 使用自建 `test/helpers/minimal-dom-shim.ts`（211 行）做最小渲染验证；视觉/布局未验证。

## 5. 关键实现对照（抽检证据）

- 通知链：`src/server.ts:223-259` 写盘后在锁内构造快照并 `server.notification`；`adapters/src/plugins/mcp.ts:187-191` 由 loader 注入 `pluginId`；`adapters/src/mcp/index.ts:1718-1744` 仅识别 `acode-plugin-state:` 前缀；`adapters/src/mcp/pool.ts:59-88,375-391` 按 lease 路由、无 session 的 lease 不订阅、关闭清理。
- 事件/投影：`contracts/.../session.events.ts:158-165,1026-1042,1356`；`create-app.ts:696-748` 双桥接（adapter 回调 / lease 订阅）；`product-projection.ts:4559-4575` 键级整体替换 + `isDeepStrictEqual` 幂等；`projection-state.ts:89-90` 初始 `pluginStates: null`；`statePatchSchema` 容器不 strict；`pluginStates` 不在 `REVISION_BEARING_PATCH_KEYS`（`projection-state.ts:193-205`）。
- UI 唯一收窄：`packages/ui/src/v4/teamPanelModel.ts:102-223` 按 `agent-teams@…:agent-teams` 取键、`captainSessionId` 过滤、active/ended 分桶；`ConversationStatusPanel.tsx:2105-2155` 与 `app-shell/TeamSidePane.tsx:25-32` 共用该模块。
- 审批动作：`TeamApprovalActions.tsx:33-70` 只提供填入/复制/查看；`useTeamApprovalDraft.ts:34-42` 经唯一 composer 通道并传 workspaceIdentity；`ConversationComposer.tsx:267-285` 的 `append` 只写草稿、不发送。
- 工作树安全：`worktree/merge.ts:107-137,205` 拒绝脏主工作区/错分支/冲突，清理只用 `git branch -d`（未发现 `-D`）；`naming.ts` 只认 `acode/wt/`。

## 6. 修复复验（t-19，2026-10-20 11:38–11:45）

复验范围：t-7 的 2 项 P1 红（description parity、third-party L01）与 4 个文件格式偏差。复验期间除修复文件与台账外，工作树无其它新增/变化（`git status` 123 条，其中 121 条移植改动 + 台账 + 本报告；并行 usage-bar 批次尚未落盘）。

### 6.1 修复内容核对（仅描述/格式/台账）

| 文件 | 修复 | 判定 |
| --- | --- | --- |
| `.acode-plugin/plugin.json` | 顶层 description 与 `description_i18n.zh-CN` 补「与成员工作树隔离」，en 补 worktree 语义；`official-plugin-definitions.ts:305` 未再改动 | 仅描述变更（`git diff` 中另有版本/maxActiveTeams/keywords 换行，均为移植既有内容） |
| `third-party/inventory.json` | 仅两行哈希：agent-teams package.json → `f27685c8…`、ui/styles.css → `4d0a3f21…` | `git diff` 仅 2 处哈希，无其它条目 |
| `packages/ui/test/teamApprovalCard.gaps.test.ts:24` | 类型导入换行 | 纯换行 |
| `packages/ui/test/teamPanelModel.test.ts:104` | `assert.equal` 拆多行 | 断言内容不变 |
| `i18n/locales/en-US.ts` / `zh-CN.ts` | 删除团队键块尾部多余空行 | 键/值未变 |
| `packages/ui/src/styles.css` | 工作树转为 LF（内容仍为 16 行团队药丸样式新增） | 仅行尾，`git diff --numstat` 仍为 16/0 |

### 6.2 复验命令与真实退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node_modules/.bin/oxfmt --check packages/ui/test/teamApprovalCard.gaps.test.ts packages/ui/test/teamPanelModel.test.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/styles.css` | **0** | `All matched files use the correct format.`（5 files） |
| `node --import tsx --test tests/agent-teams-registration-parity.test.mjs`（cwd=`apps/acode-cli`） | **0** | tests 6 / pass 6 / fail 0 |
| `node --import tsx --test tests/plugin-registration-description-parity.test.mjs`（cwd=`apps/acode-cli`） | **0** | tests 2 / pass 2 / fail 0 |
| `node --import tsx --test tests/third-party-reproducibility.test.mjs`（cwd=`apps/acode-cli`） | **0** | tests 9 / pass 9 / fail 0 |

### 6.3 复验结论

- t-7 的 2 项 P1 红均已关闭；4 个格式偏差文件定向 `oxfmt --check` 通过，styles.css 行尾已归一。
- 修复未引入行为/文案变化：台账仅哈希两行、测试仅换行、i18n 仅删空行、plugin.json 仅描述（其余差异为移植既有内容）。
- 残留（非本次引入、不阻塞 t-7 修复项）：全量 `pnpm fmt:check` 仍会因 643 个未改动文件的 Windows CRLF 既有环境红而 exit 1；S6 wait 运行时行为、S14 双链路/手工 UI 仍未验证；usage-bar 并行批次仍未验收。
- 复验未修改任何源码，仅追加本节。

## 7. 附录：日志

`C:\Users\admin\AppData\Local\Temp\acode1-verify\` 下：

- 基线：`install-offline.log`、`install-online.log`、`typecheck-baseline.log`、`lint-baseline.log`、`plugin-test-baseline.log`
- 本次：`plugin-build.log`、`plugin-typecheck.log`、`plugin-lint.log`、`plugin-test-final.log`、`plugin-smoke.log`、`typecheck-final.log`、`lint-final.log`、`fmt-check.log`、`arch-changed.log`、`verify-pre-push.log`、`cli-tests.log`、`cli-turbo-lint.log`、`shared-test.log`、`ui-test.log`、`registration-parity.log`、`freshness.log`、`rerun-*.log`
