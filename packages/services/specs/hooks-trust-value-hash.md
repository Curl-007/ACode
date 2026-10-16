# Workspace Hook 信任值哈希扩展（services 展示面）

状态：已实施（2026-10-15，价值提取第二轮 T2-s5①「信任 digest 值哈希扩展」先行件）。
代码：`packages/services/src/hooks/workspaceHookValueHash.ts`（值哈希与等价判定，新）、
`packages/services/src/hooks/hooksService.ts`（trust 记录读取扩展）、
`packages/services/src/hooks/workspaceHookSettingsModel.ts`（展示 trustState 分类）。
测试：`packages/services/test/workspace-hook-value-hash.test.ts`。

## 背景与两面关系（单源义务）

- **CLI 树（apps/acode-cli）是信任执行面与唯一写入方**：runtime 以 `(workspaceIdentity, hookDeclarationDigest)`
  精确匹配放行（`workspace-hook-trust-evaluation.ts`），grant 经 Agent authority 复核 canonical snapshot 后写
  store（`workspace-hook-trust-records.ts` 的 `bundleDigestAtGrant` 等 AtGrant 字段即第一轮已落地的 CLI 侧）。
- **services 树（本 spec）是只读展示投影**：桌面工作区 hooks 设置面的 `trustState` 分类。services 不建第二份
  同意库、不写 store（`IHooksService.grantWorkspaceHookTrust` 注释既有禁令不变）。
- **单源**：`workspace-hook-trust-v1.json` 文件与 `@acode/shared/workspace-hook-trust-store-file` strict schema
  是信任记录唯一权威；两面必须对同一文件得出同一 corrupt 结论（hooksService 既有注释）。本扩展只改 services 侧
  **分类逻辑**，不改文件、schema 与任何写入路径。
- 值哈希 canonical payload 定义在 `workspaceHookValueHash.ts`；未来 CLI 侧记录 schema 扩展 `valueHashAtGrant`
  时必须复用同一定义（登记为后续义务，见文末）。

## 规则

- **展示值哈希（display value hash）**：`sha256(["workspace-hook-display-value-v1", event, matcher, displayCommand])`。
  `displayCommand` 推导与 CLI 写记录侧逐字一致：`process` → `[command, ...args].join(" ")`；`command` → `command`。
  该哈希**不含**路径/发现序/索引——即「改名不变量」：值没变、仅配置文件路径或钩子位置变化时哈希不变
  （对应参考实现的 formerLabels 改名兼容在 ACode hooks 配置形状下的等价物：信任记录的键是
  路径+索引派生的 declaration digest，「改名」＝digest 的键面变化而值面不变）。
- **展示 trustState 分类顺序**（`resolveWorkspaceHookDisplayTrustState`，全部 fail-closed）：
  1. 精确 digest 命中记录 → `trusted_persistent`（与 runtime 放行条件一致，不变）。
  2. **slot 等价**：某记录与 entry 的 `event/sourceRelativePath/discoveryOrder/matcher/matcherIndex/hookIndex`
     全部相同而 digest 不同（＝同位置配置值变了）→ `stale_digest`（镜像 runtime `hasStaleSlotRecord` 语义，
     「配置变更→哈希失配→回到待信任态重新询问」）。记录缺失任一 slot AtGrant 字段 → 不参与 slot 等价。
  3. **改名等价**：entry 的展示值哈希命中某记录推导的展示值哈希（而精确 digest 未命中）→ `stale_digest`
     （值没变仅路径/位置变——仍重新询问，但分类为「陈旧 digest」而非「全新钩子」，UI 可按已信任值演进预填/降低打扰）。
     记录缺失 `eventAtGrant`/`displayCommandAtGrant` → 不参与改名等价；`matcherAtGrant` 缺失（undefined）与
     entry.matcher（null）不判等——与 runtime slot 比较语义一致。
  4. 其余 → `pending_trust`。
- **改名等价绝不升级为 `trusted_persistent`**：runtime 以精确 digest 强制，展示面单方面放行会造成
  「UI 已信任、Hook 永不执行」的分歧（hooksService 头注释登记的事故模式）。「改名完全不打扰」需要 runtime
  侧同步支持值哈希放行，登记为后续义务（见下）。
- **同意记录读取失败 → 全量重问（fail-closed）**：trust store 不可读/corrupt → 空 digest 集合 +
  `trustStoreCorrupt: true`（既有行为），此时 slot/改名等价集合同样为空——任何记录派生等价都不得在 corrupt 时生效。
- **值哈希覆盖面的诚实边界**：展示值哈希只覆盖 `event/matcher/displayCommand`（记录 AtGrant 字段可推导的交集）；
  `async/shell/timeout` 变更不在改名等价判定内。这不产生放行风险（等价命中最多得到 `stale_digest`，仍需重新
  grant，grant 由 runtime 按当前完整 declaration digest 复核），只影响标签精度；完整值面覆盖依赖
  `valueHashAtGrant` schema 扩展（后续义务）。

## 事件顺序

```text
loadHooks(workspace)
  → 读 trust store（shared parseWorkspaceHookTrustStoreContent，单源）
      ├─ ENOENT → 空集合（无记录，非 corrupt）
      ├─ 读失败/corrupt → 空集合 + trustStoreCorrupt（全量 pending_trust）
      └─ ok → 按 workspaceIdentity 过滤记录
            → { 精确 digest 集合, slot 键集合, 记录侧展示值哈希集合 }
  → fromProjectSnapshot 逐 entry 分类：
      精确命中 → trusted_persistent
      slot 等价 / 改名等价 → stale_digest
      其余 → pending_trust
  → UI（TRUSTABLE_WORKSPACE_HOOK_STATES = pending_trust/revoked/stale_digest）按待信任处理，
     grant 仍走 Agent authority → CLI 写当前 digest → runtime 放行
```

## 后续义务（登记，不在本轮）

1. **shared schema 扩展 `valueHashAtGrant`**（`workspace-hook-trust-store-file.ts`，strict schema 加可选字段）＋
   CLI 写入侧（`createWorkspaceHookTrustRecords`）落全值面哈希（含 args/async/shell/timeout）——之后 services
   改名等价升级为全值面比较。
2. **runtime 改名放行**：CLI trust evaluation 支持「记录 valueHashAtGrant 与当前 entry 全值哈希一致 → 迁移记录
   （换 digest）而非重问」，实现参考实现的「改名不打扰」。届时展示面与执行面同步收敛，本 spec 的
   「改名等价 → stale_digest」升级为「改名等价 → trusted_persistent（迁移后）」。
3. 两项都涉及 CLI 树与 shared，需与第一轮 CLI hooks trust 的 owner 对齐后立项。

## 验收

- `workspace-hook-value-hash.test.ts`：
  - 展示值哈希确定性；process args 参与 displayCommand；路径/索引不参与哈希。
  - 分类：精确 digest → trusted_persistent；同 slot 值变 → stale_digest；改名（路径变、值同）→ stale_digest；
    全新钩子 → pending_trust；改名+值变 → pending_trust（等价不命中）。
  - fail-closed：corrupt store → 全部 pending_trust + trustStoreCorrupt；记录缺 AtGrant 字段 → 不参与等价。
  - `loadHooks` 集成（tmp HOME）：真实 trust store 文件写入记录后，改名 hook 判 stale_digest、精确 hook 判
    trusted_persistent；store 损坏时全量 pending_trust。
- `pnpm --filter @acode/services test`、`pnpm typecheck`、`pnpm lint` 通过。
