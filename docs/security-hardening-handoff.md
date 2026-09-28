# 安全加固交接文档（HANDOFF）

> **给接手的模型/工程师**：本文记录 ACode 安全加固（P0 + P1）的完整状态、已验证的改动、跑测试的确切命令、以及踩过的坑和协作陷阱。读完本文即可无缝接手，无需回溯对话历史。
>
> **最后更新**：2026-09-28 ~17:30。**分支**：`fix/security-hardening-p0-p1`（未推送、未合并）。**工作树**：干净。
>
> 计划全文见 [`docs/security-hardening-plan.md`](security-hardening-plan.md)；本文件是「实施进度 + 接手须知」，与计划互补。

---

## 0. 一眼看懂当前状态

| 项 | 状态 | 能否合并 |
|---|---|---|
| **P0-1/P0-2** server 鉴权 | ✅ 完成，两轮对抗验证通过 | ✅ 可合并 |
| **P0-3** bot 权限天花板 | ✅ 完成，补了 task-attach 旁路修复 | ✅ 可合并 |
| **P0-4** 凭据主密钥 | ✅ 完成（范围是「无后悔步」，非 OS 钥匙串，见 §4） | ✅ 可合并 |
| **P1-6** 项目 permission 收紧 | ✅ 完成，补了 disallowedTools 并集修复 | ✅ 可合并 |
| **P1-7** 更新源 isPackaged 门禁 | ✅ 完成 | ✅ 可合并 |
| **P1-5** BYO Key 迁 credentialRef | ✅ 三条回归已修复（见 §5），含 5.4 UX 占位 | ✅ 可合并（建议合并前再跑一轮 §2 门禁） |
| P2 / P3 | 未开始 | — |

**当前状态**：P1-5 的三条回归（§5）已于 2026-09-28 下午全部修复并验证（含一次「故意注入回归确认测试变红」的对照验证）。分支上的全部 P0/P1 项均已完成且门禁全绿。剩余工作是 P2/P3（见 §6）。

---

## 1. 分支与提交

```
git log --oneline dev/0.0.1..HEAD
7e2dcdc fix(security): P1-5 回归修复——worker vault 注入、provisioning 同步 BYO Key、孤儿清理   [P1-5 §5 修复]
a37b9f1 fix(cli): 项目 disallowedTools 改为并集，堵住 P1-6 遗留的收窄旁路      [P1-6 补漏]
8514adf feat(provider): BYO Provider API Key 迁出明文，落盘只存 credentialRef   [P1-5 — 回归已由 7e2dcdc 修复]
8d80218 docs(spec): P1-5 …执行规格（spec-first）                              [P1-5 spec]
0a026f2 fix(cli): 项目级 permission 只能收紧不能放宽，堵住恶意仓库预放行         [P1-6]
7ca6b3c fix(desktop): 打包版忽略更新源 env/argv 覆盖…                          [P1-7]
3f8f619 fix(server): 铸造端点加 Origin 门堵可用性 DoS；修 cookie 解码分叉…       [P0 二轮修复]
7bba076 fix(security): 落地对抗评审 P0 mustFix——主体绑定执行、能力上限…         [P0 一轮修复]
d1b324f fix(bots): 活跃任务派发路径补权限模式天花板，堵住 /task-attach 旁路      [P0-3 补漏]
de13472 fix(security): 恢复凭据解密错误契约，修复 OAuth 损坏会话恢复路径         [P0-4 回归修复]
1bd9eeb fix(security): 凭据主密钥改用每安装随机密钥，去除可离线推导回退          [P0-4]
86d2016 fix(bots): 绑定码防爆破 + 远程入口权限模式天花板                        [P0-3]
492382d fix(server): 鉴权 fail-closed + 信任主机能力绑定主体与 Origin 校验       [P0-1/P0-2]
```

基线是 `dev/0.0.1`（commit `8a1018e`）。回滚 P1-5 整体的命令已不适用（7e2dcdc 是其回归修复，
回滚需 `git revert 8d80218 8514adf 7e2dcdc` 三条一起评估）。

---

## 2. 如何跑门禁与测试（务必按此，否则误判）

