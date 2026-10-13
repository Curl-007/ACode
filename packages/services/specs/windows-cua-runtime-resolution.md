# Windows CUA runtime 解析契约（windows-cua-runtime-resolution）

状态：已实施（记录既有行为，本文档不改行为）。守护测试：
`packages/services/tests/windowsCuaDevRuntimeResolution.test.mjs`（12 类 reason 全覆盖）、
`packages/services/tests/agent-command-env-gate.test.mjs`（R4 dev-root 门禁的场景 6/6b）。
被测源码：`packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts`（下文行号均以此文件当前源码为准）。

## 背景与威胁模型

`resolveWindowsCuaRuntime`（`:79-99`）是 Windows Computer Use 产品运行时的唯一解析边界。
它解析出 helper host 稍后会 **fork** 的 `entryPath`（JS）与 `addonPath`（原生 `.node`），
因此它的失败语义直接决定「哪段代码会被执行」。两条解析链共享同一稳定错误契约：

- **dev 链**（`resolveDevelopmentRuntime` `:101-151`）：由用户 env `ACODE_CUA_DEV_ROOT`（`:8`）
  显式指定开发根目录，最高优先级；配置错误一律 fail closed，**绝不悄悄回退到安装资源**（`:94-96`
  是无 `try/catch` 的裸 `return`，dev 链抛错时 `:98` 的 packaged 链不可达）。
- **packaged 链**（`resolvePackagedRuntime` `:168-233`）：只读取
  `resourcesPath/tools/cua-helper`（`PRODUCT_RUNTIME_SEGMENTS` `:12` + `resolve` `:188`），
  不搜索源码目录或 `node_modules`；额外做 SHA-256 完整性校验（dev 链无此步）。

威胁模型与 `agent-command-env-gate.md` R4 一致：dev-root 目录下的 JS 会被 helper host fork，
用户级 env 注入即可替换执行面。故打包态经统一谓词 `isPackagedACodeDesktopRuntime(env)`（`:94`）
忽略 dev-root env，落回 packaged 链；dev/独立 CLI/远程 server 无标记 → dev-root 照常生效。

失败一律抛 `WindowsCuaDevRuntimeResolutionError`（`:53-62`），带三个字段：`reason`
（12 类之一）、`message`（稳定字面量）、可选 `artifact`（稳定 artifact 标识）。
**reason 联合类型 `WindowsCuaDevRuntimeResolutionReason`（`:39-51`）未导出**，模块公开面只有
`WindowsCuaRuntime`（`:14`）、`WindowsCuaDevRuntimeResolutionError`（`:53`）、
`resolveWindowsCuaRuntime`（`:79`）三个符号；故守护测试用「已观测 reason 集合 === 12 个字面量集合」
的集合相等断言替代类型层穷尽性，不为此新增导出（属公开面改动且会被 `pnpm knip` 判未使用）。

## 产品规则

### R1 12 类 resolution reason 的语义与 throw 站点

