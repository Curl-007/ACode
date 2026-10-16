# SSH config 别名：不支持指令的结构化拒绝

修复缺口：`ssh -G` 解析只取 hostname/port/username/identityfile 类平铺键，别名
配置里的 ProxyJump/ProxyCommand/LocalCommand/Match 被静默丢弃——跳板机别名表现为
连接超时挂起而非解释性拒绝。本 spec 定义别名解析的显式拒绝语义；检测逻辑位于
`sshConfigAliasUnsupported.ts`，接线在 `sshConfigAlias.ts`。

## 产品规则

1. **`ssh -G` 权威路径**：`ssh -G` 输出中出现行首小写键 `proxyjump` /
   `proxycommand` / `localcommand`（后随空白与值）即该别名的生效配置依赖不支持
   指令，返回结构化拒绝。注意 `permitlocalcommand` 是恒出现的独立键，不得与
   `localcommand` 混淆（前缀匹配会误报）。Match 块在 `-G` 求值时已被真实 ssh
   展开进平铺键（含 Match 设置的 proxy 类指令，会以上述键形式现形），因此
   `-G` 成功路径不做静态 Match 判断，也不叠加 fallback 检测结果。
2. **静态回退路径**（无 ssh 可执行文件、`-G` 失败或超时）：
   - 匹配别名的 Host 块中出现 `proxyjump` / `proxycommand` / `localcommand`
     指令 → 对应拒绝；
   - `Match` 行自成条件块（不再把条件 token 误当 Host pattern、也不再把其后
     指令误并入前一个 Host 块——两者都是现行静默错配源）。条件静态可判定仅
     `host <patterns>`（含 `!` 否定）与 `all`；出现 `exec` / `address` /
     `localaddress` / `localnetwork` / `user` / `group` / `canonical` / `final` /
     `tagged` 等不可判定条件 → 该块对别名「不可判定」；
   - 不可判定块按保守原则拒绝（`match_unsupported`），除非块内另一条件已
     确定不成立（AND 语义，如 `Match host !<alias> exec …` 对该别名确定不适用）；
   - 确定适用的 Match 块与 Host 块同序合并（first-win）；其中的 proxy 类指令
     按对应 reason 拒绝。
3. **reason 闭集**（`SSHConfigAliasUnsupportedReason`）：
   `proxy_jump_unsupported` / `proxy_command_unsupported` /
   `local_command_unsupported` / `match_unsupported`。多个命中时指令类拒绝优先
   于 `match_unsupported`（更可解释），同类按扫描序取首个。
4. **拒绝形态**：被拒绝的别名**保留在列表中**并携带
   `SSHConfigAliasOption.unsupported = { reason, directive, message, detectedBy }`；
   不静默移除（消失与挂起同为「无解释」）。`detectedBy` 记录 `ssh-g` /
   `static-fallback` 供排障。
5. **文案**：自撰中文，语义固定为「该别名依赖 ACode 尚不支持的 <指令>，
   请直连目标主机或说明你的跳板拓扑」，指令名用用户可读标签
   （ProxyJump（跳板机）/ ProxyCommand（代理命令）/ LocalCommand（本地命令）/
   Match（条件配置块））。错误通道形态对齐 host-key challenge：闭集 reason +
   结构化载荷，消费方按枚举分支，不做自由文本匹配。

## 状态所有者与边界

- services 侧 `listSSHConfigAliasesFromLocalConfig` 是别名事实（含拒绝标记）的
  唯一所有者；缓存（30s TTL）语义不变，拒绝标记随选项克隆。
- 检测函数是纯函数（输入 `-G` 输出文本 / 解析块 + 别名，输出拒绝或 undefined），
  不 spawn、不读盘，可单测。
- `SSHConfigAliasOption` 类型载体在 `packages/shared/src/platform.ts`（新增可选
  字段，向后兼容）；barrel 无需改动（符号已导出）。

## 迁移边界与登记项

- **UI 接线（登记）**：`RemoteConnectionFields` 别名下拉对带 `unsupported` 的
  选项置灰 + 展示 message；`useRemoteConnectionForm.applySshConfigAlias` 拒绝
  套用被拒别名；连接期兜底拒绝需要 alias 身份流入连接请求（当前 UI 只提取
  host/port/username/privateKeyPath，别名身份不落连接参数）。UI/desktop/connect
  文件非本批所有权，接线前被拒别名仍可被选中并直连（现状行为），标记使
  「解释性拒绝」可被后续批次直接消费。
- **locale 键（登记）**：拒绝文案当前由 services 侧生成中文 message；UI 批次
  若改为 locale 键渲染，reason 闭集即分支依据。
- **系统 OpenSSH 引擎（条件触发登记）**：ProxyJump/ProxyCommand 的真正支持
  需进程引擎（继承用户全量 ssh config/agent/跳板），触发条件与范围见
  packages/server/specs/ssh-prompt-mediation.md 登记项 3。

## 验收场景

1. `-G` 输出含 `proxyjump bastion` → reason=`proxy_jump_unsupported`、
   directive=`ProxyJump`、detectedBy=`ssh-g`；含 `proxycommand ssh -W …` /
   `localcommand echo hi` 同理；仅含 `permitlocalcommand no` 不误报。
2. 干净 `-G` 输出 → 无拒绝标记，平铺键解析行为与现状一致。
3. 静态回退：匹配 Host 块含 ProxyJump → 拒绝；`Match host <alias>` +
   ProxyCommand → `proxy_command_unsupported`（指令类优先）；`Match exec "…"`
   → `match_unsupported`；`Match host !<alias>` → 不适用、无拒绝；
   `Match host other` → 不适用；`Match all` + 良性指令 → 指令并入且无拒绝。
4. Match 块的条件 token 不再被当作 Host pattern 参与别名匹配（`Match host x`
   不使 x 成为别名，其后指令不并入前一 Host 块）。
5. 拒绝 message 含指令标签与「直连目标主机」/「跳板拓扑」指引语义。
