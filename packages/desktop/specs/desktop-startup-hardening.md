# 桌面启动硬化 + 深链/argv 入口硬化（T1-s2 / T2-m4 / T2-m7④）

- 状态：本批实施（分支 `feature/value-extract-23737-r2`）
- 范围：`packages/desktop` main 进程的启动段与深链/argv 入口面。
- 关联：`specs/electron-hardening.md`（P2 壳层加固，本 spec 是其启动段延伸）。
- 机制来源：对上游发行版启动段的还原复核（拒启表/归一化、env 清洗、三段签名令牌、
  argv 字节预算与 UTF-8 感知截断、second-instance 去重、盘符相对拒绝、UNC hop 断言、
  toast 限频与安全 URL 渲染、一行卫生件）。文案与命名全部自撰，不含上游厂商代号。

本 spec 是行为变更的前置规则来源；实现里的中文注释引用本文小节。

---

## 0. 模块地图与状态所有权

| 模块 | 职责 | 状态所有权 |
| --- | --- | --- |
| `src/main/debugTokenGate.ts` | 签名短时调试令牌的校验纯函数 + 启动期一次性决策（memoized） | 令牌决策唯一所有者 |
| `src/main/bootSwitchDenylist.ts` | 16 个调试/网络覆写类 Chromium 开关的归一化、匹配、拒启决策与执行 | 拒启决策唯一所有者 |
| `src/main/startupSanitation.ts` | 一行卫生件（§5）+ 打包态 boot env 清洗单一漏斗（§2），import 副作用即执行 | boot env 清洗唯一漏斗 |
| `src/main/argvBudget.ts` | argv 字节预算、UTF-8 感知截断、防循环 relaunch 决策（§4a） | 预算决策唯一所有者 |
| `src/main/deepLinkHardening.ts` | second-instance 500ms 去重、盘符相对拒绝、UNC hop 断言、失败 toast 限频与分类、日志安全 URL 渲染（§4b–4f） | 各判定纯函数的唯一所有者 |
| `src/main/desktopRuntimeEnv.ts` | 既有身份/env 解析；本批仅接入 §2 漏斗（import 副作用）并透出决策 | 身份常量唯一所有者（不变） |
| `src/main/desktopSecondInstanceDeepLink.ts` | second-instance 请求处理；本批接入去重与路径安检 | 不变 |
| `src/main/desktopDeepLinkUrl.ts` | 深链解析；本批在 `--open-workspace` 提取层拒绝盘符相对路径 | 不变 |
| `scripts/issue-debug-token.mjs` | 本地开发用令牌签发 + 密钥对生成工具（私钥永不入仓库） | 无运行时状态 |

漏斗时序约束：`startupSanitation.ts` 只允许 import `electron`（app.isPackaged）、
`node:*` 与同批新模块，**不得** import `@acode/services`（其 `paths.ts` 在模块加载期
缓存 `ACODE_DATA_BASE_DIR`/`HOME`）。这样当它被接成 `index.ts` 第一行 import 时，
清洗发生在任何 services 模块加载之前，`ACODE_DATA_BASE_DIR` 的删除才真正生效；
未接第一行时漏斗仍会经 `desktopRuntimeEnv.ts` 的 import 触发，只是该键已被
`paths.ts` 抢先缓存（删除无害但无效，见「接线需求」与「未尽事项」）。

---

## 1. argv 开关拒启表（T1-s2①）

### 规则

16 个调试/网络覆写类 Chromium 开关（闭集，`DENIED_BOOT_SWITCHES`）：

```
remote-debugging-port, remote-debugging-pipe, ignore-certificate-errors,
host-resolver-rules, host-rules, disable-web-security, log-net-log,
net-log-capture-mode, ssl-key-log-file, renderer-cmd-prefix,
utility-cmd-prefix, gpu-launcher, zygote-cmd-prefix, ppapi-plugin-launcher,
nacl-loader-cmd-prefix, browser-subprocess-path
```