| # | reason | throw 站点（当前源码行） | 触发语义 | `artifact` |
| --- | --- | --- | --- | --- |
| 1 | `unsupported-platform` | `:83-86` | `platform`（缺省 `process.platform`）非 `win32` | 无 |
| 2 | `development-root-not-absolute` | `:108-111` | dev root 既非宿主绝对路径（`isAbsolute`）也非 Windows 绝对路径（`windowsPath.isAbsolute`） | 无 |
| 3 | `development-root-not-found` | `:349-352`（`requireDevelopmentRuntimeRoot` 的 catch） | dev root 不存在/非目录/是 symlink/realpath 逃逸配置路径 | 无 |
| 4 | `invalid-package` | `:567-571`（`requireExpectedPackage`，catch 空 `:564-566`） | dev root 的 `package.json` 任一契约校验失败（**汇聚码**，见 R2） | `package.json` |
| 5 | `missing-helper-entry` | `throwMissingArtifact` `:450-454`，调用点 `:426`/`:432`/`:441`（`requireContainedRegularArtifact`）与 `:497`（`readRequiredArtifact` 的 catch） | entry artifact 不存在/非普通文件/IO 失败 | `entry` 相对路径 |
| 6 | `missing-native-addon` | 同 5 的站点（由 `missingReason` 参数区分） | addon artifact 不存在/非普通文件/IO 失败 | `addon` 相对路径 |
| 7 | `missing-resources-path` | `:176-179` | packaged 链无 `resourcesPath`（options 与 `process.resourcesPath` 皆空/空白） | 无 |
| 8 | `resources-path-not-absolute` | `:182-185` | `resourcesPath` 非宿主绝对路径 | 无 |
| 9 | `invalid-runtime-manifest` | `:257-261`（`readRuntimeManifest` 的 catch）**与** `:280-284`（`requirePackagedRuntimeRoot` 的 catch） | **跨语义复用**：manifest 文件问题 + packaged root 目录问题（见 R2） | `runtime-manifest.json` |
| 10 | `incompatible-runtime-manifest` | `:326-330`（`validateRuntimeManifest`） | manifest 键不精确/arch/electronVersion/sha256 形态/entry===addon 等任一不符 | `runtime-manifest.json` |
| 11 | `invalid-artifact-path` | `throwInvalidArtifactPath` `:506-510`，调用点 `:373`/`:386`（`resolveManifestArtifact`）与 `:429`/`:437`（`requireContainedRegularArtifact`） | artifact 路径非规范相对路径，或 realpath 逃逸 root，或是 symlink | `entry`/`addon` 字面量 |
| 12 | `artifact-integrity-mismatch` | `requireArtifactHash` `:519-523` | packaged 链 artifact 实际 sha256 ≠ manifest 声明值（**仅 packaged 可达**，见 R4） | `entry`/`addon` 字面量 |

dev 链可达 reason：1/2/3/4/5/6/11（无 7/8/9/10/12——那些是 packaged 链专属）。
packaged 链可达 reason：1/5/6/7/8/9/10/11/12（无 2/3/4——dev-root 专属）。

### R2 `invalid-package` 是汇聚码，`invalid-runtime-manifest` 跨语义复用

**`invalid-package`（`:567-571`）汇聚 ≥11 类互不相同的根因**：`requireExpectedPackage`
（`:526-572`）的 `catch`（`:564-566`）**是空的**（注释明写「解析和 I/O 失败共用稳定的 package
诊断，避免依赖底层错误文本」），下列根因全部映射到同一 reason，且错误对象**不携带任何区分信息**
（`artifact` 恒为 `package.json`）：

- `package.json` 文件缺失 / 是目录 / 是 symlink / realpath 逃逸 dev root（`:532-539`）；
- 内容非文本（`typeof contents !== "string"` `:541`）/ 非对象（`isPlainRecord` `:543`）；
- `name !== "@acode/acode-cua"`（`:546`）；
- `version` 非「非空且已 trim」字符串（`isNonEmptyTrimmedString` `:356-358`，故 `" 1.0.0 "` 也失败，`:547`）；
- `acodeCuaRuntime` 契约键不精确（`hasExactKeys(["schema","windows"])` `:549`；`schema !== 1` `:550`；
  `windows` 键不精确 `hasExactKeys(["entry","nativeAddon"])` `:552`）；
- `entry`/`nativeAddon` 非规范相对路径（`isCanonicalRelativeArtifactPath` **前置**调用 `:553-554`）；
- `entry === nativeAddon`（`:555`）。

**因此守护测试必须每个根因独立成一个 test case，不能参数化后只断一次码**——错误对象无法区分它们。

**`invalid-runtime-manifest`（`:9`）跨两种语义复用同一码**，会把运维引向错误的文件：

- **manifest 文件本身的问题**（`readRuntimeManifest` catch `:256-262`）：`runtime-manifest.json`
  不是普通文件/是 symlink（`:242`）、realpath 逃逸 root（`:246`）、非文本（`:250`）、
  `JSON.parse` 失败（`:251`）、解析结果非对象（`:252-254`）；
- **packaged root 目录的问题**（`requirePackagedRuntimeRoot` catch `:279-285`）：
  `tools/cua-helper` 目录不存在/非目录/是 symlink（`:271`）、realpath 逃逸（`:275`）。

