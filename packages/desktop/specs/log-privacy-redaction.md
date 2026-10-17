# 日志隐私脱敏：桌面主进程漏斗、Windows 注册表真名与分节支持包（desktop）

核心脱敏机制在 `packages/shared/specs/log-privacy-redaction.md`；
服务层漏斗在 `packages/services/specs/log-privacy-redaction.md`。
本 spec 覆盖 `packages/desktop` 侧的三件事：main 日志单一漏斗挂脱敏、
Windows 用户名注册表真值收集、exportLogs 升级分节支持包。

## 产品规则

### 漏斗（logger.ts）

- R1 `packages/desktop/src/main/logger.ts` 的 `write()` 是 main 进程日志文件
  的**唯一漏斗**：main 直调、renderer 经 `fromRenderer`（ui logger →
  `window.acode.log` → PlatformChannels.Log IPC）、host 进程经
  `hostLogRelay`（结构化 postMessage 与 stdout/stderr 兜底）全部汇入。
  脱敏挂在 `write()` 一处，禁止在调用点散挂。
- R2 文件行与 console 行使用同一份脱敏后文本：args 中字符串逐个过
  `redactLine`，非字符串 `JSON.stringify` 后过 `redactLine`（与既有
  message 拼接语义一致）；管线 fail-closed（异常 → 该行 `<withheld>`）。
- R3 ui logger 直通 main 漏斗，确认覆盖即可，不在 ui 侧重复脱敏。

### Windows 注册表真名（logPrivacyIdentity.ts）

- R4 身份收集优先级：注册表真值 > env 派生，两者取并集（env 撒谎或缺失
  也能正确 redact）。注册表证据：
  - `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`：
    `ProfilesDirectory` 值 + 各 SID 子键的 `ProfileImagePath`/`CentralProfile`；
  - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI`：
    `LastLoggedOnDisplayName`/`LastLoggedOnSAMUser` +
    `SessionData\<sid>` 子键的 `LoggedOnDisplayName`/`LoggedOnSAMUser`。
  - 名字后处理：剥 `.000`/`.V2` 类后缀（`\.\d{3}$`、`\.V\d$`）、
    剥 `域\`/`机器名\` 前缀补全（USERDOMAIN/COMPUTERNAME 大小写不敏感）。
- R5 注册表访问用系统自带 `reg.exe query`（execFileSync，一次性、带超时、
  try/catch），零新增依赖；任何失败（非 Windows、reg 不可达、输出不可解析）
  → 静默退回 env 派生，绝不抛出、绝不阻塞日志写入。
- R6 身份与主机名注册表在 main 进程内是模块级单例（懒初始化，首次写日志时
  构建）；`os.hostname()`、env 的 COMPUTERNAME/USERDOMAIN、身份用户名
  以 `host`/`user` 类别收名进注册表。运行期远端主机名（SSH/远程 workspace）
  由连接建立点调用 `registerLogHostName` 收名——该接线不在本模块所有权内，
  作为接线需求输出。
- R7 截断不劈名字：支持包与任何按长度截断的出口使用注册表的
  `truncatePreservingNames`。

### 分节支持包（supportBundle\*.ts）

- R8 节注册表形态：`{id, group, label, defaultChecked, appliesIn(ctx), collect(ctx)}`；
  `label` 即隐私承诺文案（自撰中文，明确「收了什么、脱敏了什么」），
  `group ∈ {metadata, logs}`。节清单（首批）：
  - `system-info`（metadata）：about 快照（版本/平台/架构/构建），不含用户文件内容；
  - `credentials-status`（metadata）：仅 `{status, providers, count}`——
    status ∈ not-configured/corrupt/ok，providers 为 `oauth:<provider>:…` 键名
    去重派生，count 为键数；**不读任何值、不解密**；
  - `main-log`（logs）：main 日志 tail ~1MB → 过滤 warn|error → 预算采样；
  - `cli-log`（logs）：`~/.acode/cli/log` 最新 jsonl tail → 过滤
    `"level":"warn|error"` → 预算采样；
  - `cua-helper-log`（logs，appliesIn：目录存在 \*.exit.log）：Helper 退出诊断。
- R9 日志预算采样：tail 读取上限 ~1MB（读文件尾部字节，丢弃首个不完整行）；
  过滤 warn|error 后按预算采样——优先类（API/流/协议错误事件行）从尾部取
  最多 150 行，再从尾部补足普通类至总预算（400 行）。
- R10 每节内容尾部截断：超过节字节上限（512KB）保留尾部并前置标记
  `…（已截断，显示最后 N 字节）`；截断走 R7 不劈名字。
- R11 节收集失败不中断整包：`collect` 抛异常 → 该节内容
  `<section failed: 错误摘要>`（摘要本身过脱敏管线）。
- R12 导出写入：staging 目录组装 → zip 写 `<outputRoot>/acode-support-<ts>.zip.tmp`
  → rename 为最终名。Windows 上 rename 可能被杀软/索引器短暂占用：
  指数退避 200ms×2^n，总预算封顶 5s，预算耗尽按失败处理（保留 tmp 供清扫）。
- R13 陈旧 tmp 清扫：导出开始与结束后清扫 outputRoot 下 `*.zip.tmp`
  mtime 超过 10 分钟的陈旧文件；清扫失败静默（warn 一行）。
- R14 支持包内容全部过脱敏管线：日志行先过 shared 脱敏（凭据/路径/主机名/URL/
  SID/会话门），凭据类节天然无值；导出文件不落任何明文机密。

## 状态所有者与事件顺序

```text
exportSupportBundle(options)                      [supportBundle.ts]
  ├─ sweepStaleTmp(outputRoot, 10min)             ← R13（前置清扫）
  ├─ ctx = await buildContext()                   ← logsDir/cliLogDir/about/credentials
  ├─ applicable = registry.filter(appliesIn(ctx)) ← R8
  ├─ selected = options.sections ?? defaultChecked
  ├─ for section: content = collect(ctx)          ← R11 失败隔离
  │     └─ tail(1MB) → filter(warn|error) → sample(150优先+尾部补足) → 截断标记
  ├─ zip(staging) → out.tmp → renameWithBackoff(200ms×2, ≤5s)  ← R12
  └─ sweepStaleTmp(outputRoot, 10min)             ← R13（后置清扫）

