# 凭据静态加密：主密钥来源与版本迁移

安全加固 P0-4；批次 4 R1-a 增补 OS 钥匙串档（设计文档 `docs/credential-os-keychain-design.md`，
D1–D6 已按推荐批复）。定义凭据静态加密的主密钥来源、密文版本语义与升级迁移规则。

## 背景

此前 AES-256-GCM 的密钥为 `sha256(ACODE_CREDENTIAL_SECRET ?? "acode-credential-fallback:{platform}:{homedir}:{username}")`。该环境变量在产物代码中从不被赋值，故永远走可推导回退：三个组成部分对同机任意进程公开可知、单轮 sha256、无盐、无机器绑定。`credentials.json` 一旦被外带（云同步/备份/磁盘镜像/恶意依赖/本产品自带的 Read·Bash 工具），即可纯离线还原全部 OAuth token 与付费 Key。

此外，桌面 host（`@acode/services`）与 CLI（`@acode/adapters/auth`）各持一份**完全等价**的 cipher 实现，两处需同步修改才能保持一致。

## 产品规则

- **主密钥来源优先级**（R1-a 起五级，设计文档 D4）：显式注入 secret（测试/宿主）> **OS 钥匙串条目** > **已存在的密钥文件** > `ACODE_CREDENTIAL_SECRET` 环境变量 > 生成新的每安装随机材料（钥匙串可用 → 直接入条目不落文件；不可用 → 0600 密钥文件 + 一次性降级告警）。
  - 钥匙串排在密钥文件**之前**：它是迁移后材料的新家；两者并存（用户手动恢复旧备份）时钥匙串优先并告警——材料本应相同，分歧即备份错位事故现场，告警给出双路径处置提示。
  - 钥匙串条目/blob **存在但读不出合法材料**（损坏、异用户 DPAPI、长度不符）→ **抛错保留现场**，绝不降级到文件或生成——与密钥文件损坏同一纪律（生成 = 换密钥 = 既有 `enc:v2` 凭据永久垃圾）。
  - 密钥文件排在 env **之前**是刻意的：它一旦存在就拥有已写入的全部 `enc:v2` 凭据，绝不能被静默替换。若密钥文件与 `ACODE_CREDENTIAL_SECRET` 同时存在，env 被**忽略**并发出告警（`onWarn`），因为切到 env 派生的密钥会让既有 v2 凭据全部解不开。
  - env 仅在**钥匙串与密钥文件都尚无材料**（全新安装显式配置）时生效；此时不生成任何持久材料，后续调用同样走 env 以保持一致。
  - **反向脚注**：这意味着「先用 env 写入 v2、之后取消该 env」会落到生成分支、换一把新密钥，令 env 时期写入的凭据解不开。这是 env 配置的固有取舍——用 env 就必须一直用同一个 env。
- **OS 钥匙串访问**（R1-a，`credentialKeychain.ts`，D1/D3/D5 裁决）：平台原生工具统一路径，桌面 host 与 CLI 共用**同一实现**——macOS Keychain generic-password（`security`，经其创建的条目 ACL 归属 `security`，跨进程读取不触发弹窗）；Windows DPAPI(CurrentUser) blob 文件（`<凭据目录>/credential-key.dpapi.json`，`wx` 排他创建，异机/异用户不可解 = 逻辑分离）；Linux libsecret（`secret-tool`，密码走 stdin 无 ps 暴露；需 D-Bus 会话，headless 走降级）。条目账户名含 keyFilePath 的 sha256 指纹（多数据目录/测试隔离；跨进程收敛靠「同一 keyFilePath 钉给 cipher」既有规则）。safeStorage（跨进程信封不通）与 keytar（原生依赖）维持否决。
  - **降级（D5）**：钥匙串不可用（工具缺席/无 secret service/平台不支持）→ 文件模式 + 一次性告警 + `source` 词汇可诊断（`keyFile` vs `keychain`）；**绝不拒绝启动**（headless/CI 的 CLI 是正当使用）。注意「不可用」与「损坏」的区分：无任何材料痕迹才叫不可用；材料可见而读不出必须 error（fail-loud）。
  - **竞争收敛**：macOS 无 `-U` 写入、重复即回读赢家；Windows blob `wx` 排他 + EEXIST 回读；Linux `secret-tool store` 无排他语义 → 写前读 + 写后回读采用最终值（残余毫秒级竞争窗已登记，Linux 并发首装为罕见路径）。
  - **Windows 传输编码**（2026-10-03 真机回归）：`write` 收到的 `secret` 是材料的 base64url（43 字符无填充、可含 `-`/`_`），而 .NET `FromBase64String` 只接受规范标准 base64——写入端必须先规范化为规范 base64 再嵌入 PowerShell 命令，否则 Protect 必抛 FormatException、写入恒失败、Windows 钥匙串档**整体静默失效**（永远降级文件模式；mock 单测测不出——mock 不做真实 base64 解码，真机冒烟 `scripts/smoke-credential-keychain.mjs` 首轮即抓到）。传输契约：blob 存 DPAPI(材料原始字节)；回读返回规范标准 base64——字符串形态可能与写入不同、解码字节一致，调用方一律按解码后字节消费。程序集加载用全名 `Assembly::Load` 而非 `Add-Type`（冷启动实测 ~1.8s→~0.9s，热态等价，非过时 API）；stderr 按控制台代码页（GBK）解码后再拼入用户可见告警（中文 locale 下 UTF-8 直解是乱码；GBK 为 ASCII 超集，英文 locale 结果不变）。