两处 catch 抛出的 message 与 `artifact` 完全相同（`:259-260` 与 `:282-283`），
消费者无法从错误区分「manifest 文件坏了」还是「packaged root 目录坏了」。

### R3 dev/packaged 错误码不对称的根因（同一逻辑错误报不同码）

同一 artifact 路径违规，在两条链报**不同的码**：

| 违规 | dev 链期望码 | packaged 链期望码 | 根因 |
| --- | --- | --- | --- |
| `entry`/`addon` 含 `..` / 反斜杠 / 绝对路径 / ADS 冒号 / NUL / 空段 / `.` 段 | `invalid-package` | `invalid-artifact-path` | dev 链在 `requireExpectedPackage` **前置**调用 `isCanonicalRelativeArtifactPath`（`:553-554`），违规被吸进汇聚码 `invalid-package`；packaged 链的 `validateRuntimeManifest` 对 `entry`/`addon` **只查** `typeof === "string"`（`:319-320`）与互不相同（`:321`），规范性校验**推迟**到 `resolveManifestArtifact`（`:197-198` → `:372` → `throwInvalidArtifactPath` `:373`） |
| artifact 是 symlink / realpath 逃逸 root | `invalid-artifact-path`（`:429`/`:437`） | `invalid-artifact-path`（同站点） | 两链共用 `requireContainedRegularArtifact`，此处对称 |

两链都 fail closed，**无安全缺口**；但守护测试的断言必须**按模式分别写死期望码**，
不能写成「`invalid-package` 或 `invalid-artifact-path`」这类含糊措辞。

### R4 sha256 hash 链路只在 packaged 模式存在，且只接受小写

- **hash 校验只发生在 packaged 链**：`resolvePackagedRuntime` 的 `readRequiredArtifact`（`:217-220`）
  → `hashBytes`（`:221-222`）→ `requireArtifactHash`（`:223-224`）。dev 链
  （`resolveDevelopmentRuntime` `:101-151`）**完全无** `readRequiredArtifact`/`hashBytes` 调用。
  故 **dev 模式不可达 `artifact-integrity-mismatch`**。
- **hashPattern `/^[0-9a-f]{64}$/u`（`:292`）只接受小写十六进制**：manifest 写大写 SHA256
  摘要（如 `"A".repeat(64)`）会让 `validateRuntimeManifest` 的 `compatible` 判定为 false
  （`:323-324`），归 **`incompatible-runtime-manifest`（`:326`）而非 `artifact-integrity-mismatch`**。
  → 提示：阶段 5 落地 `windows-cua-helper-assets.mjs` 生成 manifest 时，摘要**必须 `toLowerCase()`**，
  否则合法产物会被误判为「清单不兼容」。
- `hashBytes` 是可注入的（`WindowsCuaRuntimeResolveOptions.hashBytes` `:36`）；缺省用
  `defaultHashBytes`（`:71-72`，真 `createHash("sha256")`）。守护测试注入假 `hashBytes`
  即可零成本覆盖 `artifact-integrity-mismatch`（返回不匹配摘要）与 packaged happy path
  （返回匹配摘要）——**无需构造真实字节差异**。

### R5 注入式 fileSystem 夹具契约（含一条死约束）

`WindowsCuaRuntimeFileSystem`（`:22-27`）与 `WindowsCuaRuntimeResolveOptions`（`:29-37`）把
`platform`/`env`/`resourcesPath`/`arch`/`electronVersion`/`fileSystem`/`hashBytes` **七个维度**
全部参数化；注入点两处（`:95` dev 链、`:98` packaged 链），均为
`options.fileSystem ?? defaultFileSystem`。守护测试用**纯内存夹具**即可让 12 类 reason
全部可达，**无需真实磁盘、无需 Windows**（模块 `:114-115` 与 `:370-371` 的注释显式背书
「构建和测试会在非 Windows 主机校验 Windows runtime」）。

夹具注入契约：

- **必须注入 `lstat`**（接口可选 `:24`）：模块所有 stat 语义走 `lstatFile`（`:457-462`），
  它对**缺失的 `lstat` 字段回退到真实 fs**（`:461` `fileSystem.lstat ?? defaultFileSystem.lstat!`）。