logger.write(level, source, ...args)              [logger.ts 单一漏斗]
  └─ redactArgs(args)（懒初始化单例 redactor）→ 文件行 + console 同源
        identity：注册表真名 ∪ env 派生（R4/R5，一次性 execFileSync）
        registry：进程级收名（R6），远端主机名由连接点运行期补登记
```

## 失败语义

- reg.exe 任何失败 → env 派生身份，日志功能不受影响（R5）。
- 脱敏管线异常 → 该行 `<withheld>`（shared R5），日志继续写。
- rename 退避预算耗尽 → 导出返回失败并保留 tmp（等 10 分钟清扫）。
- 单节 collect 失败 → 节内错误占位，其余节照常（R11）。
- tail 读文件失败（ENOENT/权限）→ 节内容为 `(无 <文件名> 或不可读)` 说明行。

## 验收场景

1. `logger.warn` 写入含 homedir/用户名/内网 URL/Bearer token 的行 →
   落盘行为占位符形态；renderer 经 fromRenderer、host 经 relay 同样被覆盖。
2. 注册表输出样例（ProfileImagePath=`C:\Users\Real.Name.000`、
   LastLoggedOnSAMUser=`CORP\alias`）→ 身份名字集含 `Real.Name`、`alias`；
   env 名与注册表名不一致时两者都能被替换。
3. reg.exe 抛错 → 身份退回 env 派生，redactLine 仍工作。
4. 支持包：勾选节全部产出；`credentials-status` 节文本不含任何凭据值
   （仅 status/providers/count）；节 collect 抛错时包仍生成且含
   `<section failed:` 占位。
5. 日志节：>1MB 文件只读尾部；warn|error 过滤生效；优先类 150 行 + 尾部补足；
   超上限节有 `…（已截断，显示最后 N 字节）` 标记且标记后首行完整。
6. rename 首次 EPERM 第二次成功（假时钟）→ 导出成功；持续失败 5s 预算耗尽 →
   返回失败、tmp 保留。
7. 10 分钟前的 `*.zip.tmp` 被清扫；新鲜 tmp 不被清扫。
8. exportLogs 的 isSensitiveKeyName 与 shared 单源同源（词表收敛后行为回归：
   `x-api-key-v2` 脱敏、`max_tokens` 保留）。

## 迁移边界

- `exportLogs.ts` 本地敏感键词表删除，改为消费 shared 单源（行数净减）；
  `exportLogs()`/`createFeedbackLogArchiveFromExportLogs()` 签名与行为不变。
- 支持包是新入口 `exportSupportBundle()`；IPC/菜单/设置页接线与 locale 键
  不在本模块所有权内，作为接线需求输出。
- `logger.ts` 保持 ≤400 行；注册表收集与单例构建在新文件
  `logPrivacyIdentity.ts`（≤400 行）。
