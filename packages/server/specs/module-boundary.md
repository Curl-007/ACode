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

- `onboard-b3-server-over-limit`：9 个存量超 400 行文件（remoteAssetCache.ts
  1928 行、remoteAssetInstaller.ts 1087 行为最大头）；例外只冻结存量。
- `onboard-b3-server-disables`：8 个含 lint disable 的存量文件。
- 到期前应拆分文件、移除 disable，而不是续期例外。

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
