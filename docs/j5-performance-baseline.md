# J5 性能与资源效率基线剖析

> 状态：**L1（字节码生产启用）+ L4（token 估算 length-based 投影）已实施**；L3/L2/L5 经深读代码后修订评估为 deferred（见 §11）。本文件原是测量报告；§11 追加实施状态与修订理由。落地杠杆均已按 AGENTS.md 先补 spec（`packages/desktop/specs/agent-bytecode-production.md`、`apps/acode-cli/specs/token-estimate-perf.md`）。
>
> 测量日期：2026-10-01 · 分支：dev/0.0.1 · 平台：win32 x64
>
> 缘起：jcode（Rust TUI harness）的核心优势是性能与资源效率。ACode 的引擎就是 `apps/acode-cli`（Desktop 经 stdio 调度的 `app-server` 子进程），UI 壳与引擎性能解耦，因此 jcode 式的极致利用可落在 CLI 上而无需改产品形态。本轮先做基线剖析，用数据确定真瓶颈，再挑 top 杠杆立项。

## 1. 方法与被测形态

引擎在生产里有四种运行形态，全部实测（每形态 5 次取中位数）：

| 形态                | 入口                                       | 运行时                                                                  | 对应场景                                                  |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| A tsx-dev           | `src/main.ts`                              | node 25.8.2 + tsx 即时转译                                              | 开发态                                                    |
| B dist-node25       | `dist/acode.cjs`（esbuild minify，15.6MB） | 系统 node 25.8.2（V8 14.1.146.11）                                      | 独立 CLI / SEA 等价                                       |
| C dist-electron     | `dist/acode.cjs`                           | Electron 41.0.3 as-node（内嵌 node 24.14.0，V8 14.6.650202-electron.0） | **桌面生产现状**                                          |
| D bytecode-electron | `dist/acode.bytecode.cjs`（36MB .jsc）     | Electron 41.0.3 as-node                                                 | 桌面生产 + 字节码试验（`ACODE_DESKTOP_AGENT_BYTECODE=1`） |

