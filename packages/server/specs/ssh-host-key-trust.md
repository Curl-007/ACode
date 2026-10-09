# SSH 主机密钥信任边界

## 产品规则

1. `ssh2` 连接必须设置 `hostHash: "sha256"` 和同步 `hostVerifier`；没有信任记录时 fail-closed。
2. 信任端口由宿主注入 `SSHHostKeyTrust`。旧的 `resolve(host, port)` 仍返回此前明确批准的 SHA-256
   host key fingerprint 或只读 fingerprint 列表（例如 `SHA256:...`）；支持 candidate-aware 的
   `resolveCandidate(host, port, candidateFingerprint)` 时，返回 `trusted`、`unknown`、`changed`、
   `revoked` 或 `unavailable` 裁决及当时的 expected fingerprints。兼容 ssh2 的 64 位 hex hash，比较前
   统一转换为 OpenSSH SHA256 base64 表示。server 不在连接过程中写入或猜测信任记录。
3. 首次连接（没有记录）拒绝；收到与记录相同的 key 允许；收到不同 key 视为 changed 并拒绝。
   这些裁决都在 SSH 用户认证前完成，不能先尝试 password、agent 或 keyboard-interactive。
4. 没有注入 trust store、trust store 抛错、返回空值或返回非字符串时均拒绝；非交互连接没有确认回调，
   不允许自动接受未知 key。`revoked` 是不可交互批准的终态，不能降级为 `changed`。
5. 交互宿主可注入候选密钥挑战处理器。挑战只在 `hostVerifier` 拒绝后产生，必须携带一次性
   `challengeId`、规范化 host/port、候选 SHA-256 fingerprint、裁决状态和当时的已批准指纹快照。
   挑战产生前不得尝试 password、agent、keyboard-interactive、上传或 exec。
6. 决策必须回显同一个 `challengeId` 与候选 fingerprint；`unknown` 只允许 `approve`，`changed`
   只允许显式 `replace`，`reject` 永不重试。决策过期、重复、目标或 fingerprint 不匹配均 fail-closed。
   单次连接最多因一个挑战重试一次。
7. 托管 trust store 由宿主持有并使用版本化 JSON 记录 `host + port + fingerprints`；每条记录可带
   `allowKnownHostsOverride`，仅同一候选的显式 `changed → replace` 写入 `true`，旧文件缺省为 `false`。
   普通 `unknown → approve` 必须写入 `false`。批准、替换在文件锁内重读并以私有权限原子写入。
   并发 Desktop/CLI writer 不能丢失彼此批准；拒绝不写文件。

8. Desktop 交互通过最小 `requestId` IPC 闭环：Host 上报 challenge 时携带连接 `requestId`、一次性
   `challengeId`、host/port、status、candidate fingerprint 与 expected fingerprints；Main 仅按
   `(webContentsId, requestId)` 路由到发起连接的 Renderer。Renderer 回传同一 requestId、challengeId、
   candidate fingerprint 与 action，Main 只把已登记 requestId 的决策转发回对应 Host。
9. Window Host 为每个 requestId 持有唯一 pending challenge waiter；取消、Host 退出或决策完成时删除
   waiter 并 fail-closed，旧决策不能影响后续连接。取消后保留 requestId 墓碑直到 Host 释放，防止底层
   SSH handshake 的迟到回调重新创建 waiter；同一 requestId 不得复用。Web/headless 无 handler 路径继续
   拒绝未知/变化 key。
10. 同一 Window Host 对相同 SSH target 的握手进行主机密钥交互时不复用 connecting entry；后续并发
    request 立即失败并可在首个请求结束后重试，避免首个 Renderer 取消后把第二个请求挂在失效 challenge 上。

## 状态所有者与事件顺序

- 宿主的 `SSHHostKeyTrust` 是已批准 key 的唯一所有者；SSH backend 只读取，不缓存跨连接信任事实。
- 交互宿主通过 `SSHHostKeyChallengeHandler` 消费候选挑战；backend 只负责认证前收集、校验决策绑定并
  触发一次重试，不持有第二份已批准集合。
