# 日志隐私脱敏核心机制（shared）

把 AGENTS.md 日志纪律（不在日志/示例/提交中写入凭据、真实用户数据、内部服务地址）
从约定升级为机制。本 spec 覆盖 `packages/shared` 内的纯函数脱敏原语；
桌面端漏斗与 Windows 注册表真名见 `packages/desktop/specs/log-privacy-redaction.md`，
服务层漏斗见 `packages/services/specs/log-privacy-redaction.md`。

## 产品规则

- R1 敏感键名词表**单源化**：`sensitiveKeyNames.ts` 是「哪些键名属于机密」的唯一事实源。
  `feedbackPrivacy.ts`（反馈面）与日志脱敏管线（`logRedactionPipeline.ts`）、
  桌面导出（`exportLogs.ts`）全部同源消费，禁止再出现第二套词表。
  词表 = 原 feedbackPrivacy 族（password/passwd/passphrase/secret/token/apikey/
  accesskey/privatekey/authorization/cookie/credential）∪ 原 exportLogs 族
  （pwd/dsn/auth/conn-str/database-url/db-url）∪ 新增精确键与组合后缀
  （x-api-key、x-amz-security-token 等 header 拼写；`-keys/-secrets/-tokens`
  组合后缀及 `-v2`/`_v10` 版本号形态）。
  白名单（max_tokens 等 LLM 计数、author、public_key、keywords、tokenizer）
  同属该单源，防止「脱掉排障所需上下文」的过度抑制在两处漂移。
- R2 主机名注册表运行期收名：`logRedactionHostNames.ts` 提供进程级注册表。
  收名规则：NFC 归一 + casefold（逐字符 toLowerCase，失败保留原字符；ς→σ）+
  剥尾部点号；长度 <3 或 >255 不收；`localhost`/`127.x.x.x`/`::1` 不收；
  上限 2000 条，超限置 `full` 标志并停止收录（fail-closed 方向：宁可不替换，
  不可让注册表无界增长拖垮正则）。每个名字登记 NFC 与 NFD 双打印形态；
  剥不可见码点（Cc/Cf/U+034F/U+2028/U+2029）后若与原形不同，递归补登记。
- R3 组合正则按名单引用 + size 缓存：注册名按长度降序拼接单一正则，
  缓存键 =（names Map 引用, size）；仅当注册表变化时重建，绝不逐行重建。
  边界守卫：`(?:(?<=%[0-9a-f]{2})|(?<![\p{L}\p{N}_-])(?<![\p{L}\p{N}_-]\.))`
  前缀 + `(?![\p{L}\p{N}_-])(?!\.[\p{L}\p{N}_-])` 后缀（giu）——
  percent-encoded 边界（`%41name` 形态）也算命中，防止编码绕过；
  点号守卫防止把 `example.com` 中的 `com` 段或子串误替换。
  占位符/errno/平台词/日志级别词进入排除名单，防止 `<host>` 等占位符被再次收名替换。
- R4 命中替换 `<user>`（来自身份收集的用户名类）/`<host>`（主机名类）占位符。
- R5 fail-closed：脱敏管线任何一步抛异常 → 该行整体改发 `<withheld>`，
  并允许经由注入的 `onError` 回调告警（回调自身异常也吞掉）。
  不存在「脱敏失败就发原文」的路径。
- R6 截断不劈名字：`truncatePreservingNames(text, limit)` 截断点若落在任一
  注册名的打印形态内部，则按边界回退（名字整段进或整段出），回退后仍超限则递归。
- R7 路径/PII 占位符五类：`<home>`（homedir 前缀）、`<user>`
  （`/Users|/home/<name>`、`<ProfilesDir>/<name>`、注册表真名）、`<vol>`
  （`/Volumes|/mnt|/media/<name>`）、`<unc>`（`\\server\share`）、
  `<drv>:`（盘符）。替换跳过 URL authority 区间（`scheme://` 之后的 host 段
  由 URL 策略处理，不得被路径规则劈碎）。
- R8 Windows 用户名优先注册表真值：身份构建器接受注入的注册表证据
  （HKLM ProfileList 各 SID 的 ProfileImagePath/CentralProfile、LogonUI
  LastLoggedOnDisplayName/LastLoggedOnSAMUser、SessionData 各会话
  LoggedOnDisplayName/LoggedOnSAMUser、ProfilesDirectory），
  含 `.000`/`.V2` 后缀剥离与 `域\名`/`机器名\名` 补全；注册表不可达时退回
  env 派生（USERPROFILE/HOMEDRIVE+HOMEPATH/USER/USERNAME/LOGNAME +
  os.userInfo/homedir）。env 撒谎或缺失也必须能正确 redact——
  因此注册表证据与 env 派生值取**并集**，全部进占位符与收名注册表。