（命名以还原证据中的真实 Chromium 开关名为准；需求转述里的 `ppapi-loader-cmd-prefix`
在 Chromium 中不存在，对应物是 `ppapi-plugin-launcher`，已在报告中注明该偏离。）

匹配前归一化 `normalizeBootSwitchArg(arg)`：去掉一个前导 `--` / `-` / `/` 前缀 →
小写 → 截断第一个 `=` 及其后内容。命中判定为 `startsWith`（与证据一致）：
`--remote-debugging-port=0` 与裸 `remote-debugging-pipe` 都命中。

决策矩阵 `resolveBootSwitchDenylistDecision({ argv, isPackaged, tokenValid })`：

| 形态 | 命中 | 动作 |
| --- | --- | --- |
| dev（未打包） | 是 | `allow-with-warning`：放行但 warn（e2e-smoke 依赖 `--remote-debugging-port=0`，不得破坏） |
| dev（未打包） | 否 | `allow` |
| 打包 + 有效签名调试令牌（§3） | 是 | `allow-with-warning`：持令牌的受控调试放行（证据中拒启条件为 `命中 && !令牌有效`） |
| 打包 + 无有效令牌 | 是 | `refuse`：stderr 写拒绝原因（自撰文案，语义=「检测到调试或网络覆写开关，拒绝启动」，附命中的归一化开关名，不附开关值）+ `process.exit(1)`；stderr 用 `fs.writeSync(2, …)` 直写并 try/catch（此时 logger 可能未就绪） |
| 打包 | 否 | `allow` |

执行器 `enforceBootSwitchDenylist()` 在 §2 漏斗内自动运行（startupSanitation import
副作用）；dev 态 warn 走 `console.warn`（try/catch 防 EPIPE），打包态命中名单只落
stderr 拒绝文案与决策对象（键名级，不落值）。

### 验收

1. 打包态 argv 含 16 项任一（任意前缀形态/大小写/带 `=` 值）→ stderr 出现拒绝原因且退出码 1。
2. dev 态同样 argv → 放行 + warn。
3. 打包态 + 有效令牌 → 放行 + warn。
4. 归一化：`/HOST-RULES=x`、`--Remote-Debugging-Port=0`、`-gpu-launcher` 全部命中。

---

## 2. 打包态 boot env 清洗单一漏斗（T1-s2② + ③ 的门控升级）

### 规则

`sanitizePackagedBootEnvironment()`（startupSanitation.ts，memoized，进程内只跑一次）：

- **dev（未打包）**：不做任何删除——现有 `ACODE_ENV=test` env 门控、e2e-smoke、
  dev 脚本行为完全不变（兼容约束）。
- **打包 + 有效令牌（§3）**：不做任何删除——受控调试/E2E 保留 TLS key log 与身份覆写能力。
- **打包 + 无有效令牌**：从 `process.env` 原地删除以下闭集键（`PACKAGED_BOOT_ENV_DROP_KEYS`）：
  1. `SSLKEYLOGFILE`、`sslkeylogfile`（大小写双拼；Chromium/NSS 会把全部 TLS 会话密钥落盘）；
  2. 运行时「自称测试」键：`ACODE_ENV`、`ACODE_E2E_RUN_ID`、`ACODE_E2E_COVERAGE`、
     `ACODE_E2E_ARTIFACT_DIR`、`ACODE_E2E_RUNTIME_LOG_DIR`；
  3. 身份/数据目录覆写键：`ACODE_DESKTOP_USER_DATA_DIR`、`ACODE_DESKTOP_HOME_DIR`、
     `ACODE_DESKTOP_SESSION_DATA_DIR`、`ACODE_DESKTOP_APPLICATION_NAME`、
     `ACODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA`、`ACODE_DATA_BASE_DIR`。

诊断：记录被忽略的**键名**列表（`getBootEnvironmentDecision().ignoredEnvKeys`），
**绝不记录值**；同时经 `console.warn`（try/catch）输出一行键名摘要。决策对象常驻
模块内供后续诊断读取（对齐证据的 globalThis ignored 记录，但收敛为模块导出，单一所有者）。