- **一次性迁移（R1-b，D4）**：解析链发现「密钥文件存在 ∧ 钥匙串条目缺失（read 为 absent，unavailable 不触发）」时自动迁移：写入条目 → **回读逐字节验证** → 通过才删除密钥文件 + 一次性 INFO 提示。任一步失败 → **尽力删除刚写入的条目**（解析链里钥匙串优先于文件，与文件材料不一致的坏条目会压过权威材料，比不迁移严重得多）→ 保持文件模式 → 下次解析重试。并发迁移：两进程搬同一份文件材料，macOS/Windows 排他写入的落败方回读赢家（材料相同、验证必过），Linux last-writer-wins 写的也是同一材料；删除文件的 ENOENT（对端已删）视同成功。迁移不改变材料字节 → 既有 `enc:v2` 密文**零重加密**。
- **分歧材料解密回退与自愈收敛（R2，0.0.3）**：R1-b 删除密钥文件后，同机仍在运行的 pre-R1 构建（旧安装未升级、回滚、旧 CLI）会因文件缺失**重新生成一把全新随机密钥文件**并用它写入新凭据，形成「钥匙串 vs 密钥文件」材料分歧——双方各自写出的密文互相解不开，而旧路径把「解不开」经 `clearCorruptOAuthSession` 放大成不可逆的登录态清空（2026-10-04 真机实证：0.0.1 与新构建共用 `~/.acode/v2`，混版每切换一次清一次供应商登录态）。规则：
  - 解析链处于「钥匙串条目 ∧ 密钥文件并存」状态时**尝试**读取文件材料：与钥匙串材料不同 → 解析结果携带 `divergentFileKey`；材料相同 → 不携带；文件损坏读不出 → 不提供回退但**不抛错**（钥匙串权威不受影响，损坏文件只意味着没有回退可用）。
  - `enc:v2:` 解密先用主密钥材料（钥匙串），GCM 失败后用 `divergentFileKey` **重试一次**；两者皆失败 → 抛主密钥的错误（稳定 code + CJK 前缀契约不变，`isCredentialDecryptError` 谓词不受影响）。加密永远用主密钥材料，分歧材料**绝不产出新密文**。
  - **自愈收敛**：host `credentialService.load` 回退成功后，在凭据文件锁内用主密钥材料把该值重加密写回（CAS：原密文已被其他进程改写则放弃）；收敛失败仅告警、不影响本次读取返回明文（值仍可经回退材料读取，下次读取重试）。全部分歧密文被读过一遍后，存储回到单一材料态，此时删除多余密钥文件才安全。
  - 边界：CLI（`adapters/auth/shared-credentials`）共用同一 cipher，自动获得回退读取（登录态不再因分歧丢失），但**不做 CLI 侧重写收敛**——host 启动读取覆盖 OAuth 主命名空间，CLI 独有值若从未被 host 读过则维持分歧材料加密，登记为已知边界（删除分歧密钥文件后不可解，与「钥匙串条目丢失」同性质）。
  - pre-R1 构建无法追溯修复：它仍只认密钥文件、解不开钥匙串材料密文并会清空。R2 保证的是**新构建侧免疫与自愈**，把「双向互清」收敛为「旧构建侧单向失效」。