- R9 URL 策略（`logRedactionUrls.ts`）：
  - 文本中的 http(s)/ws(s) URL 只留 origin：`scheme://host[:port]/<path>`；
    无法解析 → `<url>`。
  - 非 http(s)/ws(s) scheme：仅当「scheme 是简单小写连字符拼写（≤20 字符）
    且脱敏后不变形」才保留 scheme 前缀，其余 → `<url>`；含 `@` 直接 `<url>`。
  - host 为 IP 字面量（v4/v6，含 `[::1]` 与点分/横线变体）、无点主机
    （localhost 除外）、`.local/.lan/.home/.home.arpa/.internal/.localdomain/.localhost`
    结尾 → 一律 `<url>`（内部服务地址不落日志）。
  - userinfo 剥除且识别编码绕过：`%40`、`%25*40`、`\u0040`、`\x40` 出现在
    authority 位置即整段 `<url>`；稠密 URL（单 token 内 `://` 超过 32 次）
    整体替换为 `<redacted:dense-urls:Nb>` 防正则放大。
  - `\\?\`、`\\.\`、`\\?\UNC\` 设备/UNC 前缀先归一（UNC → `\\host\share`）
    再进脱敏；归一时在首个 `?`/`#`（含 percent 编码形态）处截断。
- R10 Windows SID → `<sid>`：`\bS-1-\d+(?:-\d+){4,}\b` 全文替换（大小写不敏感）。
- R11 机密值形态脱敏：Bearer/Basic 凭据、私钥块、常见厂商 key 拼写
  （sk- 前缀长 token、AKIA/ASIA、AIza、ghp*/gho*/ghu*/ghr*/ghs*、github_pat*、
  xox\*、JWT `ey…` 三段式）、长 base64/blob（≥40 字符）、敏感键 kv
  （消费 R1 单源）→ `<token>`/`<jwt>`/`<blob>`/`<redacted>`。
  email → `<email>`；IPv4/IPv6 字面量 → `<ip>`（`HH:MM:SS` 时间形态豁免）。
- R12 session/task id 出网形态门（`sessionEgressGate.ts`）：
  ACode 自己的 id 拼写（调查自 `apps/acode-cli/packages/contracts/src/interfaces/shared.ts`
  与 cli-workflow）：`sess_/turn_/evt_/query_/tool_/msg_/part_/input_/proj_/ws_/wf_`
  前缀 + `[A-Za-z0-9._-]{1,128}` 主体（uuid、`<base36ts>_<uuid>` 可排序段、
  `subagent_<id>`/`dwf-…` 派生段），`dwfrun-/dwfeval-/launch-/settings-/acp-prompt-`
  连字符前缀 + uuid 主体，以及裸 UUID（TraceId）。
  - 合法形态正则 = 上述三族的并集。
  - 出网值只允许：`""`、`local_*` 前缀、`sha256_[0-9a-f]{64}`。
  - 文本中检出「疑似会话 token」（带上述任一前缀）但**不符合合法形态** →
    判定泄漏，`detectSuspectedSessionTokenLeak(text)` 返回 true；
    消费方（脱敏管线）对该行 fail-closed 抑制为 `<withheld>`。

## 状态所有者与事件顺序

```text
身份/注册表证据（desktop main 收集，一次性）
        │ buildLogRedactionIdentity(注入值, 纯函数)
        ▼
LogRedactionIdentity（不可变快照）──┐
                                    │ createLogRedactor(identity, registry)
主机名注册表（进程级单例，运行期收名）─┘        │
        │ register(kind, name)               ▼
        ▼                            LogRedactor.redactLine(text)
  names Map（size 变化 → 组合正则重建，引用+size 缓存）
                                             │
                     阶段顺序（任一异常 → "<withheld>"）：
                     ① UNC/设备路径归一 → ② SID → ③ userinfo 剥除
                     → ④ URL 策略 → ⑤ 会话 token 泄漏检测（命中 → "<withheld>"；
                     必须先于机密形态——blob 规则会吞掉超长非法 token）
                     → ⑥ 身份路径占位符（<home>/<user>/<vol>/<unc>/<drv>:）
                     → ⑦ email/IP → ⑧ 机密值形态 → ⑨ 主机名组合正则
```

- 注册表是唯一收名所有者；管线只读。管线按「名单引用+size」判断是否重建正则，
  不复制名单（避免第二份真相）。
- 脱敏是幂等的：占位符词汇（`<home>`、`<user>` 等）在收名排除名单里，
  二次过管线不产生新变形（桌面 main 漏斗与 serviceLogger 漏斗串联时依赖此不变量）。

## 接口（公开面，经 packages/shared/src/index.ts 桶导出）

