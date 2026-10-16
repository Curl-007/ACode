# SSH 连接期提示中介通道

本 spec 覆盖两件事：

1. `ssh2` 引擎 keyboard-interactive 认证的安全应答边界（修复「同一密码应答全部提示」缺口）；
2. 把 host-key challenge 的一次性 `challengeId` IPC 闭环泛化为「连接期提示通道」抽象，
   为 passphrase / 2FA（otp）等需要真人应答的提示预留统一中介入口。

机制参照外部还原工程的提示中介设计（提示分类、文本消毒、顺序闸、应答长度上限、
abort 闭集），全部文案与实现自撰；系统 OpenSSH 进程引擎（SSH_ASKPASS 助手、
broker 管道、asker 进程验证）不在本批范围，见「登记项」。

## 产品规则

### R1 提示消毒（展示前强制）

任何来自对端的提示文本（keyboard-interactive prompt/instructions、未来通道提示）
在展示、写日志或并入错误文案前必须经 `sanitizeSSHPromptText`（`sshPromptSanitize.ts`）：

1. 孤立代理对（`\p{Cs}`）替换为 `\0`，防止下游 UTF-8 编码歧义；
2. `\r\n`、`\r`、U+2028、U+2029 统一归一为 `\n`；
3. 剥除 `[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u3164\uFFA0]`
   （格式字符、默认不可见码点、盲文空白、谚文填充符）；
4. 其余控制字符（除 `\n`、`\t`）替换为空格；
5. 每行去尾随空白，3 个以上连续换行折叠为 2 个，整体 trim；
6. 超过 4096 字符时截断为「头部 1024 字符 + `\n…\n` + 尾部 3069 字符」。

**单源义务**：第 3 条的不可见字符族与
`apps/acode-cli/packages/core/src/permission/bash-confirm-reflex-gate.ts` 的
`INVISIBLE_CHARACTERS_PATTERN`（`\p{Cf}` + `\u2028\u2029\u2800\u3164\uFFA0` 七族）同源。
CLI 包不可被 server/services import，故本包内提炼为等价纯函数；任何一侧调整
不可见字符策略时必须同步另一侧并在两处注释互相指向。

### R2 keyboard-interactive 应答闭集

`createKeyboardInteractiveResponder`（实现位于 `sshKeyboardInteractive.ts`，由
`sshAuth.ts` re-export 保持既有 import 面）只允许一种自动应答形态：

- **单提示**、`echo === false`、消毒归一后的文本命中密码语义词表、且不含任何
  拒答标记 → 以连接密码应答（保持既有「服务端只开 keyboard-interactive 也能登录」能力）。

其余一律不盲答，记录结构化拒绝并以空应答结束本轮认证：

| reason（闭集）              | 触发条件                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `multi_prompt`              | 一次事件包含多于 1 条提示（ssh2 `finish` 是批量语义，逐条中介留待通道 UI 批次） |
| `second_factor_prompt`      | 提示命中 otp/2fa/mfa/totp/验证码/authenticator/token/pin 等双因素标记 |
| `passphrase_prompt`         | 提示命中私钥口令语义（passphrase/口令/パスフレーズ/private key 等）。连接密码不是私钥口令，答给它等于把密码交给错误的问题 |
| `unrecognized_prompt`       | 其余无法确认密码语义的提示（含 `echo === true`：可见输入不是密码槽位，例如 Username 提示；用密码应答会把凭据泄露进非密文通道） |

语义词表宁保守：拒答标记优先于密码白名单（例如「动态密码/验证码」同时含
「密码」与拒答词时判 `second_factor_prompt`）；无法确认即 `unrecognized_prompt`。
词表覆盖 en/zh（简繁）/ja/ko/de/fr/es/pt/it/nl/sv/no/da/pl/ru/tr/vi/id/ar 常见
密码与双因素措辞；新增语种按同闭集扩展，不引入自由文本匹配。

### R3 拒绝的错误通道形态