### 门控升级语义（T1-s2③ 的用途）

现有 E2E/test hook 全部是「env 说是测试就是测试」：`logger.ts` 的
`process.env.ACODE_ENV === "test"` 日志目录改写、`index.ts` 的 `ACODE_E2E_RUN_ID`
覆盖率 flush、`e2eCoverage.ts` 的 `ACODE_E2E_COVERAGE`/`ACODE_E2E_ARTIFACT_DIR`、
以及身份覆写键。本漏斗把这些键在「打包 + 无令牌」态整体删除后，**每个消费点的既有
env 判定自然失效**——不需要逐个改消费点，即完成「打包态必须持有效令牌才是测试」的
升级；dev/未打包态键保留，既有 e2e 脚本零改动。`ACODE_ENV` 的编译期 define
（`__ACODE_ENV__`）不受运行时删除影响；host 进程的 `ACODE_ENV` 由
`buildHostProcessEnv` 显式下发编译期值，同样不受影响。

`ACODE_DATA_BASE_DIR`/`ACODE_DESKTOP_HOME_DIR` 存在加载期缓存时序依赖，见 §0 漏斗
时序约束与「接线需求」第 1 条。

### 验收

1. 打包态（stub `app.isPackaged=true`）+ 无令牌：闭集键全部被删，`ignoredEnvKeys` 只含键名。
2. 打包态 + 有效令牌：一个键都不删。
3. 未打包：一个键都不删（`ACODE_ENV=test` 等原样保留）。
4. 漏斗幂等：重复调用不重复记录。

---

## 3. 签名短时调试令牌（T1-s2③）

### 格式

`<unix毫秒>.<base64url(userDataPath)>.<base64url(ed25519签名)>`，签名对象为前两段
`<unix毫秒>.<base64url(userDataPath)>` 的 UTF-8 字节。令牌经环境变量
`ACODE_DEBUG_TOKEN` 传入（boot 早期 argv 尚未可信解析，env 是既有注入面）。

### 校验规则（`verifySignedDebugToken`，纯函数，闭集失败原因）

按序校验，任一失败返回闭集原因并 warn 一条（原因码入日志，令牌与路径值不入日志）：

1. 恰好 3 个 `.` 分段，否则 `malformed`；时间戳段必须是有限整数，否则 `malformed`。
2. payload 段 base64url 解码后 **=== 期望 userDataPath**，否则 `path_mismatch`。
   期望路径 = `ACODE_DESKTOP_USER_DATA_DIR` 覆写值：令牌必须与身份覆写键**成对**出现
   （证据同构：payload 对齐 user-data-dir env）。打包生产用户不会设置该覆写，因此
   令牌在生产身份下天然不可用；打包 E2E 由 harness 建临时目录后按同一路径签发。
   有令牌但无覆写键 → `path_mismatch`。路径比较为精确字符串比较（签发方使用同一字符串）。
3. 年龄 = now − 时间戳：`年龄 > 300_000ms` 为过期；时钟 skew 容忍 60s——
   `年龄 < −60_000ms`（签发钟快超过 1 分钟）同样按 `expired` 拒绝。
4. 对内嵌 ed25519 公钥（SPKI DER base64，`EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS` 数组，
   支持轮换期双钥）验签；验签抛错或返回 false → `invalid_signature`。加载公钥时校验
   `asymmetricKeyType === "ed25519"`，非 ed25519 键直接视为不可用。

失败原因闭集：`malformed | path_mismatch | expired | invalid_signature`
（「无令牌」不是失败原因，不 warn；`DebugTokenRejectionReason` 类型钉死闭集）。

### 密钥管理

