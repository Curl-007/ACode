# Agent/Host 进程 v8 堆上限护栏(agent v8 heap guard)

内存治理配套项(chat-lane-idle-reclaim.md 的后续项 2)。给 Host utilityProcess、
cron scheduler 与 app-server agent 三类长驻 Node 运行时设置显式
`--max-old-space-size` 上限,把「泄漏无界增长直到系统 OOM」变成「堆内提前
GC 压力/可归因的 heap OOM 错误」;同时把 `NODE_OPTIONS` 收进 env 剔除面,
关掉一条既有的用户级 env 注入通道。

## 背景(起草时逐条核实)

1. **现状零上限**:Host fork `execArgv = ["--no-warnings"]`
   (`packages/desktop/src/main/desktopHostProcess.ts:243-246`),cron scheduler 同
   (`desktopCronScheduler.ts:62`);app-server spawn env 无任何 v8 flag
   (`packages/services/src/acode-agent/acodeAgentProcessManager.ts` env 装配块)。
   Node 64 位缺省堆上限按系统内存放大(常见 2-4GB),单进程泄漏可吃掉整机额度。
2. **事故先例**:renderer 堆曾从 87MB 棘轮到 2088MB
   (`packages/ui/specs/renderer-memory-budget.md`);CLI/Host 侧同类风险仅靠
   代码纪律约束,无机械护栏。
3. **注入通道**:`NODE_OPTIONS` 目前不在 `SANITIZED_RUNTIME_ENV_KEYS`
   (`packages/shared/src/runtimeEnv.ts:50-101`),用户 shell/launchctl 级
   `NODE_OPTIONS=--require=/tmp/evil.js` 会随继承 env 进入 Host(fuse
   `enableNodeOptionsEnvironmentVariable` 为开,`desktop-electron-fuses.mjs:16-23`)
   与 agent 进程——与 agent-command-env-gate.md 封堵的二进制替换面同一威胁等级
   (用户级权限注入 GUI 应用子进程 = 代码执行)。仓库既有意图佐证:
   `runtimeCommandEnv.ts:94`「避免恢复宽继承把 NODE_OPTIONS 等带进 host/agent runtime」。
4. **合并先例**:E2E coverage 已经用 NODE_OPTIONS preload 且自带合并写法
   (`acodeAgentProcessManager.ts:218-222`),护栏注入必须与其兼容(在
   `buildE2EAgentCoverageEnv()` 之后合并,不覆盖)。

## 产品规则

### R1 Host 与 cron scheduler:execArgv 显式上限

- `desktopHostProcess.ts` 与 `desktopCronScheduler.ts` 的 fork `execArgv` 追加
  `--max-old-space-size=<mb>`;mb 由 `resolveMaxOldSpaceMb(env[ACODE_HOST_MAX_OLD_SPACE_MB_ENV_KEY], DEFAULT_HOST_MAX_OLD_SPACE_MB=2048)` 解析。
- 用 execArgv 而非 NODE_OPTIONS:确定性生效,且与 R3 的剔除互不干扰。

### R2 app-server agent:spawn env 注入并合并 NODE_OPTIONS

- `ACodeAgentProcessManager` spawn env 装配末尾(coverage env 之后)合并
  `--max-old-space-size=<mb>` 进 `NODE_OPTIONS`;mb 由
  `ACODE_AGENT_MAX_OLD_SPACE_MB` 解析,缺省 `DEFAULT_AGENT_MAX_OLD_SPACE_MB=3072`。
- 既有 NODE_OPTIONS 片段(spawnEnv/command.env/coverage preload)保留,空格拼接。
- 覆盖所有经 processManager 的 spawn 面:桌面 chat/plugin/mcp-status lane、
  web server、acode-server-cli 远端部署。

### R3 NODE_OPTIONS 进剔除面(安全收口)

- `SANITIZED_RUNTIME_ENV_KEYS` 与 `NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS`
  各加 `"NODE_OPTIONS"`:继承的用户值在 Host env(buildHostProcessEnv 走
  sanitizeACodeRuntimeEnv)、agent spawn base env、Bash/tool 子进程 env 三处
  统一剔除,且不经 tool-env-passthrough 恢复。
- 护栏值(R1/R2)在剔除之后注入,不受影响;CLI 启动后自清洗
  (applyCliRuntimeEnvSanitization)会把 NODE_OPTIONS 从自身 process.env 摘除
  ——v8 已在启动时读取,heap 上限不受影响,而孙进程(bash 工具、plugin host、
  MCP)不再继承,符合「护栏只约束自有 runtime」边界。

