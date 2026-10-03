# R1 设计文档：凭据主密钥接入 OS 钥匙串（含 BYO vault 明文回退收口）

状态：**已实施**（2026-10-03 所有者批复「按推荐」，D1–D6 全采纳；R1-a/b/c 三批落地，
实施记录见 `docs/capability-uplift-plan.md` 批次 4 第三轮，规则沉淀在
`packages/services/specs/credential-storage.md` 与
`packages/provider-node/specs/byo-apikey-credential-ref.md` R1-c 节）。以下为批复时的
设计原文；前置事实核实全部基于当时检出源码（`credentialMasterKey.ts` /
`credential-storage.md` spec / `provider-config.ts`）。

## 1. 现状（P0-4 已落地的地基与已知边界）

- 主密钥解析单一所有者：`packages/shared/src/node/credentialMasterKey.ts`（**同步**，
  仅依赖 `node:crypto`/`node:fs`）。优先级：显式 secret（测试/宿主）> **已存在密钥
  文件** > `ACODE_CREDENTIAL_SECRET` env > 生成新随机密钥文件（0600、`wx` 排他创建、
  竞争回读带退避重试）。keyFile 先于 env 是刻意设计：已存在材料拥有全部 `enc:v2`
  密文，绝不能被静默替换。
- 密钥材料（32 字节）经 **HKDF-SHA256** 派生数据加密密钥；密文 `enc:v2:` =
  AES-256-GCM + 随机 IV + 版本绑定 AAD。桌面 host（services）与 CLI（adapters/auth）
  的 cipher 均已退化为 shared 的委托层——**单一实现、两进程共用**。
- cipher 接口**同步**，被 `credentialService` 与 CLI `shared-credentials` 在**文件锁
  内联**调用——这是 P0-4 当时不接 safeStorage/keytar 的直接原因（spec 明文）。
- **spec 已声明的诚实边界**（本设计要收掉的正是这两条）：
  1. 密钥文件与密文同盘：挡不住「整个 `.acode` 目录被外带」（云同步/备份/磁盘镜像/
     恶意依赖/本产品自带工具读到后离线解密）。
  2. 密钥文件即单点：删文件或备份漏带 → 全部 `enc:v2` 凭据永久不可恢复（README 已披露）。
- **BYO vault 明文回退**（第 4 项安全残留）：`provider-config.ts` 磁盘形态「有
  credentialRef 只写 ref、绝不写 apiKey 明文」，但「未迁移/凭据库不可用的明文回退态」
  仍会把 BYO API Key 明文落盘。

## 2. 目标与非目标

**目标**：密钥材料与密文**分离**——材料存 OS 钥匙串（macOS Keychain / Windows DPAPI /
Linux libsecret），目录整体外带到异机/异用户后不可解密；桌面 host 与 CLI 两进程对同一
数据目录收敛到同一把钥匙串条目；BYO 明文回退收口或至少显式告警。

**非目标**：密钥轮换；多设备同步；硬件密钥（FIDO/TPM 直接绑定）；`enc:v2` 密文格式
变更；引入原生 node 依赖（keytar 类 node-gyp 负担）；改变 cipher 同步接口。

## 3. 设计不变量

1. **零重加密迁移**：钥匙串里存的就是密钥文件里那 32 字节材料本身（HKDF 输入不变 →
   DEK 不变 → 既有 `enc:v2` 密文一个字节都不用动）。迁移 = 材料搬家 + 验证 + 删文件。
2. **既有材料永不被静默替换**：钥匙串进入优先级链是「既有材料的新家」，不是新材料
   （keyFile > env 的既有精神原样延伸到 keychain）。
3. **同步接口不弱化**：平台钥匙串访问用 `spawnSync` 一次性解析 + 进程内缓存——cipher
   接口、文件锁调用点、两套委托层**零改动**（推翻「必须异步化」的前置假设，见 D2）。
4. **跨进程单一实现**：平台访问器全部落 `shared/src/node/`，services 与 CLI adapters
   经既有委托层自动同源；条目命名规则单一事实源（同一 keyFilePath → 同一条目）。
5. **降级诚实**：钥匙串不可用（headless Linux 无 secret service、容器、CI）→ 回落
   0600 文件模式 + 一次性告警 + README 披露，绝不假装已分离。
6. **零网络出口**：`security`/PowerShell/`secret-tool` 均为 OS 本地调用（no-telemetry
   红线自然满足）。

## 4. 机制选型（D1）

