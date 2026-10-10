# ARCH-02 外部行为验收记录（2026-10-09）

## 补充：Windows isolated-profile Electron smoke 已落地并通过（2026-10-09 第二批）

上一节记录的“Electron 主进程保持运行但 30 秒内没有 CDP/首窗”卡点已定位并排除：**应用本体启动链路没有卡点，是探针的 CDP 发现方式错误**。真实原因是等待固定端口（9229 被 `ACODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` 正确关闭）和等待 `DevToolsActivePort` 出现在 `ACODE_DESKTOP_USER_DATA_DIR`——Electron 并未把该文件写进 `app.setPath` 指定的隔离目录，导致探针永远等不到端口，而应用其实早已完成首窗与 Host 启动。

新增 `packages/desktop/scripts/e2e-smoke.mjs`（`pnpm --filter @acode/desktop e2e:smoke`）：完全隔离身份（唯一 app name、临时 home/userData/数据目录/E2E 日志目录）启动开发态 Electron，CDP 发现改为「`DevToolsActivePort` 文件 + 按主进程 PID 扫描监听端口逐个探测 `/json/version`」双通道，随后依次验证四个检查点并强制回收。

本机实测（Windows 11，Node v25.8.2；bundles 先用 tsup+vite 按当前工作树重建，preload/renderer 此前为 10-05 旧产物）：

- CP1 进程存活：PASS（+5.0s，pid 19260）。
- CP2 CDP：PASS（+5.1s，`DevToolsActivePort` 未落盘，经监听端口探测发现 port 64056，`Chrome/146.0.7680.216`）。
- CP3 首窗 ready：PASS（+5.1s，title "ACode"，launchMarks `createdAt→mainStart 559ms → appReady 624ms → loadUrl 889ms`）。
- CP4 Host 启动：PASS（+5.1s，主日志 `[spawnHostProcess] forked host process for (local-1)`；Host RPC 流量与 renderer memory 日志齐全）。
- 退出清理：PASS——`taskkill /T /F` 后无任何 electron 进程命令行引用临时目录，临时目录整体删除（+6.5s 全程结束）。

结论：真实 Electron 的 app-ready/首窗/Host 启动/进程树与临时目录清理闭环首次在本机形成可复核证据，也证明修复批次的 main/host/preload/renderer 产物可以完整启动。观察到一个非阻塞日志缺陷：forked host 行的 `pid=undefined`（utilityProcess pid 在 fork 时刻未就绪），不影响验收判定。

仍未闭环（与本节先前结论一致）：SSH 首次批准对话框在真实 GUI 中的端到端驱动（现在 CDP 可发现，已具备用 CDP/Chromedriver 接管的条件）、macOS/Linux 行为矩阵、clean checkout CI、Docker remote SSH verifier。

## 已完成的本机证据

- 环境：Windows 11，Node `v25.8.2`，pnpm `9.10.0`；仓库声明 Node `24.14.0`、pnpm `10.33.2`。
- `node scripts/check-workspace-freshness.mjs`：通过，`dev/0.0.7` 与 `origin/dev/0.0.7` 同步。
- `pnpm --filter @acode/server test`：`74/74` 通过。套件包含真实 `ssh2` fake-server 握手、未知/相同/变更 key、`known_hosts` 多 key/hashed/wildcard/negation/revoked、managed replace、并发写入和 HTTP/WebSocket harness。
- `pnpm --filter @acode/desktop test`：`72/72` 通过。包含 SSH challenge cancellation tombstone、并发 requestId 保护、Desktop IPC 路由边界和 renderer/main 安全回归。
- Windows OpenSSH 实证：使用 `%TEMP%` 临时 host/client ED25519、临时 `sshd_config` 和高端口 `22322` 启动 `sshd.exe`；`ssh-keyscan` 生成的 `known_hosts` 可被 ACode `createKnownHostsTrust` 解析；`SSHBackend` 完成 host-key 验证及公钥认证，sshd 日志出现 `Accepted publickey`。探针结束后已停止 sshd，临时文件未进入仓库。

Windows OpenSSH 的远程默认 shell 是 `cmd.exe`，而 SSH backend 按产品合同强制执行 `/bin/sh -lc`。因此该探针在认证后执行 `detect/exec` 会因缺少 `/bin/sh` 失败；这证明的是主机密钥与认证边界，不能作为远端 POSIX 环境的完整连接验收。

## 当前无法在本机完成的验收

- `packages/acode-server-cli/scripts/verify-remote-ssh.mjs` 提供 Docker + Ubuntu `sshd` + staged server CLI + SSH 隧道 + WebSocket capability + node-pty + daemon lifecycle 的真实流程，但当前机器没有 Docker daemon，无法执行。
- WSL Ubuntu 可以启动，但没有 `sshd`；当前未安装额外系统包。macOS/Linux 行为矩阵不可在 Windows 替代。
- 真实 Electron 探针使用隔离的 `ACODE_ENV=test`、`ACODE_DATA_BASE_DIR`、`ACODE_DESKTOP_HOME_DIR`、`ACODE_DESKTOP_USER_DATA_DIR` 和 `ACODE_E2E_RUN_ID`。Electron 41.10.7 主进程保持运行但 30 秒内没有 9229/9230 CDP、首窗口或 E2E 日志；因此当前工作区没有形成可复核的 Electron IPC/UI 闭环证据，需要先排查 app-ready/首窗前启动卡点。
- 当前没有发现 Desktop 真实 Electron E2E runner/test 文件；源码存在 CDP、隔离 profile 和 coverage 钩子，但 CI 未启动真实应用。

## 建议的验收门禁

1. `@acode/server-cli` 已增加 `verify:remote-ssh` 脚本，调用现有 verifier；下一步在 Linux CI 用 Node 24/pnpm 10 先 stage `linux-x64`，再运行 Docker verifier。
2. 增加 Windows isolated-profile Electron smoke：等待 CDP、首窗 ready、Host 启动、关闭后确认进程树和临时目录清理；先定位本机 app-ready 卡点再纳入门禁。
3. 在 macOS 与 Linux runner 分别执行真实 Electron/SSH 矩阵；CI 结果通过后再关闭 ARCH-02 的“真实 Electron/跨平台 E2E”剩余项。