- **解密失败留证与显式留痕（R2）**：此前 `credentialService.load` 解密失败直接上抛，`oauthCredentialRepo` 随即静默逐条删除条目——密文永久丢失、日志零痕迹，用户只见「登录态消失」。现在：
  - 抛解密失败错误前，先把整份凭据 store 经 `backupCorruptFile` 留证（内容哈希命名 `.corrupt-<hash>.bak`、0600、幂等排他创建），并输出 warn（只含路径与备份路径，不含凭据内容）。用户找回原密钥材料后可从 `.bak` 恢复密文。
  - `clearCorruptOAuthSession` 清空前显式 warn（列出受影响 provider id）。清空本身**保留**——让用户回到可重新登录的干净态仍是正确恢复——但不再静默、不再不可追。
- **每安装密钥文件**：`<凭据目录>/credential-key.json`，首次使用时随机生成 32 字节，`0600` 权限，`wx` 排他创建。排他创建保证并发首次启动时只有一个进程写入成功、落败方回读赢家的密钥，两个进程因此收敛到同一把密钥——这是桌面 host 与 CLI 共用同一 `credentials.json` 的前提。（R1-a 后仅在钥匙串不可用的降级模式或未迁移遗留中产生/使用。）
  - **回读必须带重试**：赢家的 `writeFileSync` 不是原子操作，落败方可能在半截 JSON 上读到内容。旧实现直接 `JSON.parse` 会抛未捕获的 `SyntaxError` 崩进程（对抗评审核实，且直接反驳了「必然收敛」）。现在落败方按 `[10,25,50,100,200]ms` 退避重试；重试耗尽仍读不出则**保留现场报错**，绝不回退到生成新密钥——生成等于换一把密钥，会把已写入的全部 `enc:v2` 凭据变成永久垃圾。
- **密钥文件与凭据文件同目录**：所有调用点必须把凭据文件所在目录显式钉给 cipher（`keyFilePath`）。若各自独立解析 baseDir，宿主用 `setDataBaseDir` 切换数据根后会出现「凭据在新目录、密钥在旧目录」的分裂并解密失败。
- **派生**：env/显式 secret 经 scrypt（带固定盐做域分离）派生；密钥文件内容为主密钥，经 HKDF-SHA256（带盐 + info 域分离）派生数据加密密钥。不再使用单轮 sha256。
- **密文版本语义**：
  - `enc:v2:` 当前格式。AES-256-GCM + 每值随机 12 字节 IV + 绑定格式版本的 AAD。
  - `enc:v1:` **仅可解密，永不产出**。沿用旧的可推导密钥，唯一目的是让升级前已落盘的凭据仍可读。
  - 未带 `enc:` 前缀的值视为历史明文，原样返回（与旧实现行为一致）。
- **版本混淆防护**：v2 密文绑定 AAD，v1 密文加密时未绑 AAD（故 v1 解密路径**不得**传 AAD，否则 GCM 标签必然校验失败并毁掉全部既有凭据）。把 v1 密文重新贴上 `enc:v2:` 前缀会因 AAD 不匹配被拒绝。

## 状态所有者

- **主密钥解析**：`packages/shared/src/node/credentialMasterKey.ts`（同步，依赖 `node:crypto`/`node:fs` 与钥匙串访问器）。
- **分歧材料（R2）**：`divergentFileKey` 只在 `credentialMasterKey.ts` 的并存分支产生（唯一知道并存态的地方）；回退解密归 `credentialCipher.ts`（host 与 CLI 共用）；收敛重写与解密失败留证归 `credentialService.ts`（凭据文件读写漏斗的唯一所有者）。
- **OS 钥匙串访问**：`packages/shared/src/node/credentialKeychain.ts`（R1-a；dumb secret store——四态显式 found/absent/unavailable/error、从不抛错、不理解密钥格式，长度校验归解析层）。
- **cipher 实现**：`packages/shared/src/node/credentialCipher.ts`，经 `@acode/shared/node` 导出，两套调用方共用。
- **调用方**：`packages/services/src/credential/providers/credentialCipherProvider.ts` 与 `apps/acode-cli/packages/adapters/src/auth/credential-cipher.ts` 均退化为委托层，保留既有导出名以免改动调用点（R1-a 零改动：`keychain` 注入位随 options 透传）。

## 接口