```bash
cd /c/Users/ZhuanZ/Desktop/ACode

# 类型检查（root，覆盖 provider/provider-node/services/server/shared/desktop host）
pnpm typecheck                      # 期望 exit 0

# CLI 子工作区单独 typecheck（root typecheck 不覆盖 apps/acode-cli 的 core/cli/tui）
cd apps/acode-cli
for p in adapters bootstrap core contracts dynamic-workflow; do
  node node_modules/typescript/bin/tsc -p packages/$p/tsconfig.json --noEmit
done
# 注意：'turbo' 不在 PATH，故 apps/acode-cli 里跑 `pnpm typecheck` 会失败——那是环境问题不是代码问题。
# 注意：'cli' 包会报 ~36 个 TS2307 找不到 @acode/tui——tui/dist 被 gitignore 未构建，既有环境问题，忽略。
cd ../..

# lint / 架构检查
pnpm lint                           # 期望 0 error，76 warnings（基线值，别被 warning 吓到）
pnpm architecture:check -- --changed  # 期望 0 violations

# 测试：必须用 --import tsx，裸 node --test 解析不了内部 .js→.ts 导入
node --import tsx --test <file>
```

**跑全部安全相关测试**：
```bash
for f in \
  packages/server/tests/server-auth.test.mjs \
  packages/services/tests/bot-guardrails.test.mjs \
  packages/shared/tests/credential-master-key.test.mjs \
  packages/shared/tests/browser-boundary.test.mjs \
  packages/provider-node/tests/byo-apikey-credential-ref.test.mjs \
  apps/acode-cli/tests/project-permission-restriction.test.mjs \
  apps/acode-cli/tests/protocol-worker-vault-injection.test.mjs \
  packages/desktop/tests/github-updates.test.mjs \
  packages/services/test/providerConfigMigration.test.ts \
  packages/services/test/botDraftOptions.test.ts \
  packages/services/test/providerProvisioningByoApikey.test.ts ; do
  node --import tsx --test "$f" >/dev/null 2>&1; echo "EXIT=$? $f"
done
```

### 三个既有红（不是回归，别去修）
以下三个测试在**干净的基线 `8a1018e`** 上就是红的（我已在临时 worktree 复核确认）。它们断言的是与本工作无关的代码：
- `packages/desktop/tests/no-official-platform.test.mjs` — 断言未改动的 conversationShareService.ts。
- `packages/ui/tests/no-telemetry.test.mjs` — ENOENT 引用 `codingPlanEmbeddedWebview.ts`，该文件 git 全历史从未存在。
- `packages/ui/test/nonCliAcpRetirement.test.ts` — `@/lib` 路径别名在裸 tsx 下解析不了。

跑全量时这三个红是**预期**的；其余必须全绿。

---

## 3. 已完成且验证通过的部分（P0 全部 + P1-6 + P1-7）

### P0-1 / P0-2 — server 鉴权（提交 492382d + 修复 3f8f619）
- 非 loopback 绑定无 token → 拒绝启动（fail-closed），两套 server（`packages/server` 与 `acode-server-cli/server-core`）共用 `@acode/shared/node` 的 `assertServerAuthInvariant`。
- token 校验优先级 Bearer > cookie > `?token=`（弃用告警）；`readLiteTokenCookie` 统一了鉴权与主体绑定对 cookie 的解码（修了 decodeURIComponent 分叉导致的 403/500）。
- `/ws/host` 升级与 `POST /api/rpc-host-capability` 铸造**都在 issue() 之前**做 `resolveRequestOriginTrust`（原名 resolveUpgradeRequestTrust，已改名）——防 DNS-rebinding，也防恶意网页灌满能力槽位的可用性 DoS。
- 能力主体绑定 `resolveHostCapabilityBinding` 真正执行（此前 consume() 返回值被丢弃，是装饰性的）。
- 能力存活上限 `MAX_LIVE_HOST_CAPABILITIES=256`，满则 503（拒绝而非淘汰最旧）。
- 测试：`packages/server/tests/server-auth.test.mjs` **22/22**。
- **已知诚实边界**（已写进 spec，不是 bug）：单 token 模型下 presented==bound 恒成立，主体绑定是「面向将来多 token 的结构性防回归」而非当下活动屏障；server-core 无 token 概念，其绑定传字面量 null → 恒放行。