- **必须注入 `realpath`**（接口可选 `:25`）：同理走 `realpathFile`（`:464-466`），
  缺失字段回退真实 fs（`:465`）。
- **必须注入 `readFile`**（接口必填 `:26`），且**按双模式**：传 `"utf8"` 返回 `string`
  （manifest/`package.json` 读取 `:249`/`:540`），不传 encoding 返回 `Uint8Array`
  （packaged 链读 artifact 字节 `:494`）。缺 encoding 分支会让 happy path 在运行时崩，
  而 `.mjs` 测试不经 typecheck（`packages/services/tsconfig.json` 的 `include: ["src"]`
  不覆盖 `tests/`），形状错误只在运行时暴露。
- **`stat` 是接口唯一必填成员（`:23`）却从不被模块调用——死约束**：`windowsCuaDevRuntime.ts`
  全文无任何 `fileSystem.stat(` 调用，所有 stat 走 `lstatFile`/`realpathFile`。夹具应给 `stat`
  一个 **throw 占位**（而非 ENOENT），以便未来若模块改用 `stat` 时测试**立刻显式失败**，
  而不是静默回退真实磁盘。只注入 `stat` 的夹具是**非密封**的：实测 dev-root 指向宿主上真实
  存在的目录时，reason 会从 `development-root-not-found` 变成 `invalid-package`
  （因为 `lstat`/`realpath` 回退真实 fs 命中了真实目录）——用例通过与否取决于宿主机是否存在该目录。
  此即 `agent-command-env-gate.test.mjs` 场景 6/6b 的夹具修复依据。
- **夹具路径键必须用与模块相同的 `node:path` `resolve()`/`join()` 计算，绝不硬编码分隔符**：
  packaged root 由 `resolve(resourcesPath, ...PRODUCT_RUNTIME_SEGMENTS)`（`:188`）在 win32
  宿主产出反斜杠路径；若夹具键写成正斜杠，`lstat` 查不到节点抛 ENOENT，被
  `requirePackagedRuntimeRoot`（`:265-286`）折叠成 `invalid-runtime-manifest`——**给出的是
  「看起来合法的稳定错误码」而非显式报错**，是最误导的失败形态。

### R6 隐私门槛：错误文本只含稳定字面量与 artifact 名

所有 `WindowsCuaDevRuntimeResolutionError` 的 `message` 只由**稳定字面量** + **artifact 名**构成，
**不含任何底层 IO 错误码或路径细节**：`throwMissingArtifact`（`:450-454`）、
`readRequiredArtifact` 的 catch（`:495-502`，注释明写「不能把宿主 I/O 细节泄漏成不稳定诊断」）、
`requireExpectedPackage` 的空 catch（`:564-566`，注释「避免依赖底层错误文本」）、
`readRuntimeManifest`/`requirePackagedRuntimeRoot` 的空 catch（`:256-262`/`:279-285`）
均丢弃底层 error，只抛固定文案。守护测试对所有负样本统一加
`assert.doesNotMatch(err.message, /ENOENT|EACCES|EPERM/u)`，并断言 `err.artifact` 为稳定标识
（`package.json` / `runtime-manifest.json` / `entry` / `addon` / entry·addon 的相对路径）。

### R7 无回退：dev 链失败时零次访问 packaged 路径

`resolveWindowsCuaRuntime` 的 `:94-96` 是无 `try/catch` 的裸 `return`：dev-root env 被采纳后
直接 `return resolveDevelopmentRuntime(...)`，dev 链抛错时 `:98` 的 packaged 链**不可达**。
守护测试同时注入合法 `resourcesPath` 与 symlink/缺失的 dev root，夹具记录全部 fs 调用路径，
断言「记录数组中不存在任何 packaged 前缀路径」（而非只看错误码——若不给 `resourcesPath`，
回退也会因 `missing-resources-path` 失败，掩盖真实行为）。消费者侧同样无回退：
`node.ts` 只 log 后原样 rethrow。