cipher 接口保持**同步**（`encrypt/decrypt`），因为它被 `credentialService` 与 CLI `shared-credentials` 在文件锁内联调用。P0-4 时点「safeStorage/keytar 皆异步」是不接入的直接原因；R1-a 的解法（设计文档 D2）不是异步化整条链，而是**平台工具 `spawnSync` 一次性解析 + 解析层进程级缓存**（found/unavailable 缓存；absent/error 不缓存——前者生成写入后须可见，后者必须每次现场 fail-loud）。钥匙串访问频率 = 每进程每数据目录至多一次成功 spawn。Windows PowerShell DPAPI 延迟**已实测**（2026-10-03，Win10 26200，`scripts/smoke-credential-keychain.mjs`）：连发热态 ~225ms/次，间隔真实使用 ~860–930ms/次，冷启动（开机后首调/程序集缓存被逐出）0.9–2s——原「约 100–300ms」的预估登记项据此关闭。缓解为惰性解析（首次加解密才触发）+ 进程级缓存；CLI 短进程在触碰凭据的路径上付 ~0.9s，若成体感痛点，登记的后续优化是 bootstrap 异步预热（进程启动即并行 spawn 填充缓存），而非回退材料落盘。

R2 接口增量：`ResolvedCredentialMasterKey` 增加可选 `divergentFileKey?: Buffer`（仅 `source === "keychain"` 且与密钥文件材料分歧时有值；**只作解密回退，绝不用于加密**）。`ACodeCredentialCipher` 增加可选 `decryptWithFallbackInfo?(value) → { plaintext, usedFallbackKey }`（共享工厂恒实现；声明为可选以免破坏既有测试 stub 与委托层），`decrypt` 语义 = `decryptWithFallbackInfo().plaintext`。`ICredentialService` 接口**不变**（收敛与留证都发生在 host 实现内部，不跨 RPC 边界）。

## 已知边界（诚实声明）

- **降级文件模式**（钥匙串不可用/未迁移遗留）：密钥文件与密文同盘，**不能**防住「整个 `.acode` 目录被外带」。它防住的是：由公开机器属性离线推导密钥，以及同用户名异机复用同一可推导密钥。降级发生时有一次性告警。
- **钥匙串模式（R1-a）**：材料与密文分离，目录外带到异机/异用户不可解密（Windows DPAPI blob 为逻辑分离：物理同目录、仅同机同用户可解）。**钥匙串条目即新单点**：条目丢失（OS 重装未迁移钥匙串、手动删除条目、Linux secret service 清库）= 凭据不可解密，后果是重新登录/重输 Key（凭据本体可服务端重签发，非灾难数据）——与既有「密钥文件单点」同性质，README「本地凭据保护」口径在 R1-b 迁移批次同步更新。
- **备份/迁移工具不知情**：应用内置的数据目录迁移（`copyDataDirectory`）复制密钥文件，但**复制不了钥匙串条目**——迁移到钥匙串模式的安装在目标机上首次解析会走「无条目 → 有密钥文件则用之，否则新生成」路径。R1-b 迁移批次负责给出备份语义的 README 披露。
- **Linux 竞争窗**：`secret-tool store` 无排他语义，写前读+写后回读把并发首装的竞争窗压到毫秒级但未归零（macOS/Windows 有排他语义不受影响）。
- **回滚会静默损坏登录态**：旧版本只认 `enc:v1:` 前缀，遇 `enc:v2:` 会把密文原样当明文返回（表现为 401/无效 Key，而非明确错误）。已在 README 向用户披露「升级后勿回滚到升级前构建」。R1-a 后追加一层：回滚到 R1 前构建时，钥匙串模式安装**没有密钥文件**，旧构建会生成新密钥并孤立既有 v2 凭据——README 需同批披露（R1-b）。R2 再追加一层：材料分歧后**新构建侧**有回退解密 + 重加密收敛（见产品规则 R2），「混版双向互清」收敛为「旧构建侧单向失效」；旧构建自身的行为无法追溯修复。
- `enc:v1:` 支持在提供重加密迁移之前**不得移除**——移除等于让所有升级前保存的凭据当场变成不可解密的垃圾。（R1 钥匙串迁移是**零重加密**的——材料字节不变、只搬存放处，故与本条无关；v1 移除仍需独立的按值重加密迁移。）

## 验收场景

见 `packages/shared/tests/credential-master-key.test.mjs`（文件模式，注入 unavailable 钥匙串 stub 钉住 P0-4 语义）与 `packages/shared/tests/credential-keychain.test.mjs`（R1-a：平台访问器 mock spawn 全分支 + 解析链优先级）；真机层验证走 `scripts/smoke-credential-keychain.mjs`（真实平台机制、临时目录隔离、不进 CI——mock 与真机互补，2026-10-03 Windows 首轮 17 项全过并抓到 base64url 传输 bug）：