### R4 解析规则(fail-safe 方向与 idle-exit 相反)

- `resolveMaxOldSpaceMb(raw, fallback)`:undefined/非法 → **fallback**(护栏是
  安全默认,打错字不应静默解除);`"0"` → 关闭注入(逃生门,显式意图);
  正整数 → 该值。与 idle-exit 的「非法→禁用」方向相反,因为两者的风险方向相反
  (误杀进程 vs 失去护栏),差异在解析函数注释中显式说明。

### R5 兼容性核实(起草时逐条核实,实现不引入新假设)

- fuse `enableNodeOptionsEnvironmentVariable` 打包态为开
  (`desktop-electron-fuses.mjs:22-23`,打包 agent 依赖 Electron-as-node 语义)
  → NODE_OPTIONS 在生产桌面生效。
- `--max-old-space-size` 属 NODE_OPTIONS 白名单 flag;非编译期 flag,
  不影响字节码 loader 的指纹校验(Electron/V8/平台/架构),
  `acode.bytecode.cjs` 路径照常。
- SEA/native binary(`acode-agent`)内嵌 Node 同样接受该 flag。

### R6 缺省值依据

- Host 2048MB:实测常驻提交 ~156MB,13× 余量;Host 承载 services/task index/
  浏览器 guest 管理,重负载路径均有独立上限(如 taskRealtimeBus 有界缓冲)。
- Agent 3072MB:实测活跃长会话堆 93-200MB,15×+ 余量;上限只拦截病态增长,
  不改变任何正常工作集。两值均可 env 调,`0` 显式关闭。

## 状态与所有者

- 解析函数与常量:`packages/shared/src/process-v8-heap-guard.ts`(纯函数,注入点共用)。
- Host/cron execArgv:desktop main(spawn 点唯一所有者)。
- agent NODE_OPTIONS 合并:processManager spawn env 装配(唯一注入点,
  与 ACODE_WORKSPACE_IDENTITY/idle-exit env 同一模式)。
- 剔除面:shared runtimeEnv 两个清单(单点生效三面)。

## 验收场景

1. Host fork 与 cron scheduler 的 execArgv 含 `--max-old-space-size=2048`
   (缺省);`ACODE_HOST_MAX_OLD_SPACE_MB=1024` → 1024;`=0` → 不含该 flag。
2. agent spawn env 的 NODE_OPTIONS 含 `--max-old-space-size=3072`(缺省);
   已有 NODE_OPTIONS 片段(如 coverage preload)时空格合并不覆盖;
   `ACODE_AGENT_MAX_OLD_SPACE_MB=0` → 不注入且不破坏既有片段。
3. 继承 env 携带 `NODE_OPTIONS=--require=/tmp/x.js` 时:Host env、agent spawn
   base env、工具子进程 env 均不含该值(sanitize 三面剔除)。
4. 实际生效验证:`NODE_OPTIONS=--max-old-space-size=N node -e
"v8.getHeapStatistics().heap_size_limit"` 随 N 变化(运行期抽查)。
5. 解析:undefined/空串/非法/负数/小数 → fallback;"0" → 0;正整数 → 原值。

## 测试与验证

- 单测:`packages/shared/test/process-v8-heap-guard.test.ts`(解析与合并真值表)。
- 既有套件回归:services 全套(node --import tsx --test)。
- `pnpm typecheck`、`pnpm lint`(改动文件)、`architecture:check --changed`。
- 场景 4 以一次性命令实测 heap_size_limit。

## 已知诚实边界(记录,不在本 spec 修)

- **plugin host(`__acode-plugin-host`)与 MCP 子进程不带上限**:它们由 CLI 派生,
  继承的是 CLI 自清洗后的 env(R3 语义)。plugin host 是不加载业务模块的轻进程,
  首版不覆盖;若未来出现 plugin host 泄漏事故,在 MCP spawn env 定向注入。
- **开发者用 NODE_OPTIONS 调试 agent 的流程被剔除面拦截**:替代通道是既有
  stdio tap(`scripts/dev/acode-stdio-tap.mjs`)与 Host 的 RUNTIME_ACODE_DEBUG
  --inspect-brk execArgv 路径;与 NODE_ENV 已被剔除的既有取舍一致。
- **E2E coverage 的 node 系工具子进程不再继承 preload**(此前经宽继承意外获得);
  coverage 主目标(agent 进程自身)不受影响。
- **上限不是泄漏修复**:触顶表现为 heap OOM 崩溃 + 既有 unexpected 归因/诊断链,
  比无界增长可归因,但根因仍需按事故流程修。