- 公钥内嵌 `debugTokenGate.ts`（本批生成的密钥对，公钥见源码常量）。
- 私钥**永不入仓库**：保存于开发机 `~/.acode/dev/acode-debug-token-signing-key.pem`
  （0600）。`scripts/issue-debug-token.mjs` 支持 `--generate-keypair`（重新生成私钥并
  打印待内嵌的公钥 base64——更换密钥对必须同步改源码常量并重新发版）与签发
  （`--user-data-dir <path> [--ttl-ms n] [--private-key <pem>]`，默认私钥路径可用
  `ACODE_DEBUG_TOKEN_SIGNING_KEY_FILE` 覆写）。签发时时间戳取当前时间，令牌 5 分钟内有效。

### 验收

1. 测试内生成临时密钥对：有效令牌通过；4 类失败原因逐一命中（含 301s 过期、−61s 未来钟、
   payload 改一个字符、签名段翻转一个 bit）。
2. 年龄在 (−60s, 300s] 边界内的令牌通过。
3. 内嵌公钥常量可被 `createPublicKey` 加载且 `asymmetricKeyType === "ed25519"`。
4. 签发脚本 round-trip：`--generate-keypair` + 签发 + 用生成公钥校验通过。

---

## 4. 深链/argv 入口硬化簇（T2-m4）

### 4a. argv 字节预算 + 防循环 relaunch（argvBudget.ts）

- 预算 `DEEP_LINK_ARGV_BYTE_BUDGET = 26624`（Windows CreateProcess 32767 字符上限内
  的安全余量，与证据同值）；每参数字节成本 = `Buffer.byteLength(arg,"utf8") + 1`（NUL 分隔）。
- 可截断参数 = 小写后以深链前缀 `acode:`（由 `DEEP_LINK_SCHEME` 派生，单一事实源）开头的
  argv；其余参数（含 `--open-workspace` 路径值）**永不截断**——截断路径会改变语义。
- `capDeepLinkArgv(argv)`：总成本 ≤ 预算 → `null`（无需处理）；否则给深链参数的剩余预算 =
  预算 − 非深链参数成本，逐个深链参数装不下时做 **UTF-8 续字节感知截断**
  （`truncateUtf8Arg`：从截断点回退跳过 `(b & 0xC0) === 0x80` 的续字节，绝不切开多字节
  字符）+ **尾部残缺 percent-escape 剥除**（`/%[0-9a-fA-F]?$/`，截断可能留下 `%4` 这类
  半个转义，会让下游 `decodeURIComponent` 抛错）；截断后不再以深链前缀开头（截没了）则整参
  丢弃。截断后总成本仍 > 预算 → `null`（uncappable，不 relaunch，照常启动 + warn）。
- `maybeRelaunchWithCappedDeepLinkArgv({ argv, relaunch, exit, warn })`：
  argv 已含防循环标志 `--acode-relaunched-after-deep-link-cap` → 直接放行（`already-relaunched`，
  绝不二次 relaunch）；否则 cap 命中 → `relaunch({ args: [...capped, 防循环标志] })` +
  `exit(0)`，返回 `relaunched: true`（调用方立即停止后续启动逻辑）。

### 4b. second-instance 500ms 同键去重（deepLinkHardening.ts）

`createSecondInstanceArgvDedupe({ windowMs = 500, now })`：键 =
`[...argv, workingDirectory ?? ""].join("\0")`；单槽记忆（上一次键 + 时间戳），
同键且间隔 < 500ms → 判定重复。桌面环境/协议处理器可能对同一次深链点击连发多次
second-instance（证据与 ACode Linux argv 重排注释同源），重复事件整体抑制（含窗口聚焦），
只留一条 info 日志。

### 4c. 盘符相对路径显式拒绝

`isDriveRelativeWindowsPath(value)`：`/^[a-zA-Z]:(?![\\/])/`（`C:foo` 形态）。Windows 上
盘符相对路径按「该盘的每 drive CWD」解析，是外部输入注入进程 CWD 语义的面。拒绝点：
1. `desktopDeepLinkUrl.ts` 的 `extractOpenWorkspacePathFromArgs` 提取层直接跳过此类值
   （覆盖 startup argv、second-instance argv、additionalData 三条入口）；
2. `inspectDeepLinkWorkspacePath`（4d）对直接调用方返回 `drive_relative` 闭集原因。