- 新密文为 `enc:v2:` 且可往返；降级文件模式的密钥文件生成在 `<baseDir>/.acode/v2/credential-key.json`，内容为 32 字节。
- 同 baseDir 的两个 cipher 实例互相解得开对方的密文（host + CLI 共用文件）。
- **全新安装**（尚无钥匙串条目与密钥文件）时 `ACODE_CREDENTIAL_SECRET` 生效且不生成任何持久材料；不同 secret 的实例解不开彼此的密文。
- **已存在密钥文件时密钥文件优先于 env**：再设 `ACODE_CREDENTIAL_SECRET` 不改变解析出的密钥，并发出一条告警（对抗评审 #5：防止升级后设 env 静默孤立全部 v2 凭据）。
- **R1-a 优先级链**：钥匙串 found → `source: "keychain"`；与密钥文件并存 → 钥匙串优先 + 并存告警；条目损坏（读 error / 长度不符）→ 抛错保留现场，绝不生成；钥匙串 absent + 文件存在 → `keyFile`；全新安装且钥匙串可用 → 生成直接入条目、**不落密钥文件**；钥匙串不可用/写入失败 → 文件模式 + 一次性降级告警。
- **R1-a 平台访问器**（mock spawn）：macOS found/absent(44)/重复写入回读赢家/ENOENT→unavailable；Windows blob wx 排他 + EEXIST 回读/PowerShell 失败→写入 unavailable（新装安全降级）/**blob 存在而 PowerShell 缺席→error（fail-loud）**；Linux stdin 写入/空 stdout→absent/D-Bus 缺失→unavailable/写后回读采用；不支持平台→unavailable。条目账户名含 keyFilePath 指纹（稳定且互异）。
- **Windows 传输回归**（2026-10-03 真机 bug 的 mock 钉桩）：base64url secret（含 `-`/`_`、无填充）写入时命令必须嵌**规范 base64**、原始形态绝不到达 .NET；write 返回规范化传输形态（字节同一）；命令用 `Assembly::Load` 前缀（防冷启动更慢的 `Add-Type` 回潮）；stderr 按 GBK 解码后告警可读（中文 locale 乱码回归）。
- **R1-b 迁移**：happy path（材料逐字节不变、文件删除、INFO 提示、二次解析幂等不再迁移）；回读不一致 → 条目回滚删除 + 文件保持权威 + 告警；写入失败 → 跳过迁移保持文件模式；unavailable → 绝不尝试迁移（headless 留在文件模式）。
- **R2 分歧回退**：并存且材料分歧 → 解析结果携带 `divergentFileKey` 且 `key`/`source` 不变（钥匙串权威）；材料相同 → 不携带；文件损坏 → 不携带且不抛错。用文件材料写入的 `enc:v2:` 密文，钥匙串主 cipher 经 `decryptWithFallbackInfo` 读回明文且 `usedFallbackKey: true`；两把材料都解不开 → 抛主密钥错误（`isCredentialDecryptError` 成立）；`encrypt` 产物只能被主密钥材料解开（分歧材料绝不产出新密文）。
- **R2 自愈收敛与留证**（host credentialService）：读到分歧密文后该值被主密钥材料重加密写回（删除回退材料后可直接解密）；CAS——锁内发现密文已被改写则放弃重写；收敛失败不影响本次读取返回明文；解密失败（两把材料都不行）时生成 `credentials.json.corrupt-<hash>.bak`（内容与原文件一致）且错误仍满足 `isCredentialDecryptError` 上抛。
- 历史 `enc:v1:` 仍可解密（升级不丢凭据）。
- v1 密文改贴 `enc:v2:` 前缀被 GCM 拒绝（版本混淆攻击不成立）。
- 明文值原样返回。
- 主密钥与旧派生结果不同，且重复解析幂等（读既有材料而非重新生成）。
- **`encrypt()` 绝不产出 `enc:v1:`**：三种密钥来源（随机文件 / env / 显式）逐一断言（这是 P0-4 的核心安全属性，也是 `isEncryptedACodeCredentialValueV1` 的真实用途）。
- **解密失败携带稳定 code + CJK 前缀**，满足 `isCredentialDecryptError`（对抗评审核实的回归：合并 cipher 时曾丢失该契约，令 OAuth 损坏会话恢复路径失效）。
- 源码不变量：可推导回退串只允许在 `credentialCipher.ts` 的 legacy 解密路径被**构造**（注释中提及不算违规）。
