# 凭据静态加密：主密钥来源与版本迁移

安全加固 P0-4。定义凭据静态加密的主密钥来源、密文版本语义与升级迁移规则。

## 背景

此前 AES-256-GCM 的密钥为 `sha256(ACODE_CREDENTIAL_SECRET ?? "acode-credential-fallback:{platform}:{homedir}:{username}")`。该环境变量在产物代码中从不被赋值，故永远走可推导回退：三个组成部分对同机任意进程公开可知、单轮 sha256、无盐、无机器绑定。`credentials.json` 一旦被外带（云同步/备份/磁盘镜像/恶意依赖/本产品自带的 Read·Bash 工具），即可纯离线还原全部 OAuth token 与付费 Key。

此外，桌面 host（`@acode/services`）与 CLI（`@acode/adapters/auth`）各持一份**完全等价**的 cipher 实现，两处需同步修改才能保持一致。

## 产品规则

- **主密钥来源优先级**：显式注入 secret（测试/宿主）> **已存在的密钥文件** > `ACODE_CREDENTIAL_SECRET` 环境变量 > 生成新的每安装随机密钥文件。
  - 密钥文件排在 env **之前**是刻意的：它一旦存在就拥有已写入的全部 `enc:v2` 凭据，绝不能被静默替换。若密钥文件与 `ACODE_CREDENTIAL_SECRET` 同时存在，env 被**忽略**并发出告警（`onWarn`），因为切到 env 派生的密钥会让既有 v2 凭据全部解不开。
  - env 仅在**尚无密钥文件**（全新安装显式配置）时生效；此时不生成密钥文件，后续调用同样走 env 以保持一致。
  - **反向脚注**：这意味着「先用 env 写入 v2、之后取消该 env」会落到生成分支、换一把新密钥，令 env 时期写入的凭据解不开。这是 env 配置的固有取舍——用 env 就必须一直用同一个 env。
- **每安装密钥文件**：`<凭据目录>/credential-key.json`，首次使用时随机生成 32 字节，`0600` 权限，`wx` 排他创建。排他创建保证并发首次启动时只有一个进程写入成功、落败方回读赢家的密钥，两个进程因此收敛到同一把密钥——这是桌面 host 与 CLI 共用同一 `credentials.json` 的前提。
  - **回读必须带重试**：赢家的 `writeFileSync` 不是原子操作，落败方可能在半截 JSON 上读到内容。旧实现直接 `JSON.parse` 会抛未捕获的 `SyntaxError` 崩进程（对抗评审核实，且直接反驳了「必然收敛」）。现在落败方按 `[10,25,50,100,200]ms` 退避重试；重试耗尽仍读不出则**保留现场报错**，绝不回退到生成新密钥——生成等于换一把密钥，会把已写入的全部 `enc:v2` 凭据变成永久垃圾。
- **密钥文件与凭据文件同目录**：所有调用点必须把凭据文件所在目录显式钉给 cipher（`keyFilePath`）。若各自独立解析 baseDir，宿主用 `setDataBaseDir` 切换数据根后会出现「凭据在新目录、密钥在旧目录」的分裂并解密失败。
- **派生**：env/显式 secret 经 scrypt（带固定盐做域分离）派生；密钥文件内容为主密钥，经 HKDF-SHA256（带盐 + info 域分离）派生数据加密密钥。不再使用单轮 sha256。
- **密文版本语义**：
  - `enc:v2:` 当前格式。AES-256-GCM + 每值随机 12 字节 IV + 绑定格式版本的 AAD。
  - `enc:v1:` **仅可解密，永不产出**。沿用旧的可推导密钥，唯一目的是让升级前已落盘的凭据仍可读。
  - 未带 `enc:` 前缀的值视为历史明文，原样返回（与旧实现行为一致）。
- **版本混淆防护**：v2 密文绑定 AAD，v1 密文加密时未绑 AAD（故 v1 解密路径**不得**传 AAD，否则 GCM 标签必然校验失败并毁掉全部既有凭据）。把 v1 密文重新贴上 `enc:v2:` 前缀会因 AAD 不匹配被拒绝。

