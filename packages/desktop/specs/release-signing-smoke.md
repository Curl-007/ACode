# ACode 发布签名三态 + 发布前验证 smoke + CI 缓存纪律

规则与边界（签名三态判定表、smoke 在 draft 流程中的位置、缓存键生产/消费矩阵）。
机制移植自 oh-my-pi v18.12.1（MIT，Stencil Labs / badlogic pi-mono fork）：
`docs/macos-signing-notarization.md`、`.github/workflows/ci.yml`（release_gate /
release_smoke / install_methods 作业形态）、`.github/workflows/bun-cache-warm.yml`。
本仓 workflow 为重实现（非搬运）；`scripts/acode-distribution/installer.mjs` 的
「校验通过后才落位、失败不覆盖已装版本」语义照抄 omp `scripts/install.sh` 思想。
出处对照见文末「移植来源清单」。

## 1. 签名可用性三态（omp 核心教训：部分存在必须报错，不许静默降级）

唯一判定入口：`packages/desktop/scripts/release-signing-state.mjs`
（纯函数 `resolveSigningState` + CLI 壳；`packages/desktop/tests/release-signing-state.test.mjs`
覆盖三态与报错文案）。release.yml 的 `desktop` 作业在每个平台腿打包前运行，
本地打包前也可手工运行复核。判定读取环境变量并按组计数：

| 平台（--platform 取值） | secrets 组（全部） | full（全有） | none（全无） | partial（部分存在） |
| --- | --- | --- | --- | --- |
| macOS（`mac` / `darwin`） | `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | electron-builder 签名 + notarytool 公证（见 §2） | 保持未签名（现状），输出明示「未签名」 | 立即失败，错误列出缺失项与已存在项（只出现键名，绝不回显值） |
| Windows（`win` / `win32`） | `CSC_LINK`、`CSC_KEY_PASSWORD`（PFX 形态） | signtool 用 PFX 签安装器与主程序 | 保持未签名（现状），输出明示 | 同上，立即失败 |
| Linux（`linux`） | （无签名面） | — | 恒 none（AppImage/deb 不签名），输出明示 | — |

- 判定语义：组内每个键「非空且去空白后非空」才算存在；`full`=全部存在、`none`=全部不存在、其余=partial。空字符串 secrets（GitHub 未配置的 `secrets.X` 映射为 `""`）按不存在计。
- Windows 选型说明：electron-builder 26.15 的 Windows 签名现行走 `CSC_LINK`/`WIN_CSC_LINK`（PFX）+ `CSC_KEY_PASSWORD` 驱动 signtool（`app-builder-lib` windowsSignToolManager，`cscLink === ""` 时安全跳过），或 `azureSignOptions`（Azure Trusted Signing，需改 config 并配 AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET）。本仓取 PFX 形态：零 config 改动、离线可复现；Azure 形态留作后续替代，引入时必须同步修订本表。
- 环境注入约定：三态为 full 时，脚本写 `ACODE_ENABLE_MAC_SIGN=1` 与 `CSC_IDENTITY_AUTO_DISCOVERY=true`（经 GITHUB_ENV）；其余所有结果一律写 `CSC_IDENTITY_AUTO_DISCOVERY=false`（保持既有未签名行为）。secrets 本身由 workflow 以 env 形式映射给打包步骤（GitHub 对日志中的 secret 值自动打码）；electron-builder 端「空串视为未配置」由 `electron-builder.config.js` 在载入时归一（空串键从 process.env 删除），避免 macOS `createKeychain` 拿到空 `CSC_LINK` 误入证书导入。
- 不诚实边界：禁止任何「部分存在就补齐其余」或「partial 静默按 none 继续」的兜底分支；这是 omp 的签名链路核心教训。

## 2. macOS 签名/公证接线（electron-builder 26.15.3）

- `identity`：`ACODE_ENABLE_MAC_SIGN=1` 且（有 `APPLE_SIGNING_IDENTITY`/`CSC_NAME` 身份名 **或** 有非空 `CSC_LINK`）时开启。CI 走 `CSC_LINK`（base64 P12）时 electron-builder 将证书导入临时钥匙串；config 的 `mac.identity` 置 `undefined`（非 `null`），由 auto-discovery 在钥匙串中按 Developer ID Application 匹配（`CSC_IDENTITY_AUTO_DISCOVERY` 必须非 `"false"`，由三态脚本保证）。本地预签名仍走身份名路径；未开启签名时 `identity: null` 显式跳过（现状不变）。
- `notarize`：未开启签名时保持 `false`（现状不变）；开启签名时置 `true`，由 electron-builder 内置 notarytool 消费 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`（三态 full 保证三者齐全；本地 Preview 签名不带公证凭据时 electron-builder 仅告警跳过公证，不失败）。原「build 阶段提前失败」顾虑只在凭据残缺时成立，partial 已被三态门禁拦截。
- `hardenedRuntime`：沿用 `shouldEnableMacSigning`。

### entitlements 逐条论证（omp 教训：漏条目会「签名公证全过、首次真实使用即崩」）