### P0-3 — bot 权限天花板（提交 86d2016 + 修复 d1b324f）
- 绑定码 `randomBytes(3)`→`(8)`（2^64）+ 每 bot 指数退避锁定（`createBotBindAttemptGuard`）。
- 远程聊天入口权限天花板：yolo/bypassPermissions 不可达，`/mode` 显式请求被拒（`modeRemoteForbidden`）。收敛在 `@acode/shared/bot-remote-guard`。
- **d1b324f 补的关键旁路**：天花板原本只在 createTask 生效，`/task-attach` 到既有 yolo 任务（off-peak 默认 yolo）可绕过。已在 resumeTask **之前**加 `readCurrentActiveTaskMode` + `isBotRemoteForbiddenPermissionMode` 检查，命中回 `taskModeRemoteForbidden`，读不到 meta 则 fail-closed 回 `noActiveTask`。
- 测试：`packages/services/tests/bot-guardrails.test.mjs` **10/10**（+ 既有 `packages/services/test/botDraftOptions.test.ts` 6/6）。
- **已知诚实边界**（已写进 spec）：bot 的权限请求中继回**同一聊天用户**，即发起者自批，所以 build 模式提供的是「逐动作摩擦」而非独立信任闸。真正修法（只让桌面本地可信用户响应）是后续工作。

### P0-4 — 凭据主密钥（提交 1bd9eeb + 回归修复 de13472 + mustFix 7bba076）
- **范围决定（用户选的「无后悔步」，不是偷懒）**：没做 OS 钥匙串。原因硬：cipher 接口是**同步**的、被文件锁内联调用，而 safeStorage/keytar 都是异步；且桌面 host 与 CLI 是**两个进程共用同一 credentials.json**，safeStorage 与 keytar 互不相通，一方写另一方读不出来。详见 `packages/services/specs/credential-storage.md`。
- 实际做的：每安装随机密钥文件 `credential-key.json`（32 字节、0600、wx 排他创建）+ scrypt/HKDF 派生，取代可离线推导的 `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")`。
- 密文版本：新写 `enc:v2:`（带 AAD）；`enc:v1:` **仅可解密、永不产出**，用旧可推导密钥——保证升级不丢既有凭据。v1 解密路径**不传 AAD**（旧加密没绑 AAD，传了会毁掉全部既有凭据）。
- 优先级：显式 secret > 已存在密钥文件 > env > 生成新文件（密钥文件一旦存在即拥有既有 v2，env 被忽略并告警，防止升级后设 env 静默孤立凭据）。
- 密钥文件读竞争：EEXIST 落败方按 [10,25,50,100,200]ms 退避重试（`Atomics.wait` 同步睡），耗尽则**抛错而非重新生成**（生成=换密钥=毁 v2）。
- 两份等价 cipher 实现收敛到 `@acode/shared/node/credentialCipher.ts`；`decrypt()` 走 `isEncryptedACodeCredentialValue`/`...ValueV1` 谓词（消除死代码）。
- de13472 修的回归：合并 cipher 时丢了 `code:'ACODE_CREDENTIAL_DECRYPT_FAILED'` + CJK 前缀，导致 `isCredentialDecryptError` 恒 false、OAuth 损坏会话恢复路径失效。
- 测试：`packages/shared/tests/credential-master-key.test.mjs` **13/13**；新增 `packages/shared/tests/browser-boundary.test.mjs` **3/3**（守护 `@acode/shared/node` 不被 renderer/ui/web 导入，因 Atomics.wait 在浏览器主线程会抛/阻塞）。
- **诚实边界**（已写进 README 双语 + spec）：密钥文件与密文同盘，不防「整个 .acode 被外带」；删除 credential-key.json 或回滚到旧版会丢 v2 凭据（旧版遇 v2 会把密文原样当明文返回 → 静默坏登录）。

### P1-6 — 项目 permission 收紧（提交 0a026f2 + 补漏 a37b9f1）
- 「项目配置只能收紧、不能放宽」：仓库携带的 `permission.allowedTools`/`autoApproveHighRisk`/`allowMediumRiskInAuto`/`mode` 被剥离（`restrictProjectPermission`），`disallowedTools` 保留。收敛点 `normalizeProjectConfig`（与 hooks 剥离同一函数同一时机）。剥离时发 `config_project_permission_restricted` 诊断。
- **a37b9f1 补的旁路**：`disallowedTools` 原本走替换合并、而 Project 优先级(20)>User(10)，所以仓库能把用户的硬禁用集清空。已改为 Project 作用域下**并集**（Env/Cli 仍替换，那是用户显式意图）。实现坑：继承值必须在 `Object.assign(result,config)` **之前**快照，否则读到的是项目值、并集等于没并集（这个 bug 被回归测试抓了两次）。
- 测试：`apps/acode-cli/tests/project-permission-restriction.test.mjs` **10/10**。
- 用 restrictive floor 而非接进 hooks 的 digest 信任管线，理由：permission 是纯数据无 digest，硬塞需造专用 review item 且混淆既有 UX；restrictive floor 一个同步纯函数即可，且与 P2 的策略地板同哲学。

