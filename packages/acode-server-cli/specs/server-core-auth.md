# Server Core 鉴权（server-core-auth）

Server Core（`packages/acode-server-cli/src/server-core/`，经 Supervisor 拉起的远程服务器侧
HTTP/WS 进程）的鉴权姿态。共享鉴权模型（token 裁决顺序、fail-closed 不变量、Origin/Host 裁决、
host capability 铸造/兑换/主体绑定）的**单一事实源**是
`packages/server/specs/server-auth.md`（其标题即声明覆盖两套 server 实现）；本文件只记录
Server Core 特有的产品规则与差异，不复制共享模型，避免出现第二份可分叉的描述。

## 产品规则

- **token 来源（M1 修复）**：`createCoreHttpServer` 解析
  `options.authToken?.trim() || process.env.ACODE_SERVER_AUTH_TOKEN`（trim 后为空 = 未配置）。
  环境变量名与 `packages/server` 的唯一鉴权变量一致（`ACODE_SERVER_AUTH_TOKEN`）；全仓不消费
  历史误名 `ACODE_SERVER_TOKEN`。
- **配置了 token 时**：挂全局 token 中间件，裁决与 `packages/server` 完全同源（共享
  `resolveServerTokenAuth` / `isTokenProtectedPathname`：Bearer > `acode_lite_token` cookie >
  `?token=` query 仅 `/ws*` 升级面）；`/api/server-info` 的 `authRequired` 如实上报；能力铸造
  绑定已认证主体指纹；`/ws/host` 的 `resolveHostCapabilityBinding` 传真实
  `configuredToken`/`presentedToken`（兑现 P0-1 预留的「接入 token 时必须同步改那两个实参」）。
  `assertServerAuthInvariant({ host, authRequired })` 反映真实 token 状态。
- **未配置 token 时（缺省姿态，保持现状）**：仅允许 loopback 绑定（共享 fail-closed 不变量），
  Origin/Host 裁决与能力上限照旧；listen 成功后打印与 `packages/server` 同一串的
  `describeNoAuthLoopbackWarning(host)`（经 `createServiceLogger("server-core")` info 级）。
- **Credential 通道收窄（M4 修复）**：`exposeWebSocket` 对
  `clientMode !== "desktop-continuous"` 的连接，用 `@acode/shared/node` 的
  `createTerminalClientCredentialGuard` 收窄 `ICredentialService`——allowlist 键只读，其余
  load/save/delete 拒绝；desktop-continuous 保持全量。allowlist 与拒绝语义的唯一所有者在
  shared（见 server-auth.md「Credential RPC 通道按客户端角色收窄」节），本包不另写键列表。

## 状态所有者与写入路径

- token 配置：进程启动入参 / 环境变量，运行期不变更；唯一读取点 `createCoreHttpServer`。
- 能力 store、 Origin 裁决、token 裁决：全部来自 `@acode/shared/node`，本包无本地副本。
- 凭据收窄 overrides：仅在每条 WS 连接的传输注册层（`exposeWebSocket`）生效，不改
  `packages/services` 的 credential 服务本体。

## 接口

- `createCoreHttpServer(services, options)` 新增 `options.authToken?: string`；其余行为见
  server-auth.md「接口」节对 `packages/acode-server-cli/src/server-core/http.ts` 的描述。

## 验收

- 验收场景与测试位置见 `packages/server/specs/server-auth.md` 场景 13、16-20（既有模式：两套
  server 的同源不变量测试集中在 `packages/server/tests/server-auth.test.mjs`，本包无独立测试
  入口——package.json 无 test 脚本）。
- 关键场景：配置 token 后无凭据访问 `/api/server-info`、`/api/rpc-host-capability`、`/ws` → 401；
  Bearer → 200 且 `authRequired:true`；`/ws?token=` → 101；未配置 token 行为与现状一致且有告警；
  非 desktop 连接的 credential guard 生效。
