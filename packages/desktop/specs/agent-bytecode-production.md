# 桌面 Agent 字节码生产启用（J5-L1）

方案条目 **J5-L1**（`docs/j5-performance-baseline.md` §7），性质：**性能优化 + 发布链改动**。
承接 `electron-hardening.md:234` 登记的「bytecode 入口属后续工程」。

## 背景

基线剖析（`docs/j5-performance-baseline.md` §3）实测：桌面生产 agent（`acode.cjs app-server`，
Electron-as-node）就绪中位数 1073ms；启动 cpu-prof 定位 ~60% 在 V8 编译（wrapSafe 31%）+
顶层模块求值（30%）的 15.6MB 单文件 bundle。**字节码形态（D）就绪 604ms，-44%（-469ms）**，
代价 +39MB RSS。字节码编译/加载三件套已在仓库（`scripts/build-desktop-agent-bytecode.mjs`、
`compile-desktop-agent-bytecode.cjs`、`desktop-agent-bytecode-runtime.cjs`），但：

- **生产打包链完全不构建、不消费字节码**：`resolveElectronRuntimeACodeAgentCommand`
  （`acodeAgentProcessManager.ts`）读 `resources/glm/acode.cjs` 纯 JS，无 bytecode 分支。
- 现有 bytecode 消费点只在 dev/源码树分支 `resolveBundledWorkspaceACodeAgentCommand`
  （`ACODE_DESKTOP_AGENT_BYTECODE=1` env 门控，loader 缺失**硬失败**，显式试验语义）。
- CI 发布是**原生分平台构建**（`.github/workflows/release.yml:282-307`：macos-14→mac arm64、
  macos-15-intel→mac x64、windows-latest→win x64、ubuntu→linux x64、ubuntu-24.04-arm→linux arm64），
  host 平台 == target 平台，故打包时用宿主 Electron 编 .jsc 对目标平台正确。

## 安全设计原则（最高优先）

**生产任何情况下不得因字节码问题导致 agent 无法启动。** 与 dev 的「硬失败暴露问题」相反，
生产走**优雅回退**：字节码失配/损坏 → 静默回退 `acode.cjs`（现状行为）。最坏情况 = 回退 JS
（无收益、无损害），而非 P0（打包 agent 起不来）。

### 为什么权威校验必须在 agent 进程内的 loader、而非 host 侧预检

字节码 .jsc 绑定编译时的运行时指纹 `{electron, node, v8, platform, arch, cachedDataVersionTag}`
（`desktop-agent-bytecode-runtime.cjs:9-20` `configureBytecodeRuntime`）。其中
**`cachedDataVersionTag` 依赖 V8 标志**：编译/加载侧都先 `v8.setFlagsFromString("--no-lazy
--no-flush-bytecode")` 再取 tag。host 进程（Electron utility process）若为复现该 tag 而设这些标志，
会污染自身 V8 行为（禁用惰性编译、禁刷字节码 → host 变慢/涨内存）。因此 **host 侧无法在不自我污染
的前提下权威复现 agent 进程的 tag**——host 预检通过但 loader 硬失败仍是 P0。

结论：优雅回退放在 **agent 进程内的 loader**（权威 V8 校验真实发生地）。host resolver 只做
「loader 存在则优先 + 设回退标志」，不预测、不设 V8 标志、无 P0 风险。（实现期曾尝试 host 侧
指纹 sidecar 预检，实测 `cachedDataVersionTag` 因标志差异 host≠agent，已废弃该方案。）

## 实现（含对抗复核第 1/2 轮修复）

### 1. 运行时描述符（`packages/shared/src/acode-agent-runtime.ts`）

仅导出常量 `ACODE_AGENT_BYTECODE_ENTRY_FILE = "acode.bytecode.cjs"`。
**不加**描述符字节码段（`nodeBundleBytecodeEntryFile`/`resolveNodeBundleBytecodeSegments` 已删，对抗复核 F3）：
字节码 loader 不走独立候选链发现（见 §3），故描述符无需字节码入口段。

### 2. ~~字节码 bundle 独立发现链~~（F3 已删除）

对抗复核 F3：原设计的 `findACodeAgentRuntimeNodeBytecodeBundle` 独立候选链会下沉到
`~/.acode/server/agents/glm` 等**用户可写目录**，打包态下任何同用户进程写入 `acode.bytecode.cjs`
即可劫持 agent 入口（回退 agent-command-env-gate 加固）。**该函数已删除**；loader 改为按 §3 兄弟派生。

### 3. 生产 resolver 优雅回退（`packages/services/src/acode-agent/acodeAgentProcessManager.ts`）