### P1-7 — 更新源 isPackaged 门禁（提交 7ca6b3c）
- 三处来源原本互相矛盾（NOTICE 说打包版忽略、spec 说可覆盖、代码无门禁）。以文档承诺为准收紧代码：`resolveUpdateFeedSourceFromStartupConfig` 新增 `isPackaged` 选项，为 true 直接返回 undefined；`main/index.ts` 传 `app.isPackaged`。
- spec `github-updates.md` 同步；NOTICE 双语无需改（原本就这么写，现在代码与之一致）。
- 测试：`packages/desktop/tests/github-updates.test.mjs` **4/4**（含新增 isPackaged×argv 组合断言）。

---

## 4. 设计约束（血泪换来的，改这些地方前务必先读）

1. **cipher 接口必须保持同步**：被 `credentialService`/`shared-credentials` 在文件锁内联调用。接 OS 钥匙串（异步）需先把整条 cipher 链改异步 + 解决桌面 host↔CLI 跨进程密钥一致性（共用同一条钥匙串记录或一次性重加密迁移）。这是 P0-4 没做 OS 钥匙串的根本原因。
2. **provider_config.json 的 revision = sha256(encode(磁盘内容))**，且 `providerProvisioningSource.readProvisionablePersonalConfig`（`packages/services/src/model-provider/providerProvisioningSource.ts:98-104`）会重算磁盘 hash 断言等于 revision。任何让 snapshot 与磁盘不一致的改动（如把 hydrate 后的明文回灌进 revision/snapshot，或用随机 IV 的内联密文）都会：① 远程 provisioning 抛「配置在读取期间发生变化」；② 每次 1s 轮询误判变化重写文件（写放大）。**这就是 P1-5 用 credentialRef（稳定字符串）而非内联密文的原因。**
3. **registry 刷新循环是异步的**（`packages/provider/src/registry-service.ts #runRefreshLoop`，~line 180），同步的 `#resolver.resolve()` 在其内（~line 222），`getProvider()` 是同步读缓存。所以凭据 hydration 能挂在刷新循环里、resolve 之前，下游 ~39 处同步读 `access.apiKey` 无需改动。**前提是 vault 在所有读该文件的进程里都注入**——见 §5 的回归。
4. **provider-node 不能 import services**（services 已依赖 provider-node，会成环）。vault 以可选注入传入。
5. **project 配置剥离只在 `normalizeProjectConfig` 一个点**，且 explicit projectConfigPath 分支也走它（评审已端到端验证无第二条未剥离入口）。
6. **合并按 ConfigScope 优先级升序**（System 0 < User 10 < Project 20 < Session 30 < Env 40 < Cli 50），`mergeConfigs` 里 `Object.assign(result, config)` 会整体替换嵌套对象——所以任何「跨 scope 累积」语义（如 disallowedTools 并集）必须在 assign 前快照继承值。

---

## 5. ✅ P1-5 的三条回归（**已全部修复**，2026-09-28 下午）

对抗评审（P1-5 credential-loss lens）曾判 `introduced-new-defect`，三条回归均已核实为真并修复。
根因同源：「谁读 vault 化的 provider_config.json，谁就得有 vault」这条不变量没有完整执行。
规格已固化在 `packages/provider-node/specs/byo-apikey-credential-ref.md` 的「跨进程/跨环境注入完整性」
（R1/R2/R3）与验收场景 10–12。

### 5.1 桌面 BYO provider 全线静默 401 —— 已修复（R1）
- **原状**：桌面 host 把 `provider_config.json` 迁成 ref 形态、抹掉明文；但跑对话的 worker 进程
  （`acode.cjs app-server --stdio`）经 `acode-protocol-entrypoint.ts` 调
  `startProcessProviderRegistryRuntime(runtimeEnv)` 不传 standalone → 无 vault → ref 字符串被当
  apiKey 用 → 401。
- **修法**：`process-provider-registry-runtime.ts` **无条件注入** vault（协议 worker 与桌面 host 经
  `ACODE_DATA_BASE_DIR`/默认 homedir 解析到同一份 credentials.json；cipher 惰性，构造无磁盘副作用）。
  standalone 专属的账号管理（`createAccountSource`/`importLegacy`/`providerRuntimeHeadersPort`）改以
  `standaloneCredentialStore` 为门槛，行为不变；凭据变更订阅不再假定 `standaloneAccount` 存在。