拒绝以 `SSHKeyboardInteractiveRefusalError` 表达，形态对齐 host-key challenge
错误通道（`SSHHostKeyVerificationError`）：稳定 `code`
（`ssh-keyboard-interactive-refused`）+ 闭集 `reason` + 消毒后的提示文本快照。
`normalizeSSHConnectError(error, context?)` 接受可选 context：认证失败且存在
本轮拒绝记录时，返回携带解释文案的拒绝错误，替代泛化的「认证失败」文案。
context 由连接层注入；未注入时（现有 `SSHBackend` 调用形态）行为不变。

### R4 连接期提示通道抽象

`sshPromptChannel.ts` 提供连接作用域的提示通道，一次连接一个实例：

1. **提示种类闭集**：`host_key` / `passphrase` / `otp` / `generic`。每个提示携带
   一次性 `promptId`、种类、`secret` 标记、消毒后的文本；`host_key` 额外携带
   结构化 challenge 载荷（host/port/status/candidateFingerprint/expectedFingerprints）。
2. **应答归一**：剥 `\r`、`\n`、`\0`；UTF-8 字节长度 > 1023 → 不接受该应答，
   abort `undeliverable`；secret 类提示的空应答视为 `dismissed`。
3. **abort 闭集**：`peer_unconfirmed` / `dismissed` / `undeliverable` / `expired`。
   handler 抛错按 `dismissed`；通道 dispose 时全部 pending 以 `expired` 结算；
   配置了 `promptTimeoutMs` 时超时按 `expired`。`promptId` 一次性：重复或
   错位的应答一律忽略并 fail-closed。
4. **顺序闸**：对端 host key 未经确认（verifier 未报 `trusted`，且用户未通过
   本通道对 challenge 作出 approve/replace 决策）之前，任何 `secret === true`
   的提示不交给 handler、不展示，直接 abort `peer_unconfirmed`。host_key 提示
   本身不受顺序闸限制（它就是确认对端的途径）。
5. **host-key challenge 是第一个消费者**：`requestHostKeyDecision(challenge)`
   把既有 `SSHHostKeyChallenge` 包装为 `host_key` 提示走同一通道；决策绑定校验
   （promptId/challengeId/candidateFingerprint 回显、`unknown→approve`、
   `changed→replace`、reject 直通）与 `SSHBackend.connectWithChallenge` 现行
   规则一致，校验失败抛 `SSHHostKeyDecisionError` 语义的错误。
   `createHostKeyChallengePromptHandler` 把存量 `SSHHostKeyChallengeHandler`
   适配为通道 handler，保证既有 Desktop IPC 闭环无需改动即可作为通道后端。
6. **keyboard-interactive 中介入口（预留）**：responder 可选接受
   `SSHKeyboardInteractiveMediatorPort`（结构化 `requestSecretPrompt`）。存在
   中介时，非密码语义的单提示按种类（`passphrase`/`otp`/`generic`）交给通道，
   由顺序闸与 abort 语义治理；通道 abort 或无中介 → 落回 R2 拒绝路径。
   多提示批次不经中介（v1 边界）。

### R5 状态所有者

- 通道实例是「对端已确认」状态与 pending 提示表的唯一所有者；verifier/backend
  只通过 `notifyHostKeyOutcome(status)` 通知结果，不保存第二份确认状态。
- 拒绝记录归 responder 实例所有（每次 keyboard-interactive 事件覆盖前值），
  连接层读取后注入错误归一化 context；不落盘、不跨连接。
- 提示文本只有消毒后形态可以离开 server 包；原始对端文本不写日志。

## UI 接口形状（登记，本批不实现）

未来 Desktop 中介面按以下 wire 形状接线（与 host-key challenge 的
`(webContentsId, requestId)` 路由纪律一致，promptId 即 requestId 语义）：