`resolveElectronRuntimeACodeAgentCommand`：
- 照常解析 `bundlePath`（acode.cjs，经 `findACodeAgentRuntimeNodeBundle` 候选链）；为 null 直接返回 null（现状，远端 SSH 无 electron 不受影响）。
- **F3 兄弟派生**：`bytecodeLoaderPath = existsSync(join(dirname(bundlePath), ACODE_AGENT_BYTECODE_ENTRY_FILE)) ? 该路径 : null`。loader 只认「已解析 JS bundle 的同目录兄弟」，与 acode.cjs **同源于同一可信目录**（生产=只读签名区 `process.resourcesPath/glm`），不下沉用户可写目录。`entrypoint = bytecodeLoaderPath ?? bundlePath`。
- 选用 loader 时在 spawn env 加 **`ACODE_BYTECODE_FALLBACK: "1"`**（走 JS bundle 时不加）。该 env 经 `effectiveCommand.env` 在 spawn 合并链最高优先级合入（`sanitizeACodeRuntimeEnv` 之后），不被剥离。
- `storagePreparationEntry` **恒为 acode.cjs**（沿用既有语义：Worker 与 Electron Node 子进程 V8 snapshot 可不同）。
- host 侧**不做指纹预检、不设 V8 标志**（见上「为什么」）。

dev/源码树分支 `resolveBundledWorkspaceACodeAgentCommand` **保持现状**（env 门控 + 硬失败），本轮不动。

### 4. loader 优雅回退 + runtime 校验顺序（`scripts/build-desktop-agent-bytecode.mjs` + `scripts/desktop-agent-bytecode-runtime.cjs`）

导出的 `renderBytecodeLoader(metadata, runtimeFile)` 生成的 loader：
- **F1（P0）**：同步 `require("./<runtimeFile>")` 包进 try/catch，catch 调 `tryFallback`——runtime 文件缺失（打包遗漏）时原 `.catch` 覆盖不到同步 require，会 Cannot find module 硬崩、回退永不触发。
- `tryFallback(error)`：仅当 `ACODE_BYTECODE_FALLBACK==="1"` **且** `error.__acodeBytecodeExecuted` 未置位时，`require(path.join(__dirname, metadata.sourceFile))` 回退 acode.cjs；否则 `hardFail`（stderr + exitCode=1）。
- **F4a**：`desktop-agent-bytecode-runtime.cjs` 的 `run.call` 包 try/catch，bundle 工厂执行期错误打 `error.__acodeBytecodeExecuted=true` 再抛——loader 见此标记**不回退**（避免 require(acode.cjs) 二次执行顶层副作用）。加载失败（指纹/摘要/cachedDataRejected/runtime 缺失，均在 run.call 之前）不带标记，可安全回退。
- **F4b**：回退前写 `[acode-bytecode] fallback to <sourceFile>: <reason>` 到 stderr（host 已接 agent stderr 进诊断，stdout 协议流保持干净），补「字节码静默失效」可观测性。
- **N1（关键）**：`loadBytecode` 校验顺序重排——**无需 flags 的校验前置**（5 个稳定字段 electron/node/v8/platform/arch 比较 + .jsc digest 校验），全部通过后才 `configureBytecodeRuntime()`（设 `--no-lazy --no-flush-bytecode`）+ 比 `cachedDataVersionTag` + `vm.Script`。原因：flags 一旦设置，之后任何失配回退的 acode.cjs 都在 eager-compile 污染下运行（实测启动 +20~25%，比现状 JS 还慢），证伪「最坏=回退 JS 无损」。前置后，最常见的两类回退（Electron/V8 版本漂移、.jsc 损坏/陈旧）在设 flags 前失败 → 回退回到**干净 JS 现状**（实测损坏回退 median 1024ms ≈ 干净基线 987ms）。仅同版本下 cachedDataVersionTag 失配（极低概率）才残留污染。
- 回退 require 的 acode.cjs 顶层 `void main()` 照常执行，`process.argv.slice(2)` 不受 loader 作为 argv[1] 影响（仍是 `app-server --stdio`）；回退目标也缺失 → 二次失败 exitCode=1。

### 5. 构建链编译（`packages/desktop/scripts/prepare-agent-node-bundle.mjs`）

`buildCliBundle()` 之后、`stageBundle()` 之前插入 `await buildAgentBytecode()`：
- **跨平台守卫**：仅当 `process.platform === platform && process.arch === arch`（host==target）才编译。交叉打包跳过 → 包内无 .jsc → 生产回退 JS。
- **F5**：编译后断言 `artifact.metadata.runtime.platform/arch === target`（守卫校验的是宿主 node，实际编译用的 Electron 在 Rosetta/npm_config_arch 下可能异架构）；失配 → `removeBytecodeArtifacts()` + warn（JS 回退，避免错平台 .jsc 进包 36MB 死重）。
- **非致命**：try/catch，编译失败 `removeBytecodeArtifacts()` + log warn 继续（不阻断发布构建；生产回退 JS）。
- `ACODE_E2E_COVERAGE=1` 跳过（构建脚本本就拒绝，coverage 需 JS 路径）。