- **验证**：`apps/acode-cli/tests/protocol-worker-vault-injection.test.mjs`（端到端：明文→worker 迁移→
  重启 worker→ref hydrate 回明文）。已做对照验证：临时还原旧逻辑该测试变红，恢复修复后变绿。

### 5.2 远程/跨机 provisioning 丢 BYO Key —— 已修复（R2）
- **原状**：provisioning 只导出 oauth allowlist + `^account-provider:.+:api-key$`，新键
  `provider:apikey:<providerId>` 不匹配 → 信封带 ref 形态配置不带真值 → 目标端 hydrate 得 null。
- **修法**：scope 枚举新增 `"provider-apikey"`（`packages/shared/src/provider-provisioning.ts`，附
  `isProviderProvisioningProviderApiKeyCredentialKey` 谓词）；source 的 scope 解析与
  `listProviderProvisioningCredentialKeys`、target 的 `validateCredentialEntries`（已导出供测试共用）与
  `captureBeforeState` 四处匹配保持一致；桌面 host `onDidMutate` 的 provisioning 触发判定纳入该 scope。
- **诚实边界**：版本偏差（旧目标端收到新 scope）表现为目标端 envelope 校验**显式失败**（而非静默丢 Key），
  双端升级后按 syncId 幂等恢复。server 中继不解析 envelope，无兼容问题。
- **验证**：`packages/services/test/providerProvisioningByoApikey.test.ts`（谓词、source 导出、物理键枚举、
  目标端 scope↔key 校验）。

### 5.3 删除 provider 后凭据永久孤儿 —— 已修复（R3）
- **修法**：`ProviderApiKeyVault` 接口新增幂等 `delete(ref)`（两实现分别委托
  `ICredentialService.delete` / `SharedACodeCredentialStore.delete`，对不存在键均为无操作）；
  `NodePersonalProviderConfigRepository.update` 在 `#writeLocked` 成功**之后**、同一文件锁内，
  对比提交前后引用的 credentialRef 集合，删除消失的 ref（`deleteOrphanedProviderApiKeys`）。
  顺序必须「先写文件、后删凭据」：反序会在写失败时留下「引用悬空且真值已删」的真丢 Key 状态；
  正序最坏只留孤儿（非破坏）。清理失败不回滚已提交写入，经 `onRecovery` 上报。
  该 diff 语义与 provisioning 的 replace-allowlist/回滚天然兼容（对同一 ref 的重复删除幂等）。
- **验证**：`byo-apikey-credential-ref.test.mjs` 新增场景 12/12b/12c（删除清理、换 Key 不产生孤儿、
  清理失败不影响已提交写入）。

### 5.4 Settings UI 空框困惑 —— 已修复（占位符方案）
- `toJSON()` 在有 ref 时丢 apiKey 属**安全设计**（明文不出 host），不改序列化；改在 UI 层：
  `hasProviderFormStoredApiKey`（`providerSettingsFormTypes.ts`）判定已 vault 化，`ApiKeyInput`
  以 `storedInVault` 切换占位符为「已配置（••••••••），输入新值可更换」（zh/en 双语）。
  保存逻辑不动：`ProviderDraftSave` 的 `keyChanged` 基线是 `apiKey ?? ""`，字段未动即不写 access，
  ref 不会被误清。
- **诚实边界**：字段留空保存不会删除已存 Key（与 P1-5 前行为不同）——移除 Key 的正式入口是删除
  provider 或换 Key；如需「清空即删除」语义属后续产品决策。

### 历史决策记录（保留供回溯）
当初的选项是「修」或 `git revert 8d80218 8514adf` 回滚 P1-5。选择了修：P1-5 的设计（credentialRef +
异步 hydrate + revision 保 ref 形态）经得起推敲，漏的只是注入完整性，且每条修复都有回归测试钉住。

---

## 6. 剩余工作（P2 / P3，未开始）

见 `docs/security-hardening-plan.md` 的 P2/P3 段。摘要：
- **P2 策略地板 + 旁路免疫熔断器**（Claude Code policySettings / Codex requirements.toml 的 strictest-wins + bypass-immune breakers）。ACode 当前 `permission/service.ts` 是 `yolo → 直接 allow` 无熔断。P1-6 的 restrictive floor 是它的雏形，可在此基础上长。
- **P2 其余继承加固项**（子进程 env 白名单化、Electron 四件套、fuse、agent 命令 env 门禁、工作区路径收敛、OAuth PKCE、http 端点告警、插件 git 源 commit 固定、子代理模式继承、Chrome 提权门）。
- **P3 能力差异化**（auto 模式 LLM 分类器目前是桩、heartbeat 自动化、跨厂商插件清单兼容、prompt-cache 诊断、任务依赖图）。
- 计划里还列了 P1 之外的 P2 项（如 bot 权限请求改由桌面本地可信确认者响应），是 P0-3 诚实边界的真正修法。