- `sensitiveKeyNames.ts`：`isSensitiveLogKeyName(key)`、`SENSITIVE_KEY_NAME_PATTERN`、
  `NON_SENSITIVE_LOG_KEY_ALLOWLIST_PATTERN`、`normalizeLogKeyName(key)`。
- `logRedactionIdentity.ts`：`LogRedactionIdentity`、`buildLogRedactionIdentity(input)`、
  `collectWindowsProfileNameEvidence(input)`（纯函数，注册表原始值→名字/目录证据）。
- `logRedactionHostNames.ts`：`createHostNameRegistry()`（register/registerAll/
  truncatePreservingNames/snapshot/isFull）。
- `logRedactionUrls.ts`：`redactUrlsInText(text)`、`normalizeDeviceAndUncPaths(text)`、
  `redactWindowsSids(text)`。
- `logRedactionPipeline.ts`：`createLogRedactor({identity, registry, onError})` →
  `{ redactLine(text), redactArgs(args) }`。
- `sessionEgressGate.ts`：`ACODE_SESSION_ID_PATTERN`、`isAllowedEgressSessionValue(value)`、
  `detectSuspectedSessionTokenLeak(text)`。

## 失败语义

- 任何阶段异常 → 整行 `<withheld>`（R5）；onError 只用于诊断，不影响输出。
- 注册表 full → 停止收名，已收名字继续替换；truncate 仍用已登记打印形态。
- 会话 token 泄漏检测命中 → 整行 `<withheld>`，不尝试局部修补。
- 身份输入为空/不可用 → 退化为「无身份占位符」的最小管线（URL/SID/机密形态/
  会话门仍然生效），绝不因身份缺失抛异常。

## 验收场景

1. `isSensitiveLogKeyName("x-amz-security-token")`、`("api-key-v2")`、`("client_secrets")`
   为 true；`("max_tokens")`、`("author")`、`("public_key")` 为 false（R1 白名单）。
2. 注册表收名：`Example.Host`（NFD、含零宽码点、ς 结尾变体）登记后，
   文本中 NFC/NFD/casefold 形态与 `%45xample.host` percent 边界形态都被替换为 `<host>`；
   `localhost`、`127.0.0.1`、`::1`、两字符名不被收录。
3. 注册 2000 条后再注册 → `full=true` 且 size 不再增长。
4. 组合正则只建一次：连续 redact 1000 行，注册表不变则不重建（缓存计数断言）。
5. `truncatePreservingNames` 截断点落在注册名内部时回退到名字边界，名字不出现半截。
6. 管线内注入抛异常的 identity → 输出 `<withheld>` 且不抛出。
7. `C:\Users\RealName\...`（注册表真名与 env 名不一致）→ `<home>`/`<user>` 正确替换；
   `\\?\UNC\server\share\x` 先归一再脱；`\\srv\share` → `<unc>`；`D:\a` → `<drv>:\a`。
8. `https://user:pass@internal.host:8443/a/b?sig=1#f` → `<url>`（userinfo+内部主机）；
   `https://api.example.com/v1/x?key=1` → `https://api.example.com/<path>`；
   `http://box.local/x`、`http://10.0.0.5/x`、`http://nodots/x` → `<url>`；
   `weird-scheme://h/p` 保留 `weird-scheme:` 仅当脱敏后不变形，否则 `<url>`。
9. `S-1-5-21-1234567890-1234567890-1234567890-1001` → `<sid>`。
10. `sess_` 前缀但含非法字符/超长的 token 出现在文本 → `detectSuspectedSessionTokenLeak`
    为 true，`redactLine` 输出 `<withheld>`；合法 `sess_<uuid>` 不触发泄漏判定。
11. `isAllowedEgressSessionValue`：`""`/`local_abc`/`sha256_<64hex>` 为 true；
    `sess_<uuid>` 裸值为 false（出网必须哈希）。
12. feedbackPrivacy 行为回归：收敛词表后原反馈脱敏语义不回退
    （Authorization/Cookie/Bearer/私钥块/敏感 kv/URL 凭据仍被脱敏）。

## 迁移边界

- 本 spec 只新增 shared 纯函数模块 + 收敛 `feedbackPrivacy.ts` 词表；
  不改 shared 既有导出签名（`redactFeedbackText` 签名不变）。
- `packages/shared/src/index.ts` 桶导出新增行；shared 是纳管模块，
  新文件全部 ≤400 行、无 IO、无 node 内建依赖（身份收集所需的一切值由调用方注入）。
- `sensitive-env-guard.ts`（子进程 env 继承闸）目的不同（剥离 vs 脱敏），
  本次不合并；其词表与本单源的一致性作为后续登记项跟踪。