| 方案 | 跨进程一致性 | 同步性 | 依赖负担 | 结论 |
| --- | --- | --- | --- | --- |
| **平台原生工具统一**（macOS `security` / Windows PowerShell DPAPI / Linux `secret-tool`），desktop 与 CLI 走同一条路径 | ✅ 同 OS 用户 + 同条目命名即同材料；macOS 侧经 `security` 创建的条目 ACL 归属 `security` 自身，两进程读取不触发钥匙串弹窗 | ✅ `spawnSync` 可同步 | 零新依赖（全为系统自带二进制） | **推荐** |
| Electron `safeStorage`（desktop）+ CLI 另想办法 | ❌ safeStorage 有自己的信封格式（v10/v20 前缀），CLI 无法解 desktop 写入的 blob；两进程各持材料 = 共用 credentials.json 直接破裂 | ✅（safeStorage 同步） | Electron 内置 | 否决（跨进程致命） |
| `keytar` / 其他原生模块 | ✅ | ❌ 异步 | node-gyp 原生依赖，CLI npm 安装体积/失败面显著增加 | 否决（spec 既有判断维持） |

平台细节（实施时以真实平台验证为准）：

- **macOS**：`security add-generic-password -s <service> -a <account> -w <base64> -U` /
  `security find-generic-password -s <service> -a <account> -w`。generic-password 条目
  随用户钥匙串持久化、随 Time Machine/迁移助理转移。
- **Windows**：无中央「钥匙串」原语存裸密钥，标准做法是 **DPAPI(CurrentUser) 保护的
  blob 文件**：PowerShell `[Security.Cryptography.ProtectedData]::Protect/Unprotect`
  （`System.Security.Cryptography.ProtectedData`，CurrentUser 作用域）。blob 存
  `<凭据目录>/credential-key.dpapi.json`——物理上仍同目录，但**只有同机同 Windows
  用户能解**：目录外带到异机/异用户即密文一团，达成逻辑分离。与 Chromium/safeStorage
  在 Windows 的底层原语相同、信封不同（裸 DPAPI，跨进程天然互通）。
- **Linux**：`secret-tool store --label=ACode <attr> <value>` / `secret-tool lookup`
  （libsecret → GNOME Keyring / KDE Wallet）。**需要 D-Bus 会话 + 运行中的 secret
  service**——headless/容器普遍不可用，走降级（D5）。

## 5. 同步/异步（D2）

推荐 **`spawnSync` 一次性解析 + 进程内缓存**：

- 主密钥解析本来就是「每进程一次」的启动期动作（现有实现已含同步文件 IO 与竞争
  `Atomics.wait` 小睡，先例一致）；钥匙串读取挂在同一位置，接口签名不变。
- 成本预估：macOS/Linux 单次 spawn ~10–50ms；Windows PowerShell 冷启动 ~100–300ms
  （登记为实施实测项；缓解：懒解析——首次 encrypt/decrypt 才触发，且缓存后为零）。
  **实测修正（2026-10-03，Win10 26200，`scripts/smoke-credential-keychain.mjs`）**：
  预估偏低——裸 powershell.exe 启动 ~220ms，完整 DPAPI 调用连发热态 ~225ms、间隔
  真实使用 ~850–930ms、冷启动 0.9–2s。按「每进程一次性开销（缓存后零 spawn）」评估
  仍可接受，D2 裁决维持；CLI 短进程若成体感痛点，升级路径是 bootstrap 异步预热
  （并行 spawn 填缓存）而非异步化整条 cipher 链。
- 异步化整条 cipher 链（备选）：接口手术波及 credentialService、CLI
  shared-credentials、文件锁内联点与两套委托层——工作量和回归面数倍于收益，仅当
  实测 spawnSync 延迟不可接受时才升级考虑。

## 6. 条目命名与多数据目录（D3）

- 推荐：**条目/账户名含数据目录指纹**——`service = "acode"`，
  `account = "credential-master-key@<sha256(normalize(keyFilePath)).slice(0,16)>"`
  （Windows：blob 文件名即 `credential-key.dpapi.json` 固定在凭据目录内，天然按目录
  隔离，无需指纹）。
- 理由：`ACODE_DATA_BASE_DIR` 多目录/测试临时目录不互相覆盖；桌面与 CLI 已按 spec
  把**同一 keyFilePath** 钉给 cipher（「密钥文件与凭据文件同目录」规则），指纹输入
  一致 → 跨进程收敛有既有保证。
- 否决项：固定单条目（测试目录会写脏真实钥匙串、多数据目录互相覆盖）。

## 7. 迁移（D4）

一次性迁移，触发于解析链发现「密钥文件存在 ∧ 钥匙串可用 ∧ 条目缺失」：

1. 读文件材料 → 写入钥匙串条目 → **回读逐字节验证**；
2. 验证通过 → 删除 `credential-key.json` + 一次性 info 日志（「主密钥已迁入 OS 钥匙串，
   密钥文件已删除」）；验证失败/任何异常 → **不迁移**，保持文件模式，下次重试；
3. 迁移后解析优先级：**explicit > keychain > keyFile（未迁移遗留）> env > generate**。
   keychain 与 keyFile 并存（用户手动恢复旧备份）→ keychain 优先 + 一次性告警（两者
   材料本应相同；不同说明备份错位，告警给出两路径提示）。
4. **新装路径**（R1-a 即生效）：钥匙串可用 → 生成的 32 字节直接入条目、不落文件；
   不可用 → 现状文件模式。