```ts
// main → renderer
interface SSHPromptRequestWire {
  promptId: string;                       // 一次性
  kind: "host_key" | "passphrase" | "otp" | "generic";
  host: string;
  port: number;
  secret: boolean;                        // renderer 据此决定掩码输入
  text: string;                           // 已消毒
  hostKeyChallenge?: {                    // kind === "host_key" 时携带
    challengeId: string;
    status: "unknown" | "changed";
    candidateFingerprint: string;
    expectedFingerprints: string[];
  };
}
// renderer → main
type SSHPromptReplyWire =
  | { promptId: string; value: string }                                   // 应答（≤1023B，剥 \r\n\0 由通道复核）
  | { promptId: string; abort: "dismissed" }                              // 用户关闭/拒绝
  | { promptId: string; decision?: "approve" | "replace" | "reject" };    // host_key 专用
```

路由失败、renderer 取消、窗口关闭 → 通道按 `undeliverable` / `dismissed` /
`expired` 结算。locale 键（提示面文案）随 UI 批次登记，不在本批写入。

## 失败语义与迁移边界

- 本批不改变 `SSHBackend` 的现行接线：responder 仍由 backend 以
  `createKeyboardInteractiveResponder(password)` 创建（无 mediator、无
  onRefusal），行为变化仅限于 R2 的应答收紧——单密码提示照旧成功，
  多提示/非密码提示从「盲答同一密码」变为「空应答 + 结构化拒绝记录」。
- backend 集成（注入 context 使拒绝解释进入用户可见错误、挂载通道、
  host-key challenge 改走 `requestHostKeyDecision`）与 UI passphrase/2FA
  输入面为后续批次登记项；接口形状见上节。
- 通道未被 backend 挂载前，顺序闸由通道自身语义保证（secret 提示在未确认
  时 abort），不存在「先出 secret 提示后验 host key」的路径。

## 登记项

1. **UI 提示面**：passphrase/2FA 输入界面 + locale 键 + Desktop IPC 路由
   （wire 形状见上）；host-key challenge 现有 IPC 闭环迁移到通道 handler。
2. **SSHBackend 集成**：`ssh-backend.ts` 非本批所有权；集成点为 responder
   创建（传 mediator + onRefusal）、`normalizeSSHConnectError` context 注入、
   challenge 重试循环委托 `requestHostKeyDecision`。
3. **系统 OpenSSH 进程引擎（条件触发）**：SSH_ASKPASS 助手/broker/asker
   进程验证等 ~15k 行验证逻辑量级的完整移植仅在「跳板机/ProxyCommand 用户
   成为远程 workspace 主流形态」时立项；届时本通道的种类闭集、顺序闸、
   应答归一与 abort 闭集直接复用，asker 验证类 abort（asker-unverifiable）
   在该批次扩展。
4. **remote/index.ts barrel**：通道与拒绝类型的公开导出（`@acode/server/remote`）
   随 backend 集成批次登记。

## 验收场景

1. 单条 `Password:`（echo=false）提示以连接密码应答，认证成功的既有能力不回退。
2. 两条提示（Password + OTP）→ 服务端收到空应答集，拒绝记录 reason=`multi_prompt`，
   密码未出现在任何应答里。
3. 单条 OTP/验证码提示（无中介）→ reason=`second_factor_prompt`，密码未应答。
4. `Username:`（echo=true）→ reason=`unrecognized_prompt`，密码不泄露进可见输入槽位。
5. 挂载中介且对端已确认 → otp 提示经通道到达 handler，应答回传后认证继续；
   对端未确认 → 通道 abort `peer_unconfirmed`，handler 未被调用，落回拒绝路径。
6. 消毒：Cf/默认不可见/填充符被剥除、CRLF 与 LS/PS 归一、控制符转空格、
   4096 截断保头尾；含不可见字符的提示文本进入错误文案前已消毒。
7. 应答归一：含 `\r\n\0` 的应答被剥净；1024 字节应答 → `undeliverable`；
   secret 空应答 → `dismissed`；handler 抛错 → `dismissed`；dispose 后 pending →
   `expired`；错位 promptId 的应答被忽略。
8. host_key 消费：challenge 经 `requestHostKeyDecision` 往返，approve/replace/reject
   绑定校验与现行 backend 规则一致；错误绑定 fail-closed。