### 4d. 深链路径 UNC hop 断言（防 SMB NTLM 凭据外泄）

`inspectDeepLinkWorkspacePath(path)`（同步，深链处理链是同步投递）返回
`{ ok: true } | { ok: false, reason }`，reason 闭集：
`drive_relative | unsafe_unc | unsafe_device_path | unc_hop | unverifiable`
（`unverifiable` = lstat/readlink 无法验证或 symlink hop 超限，fail-closed 拒绝）。

规则（对齐证据的 shape-check-then-walk，绝不先触网）：

1. 原始形状：UNC（`\\host\share`、`//host/share`、`\\?\UNC\…`，复用既有
   `isNetworkWorkspacePath` 谓词，单一事实源）→ `unsafe_unc`；Windows 设备命名空间
   （`\\?\`、`\\.\`、`\??\`、`\Device\` 前缀，可编码 UNC 或绕过形状检查）→
   `unsafe_device_path`；盘符相对 → `drive_relative`。
2. 符号链接 hop 行走：从根开始逐段 `lstatSync`（**lstat 不跟随链接，本地段安全**）；
   遇 symlink → `readlinkSync` 取**链接文本**（不触目标）→ 目标文本形状命中
   UNC/设备命名空间 → `unc_hop`（在对其做任何 stat 之前拒绝——对 `\\remote\share`
   的任何 stat 都会触发 SMB 认证外泄 NTLM hash）；否则解析目标继续行走。hop 上限 40
   （证据同值），超限按 `unverifiable` 拒绝（fail-closed，深链输入不该有深链接链）。
   行走中 ENOENT/ENOTDIR → `{ ok: true }` 交回下游既有存在性校验（missing 语义不变）。
   链接目标为 `\\?\UNC\…` 时先还原为 `\\host\share` 形态再分类拒绝；`\\?\<本地绝对路径>`
   （Windows 目录 junction 的常见 readlink 形态）去掉命名空间前缀后按本地路径继续——
   这是对证据的显式适配偏离（证据拒绝一切 `\\?\` 链接目标；Windows 工作区中 junction
   常见，照搬会误拒合法本地路径造成真实回归），安全目标不变：UNC/设备形态永不触网。
3. WSL UNC（`\\wsl$\…`）不做豁免：与现状 `isNetworkWorkspacePath` 一致整体拒绝；
   WSL 工作区经 remote target 解析链（desktopWslTargetResolver）进入，不走本地深链路径。

接线位点：`desktopSecondInstanceDeepLink.ts`（本批已接）；`open-url` / 冷启动
startup gate 的等价接入见「接线需求」（`startupWorkspaceDeepLinkGate.ts` 与
`desktopOAuthDeepLink.ts` 不在本批所有权内）。

### 4e. 深链失败 toast：(键,类别) 5 分钟限频 + 闭集分类 + 本地化文案

- `classifyDeepLinkFailureCategory(message)`：错误子串表 → 闭集类别
  `auth_expired | network | missing | other`（子串表集中在一个常量里，首中即归）。
- `createDeepLinkFailureToastGate({ windowMs = 300_000, now })`：双账本（证据同构）——
  键级账本产出 `isRepeat`（遥测/日志用，每次都记录）；`(键,类别)` 级账本产出
  `showToast`：窗口内同 (键,类别) 抑制 toast，5 分钟后放行；每次判定顺带清理过期条目。
  键 = 失败深链的稳定标识（如 state/workspace path 的派生键，由接线方给）。
- `resolveDeepLinkFailureToastCopy(category, locale)`：zh-CN / en-US 自撰文案
  （main 进程无 i18n runtime，沿用 `resolveExternalWorkspaceOpenDialogCopy` 的
  locale 分支模式）。UI locales 需要的键名见「locale 键需求」（本批禁改 ui locales，
  main 侧文案为过渡形态）。
- toast 展示由接线方经 Electron `Notification` 触发（深链失败目前只有 warn 日志，
  展示面接线见报告；本批交付机制 + 限频/分类/文案纯函数）。

### 4f. 日志安全 URL 渲染

`renderSafeUrlForLog(value)`：解析成功 → `protocol//host/首段路径`，query → `?…`、
hash → `#…`（OAuth code/state、支付回调参数全在 query，必须遮断）；解析失败 →
`(unparseable)`（不把原始垃圾串写日志）。消费点：本批在
`desktopSecondInstanceDeepLink.ts` 的 warn 中使用；`desktopOAuthDeepLink.ts:229`
（`无法解析 URL:` 后跟原始 url）等替换点见「接线需求」。