**丢失面（诚实声明，README/spec 同步更新）**：钥匙串条目丢失（OS 重装未迁移钥匙串、
`security delete-generic-password`、Windows 用户配置重建、Linux secret service 清库）
= 凭据不可解密。后果是**重新登录/重输 Key**（不便但非灾难——凭据本体是可在服务端
重签发的 OAuth token 与 API Key）；现有「密钥文件单点」边界同性质，README 已披露过
同类风险，改写为钥匙串语义即可。

## 8. 不可用降级（D5）

- 检测：`spawnSync` 失败（ENOENT：无 `secret-tool`；Linux 无 D-Bus 会话；PowerShell
  受限模式）或 lookup 非零退出且非「条目不存在」语义。
- 行为：回落文件模式（现状全保留），**一次性 warn**（「OS 钥匙串不可用（原因），凭据
  主密钥回退 0600 文件模式——目录整体外带风险见 README」）；`ResolvedCredentialMasterKey
  .source` 增加 `"keychain"` 取值，文件回退仍报 `"keyFile"`，宿主/诊断可区分。
- 否决项：钥匙串不可用即拒绝启动——破坏 headless/服务器/CI 上的 CLI 正当使用。

## 9. BYO vault 明文回退（D6）

- 现状：`provider-config.ts` 仅在「未迁移/凭据库不可用」写明文 apiKey（有 ref 绝不写
  明文的方向已对）。R1 主体（钥匙串）不改变 vault 可用性本身——明文回退的触发原因是
  **cipher/vault 缺席的上下文**，不是密钥弱。
- 推荐：**保留兼容回退 + 一次性显式告警 + 实施轮查明「不可用」的真实成因清单**
  （哪些宿主/路径下 vault 缺席；若属可修复的接线缺席则收口根因，若属正当场景如只读
  宿主则维持告警）。不推荐「拒绝明文落盘」硬闸：headless BYO 配置是正当工作流，
  硬闸把安全成本转嫁为不可用。
- 该项独立小批（R1-c，S 级），不阻塞 R1-a/b。

## 10. 裁决点汇总

| # | 裁决点 | 推荐 | 备选与否决理由 |
| --- | --- | --- | --- |
| D1 | 钥匙串机制 | 平台原生工具统一（`security`/PowerShell DPAPI/`secret-tool`），两进程同一路径 | safeStorage（跨进程信封不通，否决）；keytar（原生依赖，否决） |
| D2 | 同步策略 | `spawnSync` 一次性 + 进程内缓存，接口零改动 | 异步化整链（手术面大，仅当实测延迟不可接受） |
| D3 | 条目命名 | service=`acode`，account 含 keyFilePath sha256 指纹（Windows blob 天然按目录隔离） | 固定单条目（多目录/测试互相污染，否决） |
| D4 | 迁移 | 零重加密搬家：写入→回读逐字节验证→删文件；失败不迁移下次重试；keychain 优先于遗留 keyFile 并存告警 | 保留文件双写（分离收益归零，否决） |
| D5 | 降级 | 文件模式回退 + 一次性告警 + source 词汇增 `keychain` | 拒绝启动（破坏 headless 正当使用，否决） |
| D6 | BYO 明文回退 | 保留 + 告警 + 实施轮查明不可用成因再决定收口 | 硬闸拒绝明文（headless BYO 不可用，否决） |

## 11. 实施批次与成本

- **R1-a**（M）：`shared/src/node/credentialKeychain.ts` 平台访问器（三平台 + 探测 +
  mock 注入点）；`credentialMasterKey.ts` 优先级链插 keychain（explicit > keychain >
  keyFile > env > generate）、新装直接入条目、降级与告警、`source` 词汇扩展；单测
  （mock spawnSync 全分支：命中/缺失/损坏/超时/平台缺席）+ 真平台 gated 集成测试
  （CI 无 secret service 自动跳过）。
- **R1-b**（S）：一次性迁移（验证→删文件→通知）+ 并存告警 + README「本地凭据保护」
  与 `credential-storage.md` spec 改写（钥匙串语义、丢失面、优先级链）。
- **R1-c**（S）：BYO vault 不可用成因调查 + 明文回退一次性告警 + provider spec 增补。
- 验证口径：根 typecheck / lint / arch；shared+services 全套件；CLI adapters auth 相关
  套件；三平台手测清单（macOS 钥匙串访问.app 可见条目、Windows 异用户不可解、Linux
  headless 降级告警）；迁移幂等（重复跑不重复迁移、失败不破坏现场）。

## 12. 与 zoode 情报的关系

zoode 对上游产品的还原确认了「凭据入 OS 钥匙串」是同类产品的标准姿态；本设计的全部
机制（DPAPI blob、`security` 条目、libsecret 属性、HKDF 链）为业界公开原语的自有组合，
不复制任何上游代码或信封格式。P0-4 已落地的随机材料 + HKDF + AAD 绑定版本的地基
原样保留——本设计只动「材料存哪」，不动「怎么用材料」。
