# 打包态 agent 命令 env 门禁（agent command env gate）

安全加固 P2 项。打包桌面运行时**忽略用户态 env 对 agent 子进程二进制的整体替换**，
与 P1-7（更新源 isPackaged 门禁）、P2 托管策略地板（ACODE_MANAGED_POLICY_FILE 门禁）
同一哲学：打包版的安全关键解析不吃 env 注入。

## 背景

桌面 host 每次 spawn agent 子进程（`acode.cjs app-server --stdio`）前经
`resolveDefaultACodeAgentCommand` 解析命令。此前三个 env 门面能在**打包态**整体替换
实际启动的程序：

1. `ACODE_AGENT_SERVER_COMMAND` / `ACODE_AGENT_SERVER_ARGS_JSON` / `ACODE_AGENT_SERVER_CWD`
   （`acodeAgentProcessManager.ts`）——直接替换整条 spawn 命令；
2. `GLM_BINARY_PATH`（native 引擎的 `binaryEnvVar`，`providerRuntimeResolver.ts
   findACodeAgentRuntimeBinary` 的**第一候选**，压过 packagedResources）；
3. 各外部引擎的 `binaryEnvVar`（codex/opencode/gemini，`externalEngineCommandResolver.ts`
   ——引擎注册表把同一覆盖面按引擎复制了一遍）。

威胁模型（与 P1-7 相同）：macOS `launchctl setenv` / shell profile / Windows 用户环境
变量可以在**用户级权限**下注入 GUI 应用的启动环境。签名打包的 ACode 持有 TCC 授权、
钥匙串访问与用户信任；注入 `ACODE_AGENT_SERVER_COMMAND=/tmp/evil` 即让每个任务静默
运行攻击者的二进制——无需任何 UI 可见动作。

## 产品规则

### R1 打包态忽略 agent 命令 env 覆盖

- 判定单一事实源：`isPackagedACodeDesktopRuntime(env)`（`@acode/shared`）——
  `ACODE_APP_IS_PACKAGED === "1"`。该标记由桌面 main 依 `app.isPackaged`（编译期事实）
  写入 host env（`desktopRuntimeEnv`，P2 骨架已接线），host 进程内读取。
  host 无 Electron `app` 对象，env 标记是 main→host 的唯一打包事实通道；
  标记本身由 main 在 `...inheritedEnv` **之后** spread，打包态下继承值无法覆盖。
- 打包态命中时：
  - `ACODE_AGENT_SERVER_COMMAND` 分支整体跳过 → 落回既有 bundled/Electron-runtime/
    deployed 候选链（打包桌面的正常路径）；
  - `findACodeAgentRuntimeBinary` 跳过 `binaryEnvVar` 候选（native 与外部引擎统一）→
    只走 packagedResources / `~/.acode/server/agents/<engine>` / bundled-agents 候选；
  - `resolveExternalEngineCommand` 跳过 `envPath` 候选 → 委托给已门禁的
    `findACodeAgentRuntimeBinary`。
- **非打包态零变化**：dev（源码运行）、独立 CLI、acode-server-cli、远程 SSH server
  都没有该标记 → env 覆盖照常生效。这些场景里用户就是管理员，env 是合法配置通道
  （与 P1-7、托管策略地板的边界划分一致）。

### R2 门禁是统一谓词，不是散点判断

三个门面共用同一个 `isPackagedACodeDesktopRuntime()`，新增引擎或新增 env 覆盖点时
门禁自动覆盖（引擎注册表的 `binaryEnvVar` 是数据、判定点只在 resolver 两处）。
禁止在各调用点手写 `process.env.ACODE_APP_IS_PACKAGED === "1"`。

### R3 已知诚实边界（记录，不修）

- **login shell 采集的 `SHELL`**（`runtimeLoginShellEnvCapture.ts`）：候选链首项是
  `baseEnv.SHELL`，打包态**保留**——login env 采集的功能本体就是运行用户自己的 shell，
  门禁它会破坏 fish/自定义 shell 用户。已有缓解：`isExecutableFile`（accessSync X_OK）
  校验存在且可执行。残余风险 = 「SHELL 指向同用户 planted 的可执行文件」，属同用户
  文件植入面（攻击者已有用户级代码执行），不在 env 注入门禁的威胁模型内。
- 外部引擎（codex/opencode/gemini）打包态忽略 `binaryEnvVar` 后，自定义安装路径的
  发现通道只剩 `~/.acode/server/agents/<engine>`；当前外部引擎会话协议未接入
  （registry implemented:false，仅安装探测/诊断使用），UX 影响为零。接入会话时若需
  自定义路径，走 Settings 显式配置（用户可见动作），不恢复 env 通道。
- 独立 `acode-server-cli` 分发不设打包标记：其管理员对本机有完全控制权，env 配置
  属合法用法（与桌面签名包的信任位置不同）。

## 状态所有者与调用链

```
桌面 main（app.isPackaged 编译期事实）
  └─ hostEnv[ACODE_APP_IS_PACKAGED]="1"（spread 在 inheritedEnv 之后，不可被继承值覆盖）
       └─ host 进程（services）
            ├─ resolveDefaultACodeAgentCommand ── 门禁①（ACODE_AGENT_SERVER_COMMAND 族）
            ├─ findACodeAgentRuntimeBinary ────── 门禁②（binaryEnvVar，native+外部引擎）
            └─ resolveExternalEngineCommand ───── 门禁③（envPath → 委托门禁②）
```

## 接口

- `packages/shared/src/env.ts`：`isPackagedACodeDesktopRuntime(env?: Readonly<Record<string, string | undefined>>): boolean`
  （缺省读 process.env；纯谓词，可单测）。
- 三个门禁点签名不变（内部读谓词）。

## 验收场景

见 `packages/services/tests/agent-command-env-gate.test.mjs`：

1. 谓词：标记 "1" → true；缺失/其它值 → false；显式 env 参数优先于 process.env。
2. 打包态：设 `ACODE_AGENT_SERVER_COMMAND=/tmp/evil` → `resolveDefaultACodeAgentCommand`
   返回的命令**不是** /tmp/evil（落回候选链）；非打包态同 env → 返回 /tmp/evil（零回归）。
3. 打包态：设 `GLM_BINARY_PATH=/tmp/evil-glm` → `findACodeAgentRuntimeBinary` 不返回它；
   非打包态 → 返回它（存在时）。
4. 打包态：外部引擎 `binaryEnvVar` 指向的假路径被忽略；`resolveExternalEngineCommand`
   走标准候选链（未安装 → missingBinaryMessage）。
5. 标记不可被继承值伪造：main 侧 spread 顺序已有测试守护（desktopRuntimeEnv），
   本层只断言谓词语义。

## 不在本项范围

- 二进制签名校验（plan 中的「或要求签名校验」分支）：跨平台签名验证是大件，
  独立立项。
- login shell SHELL 门禁（R3 已记录为接受残余）。
- 远程/独立 server 分发的等价门禁（R3：信任位置不同，不做）。