- `sshAuth.ts` 的 host verifier 是当前连接的唯一裁决者：解析记录 → 比较 hash → 返回 boolean；
  `SSHBackend.ensureConnected` 在 `ready`/认证成功前将 host-key 失败转换为稳定错误。
- `createRemoteBackend` 透传可选 trust store；缺省时只读本机 OpenSSH `known_hosts`
  （可由 `ACODE_SSH_KNOWN_HOSTS` 指定路径），异步读取一次生成当前连接的只读快照，verifier 不做同步 IO。文件缺失、未知主机或无法解析的条目仍拒绝。
- known_hosts 同主机的多个已批准 key 均可匹配；支持 OpenSSH `|1|` HMAC-SHA1 主机 token、逗号列表、`*`/`?` 与 `!` 排除规则，非默认端口使用 `[host]:port`。
- `@revoked` key 即使同时存在普通受信行也拒绝；`@cert-authority` 不作为原始 host key 的批准记录。
- Desktop 将受管 trust 与 known_hosts 组合时，candidate-aware 裁决顺序固定为：known_hosts 的
  `revoked` 永远优先；known_hosts 的 `changed` 也优先于普通 managed approval。只有本次连接已经收到
  用户对同一候选的显式 `replace`，并由 managed entry 持久记录该 override，后续重试才能使用该候选；
  这样旧 known_hosts 基线不会被静默绕过，合法替换仍能在用户确认后完成。
- backend 在每次新握手前调用 trust 的可选异步 refresh，期间连接请求共用同一个 in-flight Promise；刷新失败或 dispose 后不进入认证，避免跨重连继续使用已撤销记录。

## 失败语义与迁移边界

- 未知 key 返回错误码 `ssh-host-key-unknown`；key 变化返回 `ssh-host-key-changed`；trust store
  故障返回 `ssh-host-key-trust-unavailable`。
- 旧的连接参数、密码、私钥和 agent 选择保持不变；新增 host-key trust 是连接建立前的附加门禁。
- 现有调用即使未显式提供 trust store 也会使用只读 `known_hosts`；Desktop Host/Main/preload/Renderer
  已接入首次批准、变更确认、拒绝、取消清理与持久化 UI。server 在没有显式 challenge handler 时不自动
  写入或接受未知 key；真实 Electron、手机远控和跨平台 E2E 仍需单独验收。
- 托管 store 可作为只读 `known_hosts` 之外的宿主管理覆盖；标准 `known_hosts` 仍保持兼容，且由
  `@revoked`/changed 规则优先裁决。managed entry 的 override 只由同一 candidate 的显式 `replace`
  决策写入，不能由普通首次 `approve` 设置。

## 验收场景

1. 无记录的首个 key 被拒绝，且 fake server 未观察到 password/keyboard-interactive 认证尝试。
2. 相同 key 被接受并继续握手。
3. 已有记录但 key 改变被拒绝，且认证未开始。
4. trust store 缺失、抛错、异步/非交互确认均 fail-closed。
5. 真实假 SSH server 使用 known_hosts 记录成功握手，证明 ssh2 hex hash 与 OpenSSH fingerprint 互通。
6. 多 key、hashed、wildcard、否定与 revoked 记录均按规则解析，未知 key 仍在认证前拒绝；managed
   已批准但被 known_hosts 标记为 revoked 的 candidate 仍在认证前拒绝。
7. 真实假 SSH server 的 unknown challenge 在认证前返回；用户拒绝不重试，批准后只对同一候选重试并
   成功；changed 必须明确 replace 且校验旧/新双指纹。known_hosts changed 不得被普通 managed
   approval 绕过，但同一 candidate 的显式 replace 可持久化 override 并只允许该候选重试。两个独立
   store 并发批准后重读包含两条记录。
8. Desktop IPC 的 challenge/decision 必须按 `(webContentsId, requestId)` 路由；取消后迟到 challenge
   被墓碑拒绝，Host 释放清空 waiter，已取消 requestId 不能复用。