- **就绪定义**：spawn 后盲发一个未知方法帧 `{"id":1,"method":"__ready_probe__"}`，收到 `id:1` 的 `-32601 Method not found` 响应即"可服务请求"。首字节 = 首个 `startup/storageState` 通知（transport 挂上）。
- **SEA 未单独测**：SEA 需现下载 node 运行时，其启动特征 ≈ 形态 B（plain node + 内嵌 bundle），由 B 覆盖。
- **探针**（只读，仓库外，可重跑）：`j5-startup-probe.mjs`（启动+RSS）、`j5-hotpath-probe.mjs`（热路径微基准）、`j5-gc-probe.mjs`（长会话 GC 合成负载），均在 `C:\Users\ZhuanZ\AppData\Local\Temp\`。
- **环境注意**：系统 node（25.8.2 / V8 14.1）与 Electron 内嵌 node（24.14.0 / V8 14.6）是**不同 V8**。字节码绑定 V8 版本，形态 D 必须在 Electron 下跑（加载器 `cachedDataVersionTag` 校验，失配硬失败）。

## 2. 进程模型盘点

每个窗口（含一个本地 workspace）的 ACode 相关进程：

1. **main** — Electron 主进程，全局共享，管窗口/原生操作/消息转发。
2. **renderer** — Chromium 渲染进程，每窗口一个。
3. **host** — `utilityProcess.fork()` 派生的 window-scoped Local Host（`packages/desktop/src/host/index.ts`），跑全部 local services（含 `ACodeAgentService`），import 整个 `@acode/services` 面。每窗口一个，本地 workspace 共享。
4. **agent** — `acode.cjs app-server --stdio`，Electron-as-node，由 host 的 `ACodeAgentService` 按 workspace 派生（`acodeAgentProcessManager.ts:363-398`）。**本报告测的就是这个进程。**

外加 Chromium GPU/network 等工具进程。多窗口 / 多 workspace 会按 renderer+host+agent 倍数增长。手机远控复用已有 host attachment，不另起 agent。

> 含义：引擎优化（启动/RSS/每轮开销）作用于 agent 进程；但用户看到的总占用是 main+renderer+host+agent 之和，host 本身也是一个跑满 local services 的 Electron 进程。"极致资源利用"若要显著降总占用，host 与 agent 的常驻成本都要看。

## 3. 冷启动到就绪（中位数）

| 形态                | 运行时基线 | 首字节 | **就绪(probe)** | storageReady | RSS 工作集 | RSS 私有 |
| ------------------- | ---------- | ------ | --------------- | ------------ | ---------- | -------- |
| A tsx-dev           | 53ms       | 4197ms | **4264ms**      | 4205ms       | 437MB      | 487MB    |
| B dist-node25       | 48ms       | 1004ms | **1082ms**      | 1013ms       | 271MB      | 279MB    |
| C dist-electron     | 95ms       | 998ms  | **1073ms**      | 1014ms       | 189MB      | 197MB    |
| D bytecode-electron | 97ms       | 530ms  | **604ms**       | 547ms        | 228MB      | 235MB    |

**关键发现：**

- **字节码是最大单点收益**：D vs C（同为 Electron 生产形态）就绪 1073→604ms，**-44%（-469ms）**。代价是 +39MB RSS（36MB .jsc 被映射）。钩子已在仓库里（`ACODE_DESKTOP_AGENT_BYTECODE=1`），构建链已能编 .jsc，但**未默认开启**。
- **tsx-dev 比字节码慢 7×**（4264 vs 604ms）：开发态每次起 agent 付 4.2s 即时转译税。生产用户拿到 dist/bytecode 不受影响，但开发迭代体验受损。
- **Electron-as-node 比系统 node25 省内存**：C(189MB) vs B(271MB)，内嵌 node 24.14 堆基线小于系统 node 25.8.2；但启动时间几乎相同（1073 vs 1082ms）。
- **storageReady ≈ 首字节 +6~30ms**：SQLite 存储检查紧跟 transport，**不是瓶颈**；启动时间被模块图加载主导。

### 3.1 启动 cpu-prof（形态 B，`version` 命令，采样 988ms）

| 自耗时  | 占比  | 函数                          | 含义                                        |
| ------- | ----- | ----------------------------- | ------------------------------------------- |
| 308.5ms | 31.2% | `wrapSafe @ loader:1720`      | **V8 编译 15.6MB CJS bundle**               |
| 293.4ms | 29.7% | `(anonymous) @ acode.cjs:4`   | **bundle 顶层模块求值**（所有子系统初始化） |
| 44.3ms  | 4.5%  | `(garbage collector)`         | 启动期 GC                                   |
| 34.5ms  | 3.5%  | `P$n @ acode.cjs:4`           | bundle 内部（zod/初始化）                   |
| ~31ms   | 3.2%  | `readFileUtf8`/`readFileSync` | 从磁盘读 bundle                             |
| 12.8ms  | 1.3%  | `compileForInternalLoader`    | node 内置模块编译                           |

**结论：启动 ~60% = 编译（31%）+ 顶层求值（30%）这个单文件 bundle。** 字节码消掉编译那一半（wrapSafe），这正解释了 D 的 -469ms；剩下的顶层求值（~293ms）只能靠惰性 import / 代码分割削减（不加载用不到的子系统）。

## 4. 热路径微基准（每次操作）

### 4.1 bash 命令 AST 分析 `assessBashCommandTargetRisk`（每 bash 工具调用 1 次）

| 命令形态                                 | 耗时      |
| ---------------------------------------- | --------- |
| `pnpm typecheck` / `npm run dev:desktop` | 4.5~5.2µs |
| `git status` / `grep -rn ...`            | 6.5~6.6µs |
| `node build.mjs --flag`                  | 5.6µs     |
| `cat \| grep \| wc`（管道）              | 8.9µs     |
| `cd && build && run`（复合）             | 15.2µs    |
| 20 条 `&&` 链                            | 44.8µs    |

→ **可忽略**。即使 20 命令链也仅 45µs，且每工具调用只跑一次。**确认 J1 爆炸半径分类器不是性能拖累**——安全工作性能中性。

### 4.2 压缩 token 估算 `estimateMessageTokens`（每 model step 跑 2~4 次全量，O(transcript)）

| transcript 规模 | JSON 体积 | 单次耗时 |
| --------------- | --------- | -------- |
| 20 msg × 1KB    | 33KB      | 10.0µs   |
| 100 msg × 2KB   | 309KB     | 75.5µs   |
| 300 msg × 3KB   | 1356KB    | 329.1µs  |
| 600 msg × 4KB   | 3569KB    | 820.9µs  |

→ **随 transcript 线性增长**。900KB 会话 ×3 次/step ≈ 1ms/step；2.4MB 会话 ×3 ≈ 2.5ms/step。相对 LLM 秒级延迟仍小，但它是**每 step 的固定税且无上限增长**，且每次 join 分配新字符串。

### 4.3 v4 帧序列化（每出站帧；continuous 30ms / replayable 150ms 窗口合并）

| 帧规模         | `utf8JsonByteLength`(计量) | 裸 `JSON.stringify`(写出) | **双 stringify(真实总成本)** |
| -------------- | -------------------------- | ------------------------- | ---------------------------- |
| ~200B          | 1.0µs                      | 0.3µs                     | 1.0µs                        |
| ~2KB delta     | 2.5µs                      | 1.2µs                     | 3.4µs                        |
| ~8KB(4 rows)   | 6.8µs                      | 4.0µs                     | 10.5µs                       |
| ~64KB(32 rows) | 64.8µs                     | 30.4µs                    | 95.9µs                       |

→ **计量使帧序列化成本翻倍~3×**。`wire-codec.utf8JsonByteLength` 做 `TextEncoder(JSON.stringify(x))`，`transport.send` 又 `JSON.stringify(x)` 一次——同一帧 stringify 两遍。稳态下（~33 帧/s × 3.4µs）可忽略，但大帧突发（工具输出/文件读取）时每帧多付 ~65µs，且是**纯浪费**（可合并为一次）。

## 5. 长会话 GC 合成负载

模拟每-step 本地核算（token 估算 ×3 + context-usage 等价 stringify ×2）作用于随 step 增长的 transcript：

| 场景            | steps | 每-step 核算 median/p95/max | 退化(前10步→后10步)    | GC 暂停  | 堆 used/peak     |
| --------------- | ----- | --------------------------- | ---------------------- | -------- | ---------------- |
| 200 msg × 1.5KB | 90    | 0.37 / 0.58 / 3.36ms        | 0.25→0.55ms (**2.2×**) | **0 次** | ~50MB / 105MB    |
| 400 msg × 2.5KB | 190   | 0.57 / 1.13 / 1.83ms        | 0.15→1.24ms (**8.0×**) | **0 次** | ~40-68MB / 106MB |

**反直觉但重要的结论：**

- **零 GC 暂停、堆稳定无泄漏**：本地核算的分配都是短命 young-gen 对象，V8 scavenger 廉价回收，堆稳定在 ~50MB used / 105MB total。**"越跑越卡"不是 GC 问题。**
- **真问题是线性 CPU 重算**：每-step 本地核算墙钟随会话长度**线性退化 8×**（400 消息时 1.24ms/step）。我的模型只含 5 个操作；真实管线还多 5 次对象图拷贝 + media 投影 + AI SDK 转换 + HTTP body stringify + rollout，**真实每-step 本地开销在 400 消息时估计 3~4ms/step**，且随会话无上界增长。

## 6. 每轮上下文装配静态分析（Explore 只读，file:line 证据见交接）

单个 model step 的固定本地开销：

- **~5 次全量 transcript 对象图拷贝**：microcompact 检查投影+克隆、microcompact 内部再克隆、autocompact 检查投影、真实请求投影、`toAiSdkMessages` 格式转换。
- **4~6 次全量字符级序列化**：token 估算 ×2+（join 文本副本 + toolCall `JSON.stringify`）、context-usage `stringifyForEstimation` ×2、HTTP body、rollout 记录。
- **每 turn 额外**：`rebuildContextPrefix` → `replaceMessages` 全量深克隆 + 系统提示重新 join。
- **stdio**：NDJSON 整帧 stringify；v4 帧 ≥2 次 stringify（计量+写出）；批量窗口 continuous 30ms / replayable 150ms。
- **持久化**：SQLite 行级 upsert（**非全量重写**）——健康，无泄漏。
- **大字符串**：逐 block 克隆只复制对象壳，字符串按引用共享（**不复制字节**）——健康；真正翻倍的是 JSON.stringify 类操作。

## 7. 候选杠杆（按证据强度排序）

| #      | 杠杆                                    | 证据                                                                                       | 预期收益                                 | 成本/风险                                                                                                                                               |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | **生产桌面默认开启字节码**              | D vs C 就绪 -44%（1073→604ms）；cpu-prof 编译占 31%；钩子+构建链已存在                     | 启动 -469ms                              | +39MB RSS、+36MB 磁盘/构建；**字节码严格绑定 Electron 版本，升级 Electron 不重编 .jsc 会硬失败**（加载器无静默回退）→ 发布链必须在 Electron bump 时重编 |
| **L2** | **bundle 惰性 import / 代码分割**       | cpu-prof 顶层求值 293ms(30%)；main.ts 已惰性 import run.js，但 bundle 内子系统全静态求值   | 启动再 -100~250ms（削减顶层求值）        | 需把 dynamic-workflow-runtime/playwright/doctor/browser-control/computer-use 改动态 import；勿破坏 plugin-host 隔离（main.ts:60 已处理）；中风险        |
| **L3** | **合并帧计量与写出 stringify**          | 4.3：双 stringify 使帧成本翻倍~3×；`utf8JsonByteLength`+`transport.send` 各 stringify 一次 | 每帧序列化减半；大帧突发 -65µs/帧        | 改 `transport.ts`+`wire-codec.ts`：stringify 一次→测 byteLength→写出；低风险，纯局部                                                                    |
| **L4** | **token 估算增量/缓存**                 | 4.2+5：O(transcript)×2-4/step，长会话退化 8×；usage-anchor 路径(compact.ts:325)已增量      | 消除每-step 线性税（长会话 -1~3ms/step） | 缓存逐消息 token（消息创建后不可变），只重算尾部；**必须保持 J1-3 压缩不变量语义**，内容变更时失效；中风险                                              |
| **L5** | **削减每-step transcript 拷贝（5→少）** | 6：micro/auto/real-request 各全量投影+克隆                                                 | 每-step 对象图拷贝 -2~3 次               | 共享一份投影 / 结构共享；触及 turn-loop 正确性，**高风险，最低优先**                                                                                    |

## 8. 非杠杆（实测确认无问题，勿动）

- **bash AST（J1 爆炸半径）**：4.5~45µs/调用，性能中性。安全加固不以速度为代价。✓
- **GC 暂停**：长会话本地核算零 GC 暂停、堆稳定无泄漏。无 GC 问题可修。✓
- **SQLite 持久化**：行级 upsert，非全量重写。✓

## 9. 诚实的局限

- 本轮**未测真实 LLM 轮次**（不触真实 provider/账号）：每-step 本地核算是合成负载模型，真实管线开销估计为模型的 2~3×，但未经端到端实测。
- **未测 host 进程 RSS**：只测了 agent。总占用需 main+renderer+host+agent 一起看，host 跑满 local services，其常驻成本未量化。
- **未测多窗口/多 workspace 倍增效应**。
- cpu-prof 在 minified bundle 上，部分函数名被 mangle（`P$n`/`zSa` 等），但 `wrapSafe`/顶层求值/GC 三个大头清晰可辨。
- 系统 node(25.8.2) 与 Electron 内嵌 node(24.14.0) 版本不同；形态 B 的绝对值不代表 SEA（SEA 用下载的 node 24.x，更接近 C 的运行时）。

## 10. 建议的下一步（基线时的初判，已被 §11 深读修订）

> ⚠️ 本节是基线剖析时的初步排序，**深读实现面后有重大修订**（见 §11）：L1 不是「改动最小」而是
> 发布链项目（生产打包链原本完全无字节码路径 + 跨平台绑定风险）；L3 不是「纯局部低风险」而是
> 跨层 plumbing 且稳态价值边际；L4 的安全赢面比设想窄（join 对单块消息近零分配）。以 §11 为准。

立项时按 AGENTS.md：先补 spec（产品规则/状态所有者/接口/验收场景），再实现，再走完整门禁（root typecheck、逐包 tsc、lint、arch、CLI 全量测试）+ 对抗复核 + 封印扫描 + docs 分支 squash 合入。

## 11. 实施状态与修订评估（2026-10-01）

深读三个杠杆的真实实现面后，风险/价值排序与基线初判有显著出入。最终实施 **L1 + L4**，
**L3/L2/L5 deferred**。修订理由与落地形态如下。

### 已实施

**L1 字节码生产启用**（spec: `packages/desktop/specs/agent-bytecode-production.md`）——真正的大头（-44% 就绪）。
- 深读发现：生产打包链**原本完全不构建/不消费字节码**（`resolveElectronRuntimeACodeAgentCommand`
  读纯 JS `acode.cjs`），字节码只在 dev/源码树分支被 env 门控消费。基线「钩子已在仓库」只对 dev 成立。
- CI 发布是**原生分平台构建**（release.yml matrix，host==target），故打包时用宿主 Electron 编 .jsc 对目标平台正确，跨平台失配在真实发布路径不存在（交叉编译守卫仍留作本地安全网）。
- **安全设计 pivot**：实现期先做了 host 侧指纹 sidecar 预检，实测 `cachedDataVersionTag` 依赖 V8 标志
  （编译/加载侧设 `--no-lazy --no-flush-bytecode`），host 进程无法在不自我污染下复现 agent 进程的 tag
  （sidecar 2612863252 vs host 无标志 2288858847，**永远失配**）→ 预检不可靠，预检过但 loader 硬失败仍是 P0。
  **改为权威校验放 agent 进程内的 loader**：resolver 只在「loader 存在则优先 + 设 `ACODE_BYTECODE_FALLBACK=1`」，
  loader 在字节码失配/损坏时 `require` 同目录 `acode.cjs` 优雅回退。host 不预测、不设标志、零 P0。
- 落地：shared 仅加入口常量；services resolver **兄弟派生**（`dirname(bundlePath)/acode.bytecode.cjs` + existsSync，不走会下沉用户可写目录的独立候选链）+ 回退 env；loader 模板加回退分支；构建链编译（跨平台守卫 + 编译后 platform/arch 断言 + 非致命）+ meta sidecar + 陈旧清理；staging **meta 驱动校验**（新鲜度 sourceSha256 + 依赖闭环 + coverage 跳过）后精确携带 loader/.jsc/runtime。
- **两轮对抗复核**（新鲜上下文只读攻击者 + 真实 Electron 探针）：第 1 轮证出 F1(P0 同步 require 在 .catch 外，runtime 缺失硬崩)、F2(High .jsc 与 acode.cjs 无新鲜度绑定，陈旧字节码静默取代新码 + coverage 归零)、F3(High 独立候选链下沉用户可写目录可被劫持)、F4a/b(二次执行 + 回退零可观测)、F5/F6/F7(Low)；L4 证出 M1(契约外畸形 text 产 NaN)。修复轮全部闭合。第 2 轮验证 F1-F7/M1 全闭合，又证出 **N1**(loadBytecode 先设 V8 flags 再校验 → 失配回退的 acode.cjs 带 eager-compile 污染 +20~25%，证伪「最坏=回退无损」)、N2(spec 滞后)。N1 已修（无需 flags 的稳定字段+digest 校验前置，最常见回退场景零污染）、N2 已同步。
- 验证：loader 回退单测 7 + staging 单测 7 + L4 等价 5 全绿；CLI 全量 666/666；**真实 Electron 端到端**——有效字节码加载（version exit 0，~521ms vs JS ~1000ms ≈ -48%）、损坏 .jsc/runtime 缺失 + 回退 env → 干净回退 acode.cjs（exit 0，N1 后 median 1024ms ≈ 基线 987ms 无污染税）、无 env → 硬失败 exit 1、F4a 已执行标记 → 不二次执行。
- 发布清单跟进（本环境无法跑真实跨平台 electron-builder 发布构建）：CI 各 runner 编出 .jsc 并 staged、安装包走字节码入口且就绪下降、包体限额、Electron bump 时强制重编 .jsc（双 pin 无机械保障，失配则干净回退 JS）。

**L4 token 估算 length-based 投影**（spec: `apps/acode-cli/specs/token-estimate-perf.md`）——安全小赢面。
- 深读发现：跨调用 memoization 难安全做（消息被 clone+变异，无稳定身份作缓存键，stale 会破 J1-3 估算精确性）；
  且 `join("\n\n")` 对**单文本块消息在 V8 里近零分配**（单元素 join 返回原串），故 length-based 投影只对多块（reasoning+text）消息有 modest 收益。
- 落地：`projectMessageContentForTokenEstimate` 返回 `textLength`（累加 `Σlen + 2×(partCount−1)`）替代 join 全文分配，**可证明输出逐位不变**。
- 验证：等价守卫测试（逐消息 + 整段 + 多块 + 媒体 + toolCalls + 边界）与 join-based 参考实现逐位相同；既有 compact-invariants（I1-I5）全绿。

### Deferred（修订理由）

- **L3 合并帧计量与写出 stringify**：基线判「纯局部低风险」**有误**。深读 `wire-codec.ts` + v4 打帧链：
  计量（`utf8JsonByteLength`，gateway 层）与写出（`transport.send`，transport 层）**跨层**，合并需把预序列化
  envelope 从 gateway plumb 到 transport，触碰分帧/checksum/delivery 正确性（协议损坏 = 桌面↔agent 通信断 = P0）。
  而稳态收益边际（~33 帧/s × ~2µs，仅大帧突发省 ~65µs/帧）。**风险/收益不划算，deferred。**
- **L2 bundle 惰性 import / 代码分割**：cpu-prof 顶层求值 293ms 是真，但削它需把 workflow/playwright/doctor/
  browser-control/computer-use 改动态 import，**架构性改动、收益不确定、难在不跑真实打包下验证**，且勿破坏
  plugin-host 隔离（main.ts:60 已处理）。需独立 profiling + 设计，**deferred。**
- **L5 削减每-step transcript 拷贝（5→少）**：触碰 turn-loop 投影正确性（micro/auto/real-request 共享投影的结构
  共享），**高风险**，需独立立项 + 强对抗复核，**deferred。**

### 非杠杆（实测确认无问题，勿动）

bash AST（J1 爆炸半径，4.5~45µs，性能中性）、GC 暂停（长会话零暂停、堆稳定无泄漏）、SQLite 持久化（行级 upsert 非全量重写）。
