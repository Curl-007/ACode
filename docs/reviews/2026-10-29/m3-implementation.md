# M3 实施报告：CLI legacy 协议 server 删除（「搬迁 + 删除」，两段式）

> 日期：2026-10-29（Asia/Shanghai）。分支 `fix/project-review-2026-10-26`（PR #11），
> worktree `exciting-spence-bf1be9`。
> 结论：**M3 已完成**。`bootstrap/src/acode-protocol/` 目录已整体删除，`v4-bridge.ts` 已删除；
> 两段（纯搬迁 + 删除）测试均全绿。
> spec：`apps/acode-cli/specs/m3-legacy-server-removal.md`（含 §0 裁决节、§A.2 逐项核验、
> A–E 证据块）。幸存面登记见 spec §0。

---

## 0. 裁决（落地前提；产品可推翻）

沿用 M2 季先例（`docs/reviews/2026-10-28/m2-scoping.md` §6.3：保守无能力损失默认、
标注产品可推翻）。

- **裁决 1（`sessionSubagents`）**：保留为幸存 legacy 面。v4 无 subagents 分页 query
  （snapshot 仅 `endedTotal` 计数），UI `SubagentDirectorySidePane` 与 `UsageBarSubagentPanel`
  依赖 ended 明细。不补 v4 协议面（属新增协议设计，超出 M3 退役目标）。长期二选一
  （补 v4 协议面 / 接受能力损失）待产品裁决。
- **裁决 2（`pluginsCancelOperation`）**：不推翻 M2-5 §4 保留裁决，legacy 词保留。
  `shared` 不动；`protocol-boundary.test.mjs` 现有断言（不进 v4 面）与现状一致。
  **验收判据重写**：所有「grep 归零」改为「除幸存清单外归零」（幸存清单显式列出三词
  及其承载模块）。先例：M4 legacy-types 六 schema 幸存白名单。
- **裁决 3（`sessionSend` 附件回退）**：保留。v4 `sendText` 只收 `attachmentRef`，宿主发送侧
  上传/寄存命令面未建模；bot（`botsService.ts:5002`）与手机 replayable 附件输入走此路。
  移除条件：v4 附件上传/寄存命令面补齐 + 双链路冒烟通过。

---

## 1. 实施内容（两段）

### 段 1 · 纯搬迁（行为零变化）

- 40 个文件从 `apps/acode-cli/packages/bootstrap/src/acode-protocol/` 整目录迁入
  `acode-protocol-v4/`（唯一改名 `v4-bridge.ts → v4-binder.ts`；其余保留原名以最小化
  import 重写面与回归风险）。
- **25 条 v4 → legacy 反向 import 全部解除**（迁入后全部转为同目录 `./`）。
- 6 个过渡钩子收编为 `V4CommandCoreHost` / `V4GatewayHost` 的**必填原生宿主能力**
  （`ensureModelReady` / `afterLegacyStateMutation` / `closeSession` / `createSessionRecord` /
  `createSelectionSideSession` / `resumePersistedSession`），执行面在 `v4-binder.ts` 调同目录
  `session-operations.js`；`commands/types.ts` 与 `v4-gateway.ts` 的过渡框架注释清除、字段转必填。
  **结构性说明**：handler 仅持窄视图（record + host）、无 context 通道，字段保留为必填原生能力
  而非字面删除——字面删除需重设计 handler 的 context 访问，超出 M3 范围。
- `server.ts` 的 76 个 v4 case + dispatch/outbox/requestClient 装配随迁；
  `acode-protocol-entrypoint.ts` 的 import 全部改指 v4 目录（只装 v4 server）；
  `transport.ts` 迁 v4 侧。
- 该段 CLI 全量测试 3,206 pass / 0 fail，证明搬迁无回归。

### 段 2 · 删除

- 删 9 个非幸存 legacy case（`sessionStop` / `sessionCancelBackgroundTask` / `sessionFork` /
  `sessionSetThoughtLevel` / `pluginsReferenceCatalogWithCategory` / `pluginsReferenceCatalog` /
  `runtimeCapabilities` / `usageStats` / `sessionUsage`）。
- 删对应死 op 函数与级联 helper：`server-operations.ts` **3,639 → 3,438 行**
  （`forkSession` / `stopSession` / `cancelBackgroundTask` / `setThoughtLevel` +
  `resolveForkTarget` / `resolveTurnMessageId` / `ensureNoActiveTurn` /
  `pauseActiveGoalForSessionStop` / `isUserVisibleSessionMessage` + 4 个 legacy params schema import）。