`build/entitlements.mac.plist`（主 app）与 `build/entitlements.mac.inherit.plist`（嵌套二进制）为事实源；启用 hardened runtime 后每一条都必须有存在理由，新增/删除须先改本表：

| Entitlement | 论证 | 缺失后果 |
| --- | --- | --- |
| `com.apple.security.cs.allow-jit` | Electron/V8 运行期 JIT 需要可执行映射。 | 主进程启动即崩（JIT 分配被拒）。 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8 JIT 页与 wasm 代码内存按需改写权限位。 | 同上或启动后首个重编译点崩溃。 |
| `com.apple.security.cs.disable-library-validation` | 随包分发、由宿主 `dlopen`/`process.dlopen` 加载的原生模块（node-pty 的 `prebuilds/<platform>`、koffi 的 `.node` 等）是**无签名/不同 Team ID** 的 Mach-O；hardened runtime 默认库校验会以 "mapping process and mapped file have different Team IDs" 拒绝。签名与公证都能通过，但**首次真实使用（首次开终端会话/调用 FFI）即崩**——与 omp 的 pi_natives 教训同构。 | 签名公证全绿，功能首用崩溃；发布前 smoke 的启动探测若不触达对应功能仍可能漏过，因此该条目是硬性前提。 |
| `com.apple.security.cs.allow-dyld-environment-variables`（仅主 app plist） | 打包态 agent 通过宿主 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 拉起（见 specs/electron-hardening.md §5），dyld 环境变量注入需要该豁免。 | agent 子进程启动失败。 |

## 3. 发布前验证 smoke（release.yml，draft-until-success 不破坏）

在产物构建完成后、公开 Release 前新增 `verify_assets` 作业（矩阵：macos-14/arm64、
macos-15-intel/x64、windows-latest/x64、ubuntu-latest）。它从 **draft release 下载
将被打出的同一批字节**再验证，任一腿失败 → `publish` 不执行 → release 保持 draft。

draft 流程位置图（步骤编号为作业名，箭头为 needs 依赖与放行条件）：

```
verify ──▶ release(建 tag+draft) ──▶ build(CLI+sha256.txt) ─┐
                 └─────────────▶ desktop(五平台打包上传) ───┤
                                                            ▼
                                              verify_assets(新增，四腿)
                                               mac: 下载 zip/dmg → sha256 → Info.plist 版本比对
                                                     ├ 签名期: codesign --verify --strict
                                                     │   + 非 adhoc 断言 + entitlements 含
                                                     │   disable-library-validation + spctl(参考)
                                                     ├ 未签名期: 明示「未签名，跳过验签」
                                                     │   + 结构检查（asar 可解析、关键文件存在）
                                                     ├ 启动 smoke（两种态都跑）:
                                                     │   --remote-debugging-port 轮询 /json/version
                                                     │   + 进程存活 + 杀树收尾，失败转储 stdio
                                                     └ 各腿产出 sha256 清单 artifact
                                               win: sha256 + 文件大小下限
                                                    （签名期: Get-AuthenticodeSignature=Valid）
                                               linux: sha256 -c sha256.txt 校验 CLI 包
                                                      + AppImage sha256/大小 + --appimage-extract
                                                            ▼
publish（needs 增加 verify_assets；keep_draft / build_artifacts 语义不变）
  ├ 汇总各腿 sha256 清单 → 上传 ACode-<VERSION>-checksums.txt 到 release
  └ gh release edit --draft=false（原有聚合放行点，最后一步才公开）
```

- **无 `--smoke-test` 旗标的诚实边界**：ACode Electron 主进程没有 omp 的 `--smoke-test`；启动探测按现实能力定义为「Info.plist `CFBundleShortVersionString` 等于本次发布版本 + Chromium 远程调试端点 `/json/version` 应答（证明主进程与渲染层活着）+ 进程未提前退出」。不伪造退出码语义；探测失败即失败并输出应用 stdio 尾部。若首次真实发布 run 中发现打包态不接受 `--remote-debugging-port`，必须先修订本 spec 再调整判定（不许静默降级成「活着就算过」）。
- Windows 不做启动 smoke（NSIS 安装器不可直接启动）；任务边界内为 sha256 + 大小下限（< 50 MiB 视为损坏），签名期附加 Authenticode 校验。Linux 腿覆盖 `sha256.txt` 与 tarball 的一致性（发布前权威校验该文件本身），并 `--appimage-extract` 抽查 x64 AppImage 结构；arm64 AppImage 仅哈希/大小（x64 runner 无法执行 arm64 runtime）。
- 校验和聚合：各腿 `sha256` 清单（`<hash>␣␣<文件名>`，`sha256sum -c` 兼容格式）经 artifact 汇入 publish，合成 `ACode-<VERSION>-checksums.txt` 上传到 release；该步骤失败则 release 保持 draft。

## 4. CI 缓存纪律（omp 教训：每 PR 一份大缓存曾吃掉 9.4GB/10GB 配额）

键与路径单一事实源：`pnpm-store-Linux-<hashFiles('pnpm-lock.yaml')>`，路径 `~/.local/share/pnpm/store`。