## 已登记待办（阶段 0 发现，不在本阶段修）

以下缺口由阶段 0 只读调查 + 实测发现，均属**宿主行为改动**，阶段 0 只登记不修
（spec §7.7：阶段 0 未完成前不得改动宿主代码）。行号以各自文件当前源码为准。

1. **`mintBrokerSocketPath` 无 win32 分支**（`packages/acode-cua/broker.js:47-50`）：
   恒返回 `tmpdir()/*.sock` 盘符路径，无 named-pipe 分支。Windows `net.listen` 对文件路径直接
   `EACCES`。`WindowsCuaHelperHost` 默认消费它（`windowsCuaHelperHostSupport.ts:63`
   `defaultSocketPathFactory = mintBrokerSocketPath`），而 `node.ts` 未覆盖该默认 →
   这是 C05（Windows 端到端）跑通的**真实前置阻塞**。属阶段 2 前置。

2. **`fileSystem.stat` 死约束**（`windowsCuaDevRuntime.ts:23`）：接口必填却从不被调用；
   真正被用的 `lstat`/`realpath` 反而可选且带真实-fs fallback（`:461`/`:465`）。
   清理属源码改动 + 公开接口类型变更，须先改本 spec 再过 `pnpm knip`，记为独立后续项。

3. **split-brain：`transport_ready` 先于 healthProbe resolve**
   （`windowsCuaDevHelperHost.ts:404-408`：`ready.type === "transport_ready"` 时
   `resolveTransportReady` 后直接 `return`，healthProbe 在其后 `:409` 才发起）。叠加占位
   `probeHelperHealth` 恒返回 `{ bundleId: null, pid: null }`（`broker.js:43-44`，经
   `defaultHealthProbe` `windowsCuaHelperHostSupport.ts:64-65` 接线）→ `isExactHealthPid`
   恒 false（`:418`）→ 即使角色 A 交出真 Helper，完整 `start()` 也必然以
   `health-pid-mismatch`（`:419`）失败；但 `waitForTransport` 已成功、Agent 拿到 env 能连 pipe，
   表现为「半工作」。→ 验收 C05 必须断言 `host.running === true`，而非只看 Agent 是否拿到 env 元组。

4. **`broker-server.js` host 侧占位面（待用户裁决角色归属）**：`createProductCuaHelperHost`
   返回全 unavailable host（`:99-101` + `createUnavailableCuaHelperHost` `:103-130`）、
   `isOfficialCuaPluginEnabledForWorkspace` 恒 false（`:132-134`）、
   `waitForCuaHelperStartup` **忽略 deadlineMs** 直接 `await startup`（`:150-152`）、
   `mark/has/clearCuaProductHelperAgentEnvUnavailable` 三件套 **no-op**
   （`:162`/`:164-166`/`:168`）。这些既不在角色 A（只管 `cua-producer/` 原生）也不在
   角色 B（只管 `broker.js`/`index.js`）的工作项里，但 `node.ts` 生产 CUA 主路径按名 import
   并调用它们 → 补实 A+B 后生产路径仍全死，且 **fail-closed marker no-op 使 §7.7 回退门槛整体失效**。
   此为需用户裁决的角色范围洞。

5. **marker 三件套 no-op**（同 4，`broker-server.js:162`/`:164`/`:168`）：单列以强调
   fail-closed 机制当前不生效——`hasCuaProductHelperAgentEnvUnavailable` 恒返回 false，
   故「helper 不可用时拒绝下发 agent env」的保护形同虚设。

## 不在本文档范围

- 生产者（`cua-producer/`、`ax_native.node`、`windows-helper.js`）的实现——属阶段 1/2。
- helper host 的代际管理、两阶段就绪与停止竞态的完整契约——由 T2 守护测试
  （`windowsCuaHelperHostLifecycle.test.mjs`）与其对应 spec 覆盖；本文档只登记与之相关的
  split-brain 待办（上文第 3 项）。
- broker 传输层的 token 鉴权与字节上限——归 `apps/acode-cli/tests/cua-broker.test.mjs`（T3）
  与 `cua-bridge.test.mjs`（T4）及其 spec。