---

## 7. 协作陷阱（务必知道）

1. **`.mimosa/` 是个 PreToolUse/PostToolUse hook 插件**（`zcode-plugins-official/mimosa`），会在你的 Read 与 Edit 之间修改文件。若遇到 Edit 报 "File has been modified since read"，多半是它（或另一会话）。对策：Edit 前重新 Read，或用 Bash 核对真实字节。
2. **曾有一个并行会话**短暂参与同分支工作，已明确退出、不再改本分支。它做过两轮独立复核，结论与本文一致（P0 全绿、P1-5 三条回归）。
3. **方案与交接文档已脱敏（2026-09-28）**：`docs/security-hardening-plan.md` 与本文均已移除研究来源的溯源表述与本地路径，只保留「机制设计」层面的对照结论。后续增补保持同一边界：不点名具体商业产品、不描述其非公开实现细节、不写本地研究工作区路径。
4. **AGENTS.md 约定**：spec-first（改行为前先更 `specs/*.md`）、必须跑 `pnpm typecheck`+`pnpm lint` 并如实报告、修 bug 用中文注释说明依据、不加无谓兜底分支。提交用 Conventional Commits，AI 协作带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
5. **dist 是 gitignore 的**（`apps/acode-cli/.gitignore`）。bootstrap 依赖 `@acode/adapters/auth` 解析到 `dist/auth/*.d.ts`——改了 adapters 的导出后，bootstrap 的 typecheck 需要先 `node node_modules/typescript/bin/tsc -p packages/adapters/tsconfig.json`（不带 --noEmit）重建 dist，否则会报「找不到导出成员」。这只影响本地 typecheck，不影响提交（dist 不入库）。

---

## 8. 验证工作流（可复跑）

**2026-09-28 桌面真机手测（P1-5）**：dev 桌面 + 临时数据根（`ACODE_DATA_BASE_DIR`）+ 本地 mock OpenAI 兼容 provider。已验证：① 设置录入 BYO Key 后落盘只有 `credentialRef`、全数据目录 grep 无明文；② `credentials.json` 为 `enc:v2` 密文条目；③ 模型连通性探针的出站请求携带 `Authorization: Bearer <录入的明文>`（hydrate 真值被真实使用）；④ Settings 占位符显示「已配置（••••••••）」（5.4）；⑤ UI 删除供应商后凭据条目同步清空（5.3 真机）。已知边界：完整聊天回合在 dev 隔离模式下未能走通——「智能配置」会把模型 ID 改写成目录名、命中 builtin 模型规则路由到真实厂商；且 dev 下 host 的 `settingService` 与 agent spawn 链路未跟随 `ACODE_DATA_BASE_DIR`（setting.json 落回真实 home、worker 报 model does not exist），属仓库 dev 隔离的既有缺口、与 P1-5 无关；worker 级 hydrate 由 `protocol-worker-vault-injection.test.mjs` 确定性覆盖。

P0 与 P1 各跑了对抗验证工作流（多代理，独立复核 + 完整门禁）。脚本已持久化，可用 Workflow 的 resumeFromRunId 复跑（已完成的代理走缓存）：
- P0 二轮：run id `wf_e9fe9599-a9c`（判 P0 8/9 项完全修复）。
- P1：run id `wf_fa7f95de-35a`（判 P1-5 introduced-new-defect、P1-6/P1-7 sound）。脚本路径见该 workflow 的启动回执。
- 复跑命令形如：`Workflow({ scriptPath: "<脚本路径>", resumeFromRunId: "<run id>" })`。

工作流的 journal 在本机执行会话的 `subagents/workflows/<run-id>/journal.jsonl`（按 run id 检索），每行一个 `{"type":"result",...}`，含各代理完整返回值（本文 §5 的三条即从中提取并逐条在源码复核）。

---

*本文由实施 P0+P1 的会话在切换模型前撰写。所有 file:line 以 2026-09-28 的检出为准，接手后请复核行号（会随版本漂移）。*
