# Server module boundary

## Scope

`packages/server/src` 是远程服务器端（HTTP/stdio 传输）、remote backend
（SSH/WSL/Docker 的部署与连接）与 Harness API 翻译桥。本 spec 登记其纳管为
架构模块（managed，ARCH-04 batch 3）。纳管不改变运行时行为与包公开 API。

## Ownership and invariants

- owner：`remote-server`。
- 业务状态不在本模块：services 的 `ServiceCollection` 是服务实例的唯一所有者；
  `harness-inprocess.ts` 只持「懒工厂 + dispose 句柄」两个连接作用域值，
  不另存第二份服务状态（K7 R5 同款纪律）。
- remote backend 实例只持连接作用域资源；`disposeAndWait` 只回收 backend 自己
  创建的进程/连接，不允许扩大到共享运行时。断开经 `onDidDisconnect` 单向上报，
  补偿 stdio channel 半开连接。
- 连接进度上报以 `requestId` 绑定（AsyncLocalStorage）；连接 Promise settle 后
  关闭上报，长生命周期 stream 的迟到日志不得继续污染连接面板。

## Public boundary

- 权威公开面 = `packages/server/package.json` exports：包根 `src/index.ts`
  （createHttpServer）、`./stdio` → `src/stdio.ts`、`./harness` →
  `src/harness/index.ts`、`./harness-inprocess` → `src/harness-inprocess.ts`、
  `./remote` → `src/remote/index.ts`、`"./remote/*.js"` → `src/remote/*.ts`（通配）。
- 通配面欠声明是治理事实：checker 的 `publicEntrypointMatches` 是精确路径匹配，
  无法表达 `./remote/*.js`。被跨模块消费的 remote 文件逐一登记为
  publicEntrypoints（当前：remote/index.ts、remote/posixShell.ts、
  remote/remoteConnectionProgressContext.ts、remote/wsl-backend.ts、
  remote/wsl-detect.ts——desktop 实测消费面）。新的跨模块 deep import 会失败，
  迫使显式补登：这是有意的 ratchet，而不是漏洞。
- `src/contract.ts` 是治理用精选视图，与上述入口一起登记；内部实现文件
  （http.ts、deploy.ts、ssh-backend.ts、remoteAsset\* 等）不可被跨模块 deep import。

## Dependency direction

- 允许：`client`（remote/connect.ts 的 RemoteServiceAccess）、`rpc`
  （Emitter/VSBuffer/SocketProtocol/ChannelServer，7 边）、`services`
  （ServiceCollection 装配与 node 面，15 边）、`shared`（协议/schema，32 边）、
  node 内置模块与三方网络/PTY 库（ssh2、node-pty、hono、ws、axios 等）。
- 禁止：server 依赖 desktop/ui/web；任何模块 deep import 未登记的 server 内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——直接持有 socket、PTY、子进程与
  文件 IO（71 处 `node:` import），声明 domain 层会触发 domain-io。
- 无环：纳管时实测模块内 0 文件级环。

## Registered debt（例外，expires 2026-12-31）

- **已全部偿还（2026-10-30）**：`onboard-b3-server-over-limit` / `onboard-b3-server-disables`
  两条删除——9 个存量超限文件的最后一个 http.ts（783 行）拆为本体（路由注册与安全裁决，
  <400 行）+ `src/http/` 七叶（log / channel-server / pending-connections / server-info /
  static-files / bot-callbacks / token-request-view，全部 <400 行），首行 max-lines
  disable 删除。server 模块 2026-12-31 例外面清零。
- 原债务登记的前置条件（安全测试管线改造）已随本批兑现，`server-auth.test.mjs`：
  - `load` 改为「stub 表优先 + 相对导入递归真实执行」——`http/*` 叶子在安全行为测试中
    真实运行（不是 stub，防静默绕过）；`./remote/index.js` 等显式 stub 键仍优先命中表。
  - 负向源码断言（禁内联第二份 cookie 解码/allowlist、禁 legacy env 字面量）从
    http.ts 单文件扩为「http.ts + 全部叶子」拼接面，防代码迁出后断言空转。
  - 正向安全 pin 按文件精确重锚：路由顺序/Origin 裁决 pin 留 http.ts 本体；
    credential 收窄（createTerminalClientCredentialGuard）pin 到 channel-server.ts；
    共享 token 裁决三符号 pin 留本体（中间件与 /ws/host 绑定所在）。
- 待认领远程连接 Map 的所有权随拆分收窄：唯一所有者迁 `src/http/pending-connections.ts`，
  写入路径收敛为叶内 register/claim/prune 三函数，本体不再直接持有 Map
  （owner 登记见 server-auth.md「待认领远程连接唯一所有者」）。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：server 零新违规；
   desktop 的 14 条入边（remote/index.ts ×10、posixShell、
   remoteConnectionProgressContext、wsl-backend、wsl-detect）与 acode-cli 的
   3 条入边（harness/index.ts、harness-inprocess.ts ×2）全部命中登记入口，
   deep-import 为 0；baseline 不新增。
2. `node scripts/architecture/architecture-check.mjs context server` 展示
   owner/contract/requires。
3. `pnpm --filter @acode/server test` 全绿；包导出面与纳管前一致。
4. `pnpm exec tsc -b packages/server` 通过（contract.example.ts 参与编译）。
