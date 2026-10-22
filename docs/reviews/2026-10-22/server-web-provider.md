# ACode 1.0.3 深度 Review · 服务端 / Web / Provider / 模型选项

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/server`（14,881 行）、`packages/web`（1,471 行）、`packages/provider`（5,558 行）、`packages/provider-node`（2,194 行）、`packages/model-option-map`（909 行）。

---

## 1. 层面整体评估

这五个包整体健康度**很高**，是全仓工程纪律最扎实的一层。`provider` 纯净（0 处 `node:` 导入）、IO 全部下沉到 `provider-node`（异步 `fs/promises` + `watch` + 定时器），经 `ProviderSource`/`ProviderApiKeyVault` 接口注入，依赖方向无反向、无循环，架构检查 0 违规。`server` 的鉴权面经过系统性加固（fail-closed 绑定、四路升级/铸造统一 Origin 裁决、凭据通道按 clientMode 收窄、路径穿越与 DoS 预算），`model-option-map` 求值器处处 fail-closed（拒成员访问/函数调用/未知标识符、数值 JSON-safe 断言、原型污染防护）。最大风险不在逻辑正确性，而在**边缘信息泄漏与 Web 恢复链路**：`connect-remote` 把原始 `err.message` 回给调用方；Web 入口对 WS 断开是空 `onClose`，手机 `web-remote-replayable` 缺前端重连；测试覆盖在 `model-option-map`/`web` 两包为零。

## 2. 问题清单（按包分组）

### server

**[P2] connect-remote 500 泄漏内部错误** — `packages/server/src/http.ts:546-549`
- 描述：`catch` 把 `err.message` 原样 `c.json({ error: message }, 500)`。SSH/WSL/Docker spawn 失败的 message 常含主机名、路径、命令。
- 证据：`const message = err instanceof Error ? err.message : String(err)` 直接进响应体。
- 建议：对外返回归类错误码（如 `remote-connect-failed`），原始 message 只进 `warn` 日志。
- 验收：构造一次失败连接，响应体不含主机/路径明文。

**[P3] 静态路由 decodeURIComponent 可抛 URIError** — `packages/server/src/http.ts:307`
- 描述：`resolveStaticFile` 对 pathname 无保护地 `decodeURIComponent`，畸形百分号编码（`/%`）抛 URIError，try/catch 只包住 `stat`（313 行起），异常冒泡成 500。
- 建议：decode 包 try/catch，失败按未命中返回 null。
- 验收：`GET /%` 返回 404 而非 500。

**[P3] 待认领连接无 TTL（自登记债）** — `packages/server/src/http.ts:168-170`
- 描述：未认领条目存活至进程重启，`MAX_PENDING_REMOTE_CONNECTIONS=32` 只兜住上限，慢泄漏仍在。
- 证据：注释「本次不引入 TTL 定时驱逐」。
- 建议：后续加惰性过期（认领时校验 spawn 时间）。
- 验收：登记项，当前可接受。

### web

**[P2] WS 断开无重连/无恢复 UI** — `packages/web/src/main.tsx:350-352`
- 描述：`connectViaWebSocket(bootstrap.wsUrl, { onClose: () => {} })` 空实现。手机 `web-remote-replayable` 的 snapshot/resume 语义在 `services` 侧（`acodeTaskServiceAdapter.ts:2363+`）齐备，但 Web 入口断线后不重连、不提示，用户停在死界面。
- 建议：`onClose` 触发退避重连 + 断线态 UI，复用 replayable 恢复。
- 验收：kill server 后 Web 自动重连并恢复会话。

**[P3] getActiveProvider 未校验强转** — `packages/web/src/auth/browserOAuthCredentialRepo.ts:108-110`
- 描述：直接 `return localStorage.getItem(...) as OAuthProviderId | null`，而同文件 `loadPendingProvider`（202-205）用 `isWebOAuthProviderId` 校验。任意 localStorage 字符串流入 `useAuthToken` 的 `oauth:${activeProvider}:access_token` 键模板。影响低（读不到即 null）。
- 建议：同样过 `isWebOAuthProviderId`。
- 验收：写入非法 active_provider 后 getToken 返回 null。

### provider / provider-node

无 P1/P2。凭据处理范式优秀：`vaultPersonalProviderApiKeys` 先入库后改文件（无「明文已删、库未存」中间态），`deleteOrphanedProviderApiKeys` 按 ref 去重清理孤儿，`downloadACodeBuiltinRelease` https-only + `credentials:"omit"` + `redirect:"error"` + 10MB 上限 + 20s 超时 + 错误脱敏。同步器 lease/退避/网络期不持锁/endpoint 变更守卫俱全。

### model-option-map

**[P3] 无包内单元测试** — `packages/model-option-map/package.json` 无 `test` 脚本
- 描述：evaluator/parser/tokenizer/merge-patch 的边界仅经 `apps/acode-cli/tests/model-compat-pipeline.test.mjs` 间接覆盖（该文件测的是管道直通，未直接断言求值器 fail-closed 分支）。
- 建议：补 evaluator 边界测试（除零、未知标识符、路径冲突、非安全整数）。
- 验收：新增 `pnpm --filter @acode/model-option-map test` 绿。

## 3. provider ↔ provider-node 分离核对

**边界清晰，无泄漏。** `grep from "node:" packages/provider/src/` = **0 命中**；`provider` 全部 IO 抽象为注入点（`ProviderApiKeyVault.load/save/delete`、`ProviderSource.read/onDidChange`）。`provider-node` 持 12 处 `node:` 导入（fs/path/os/crypto/timers），文件操作一律 `fs/promises` 异步 + `withFileLock` + `atomicWritePrivateTextFile`，唯一同步原语是 `watch`（事件驱动，非阻塞）。依赖方向 `provider-node → provider → shared` 单向，`provider` 注释显式说明「不反向依赖 services 以免循环」（`provider-api-key-vault.ts:9-10`）。架构检查 `managed: provider, provider-node` 零违规，层均为单层 `app`。

## 4. server 安全面

- **鉴权**：fail-closed 到位。未指定 host 默认 `127.0.0.1`（`http.ts:670`），非 loopback 且无 token 启动前 `assertServerAuthInvariant` 抛错（672）。token 唯一 env 名 `ACODE_SERVER_AUTH_TOKEN`，`server-info.authRequired` 如实反映挂载状态（M2 修复，230）。HTTP query token 面已关闭，仅 `/ws*` 保留。
- **输入校验**：`remoteTargetSchema.safeParse`（533）、bot provider 白名单（554）、Zod 错误经 `formatZodError` 结构化返回。
- **Origin/CSRF**：四处升级/铸造（`/ws`、`/ws/host`、`/ws/remote/:id`、`/api/rpc-host-capability`、`/api/connect-remote`）共用同一 `resolveRequestOriginTrust`，裁决在副作用之前。
- **凭据隔离**：非 `desktop-continuous` 连接的 Credential 通道经 `createTerminalClientCredentialGuard` 收窄为 allowlist 只读（143-151），Provisioning 通道对 terminal-client 直接抛错（127-136）。
- **缺口**：仅上面 P2 的错误泄漏。

## 5. model-option-map 求值正确性

**边界处理优秀，全链 fail-closed。** 分词器拒非法 token/未闭合字符串/非法 unicode 转义；parser 拒成员访问（`.`）、函数调用（`(`）、未知标识符、非字符串对象键、重复键；evaluator 用 `assertNumber` 拦非有限值与超安全整数（除零→Infinity→抛错），`requireBoolean`/`requireNumber` 强类型，比较要求同类型，`Object.create(null)` + `defineProperty` 防原型污染，`freezeJson` 深冻结；merge-patch 做单一所有者路径冲突检测（`pathsOverlap`）、null=删除、`cloneJson` 原型安全；compiler `assertObjectResultExpression` 保证 map 必返对象，空源抛错。未知模型/缺字段由上游 `option-maps.ts:31,38` 对 `undefined` effective value 抛 `ModelOptionMapError`（fail-closed，不静默 fallback）。唯一不足是测试覆盖（见 P3）。

## 6. 依赖债

- **provider-node deep import（已登记）**：`apps/acode-cli/tests/protocol-worker-vault-injection.test.mjs:23,26,31` 相对路径 deep import 3 个内部文件（`acode-builtin-release.ts`、`provider-config-file-codec.ts`、`runtime-paths.ts`）。importer 属 legacy `acode-cli` 且命中 `tests/` 豁免，当前不违规。`module-boundary.md` 明确「不加为 publicEntrypoints，后续改经包根消费」——债在册且有收敛方向，核实无误。
- **循环依赖**：无。`model-option-map` `requires: none`（纯叶子）；`web` 仅依赖 `@acode/ui`/`@acode/shared`/`@acode/client` 公开入口；`provider`/`provider-node` 单向。
- **compiler 缓存无界**：`compiler.ts:13-15` 三个 module-level Map 按源串缓存无淘汰。实际 map 源来自可信配置、数量有界，非当前风险，记录备查。

## 7. 修复入口建议

先修 `http.ts:547` 的 connect-remote 错误泄漏——把 `c.json({ error: message }, 500)` 换成归类错误码、原始 message 移入 `warn`（约 15 分钟含测试）。
