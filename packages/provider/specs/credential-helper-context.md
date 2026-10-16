# 凭据 helper 上下文标记：HELPER_CONTEXT 五值闭集（接口预留）

价值提取第二轮波次（2026-10-15）W2-SEC5 交付（T2-p4②的凭据 helper 分支）。
本 spec 是**设计 + 接口预留**：ACode 现状没有凭据 helper（外部命令供凭据）机制，
但无人值守消费面已经存在（desktop automation 的 cron / off-peak / manual 三条派发
链路）。先立上下文标记的闭集语义与预留接口，helper 机制落地批与 cron/off-peak
传递接线直接沿用，不再造词。文档结构遵循 `settings-doc-style.md`（示范面④）。

## 背景（已核实的现状，基线：当前检出）

- 凭据获取链现状：BYO Provider 的 API Key 经 `ProviderApiKeyVault` 抽象
  （`src/provider-api-key-vault.ts`）从加密凭据库读出——桌面 host 注入
  `ICredentialService` 实现，CLI 注入 `SharedACodeCredentialStore` 实现
  （`apps/acode-cli/packages/adapters/src/auth/provider-api-key-vault.ts`）。
  **没有任何调用点携带「本次获取发生在什么上下文」的信息**：vault 的
  `load(credentialRef)` 无从知道调用方是坐在设置页前的用户，还是凌晨的 cron run。
- 无人值守面已存在：`packages/desktop/src/host/automationDispatchContext.ts`
  点名 cron / off-peak / manual 三条派发链路；`cronRunDispatch.ts` 把 run 直接提交
  给目标 host 的 task service。这些链路里若凭据缺失/过期，现状只能失败或静默降级。
- 已有的「用户在场验证」面：`apps/acode-cli/packages/cli/src/provider-doctor-command.ts`
  （provider 诊断）与桌面设置页的登录/测试流程。
- 参照证据产品的形态（还原件结构性分析，文本自撰）：credential helper 是被调用的
  外部可执行体，产品把**五值闭集**的上下文标记经 env 传给 helper，helper 据此决定
  是否允许交互提示；配套 TTL 缓存与「401/过期先静默刷新、失败才上浮」的刷新协议。

## 产品规则

### R1 五值闭集（`CredentialHelperContext`）

封闭枚举，不接受运行时扩展（新值 = 代码评审 + 本 spec 更新）。语义以「有没有人类
在场能应答提示」为轴：

| 值                    | 语义                                                                 | ACode 对应面（现状/规划）                                          | 允许交互提示 |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| `interactive`         | 用户正在主动操作（登录、手工重认证）                                 | CLI `auth-login`、桌面设置页签入流程                               | 是           |
| `mid-session-refresh` | 活跃会话中的静默刷新（token 过期检查、mid-turn 401 重试）            | OAuth refresh 链（`adapters/src/auth/*-oauth.ts`）未来挂 helper 时 | 否           |
| `background`          | 后台/无人值守执行，但非定时任务（off-peak 链路、后台 workflow）      | desktop off-peak 派发、后台子进程                                  | 否           |
| `scheduled-task`      | 定时任务触发的运行                                                   | desktop cron 派发（`cronRunDispatch.ts`）                          | 否           |
| `setup-test`          | 设置期的连通性测试（用户坐在设置面前，但意图是「测试」而非「使用」） | `provider-doctor-command.ts`、设置页「测试连接」                   | 是           |

- **裁决规则**：helper 收到 `interactive` / `setup-test` 才允许弹交互提示（keychain
  解锁、浏览器登录、终端询问）；其余三值下 helper 必须以非零码或结构化错误**快速
  失败**，绝不挂起等 stdin——无人值守链路挂起 = 整条 run 卡死到超时，且用户看不到
  原因。判定函数 `isUserPresentCredentialHelperContext` 是这条规则的唯一实现点。
- **fail-closed**：标记缺失或不可识别（拼错、未来值传到旧 helper）时按最严格处理
  ——等同无人值守（`parseCredentialHelperContext` 返回 `undefined`，调用方必须落到
  禁止交互分支），不得「拿不准就提示」。

### R2 传递机制（预留设计）

- **跨进程**（helper 是外部可执行体时）：调用方在 helper 子进程 env 里设
  `ACODE_HELPER_CONTEXT=<五值之一>`（`ACODE_HELPER_CONTEXT_ENV_KEY`）。helper 文档
  （落地批交付）按三段式写清五值语义与 fail-closed 规则。该键不是秘密也不在
  劫持/凭据剥离闭集内（ACODE\_ 前缀第一方控制键，与
  `ACODE_TOOL_ENV_INHERIT_ALLOWLIST` 同理正常穿透）。