- services：`pluginReferenceCatalogRequest.ts` 的两级 legacy `-32601` 回落链删除，
  收敛为 v4 primary 单点；`acodeProtocolMethods` import 随删清出。
- `transport.ts` 的 `shouldBypassProcessingQueue` 删 legacy `sessionStop` 旁路词，
  `workspaceCancelGenerateText` 改指 `V4_METHODS.workspaceCancelGenerateText`（v4 stop 经
  command 信封、turn 后台执行不占串行队列，无需旁路）。
- **`bootstrap/src/acode-protocol/` 目录删除**；`v4-bridge.ts` 删除。
- 幸存模块头注写明裁决依据与移除条件（`server-operations.ts` / `subagent-session-query.ts`
  头注 + `server.ts` 幸存 case 注释）。

---

## 2. 终态实测证据（真实执行输出摘要）

| 检查 | 命令 | 结果 |
|---|---|---|
| CLI 全量（搬迁段） | `pnpm --dir apps/acode-cli test` | `tests 3243 / pass 3206 / fail 0 / skipped 37`，exit 0 |
| CLI 全量（删除段） | 同上 | `tests 3243 / pass 3206 / fail 0 / skipped 37`，exit 0（与搬迁段一致，无回归） |
| services 全量（删除段） | `pnpm --filter @acode/services test` | `tests 585 / pass 578 / fail 0 / skipped 7`，exit 0 |
| typecheck | `npx tsc --noEmit` × 4 包（bootstrap / cli / cli-workflow / services） | 各 exit 0 |
| 架构门禁 | `node scripts/architecture/architecture-check.mjs check --changed` | exit 0；`violations: 42 / baseline: 42 / new: 0 / regrown: 0` |
| CLI 冒烟 | `tsx src/main.ts --help` | 正常输出 usage，exit 0 |
| ACP 冒烟 | `tsx src/main.ts acp </dev/null` | `[acp] client connected` 起适配器后随 EOF 正常退出，exit 0 |
| 模块导入 | `tsx -e import(...)` | `acode-protocol-entrypoint.ts` 与 `acode-protocol-v4/server.ts` 均 OK |

**全仓 `pnpm typecheck` 未跑**：`packages/ui/**` 正被并发代理修改，全仓结果不可归因；
按任务约定改用包级 typecheck 覆盖本批全部改动范围（bootstrap / cli / cli-workflow / services 均 0 错）。
**双链路真实冒烟（desktop-continuous + web-remote-replayable）与 desktop 端到端冒烟
在本 headless 环境结构性不可跑**，按 `m2-scoping.md` §4 既有方式登记为发布期门禁
（`release.yml` desktop-smoke / `ci.yml` remote-ssh），非批次验收依据。

---

## 3. 终态 grep（验收判据重写后）

- `git grep "acodeProtocolMethods\." -- packages/services/src` → **4 命中，全部落在幸存清单**：
  `acodeAgentService.ts:4291`（sessionSubagents）、`:4776`（pluginsCancelOperation）、
  `:5191`/`:5216`（sessionSend 附件回退主路径 + 兼容重试）。
- `git grep "case acodeProtocolMethods\." -- apps/acode-cli` → **3 幸存 case**
  （`acode-protocol-v4/server.ts` 的 sessionSubagents / sessionSend / pluginsCancelOperation）。
- `git grep 'from ".../acode-protocol/...' -- .../acode-protocol-v4` → **0**（反向 import 清零）。
- `test ! -d apps/acode-cli/packages/bootstrap/src/acode-protocol` → **目录不存在**。
- `v4-bridge.ts` → **不存在**（`v4-binder.ts` 存在）。

---

## 4. 台账（只登记，不自改）

`node scripts/licenses.mjs reproducibility --inputs-only` 实测：

```
台账 inputs 与工作树不一致：2902 项中 1 项漂移（mode=inputs-only）
  - packages/ui/src/components/ai-elements/markdown-table.tsx：哈希不符
      台账 adfaad8d9e778e4909e3c11e83adc422e7795e8aa0f8f8c7de0833ad92bd4b6d
      实际 48309e2361093f40db2f061efaddf36bbf517f0a70300fbbf208d831bddd1745
```

**归属**：并发 UI 代理的改动，**不归 M3**（本批删/移的 bootstrap 文件均非 inventory 登记项，
M3 自身未新增台账漂移）。按纪律不本地重生成、不增删 `third-party/inventory.json`；
push 后由 CI Linux（`licenses-notices.yml`）重生成回补。

---