### 6. 构建产物：meta sidecar + 陈旧清理 + 原子自愈（`scripts/build-desktop-agent-bytecode.mjs`）

- **F2 meta sidecar**：编译成功后写 `acode.bytecode-meta.json`（`{bytecodeFile, runtimeFile, sourceFile, sourceSha256}`，`sourceSha256 = sha256(Buffer.from(acode.cjs utf8))` 与编译器 `bytecodeDigest` 同源），供 staging 做新鲜度 + 依赖闭环校验。非运行时文件，不随包 stage。
- **陈旧清理**：清理同目录非当前的 `acode.bytecode-*.jsc`/`acode.bytecode-runtime-*.cjs` 孤儿（多次构建残留），避免本地 dist 累积。
- **F6 原子自愈**：`publishImmutable` 遇 EEXIST 且内容不同（上次中断的截断残留）时不再 throw「已损坏」（旧行为会让本机字节码构建永久卡死），改为 rm + 重写（内容寻址名下安全）。

### 7. staging 校验后携带（`packages/desktop/scripts/stage-agent-bundle.mjs`）

`stageAgentBundle` 拷 `acode.cjs` + meta 后，经 `resolveValidatedBytecodeArtifacts` **校验通过才**携带字节码（meta 驱动精确拷贝 loader + meta.bytecodeFile + meta.runtimeFile，**非前缀 glob**）。放弃字节码（只 stage acode.cjs，JS only 安全态）的条件：
- **F2 coverage**：`ACODE_E2E_COVERAGE=1` 强制跳过（插桩需 JS 路径，旧字节码会让覆盖率静默归零）。
- **F2 新鲜度**：`meta.sourceSha256 !== sha256(本次 acode.cjs)`（utf8→Buffer 与编译器同源）→ 陈旧字节码会静默取代新 JS（甚至版本劈叉），拒绝。
- **F1 依赖闭环**：meta 引用的 `.jsc`/`runtime` 任一缺失 → 拒绝（避免生产 loader require 失败）。
保留 `rmSync` 干净重建语义；meta 增 `bytecodeEntry`（loader 名或 null，**纯信息字段**——生产 resolver 用 §3 的 existsSync 兄弟探测，不读 staged meta）。electron-builder extraResources 整目录拷贝（`electron-builder.config.js:664-672`）自动带上 staged 产物。

## 验收

- **loader 优雅回退测试**（`packages/services/tests/agent-bytecode-resolver.test.mjs`，7 例，用真实
  `renderBytecodeLoader` 模板 + fake runtime + fake acode.cjs（打标记），plain node 跑）：
  - `ACODE_BYTECODE_FALLBACK=1` + 加载失败 → 回退执行 acode.cjs（标记输出 + exit 0 + stderr 诊断行 F4b）；
  - 无 env + 加载失败 → 硬失败 exitCode=1 + 暴露原始错误（不静默回退）；
  - **F1**：runtime 文件缺失（同步 require 失败）+ env → 仍优雅回退；无 env → 硬失败；
  - **F4a**：bundle 已执行（`__acodeBytecodeExecuted`）+ env → 不回退（防二次执行），硬失败；
  - 回退目标 acode.cjs 也缺失 → 二次失败 exitCode=1；loader 模板结构钉住（env 门控/执行标记/sourceFile 回退/同步 require 保护/exitCode=1）。
- **staging 测试**（`packages/desktop/tests/stage-agent-bundle-bytecode.test.mjs`，7 例）：新鲜字节码
  （sourceSha256 匹配 + 依赖齐备）全部 staged + meta.bytecodeEntry 记录；**F2** sourceSha256 失配（陈旧）→ JS only；
  **F2** coverage → 强制 JS only；**F1** meta 引用的 .jsc 缺失（依赖不闭环）→ JS only；rmSync 清掉陈旧 .jsc/原生
  二进制；只拷 meta 引用文件不误拷 .map/孤儿 .jsc；meta sidecar 不进包。
- **真实 Electron 端到端**（实现期已验，发布清单复验）：有效字节码 → loader 加载成功（version exit 0，~521ms vs JS ~1000ms）；
  损坏 .jsc + fallback env → 回退 acode.cjs（version exit 0）；损坏 .jsc 无 env → 硬失败 exit 1；runtime 缺失 + env → 回退（F1）。
  **N1**：损坏 .jsc 回退（digest 失配，在设 flags 前拦截）启动 median 1024ms ≈ 干净 acode.cjs 基线 987ms（无 +200ms 污染税）。