### 验收

1. 预算：26624B 内不动；超预算深链被截断后总成本 ≤ 预算；多字节字符不被切半；
   尾部 `%4`/`%E` 被剥除；非深链参数原样；uncappable → null + warn。
2. relaunch：命中 cap → `relaunch` 收到 `[...capped, 标志]` 且 `exit(0)`；argv 已含标志 → 不再 relaunch。
3. 去重：同 argv+cwd 500ms 内第二次 → 重复；501ms 后 → 不重复；cwd 不同 → 不重复。
4. 盘符相对：`C:foo` 拒绝；`C:\foo`、`C:/foo`、`c:` 后带盘符分隔的放行。
5. UNC 断言：`\\remote\share`、`//remote/share`、`\\?\UNC\remote\share`、`\\.\pipe\x`
   拒绝；指向 UNC 的符号链接在**不 stat 目标**的前提下以 `unc_hop` 拒绝；普通本地目录通过；
   不存在路径通过（交给下游 missing 语义）。
6. toast 限频：同 (键,类别) 5 分钟内第二次抑制；换类别放行；过期清理生效。
7. 安全 URL：query/hash 遮断、首段保留、不可解析 → `(unparseable)`。
8. second-instance 集成：重复 argv 整体抑制（返回 handled，不再触达 handleDeepLink/聚焦回退）。

---

## 5. 一行卫生件（T2-m7④）

`applyEarlyProcessHygiene()`（startupSanitation.ts，import 副作用，幂等）：

1. `process.env.NoDefaultCurrentDirectoryInExePath = "1"`（仅在未设置时写入）：
   Windows DLL 搜索序去掉「当前目录」，缓解 DLL 劫持；对本进程主要经由子进程继承
   生效，因此必须设在**最早入口模块**（接线需求第 1 条），越早越好。
2. `Error.stackTraceLimit = 20`：默认 10 帧在 main↔host↔agent 异步链里经常截不到
   真正的调用方，20 帧是证据同值折中。

EPIPE 吞掉已由 `logger.ts:32-64`（stream error + safeConsoleWrite 双层）实现，本批不动。

---

## 接线需求（index.ts 不在本批所有权内，以下为精确插入点）

1. **第一行 import（最早入口）**：`packages/desktop/src/main/index.ts` 第 1 行
   `import { installOfficialPlatformNetworkPolicy } …` **之前**插入：
   `import "./startupSanitation.js";`
   —— 卫生件、env 清洗漏斗、拒启表执行全部随 import 副作用生效；且必须先于任何
   `@acode/services` 导入（§0 时序约束，`ACODE_DATA_BASE_DIR` 的删除依赖它）。
   未接此行时三者仍会经 `desktopRuntimeEnv.ts` 的 import 触发（生效但时序较晚）。
2. **argv 预算 relaunch**：`index.ts` 第 764 行
   `const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);`
   **之前**（必须早于一切 `process.argv` 消费点与 `requestSingleInstanceLock`，第 1788 行）插入：
   ```ts
   const deepLinkArgvCap = maybeRelaunchWithCappedDeepLinkArgv({
     argv: process.argv,
     relaunch: (options) => app.relaunch(options),
     exit: (code) => app.exit(code),
     warn: (message) => logger.warn(`[argv-budget] ${message}`),
   });
   if (deepLinkArgvCap.relaunched) {
     throw new Error("relaunched after deep-link argv cap"); // 阻断后续模块级启动逻辑
   }
   ```
   （配套 import：`import { maybeRelaunchWithCappedDeepLinkArgv } from "./argvBudget.js";`。
   `app.exit(0)` 已让进程即刻退出，throw 只是防御性阻断同步余波。）