| 角色 | workflow / 作业 | 动作 | 触发 |
| --- | --- | --- | --- |
| 生产者（唯一） | `warm-cache.yml` `warm` | probe（lookup-only）→ `pnpm fetch` 填 store → save；同前缀只保留最新 2 份（其余 `gh cache delete`，全部 continue-on-error） | push 到 `main`、`dev/**` 且 paths 命中 `pnpm-lock.yaml` / 本 workflow；手工 dispatch |
| 消费者（只读） | `ci.yml` `verify`、`remote-ssh` | `actions/cache/restore@v4` 显式 restore，**任何触发都永不 save**（弃用 setup-node 的 `cache: pnpm`，其无法关掉保存半边） | push / PR / dispatch |
| 不受影响 | `licenses-notices.yml` | 维持自身 setup-node `cache: pnpm`（本纪律不改它；台账「只在 CI Linux 重生成」既有纪律不变） | 既有触发 |
| 不在本纪律内 | `release.yml` | 低频（手动发布），本次不改其 setup-node 缓存；后续如需同纪律另行评审 | workflow_dispatch |

- 键匹配说明：生产者 save 的 key 与消费者 restore 的 key 逐字符一致（同一 `hashFiles('pnpm-lock.yaml')` 表达式、同一 `Linux` 段、同一路径）。PR 查找顺序 = 本分支 → 基分支 → 默认分支，故 PR 能命中 main 的 warm 条目；`restore-keys` 前缀 `pnpm-store-Linux-` 兜底旧锁文件条目，缺失部分由 `pnpm install --frozen-lockfile` 增量下载，永不写回。
- 不做「PR 里 save + lookup-only 探测」混合：单一生产者让配额账目可审计（omp 的 probe→save→prune 三步只保留在 warm-cache 一处）。

## 5. sha256 消费（用户可执行）

- 发布说明模板（release.yml 内嵌）把 Checksums 条目写成可直接复制的命令：`sha256sum -c ACode-<VERSION>-checksums.txt`（Linux / Windows Git Bash）与 `shasum -a 256 -c ACode-<VERSION>-checksums.txt`（macOS），中英双语；`sha256.txt`（CLI tarball）保留并在下载说明中指向同一命令。
- `scripts/acode-distribution/installer.mjs` 生成的 `install.sh`：下载 tarball 后、解压与落位**前**，用 `latest.json.sha256`（构建时写入，权威值）对本地文件做流式 sha256 比对；不一致立即失败退出，不覆盖既有安装（omp install.sh 语义）。node 为既有必需依赖，哈希用 node:crypto 实现，规避 macOS 无 `sha256sum` 的平台差异。
- 模板中「installers are not signed by ACode」的表述对应未签名现状；**若仓库首次配置签名 secrets（三态 full），同一变更必须同步改写发布说明中的未签名表述与 Gatekeeper/SmartScreen 放行指引**（已写入验收）。

## 验收

- `resolveSigningState` 单测覆盖：全有→full；全无→none；部分存在→partial 且错误文案逐项列出缺失键名；空串/空白视为不存在；linux 组为空时恒 none。
- release.yml YAML parse 通过；`desktop` 三态步骤在 partial 时以非零退出并阻断打包；`publish` 的 needs 与 if 保留 build_artifacts/keep_draft 全部既有语义，且 verify_assets 失败必然阻断公开。
- ci.yml 与 warm-cache.yml 的键/路径逐字符一致；ci.yml 不存在任何 save 路径。
- entitlements 增删必须先改 §2 表并说明理由；`disable-library-validation` 不得移除。
- YAML/脚本/单测可在本地验证；**release 与 CI 的真实 runner 行为（签名导入、公证、启动探测、缓存命中）无法本地验证，需以首次真实 run 为准复核**。

## 移植来源清单

| 机制 | 来源（oh-my-pi v18.12.1，MIT） | 本仓形态 |
| --- | --- | --- |
| 签名凭据三态（全有签/全无 ad-hoc 或 unsigned/部分存在报错） | `docs/macos-signing-notarization.md`（"With all five APPLE_* secrets … with none … A partial set is an error"） | `release-signing-state.mjs` 重实现（electron-builder 凭据族，非 rcodesign） |
| 发布前真机 codesign --verify --strict + 非 adhoc 断言 + spctl 参考 | 同文档 §How it works 3；`ci.yml` release_smoke | `release.yml` verify_assets macOS 腿 |
| entitlements 逐条论证、disable-library-validation 与 dlopen 崩溃教训 | 同文档 "Why the entitlements are mandatory" | §2 表（适配 node-pty/koffi） |
| 安装脚本「校验后才落位、失败不覆盖」 | `scripts/install.sh` | `scripts/acode-distribution/installer.mjs`（哈希取 latest.json，node:crypto 流式） |
| PR 只 restore 不 save + 专职 warm workflow + 9.4GB 配额事故 + probe/save/prune 三步 | `.github/workflows/bun-cache-warm.yml` 头注；`ci.yml` native_addons 缓存三步 | `warm-cache.yml` + `ci.yml`（pnpm store，键前缀 `pnpm-store-Linux-`） |