- **进程内**（vault / 未来的 helper invoker）：凭据获取调用携带 context 参数。
  预留接口形状（落地批实现，本批只立语义，不加死代码）：

  ```ts
  interface CredentialHelperInvocation {
    /** 五值闭集；缺席 = fail-closed 按无人值守处理。 */
    context?: CredentialHelperContext;
    providerId: string;
  }
  ```

- **cron/off-peak 接线（登记，属 desktop automation 面）**：三条派发链路在提交 run
  时已知道自己的身份——cron→`scheduled-task`、off-peak→`background`、manual→
  `interactive`。传递路径（automation dispatch → task/session runtime → provider
  凭据获取层）随 helper 机制落地批接线；本批交付的闭集与解析函数即其词表。

### R3 helper 输出与 TTL（预留设计，落地批生效）

按 `settings-doc-style.md` 三段式先行写成（示范面④），落地时直接作为设置文档：

- **输出契约（动机）**：helper 的存在意义是把「凭据在哪、怎么取」外置给用户脚本
  （keychain / 密码管理器 CLI / 内部 secret broker），产品侧只消费 stdout——单一
  bare token，或 JSON `{"token": "...", "headers": {...}}`；exit 0 才算成功，stderr
  记日志但不解析。stdout 混入 banner/日志行 = 失败而非「容错截取」：静默截取会把
  helper 脚本的错误输出当成凭据用，401 出现在离根因很远的下游。
- **TTL（失败模式推理）**：TTL 管「同一份 helper 输出可复用多久」。**设 ≤ token
  生命周期**：若 TTL 比 token 寿命长，持有过期缓存的进程 crash-loop 时会用同一份
  过期环境不断复活（每次重启都命中缓存、每次都在第一次 API 调用处 401），症状是
  「反复重启反复失败」而根因（缓存比凭据长寿）不可见。TTL 到期后静默重跑 helper
  （context 按 R1 取值——重跑发生在无人值守链路时 helper 不得提示）。
- **静态配置与 helper 的优先级（边界与替代）**：若落地批引入静态自定义 headers
  类配置，其文档必须内嵌边界句：明文配置面**不放** API key/token（配置会被分发、
  备份、进支持包）；秘密走 helper 的 `headers` 输出；同一 header 冲突时 **helper
  赢**（秘密的、动态的值压过静态常量）。

## 接口（本批已落地的预留面）

`src/credential-helper-context.ts`（纯常量 + 纯函数，无 IO，符合 provider 单层 app
模块形态；经 `src/index.ts` 公开）：

- `ACODE_HELPER_CONTEXT_ENV_KEY = "ACODE_HELPER_CONTEXT"`
- `CREDENTIAL_HELPER_CONTEXTS`（五值 readonly tuple，单一事实源）
- `type CredentialHelperContext`（由 tuple 推导的 union）
- `parseCredentialHelperContext(raw: string | undefined): CredentialHelperContext | undefined`
  （trim + 小写归一后闭集校验；未知值/空值 → `undefined` = fail-closed）
- `isUserPresentCredentialHelperContext(context: CredentialHelperContext | undefined): boolean`
  （仅 `interactive` / `setup-test` 为 true；`undefined` 为 false——缺席即无人值守）

## 验收场景

见 `packages/provider/test/credential-helper-context.test.ts`：

1. 五值全部解析为自身；tuple 与 union 一致（编译期 + 运行期各一道）。
2. 未知值（`"cron"`、空串、纯空白、`"Interactive "` 带尾空格→归一后命中）行为：
   未知 → `undefined`；大小写/空白归一后命中闭集 → 对应值。
3. `isUserPresentCredentialHelperContext`：interactive/setup-test → true；
   mid-session-refresh/background/scheduled-task/undefined → false。
4. 闭集封闭性：`CREDENTIAL_HELPER_CONTEXTS` 长度恒 5（防悄悄加值的评审锚点）。

## 不在本项范围

- helper 执行机制本体（spawn、输出解析、TTL 缓存、401 静默刷新协议）——随凭据
  helper 产品面落地批实现，本 spec R3 已立文档与语义基线。
- cron/off-peak 链路的 context 传递接线（desktop automation 面所有权；R2 已登记
  映射关系）。
- `ProviderApiKeyVault` 签名改造（加 context 参数属破坏性接口变更，与 helper 机制
  同批做，避免两次迁移）。