- 既有 `agent-command-env-gate.test.mjs`（9 例）全绿（resolver 零回归）。
- 门禁：root typecheck、services+shared+desktop 逐包 tsc、lint、arch、CLI 全量测试、desktop+services 测试。

## 发布清单跟进（本环境无法验证，必须在真实发布构建确认）

> 本轮在开发环境实现并单测 loader 回退/staging，且用真实 Electron 验证了「有效字节码加载 + 损坏回退 +
> dev 硬失败」三条路径。但**无法跑真实跨平台 electron-builder 发布构建**。发布前必须确认：
> 1. CI 各原生 runner 上 `prepare-agent-node-bundle.mjs` 成功编出 .jsc 且 staged 进 `resources/glm`
>    （loader + .jsc + runtime 三件）。
> 2. 安装包启动后 agent 走字节码入口、就绪时间较 JS 下降（~604ms vs ~1073ms）；指纹失配时静默回退 JS 且 agent 正常。
> 3. `audit-bundle-size.mjs` 限额（500MiB）在 +36MB .jsc 后仍有余量。
> 4. Electron 版本 bump 时（`packages/desktop/package.json` devDep + `electron-builder.config.js:479`
>    两处独立事实）发布链必须重编 .jsc——否则 agent 进程内 loader 指纹失配 → 优雅回退 JS（安全但无收益）。
>    建议加机械校验（bump 时强制重编 + 校验 .jsc 与打包 Electron 的 cachedDataVersionTag 一致）。

## 所有权边界

- `packages/shared/src/acode-agent-runtime.ts`（入口常量 `ACODE_AGENT_BYTECODE_ENTRY_FILE`）
- `packages/services/src/acode-agent/acodeAgentProcessManager.ts`（resolver 兄弟派生 + 回退 env）
- `packages/services/src/runtime-tools/providerRuntimeResolver.ts`（F3：删除独立字节码发现链，仅留注释）
- `packages/desktop/scripts/prepare-agent-node-bundle.mjs`（编译 + 跨平台守卫 + F5 断言 + 清理）、`stage-agent-bundle.mjs`（meta 驱动校验 staging）
- `scripts/build-desktop-agent-bytecode.mjs`（loader 回退模板 + meta sidecar + 陈旧清理 + F6 自愈）、`scripts/desktop-agent-bytecode-runtime.cjs`（F4a 执行标记 + N1 校验顺序重排）
- 本 spec、`packages/services/tests/agent-bytecode-resolver.test.mjs`、`packages/desktop/tests/stage-agent-bundle-bytecode.test.mjs`
- `electron-hardening.md:234` 表述同步（bytecode 从「后续工程」改为「已接入生产，loader 优雅回退」）

边界外：dev 分支 `resolveBundledWorkspaceACodeAgentCommand`（保持现状）、`compile-desktop-agent-bytecode.cjs`
（编译逻辑不改）、`runAsNode` fuse（保持 true，bytecode 不改此项）。

## 风险登记

- **Electron 版本绑定**：两处独立 pin（devDep + builder config），bump 其一无机械保障 → 失配时 loader
  优雅回退 JS。**N1 修复后回退是干净 JS**（稳定字段校验在设 flags 前，回退不带 eager-compile 污染，实测 ≈ 现状基线）；发布清单第 4 项建议加机械校验（bump 时强制重编）。
- **交叉平台**：守卫 + F5 编译后断言确保 host≠target（含 Rosetta/异架构 Electron）时不编/删字节码（回退 JS），错平台 .jsc 不进包。
- **打包遗漏 .jsc/runtime**：F1（loader 同步 require 纳入回退）+ staging 依赖闭环校验双保险——任一缺失 → 回退/只发 JS（安全）；发布清单第 1 项机械确认。
- **陈旧字节码取代新 JS**：F2 staging sourceSha256 新鲜度校验拦截（.jsc 与 acode.cjs 无运行时新鲜度绑定，V8 只看 sourceLength 且取自 loader 自身 metadata 恒自洽）。
- **包体 +36MB / RSS +39MB**：发布清单第 3 项确认限额；.jsc 与 acode.cjs 并存（storagePreparationEntry
  与回退仍依赖 acode.cjs，短期不可裁）。
- **回退 require 语义**：loader 回退 `require(acode.cjs)` 依赖 bundle 顶层无条件执行 + `process.argv.slice(2)`
  与 argv[1] 无关；已用真实 Electron 损坏/runtime 缺失回退路径验证（version exit 0）。
- **F7（deferred）**：`ACODE_BYTECODE_FALLBACK` 随 agent env 继承到 Bash/MCP 子进程；值恒 "1" 零机密性、唯一消费者是我方 loader、方向恒安全侧（提高可用性不执行攻击者代码），第 2 轮复核确认 deferred 成立。可选卫生加固：loader 回退/执行前 `delete process.env.ACODE_BYTECODE_FALLBACK`。