## 5. 架构基线 / policy

- `architecture-policy.yaml`：**零改动**。实测 cli/bootstrap 域在该文件中**没有**以
  `src/acode-protocol/` 为路径的例外条目（grep 仅命中 shared 侧路径），无对象可收窄。
- `.architecture-baseline.json`：**定点收窄**（任务书允许「收窄引用已删除 legacy 文件的
  ratchet 条目」）。删除 7 条 `acode-protocol/*` 旧路径 max-file-lines 条目
  （6 条随搬迁改指 + 1 条 `plugins.ts` 陈旧条目——该文件已于 M2 `caa38080` 删除），
  新增 6 条 `acode-protocol-v4/*` 新路径条目（沿用仓库 fingerprint 算法
  `sha256(rule\0file\0detail)[:16]`，实测与既有条目复算一致）。净 412 → 411。
  收窄后 `architecture:check --changed` 为 `new 0 / regrown 0`。
  **未运行 `architecture:baseline:update` 全量重生成**（避免吞掉并发 UI 代理的在途漂移）。

---

## 6. 幸存清单（M3 完成形态的一部分，3 项待产品裁决）

| 方法词 | services 发送点 | CLI 执行面 | 承载模块（M3 后） | 移除条件 |
|---|---|---|---|---|
| `session/subagents` | `acodeAgentService.ts:4291` | `server-operations.ts` `listSessionSubagents` | `acode-protocol-v4/subagent-session-query.ts` | v4 subagents 分页 query 落地 / 产品确认下线 |
| `plugins/cancelOperation` | `acodeAgentService.ts:4776` | `server.ts` `cancelPluginOperation` | `acode-protocol-v4/server.ts`（幸存 case） | 中止注册表 v4 面建模完成 |
| `session/send`（附件回退） | `acodeAgentService.ts:5191,5216` | `server-operations.ts` `sendPrompt` | `acode-protocol-v4/server.ts`（幸存 case） | v4 附件上传/寄存命令面补齐 + 双链路冒烟 |

---

## 7. 本批改动文件清单

- 搬迁：40 文件 `acode-protocol/*` → `acode-protocol-v4/*`（`v4-bridge.ts` 改名 `v4-binder.ts`）。
- 改（bootstrap）：`acode-protocol-entrypoint.ts`、`index.ts`、`commands/types.ts`、
  `v4-gateway.ts`、`v4-binder.ts`、`server.ts`（删 9 case + 幸存注释）、`server-operations.ts`
  （删死 op + 头注 + sendPrompt 幸存注）、`subagent-session-query.ts`（头注）、
  `transport.ts`（旁路词）、以及 18 个 v4 文件的 import 路径改写。
- 改（其他包）：`packages/services/src/acode-agent/pluginReferenceCatalogRequest.ts`
  （删回落链）、`packages/cli/src/headless-workflow.ts`（注释路径）、
  `packages/cli-workflow/src/contract.ts`（注释路径）。
- 改（测试）：约 20 个 `apps/acode-cli/tests/*.test.mjs` 的 legacy 路径改写
  （其中 `architecture-coverage.test.mjs` / `acp-host-adapter.test.mjs` /
  `todo-dependency-fields.test.mjs` 中误触及 shared barrel 的 4 行已还原）。
- 改（基线）：`.architecture-baseline.json`（定点收窄）。
- 删：`bootstrap/src/acode-protocol/` 整目录。
- 文档：本报告 + `apps/acode-cli/specs/m3-legacy-server-removal.md` +
  `docs/legacy-protocol-convergence-plan.md`（M3 标完成 + 进度表）。

## 8. 遗留事项（不阻塞 M3，建议后续单独裁决）

1. host 侧 17 条 inbound legacy 字面量分支（`acodeAgentService.ts` 偏斜期兜底）本批未动；
   与 CLI 侧 inbound 端口（`automation-port.ts` 等仍带 `-32601` legacy 回落发送器）同属
   「旧 CLI + 新 host」偏斜面，建议后续与发布形态（desktop 是否只 spawn 自带 CLI）一并裁决。
2. `afterLegacyStateMutation` 的 `state.updated` legacy 广播面未删（services
   `acodeAgentService.ts:2662` 仍消费）；删除需确认 `acodeTaskIndexSyncer` 不依赖。
3. `packages/ui/src/store/scriptWorkflowStore.ts:109` 一处注释仍引用旧 `v4-bridge.ts` 路径
   （并发 UI 代理范围，本批未动）。
4. 幸存清单三词的长期归宿见 §0（待产品裁决）。