## 状态所有者

- **主密钥解析**：`packages/shared/src/node/credentialMasterKey.ts`（同步，仅依赖 `node:crypto`/`node:fs`）。
- **cipher 实现**：`packages/shared/src/node/credentialCipher.ts`，经 `@acode/shared/node` 导出，两套调用方共用。
- **调用方**：`packages/services/src/credential/providers/credentialCipherProvider.ts` 与 `apps/acode-cli/packages/adapters/src/auth/credential-cipher.ts` 均退化为委托层，保留既有导出名以免改动调用点。

## 接口

cipher 接口保持**同步**（`encrypt/decrypt`），因为它被 `credentialService` 与 CLI `shared-credentials` 在文件锁内联调用。这是本次不接入 Electron `safeStorage` / `keytar` 的直接原因：两者均为异步，接入需把整条 cipher 链改成异步。

## 已知边界（诚实声明）

- 密钥文件与密文同盘，本改动**不能**防住「整个 `.acode` 目录被外带」。它防住的是：由公开机器属性离线推导密钥，以及同用户名异机复用同一可推导密钥。
- **密钥文件即单点**：删除 `credential-key.json`、或备份/迁移时只带 `credentials.json` 漏掉密钥文件，会让全部 `enc:v2` 凭据永久不可恢复。应用内置的数据目录迁移（`copyDataDirectory`）会连同密钥文件一起复制，但外部手动备份/清理工具不受其保护。这两条已在 README 的「本地凭据保护」向用户披露。
- **回滚会静默损坏登录态**：旧版本只认 `enc:v1:` 前缀，遇 `enc:v2:` 会把密文原样当明文返回（表现为 401/无效 Key，而非明确错误）。已在 README 向用户披露「升级后勿回滚到升级前构建」。
- 真正的「密文与密钥分离」需要 OS 钥匙串。跨进程密钥一致性是该工作的核心难点：桌面 host 与 CLI 共用同一 `credentials.json`，若一方用 Electron `safeStorage`、另一方用 `keytar`，两者互不相通，桌面写入的凭据 CLI 将读不出来。后续方案必须让两进程共用同一条钥匙串记录，或提供一次性重加密迁移。
- `enc:v1:` 支持在提供重加密迁移之前**不得移除**——移除等于让所有升级前保存的凭据当场变成不可解密的垃圾。

## 验收场景

见 `packages/shared/tests/credential-master-key.test.mjs`：

- 新密文为 `enc:v2:` 且可往返；密钥文件生成在 `<baseDir>/.acode/v2/credential-key.json`，内容为 32 字节。
- 同 baseDir 的两个 cipher 实例互相解得开对方的密文（host + CLI 共用文件）。
- **全新安装**（尚无密钥文件）时 `ACODE_CREDENTIAL_SECRET` 生效且不生成密钥文件；不同 secret 的实例解不开彼此的密文。
- **已存在密钥文件时密钥文件优先于 env**：再设 `ACODE_CREDENTIAL_SECRET` 不改变解析出的密钥，并发出一条告警（对抗评审 #5：防止升级后设 env 静默孤立全部 v2 凭据）。
- 历史 `enc:v1:` 仍可解密（升级不丢凭据）。
- v1 密文改贴 `enc:v2:` 前缀被 GCM 拒绝（版本混淆攻击不成立）。
- 明文值原样返回。
- 主密钥与旧派生结果不同，且重复解析幂等（读文件而非重新生成）。
- **`encrypt()` 绝不产出 `enc:v1:`**：三种密钥来源（随机文件 / env / 显式）逐一断言（这是 P0-4 的核心安全属性，也是 `isEncryptedACodeCredentialValueV1` 的真实用途）。
- **解密失败携带稳定 code + CJK 前缀**，满足 `isCredentialDecryptError`（对抗评审核实的回归：合并 cipher 时曾丢失该契约，令 OAuth 损坏会话恢复路径失效）。
- 源码不变量：可推导回退串只允许在 `credentialCipher.ts` 的 legacy 解密路径被**构造**（注释中提及不算违规）。