3. **second-instance 传 cwd**：`index.ts` 第 1792 行
   `app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {` 改为
   `(_event, argv, workingDirectory, additionalData)`，并在
   `handleSecondInstanceWorkspaceRequest({ … })` 参数对象里加 `workingDirectory,`
   （去重键 = argv + cwd）。
4. **open-url / 冷启动路径的 UNC hop 断言**：`index.ts` 第 1768 行
   `const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);` 之后插入：
   ```ts
   const inspection = workspacePath ? inspectDeepLinkWorkspacePath(workspacePath) : null;
   if (inspection && !inspection.ok) {
     logger.warn(`[deep-link] open-url 路径安检拒绝: ${inspection.reason}`);
     return;
   }
   ```
   以及 `startupWorkspaceDeepLinkGate.ts` 的 `resolveExplicitStartupWorkspaceBootstrap`
   在 `isNetworkWorkspacePath` 检查处替换为同一断言（该文件不在本批所有权内）。
5. **深链失败 toast 与安全 URL 渲染**：`desktopOAuthDeepLink.ts`（不在本批所有权内）
   各 `return false` 失败点接入 `classifyDeepLinkFailureCategory` +
   `createDeepLinkFailureToastGate` + `Notification`；第 229 行
   `logger.warn("[deep-link] 无法解析 URL:", url)` 的 `url` 换
   `renderSafeUrlForLog(url)`。
6. **boot 决策落日志**：`index.ts` logger 就绪后（如第 232 行 `const mainStallSampler = …`
   附近）插入：
   ```ts
   const bootDecision = getBootEnvironmentDecision();
   if (bootDecision.ignoredEnvKeys.length > 0) {
     logger.info(`[startup-sanitation] 打包态已忽略环境键: ${bootDecision.ignoredEnvKeys.join(",")}`);
   }
   if (bootDecision.deniedBootSwitches.length > 0) {
     logger.warn(`[startup-sanitation] 调试开关经签名令牌放行: ${bootDecision.deniedBootSwitches.join(",")}`);
   }
   ```

## locale 键需求（本批禁改 ui locales，仅登记）

深链失败 toast 文案迁入 UI i18n 时需要以下键（zh-CN/en-US 文案现内置于
`resolveDeepLinkFailureToastCopy`）：

- `desktop.deepLinkFailure.authExpired.title` / `desktop.deepLinkFailure.authExpired.body`
- `desktop.deepLinkFailure.network.title` / `desktop.deepLinkFailure.network.body`
- `desktop.deepLinkFailure.missing.title` / `desktop.deepLinkFailure.missing.body`
- `desktop.deepLinkFailure.other.title` / `desktop.deepLinkFailure.other.body`

## 未尽事项

1. `logger.ts:9`（`process.env.ACODE_ENV === "test"` 日志目录改写）与 `index.ts:1007`
   （`ACODE_E2E_RUN_ID` 覆盖率）本身不改——打包态由 §2 漏斗删键达成令牌门控；若未来
   出现「不经 desktopRuntimeEnv 的独立入口」，需在那侧显式调用漏斗。
2. `ACODE_DATA_BASE_DIR` 删除的实际生效依赖接线需求第 1 条（第一行 import）。
3. toast 展示面（Notification 调用）依赖接线需求第 5 条；本批交付限频/分类/文案机制。
4. 令牌期望路径绑定 `ACODE_DESKTOP_USER_DATA_DIR`（成对出现约束）；若未来打包 E2E 走
   Chromedriver 默认 user-data 模式（`ACODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA=1`），
   harness 需同时设置该覆写键并按同一路径签发令牌。
5. 拒启表命中名单的 telemetry 上报：本批只落 stderr/决策对象，遥测面随 T1-s4 端点注册表批次。
