# bash 目标 blast-radius 风险分级（J1-1）

> 机制参照 jcode (MIT, github.com/1jehuang/jcode)
> `crates/jcode-command-risk/src/{lib,paths,tokenize}.rs`，全部为自撰
> TypeScript 实现，未拷贝任何源文件。

给 Bash 工具补一个**目标维度**的确定性风险分级层：不看命令名 denylist，而问
「这条命令会毁掉什么、能否撤销」。四级输出 `safe / low / confirm / catastrophic`，
其中 catastrophic 是**绝对 deny**（任何论证、任何权限模式、任何 allow 规则都不解锁），
confirm 是「破坏目标无法静态确定」（J1-2 的反射门在其上叠加，本期先并入既有 ask 语义）。

与既有防线的关系（纵深防御，只加强不削弱）：

- `HIGH_RISK_ROOT_COMMANDS`（bash-command-permission-policy.ts）与 `bash-readonly-policy-*`
  族**保留不动**——它们是命令名/只读维度，本层是目标维度的正交补充。
- `bypass-immune-breakers.ts` 既有三类熔断（bashRootDelete / pathEscapeWrite /
  sensitiveRead）**语义不变**；本层注册为新的第四命中类，且引入该模块的第一个
  **deny 级**命中（见 R5）。
- 托管策略地板（process-policy-floor）优先级不变：策略 deny 仍然最高。

## 背景与证据

- `permission/service.ts` riskLevel 四档门控：`critical` 分支必 ask、`high` 在
  `autoApproveHighRisk=true` 时自动放行——即「目标无法静态确定的高危命令」可以被
  配置自动批准，也可以被 yolo 直通（除既有三类熔断外）。
- 既有类 1 熔断只覆盖 `rm/rmdir/del/erase/remove-item` + 递归旗标的形态；
  `find ~ -delete`、`shred ~/.gnupg`、`dd of=/dev/sda`、`cat paths.txt | xargs rm -rf`、
  `sh -c "rm -rf ~"`、`(rm -rf ~)` 等目标灾难形态在 yolo 下会被放行。
- jcode issue #604 教训：`rm -rf` denylist 会漏掉 `find -delete`、`shred`、`truncate`、
  `dd`、`>file`；按 blast radius 分类才能覆盖。

## 产品规则

### R1 四级定义与合并语义

| 级别 | 语义 | 接线效果 |
|---|---|---|
| `safe` | 未检出破坏性目标 | 不影响既有判定（readonly 快径保留） |
| `low` | 有界破坏：工作目录/工作区内、temp 下、git 可恢复类 | 不升级既有 riskLevel（bash 默认已 high）；但**取消 readonly 快径**（见 R5） |
| `confirm` | 破坏目标无法静态确定（未解析变量/glob 足迹未知/管道喂给删除类/wrapper payload 不可见/HOME 重赋值等） | capability riskLevel 升到 `critical`（`autoApproveHighRisk` 不能自动批准）+ needsApproval；yolo 下本期仍直通（J1-2 反射门收口） |
| `catastrophic` | 目标是 home 本体、凭据库、系统关键路径、裸 glob 清空保护目录、设备节点直写、`..` 词法归约后落到上述路径 | **直接 deny**，不进 ask，任何模式/规则/justification 不解锁 |

- 合并规则：assessment 与既有 riskLevel **取更严者**，映射
  `confirm/catastrophic → critical`、`safe/low → 不升级`。新层永远只收紧。
- `low` 的「有界破坏」白名单（避免日常 `rm -rf dist` 被升级打断）：目标解析后位于
  workingDirectory 或 workspaceRoot 之内、或位于 temp 目录之下（严格内含，不含 temp
  目录本身）。白名单外的具体路径破坏记 `low`（可见于风险日志、不打断），与 jcode 一致。

### R2 三平台路径保护表（纯词法、代码内封闭常量）

路径比较统一在**归一化词法空间**（正斜杠、盘符小写、`.`/`..` 消除）内进行；
win32/darwin 平台与 Windows 形态路径（盘符/UNC）按大小写不敏感比较，linux 上 POSIX
路径按大小写敏感。表是代码内常量，不接受配置扩展（扩展走策略地板 deny/ask，与类 3
熔断同一纪律）。

**凭据目录（home 相对，递归保护——毁掉其中单个私钥与毁掉目录同罪）**：

- 三平台共有：`.ssh` `.gnupg` `.aws` `.kube` `.docker` `.azure` `.config/gcloud`
- Windows（`%USERPROFILE%` 等价物）：`AppData/Roaming/Microsoft/Windows/Credentials`、
  `AppData/Local/Microsoft/Credentials`、`AppData/Local/Google/Chrome/User Data`、
  `AppData/Local/Microsoft/Edge/User Data`
- macOS：`Library/Keychains`

**home 配置/文档目录（精确匹配——目录本身保护、其下具体文件合法）**：
`.config` `.acode` `.local` `.local/share` `Documents` `Desktop` `Downloads`；
Windows 加 `AppData` `AppData/Local` `AppData/Roaming` `AppData/LocalLow`；
macOS 加 `Library`。例：`~/.config` 是 catastrophic，`~/.config/app/x.toml` 不是。

**home 本体**：精确匹配（`~`、`$HOME`、绝对路径、任何 `..`/`.` 归约后等价形态）。

**系统路径（精确匹配）**：
`/` `/bin` `/boot` `/dev` `/etc` `/lib` `/lib32` `/lib64` `/opt` `/proc` `/root`
`/sbin` `/srv` `/sys` `/usr` `/var` `/Applications` `/System` `/Library` `/Users`
`/home` `/private` `/cores` `/Volumes`；Windows：每个盘符根（`C:\` 等）、
`C:/Windows` `C:/Program Files` `C:/Program Files (x86)` `C:/ProgramData`
`<盘>:/Users`（用户配置根——`rm -rf C:/Users` 一次删掉所有用户 profile，含全部
凭据目录；与 POSIX 的 `/home`、`/Users` 同一条目、同一「只精确不递归」语义）。

**系统路径（递归保护——其中单个文件同样不可毁）**：
`/bin` `/boot` `/dev` `/etc` `/lib` `/lib32` `/lib64` `/proc` `/sbin` `/sys` `/usr`
`/var/lib` `/System` `/Library`；Windows：`<盘>:/Windows` 下全部、`//./` 设备命名空间。

**刻意不递归**：`/home`、`/Users`、`C:/Users` 只精确匹配——用户项目住在它们下面，
递归保护会把一切正常工作拦死（home 本体已由上一条保护）。

**设备节点**：`/dev/*`（除 `null` `stdout` `stderr`）、Windows `\\.\*` 设备命名空间、
`\\?\`（及 `//?/`、`\\?\UNC\`）前缀**在 glob 判定之前**剥掉后按其余规则判——前缀里的
`?` 是 Windows 命名空间标记而不是通配符，否则 `rm -rf \\?\C:\Windows` 会先落进 glob
分支被降级成 confirm（一次反射 + 论证即放行），永远走不到保护表。
设备节点**直写**（含 `dd of=`、truncate 重定向）判
catastrophic；但 `dd of=/dev/null`（安全汇）豁免——写 bit-bucket 无破坏。
`rm /dev/null` 不豁免（显式删除设备节点仍由 /dev 递归保护命中）。

**裸 glob**：`/*`、`~/*`、`<盘>:\*`、`~/**` 这类「保护目录 + 通配 base」形态判
catastrophic（效果等于清空保护目录，即使没有任何单一解析路径受保护）。

**8.3 短名**（对抗复审 HIGH-6）：Win32 把 8.3 别名解析到长名本体（系统卷默认开启
短名生成），而保护表是纯词法比较——`C:\PROGRA~1` 就是 `C:\Program Files` 的另一个
拼写。规则：win32 形态**绝对路径**中任一段匹配 8.3 短名形态
（`^[A-Za-z0-9._ -]{1,8}~\d$`）→ 至少 confirm（别名→长名的映射依赖卷上的静态
不可知事实，静态不可解析即升级，符合 R3 的 recall 偏向原则）；封闭常量
`PROGRA~1`/`PROGRA~2`（值可静态推出 = `<盘>:/Program Files`、
`<盘>:/Program Files (x86)`，均在精确保护表内）判 catastrophic。
短名规则**只**适用于 win32 形态绝对路径——相对路径里的 `file~1.txt`、
`dist/bundle~2.js` 是普通备份文件名，不参与（避免误伤日常清理）。

**UNC/网络共享（对抗复审 LOW-14）**：win32 形态下目标归一后以 `//` 开头
（`\\server\share`、`\\?\UNC\server\share`、孤立 `//`）→ confirm：远端数据删除
不可恢复、足迹静态不可界，且不可进入任何 cwd/temp 豁免。设备命名空间
`//./` 与 `//?/` 前缀剥除后的保护表命中仍优先（catastrophic 严于 confirm）。

**文件名位 glob**（通配在 base 段，父目录确定）按下列顺序判，前一条命中即返回：

1. 父目录**递归受保护**（`/etc`、`/usr`、`/var/lib`、`<盘>:/Windows`、`~/.ssh` 等）→
   catastrophic：任何展开结果都落在保护区内，「足迹未知」不成立——
   `rm -rf /etc/pass?`、`rm -f /usr/li*`、`rm -rf ~/.ssh/id_*`、`rm -rf /var/lib/mysql/da*`
   与删掉整个目录同罪（本条优先于下面第 3 条，是「递归保护——其中单个文件同样不可毁」
   在 glob 形态下的必然推论）。
2. base 通配**必然命中父目录下一个本体受保护的条目** → catastrophic：候选集与保护表
   同源（不另立清单），如 `~/.*`/`~/Doc*`/`~/Dow*` 命中 `.ssh` `.gnupg` `.config`
   `Documents` `Downloads`，`/b*` 命中 `bin` `boot`。匹配用单段通配（`*` `?` `[…]`），
   大小写敏感性跟随宿主（linux 敏感、win32/darwin 不敏感）；刻意**不**模拟 bash 的
   dotglob 语义（`*` 视为可匹配点目录），与既有裸 glob 规则同一保守口径。
   例：linux 上 `rm -rf ~/[a-z]*` 证明不可能命中任何受保护条目（它们都以 `.` 或大写
   开头）→ 落到第 3 条 confirm；同一命令在 win32/darwin 上命中 `Documents` → catastrophic。
3. 其余（cwd/temp 内）判 low；父目录含通配段（`/home/u/*/node_modules`）或落点在
   工作区外 → confirm（足迹未知）。

**temp 目录（严格内含即安全；temp 目录本身按「具体路径」记 low）**：
`/tmp` `/var/tmp` `/private/tmp` `/private/var/folders`；Windows：
`<盘>:/Users/*/AppData/Local/Temp`（`<盘>:/Windows/Temp` 不在豁免表——它位于
Windows 目录递归保护区内，按 catastrophic 处理）。

### R3 词法展开规则（从不触文件系统）

- `~`、`~/…`、`$HOME`、`${HOME}`（前缀完整、后续为空或以 `/` 起）、`%USERPROFILE%`
  用**受信 homedir** 展开——命令自身重赋值 `HOME=` 不改变展开结果（见 R4），防止
  `HOME=/tmp rm -rf ~` 洗白。`~user` 形态与其余 `$VAR`/`` ` ``/`%VAR%` 一律视为未解析。
- **受信 Windows 环境变量同样展开**（cmd 的 `%VAR%` 与 PowerShell 的 `$env:VAR`）：
  `WINDIR`/`SystemRoot`、`SystemDrive`、`ProgramData`/`AllUsersProfile`、`ProgramFiles`、
  `ProgramFiles(x86)`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`，以及
  `HOMEDRIVE`（home 盘符）与 `HOMEPATH`（home 去盘符路径；单独出现时按 home 根
  补全盘符——对抗复审 MEDIUM-4：二者完全满足「值可由 homedir 纯词法推出」的收录
  标准，此前被排除导致 `%HOMEPATH%` 只到 confirm 而 `%USERPROFILE%` 是 catastrophic）。
  支持**相邻拼接**展开：`%HOMEDRIVE%%HOMEPATH%\.ssh` 先展开 `%HOMEDRIVE%` 再展开
  `%HOMEPATH%`，与 `%USERPROFILE%\.ssh` 同判。只收录**值可由
  homedir/platform 纯词法推出**的变量（宿主事实、与命令无关）；其余变量仍未解析。
  盘符取 homedir 的盘符，取不到时用 `c:` 占位——Windows 保护表本身按任意盘符匹配
  （`^[a-z]:/windows`），占位不改变分级结果。
  **平台门（对抗复审 LOW-15）**：受信展开只在 win32 平台、或目标本身呈 Windows
  形态（盘符路径/反斜杠路径）时启用。非 win32 宿主上 `%WINDIR%` 是合法的字面文件
  名，展开它会把无害字面路径升级成 catastrophic 绝对 deny（无申诉通道）——其余
  平台维持未解析 → confirm 口径。
  **刻意不收录 `%TEMP%`/`%TMP%`**：展开会把既有 confirm 放宽成 temp 豁免（low），
  属放松既有行为语义；temp 豁免只适用于字面路径拼写。
- **brace 展开**（`{a,b}`、`{a,b}/{c,d}`、`{1..3}`、`{a..e}`，支持嵌套）：先展开成候选
  路径集，逐个走同一套分级、**取最严者**——`find ~/{.ssh,.gnupg} -delete` 因此是
  catastrophic（每个候选都是 shell 真会触碰的路径，任一命中保护表即不可放行）。
  **候选剥引号**（对抗复审 HIGH-2）：bash 的 brace 展开先于 quote removal，
  `~/{".ssh",x}` 展开结果与 `~/{.ssh,x}` 完全一致——候选产出后、进分级前剥除未转义
  的引号字符（`\"`/`\'` 转义保留字面引号），否则带引号备选项不命中保护表，一层引号
  就把凭据库删除降级成 low。bash 不展开的形态（`{}`、`{a}` 单项无逗号无序列）保持
  字面，不为它编造命中（`find . -exec rm {} +` 的 `{}` 仍由 find 规则处理）。
  组合数或序列长度超过静态枚举上限（128）→ confirm（足迹不可静态枚举，fail-closed）。
  **超限序列不是字面**（对抗复审 MEDIUM-3）：`{1..200}` 是「可展开但超限」，与
  `{a}` 这类「不可展开字面」必须区分——超限序列使整个目标展开失败 → confirm；
  `{1..128}`（恰 128 项）仍正常枚举。
- **全引号 tilde/brace 形态 → confirm 而非 catastrophic**（对抗复审 LOW-16）：bash
  引号内不做 tilde/brace 展开，`rm -rf "~/{.ssh,.gnupg}"` 删的是一个名为
  `~/{.ssh,.gnupg}` 的字面相对路径。整个目标 token 被完整引号包裹、且剥引号后含
  tilde/brace 展开形时，判 confirm（保留 recall——不静默放行，给反射门申诉通道），
  不判 catastrophic：catastrophic 误报的代价是**永久拒绝且无申诉**，而这里的
  静态不确定性一个确认回合即可消解。剥引号后仍按字面相对路径参与其余分级，
  **不**因此打开引号绕过（外层无引号的 `~/{".ssh",x}` 仍走候选剥引号 → catastrophic）。
- **未解析的 `$`/反引号/`%` 绝不 normalize 掉**：`$UNKNOWN/..` 不得被词法消除成
  可放行形态——含未解析段的 `..` 逃逸判 catastrophic（变量为空/多段时可达根），
  其余未解析目标判 confirm。**检测点是「`..` 弹栈消费了未解析段」**（对抗复审
  HIGH-7）：词法消除把 `$UNKNOWN/../etc` 归约成 `etc`、把 `$UNKNOWN/../../etc`
  归约成 `etc`，仅看最终落点会漏掉「变量为空/多段时它就是根」——只要弹栈吃掉
  含 `$`/反引号/`%`/`~user` 的段，整个目标直接 catastrophic，无论归约后的形态。
- 已解析路径做纯词法 `.`/`..` 消除：`rm -rf ~/../..` 视作 `/` → catastrophic。
  不感知符号链接（防御纵深定位，与 jcode 同一诚实边界）。
- 相对路径按 workingDirectory（缺省 workspaceRoot）解析后做 `..` 消除；
  `..` 无条件弹栈、弹空即归约为根（jcode 同款）——`rm -rf ..`（cwd 为 home 子目录时）
  与 `rm -rf foo/..`（无工作目录时）都按根/home 语义命中保护表。
- Windows 形态归一：反斜杠→正斜杠、盘符小写；win32 平台上 MSYS 挂载形 `/c/…` 映射为
  `c:/…`；扩展长度前缀 `\\?\`、`//?/`、`\\?\UNC\`（→ `//server/share`）剥除。
  **Win32 尾点/尾空格组件规范化**（对抗复审 HIGH-3）：Win32 非 `\\?\` 命名空间会
  剥除组件尾部的点和空格（`C:\WINDOWS.` 打开的就是 `C:\Windows`），win32 形态目标
  在词法消除前逐组件剥 `[. ]+$`（`.`/`..` 导航组件除外）——必须在 `\\?\` 前缀剥除
  之后做，且**扩展命名空间来源不剥**（`\\?\C:\dir.\file` 的 `dir.` 是字面名，与
  R2 的 `\\?\` 语义一致）；相对路径不因此改变语义（`dist.` 在 cwd 内仍按字面归位，
  不误升）。非 win32 平台上非 Windows 形态的目标不受影响（POSIX 下尾点是合法
  文件名字符）。
- **前导双斜杠**（对抗复审 HIGH-5）：非 win32 平台把前导 `//`+ 折叠为 `/`——POSIX
  规定 ≥3 个前导斜杠等价单斜杠，恰两个在 Linux/macOS 实现上同样按 `/` 处理；
  `//`、`///`、`rm -rf --no-preserve-root //` 因此与 `rm -rf /` 同判 catastrophic。
  真 UNC `//server/share` 在 POSIX 上本就是 `/server/share`，折叠不损失保护。
  win32 平台保留 UNC 语义（按上一条 UNC 规则判 confirm），孤立 `//`（无主机段）
  同样 confirm。`//./`、`//?/` 设备命名空间不折叠。

### R4 解析规则（消费 `analyzeBashCommand` AST，recall 偏向）

解析含糊时**升级而非放行**：「误报花一个确认回合，漏报花一个 home 目录」。

- **wrapper 逐层解包**：`sudo doas env nice ionice time timeout nohup xargs command
  builtin exec setsid stdbuf chroot su watch eval`，各 wrapper 的 flag 取值规则不同
  （`nice -n 10` 取值、`sudo -n` 不取；`timeout` 的裸数字/`5s` 时长是其自身操作数）。
  解包后按真实程序分类。wrapper 之下看不到 payload（如裸 `sudo`）→ confirm。
  - **JS 包运行器同样解包**：`npx bunx npm pnpm yarn bun deno node dlx`。ACode 跑在
    JS monorepo 里，`npx rimraf ~`、`bunx rimraf ~/.ssh`、`pnpm exec rimraf dist`、
    `pnpm dlx rimraf ~` 是最常见的递归删除形态；jcode 上游的 18 个 wrapper 面向
    Rust/shell 宿主，照抄表范围会留下一条 safe 直通路径。解包后的程序名不在破坏性
    表内时判定不变（`npm run clean`、`node script.js`、`deno run x.ts`、`pnpm install`
  仍是 safe），所以这一条只收紧、不新增噪声。`npm run` 族在 map 注入后的分级见
  `npm-script-body-scan.md`（R6 边界⑥已收口）。
  - **JS 包运行器的取值旗标（对抗验证 F2）**：`npx`/`bunx` 的 `-p/--package/
    -c/--call/--registry/--userconfig`、`npm` 的 `--package/-c/--call/--prefix/
    --registry/--userconfig/--cache`、`exec`/`dlx`（`npm exec`/`pnpm exec`/`pnpm dlx`
    解包链的第二跳）的 `--package/--registry` **取值**——值不进解包，其后
    才是真实 payload。取值表缺口就是 fail-open：`npx --package x npm run clean`、
    `npm exec --package x -- rimraf ~` 曾把 `x` 误停在 payload 位、真实命令整体漏评。
    配套三条：①`-c/--call` 的值是 **sh 语义命令文本**，按内联脚本递归评估
    （`npx -c "npm run clean"` 评的是 clean body，不是把 payload 当程序名）；评估
    值之后解包**继续**而非终止——bash 内建 `exec -c` 是「清空环境」（`exec -c
    rimraf ~` 仍执行 rimraf ~），与 npm exec 的 `--call` 同形不同义；通用取值表
    因此不含 exec/dlx 的 `-c/--call`，包管理器链内的 `npm exec -c` 由链上下文
    （此前出现过包管理器词）区分：链内按 call 文本递归评估并豁免「payload 不可见」
    confirm，裸 `exec -c` 按布尔跳过、后续 payload 照常分级；已评估 `-c` 文本时
    解包走到尽头不再追加「payload 不可见」confirm（`npx -c "npm run lint"` 日常
    形态零摩擦）；
    ②**保底网**——解包停点后 `wrappedBy ∈ {npx, bunx}` 且停点之后仍出现包管理器词
    （npm/pnpm/yarn/bun）→ 至少 confirm（fail-closed，防取值表再漏一项时静默放行；
    `npx pnpm lint` 这类完整再解包形态停点后已无残留，不受影响）。
  - **busybox/toybox 同样解包**（对抗复核 F-4）：`busybox rm -rf ~`、`busybox sh -c
    "rm -rf ~"`、`busybox tee /etc/passwd`、`toybox rm -rf ~` 的真实动词是**第一个
    非旗标参数**（applet 名），其后按既有 payload 递归评估（applet 是 wrapper/shell
    时继续逐层解包）。类 1 熔断按命令名只认 `rm/rmdir/…`，name=busybox 不中——不解包
    就是一条 yolo 静默放行路径。无 applet 形态（`busybox`、`busybox --help`）按
    wrapper payload 不可见 → confirm（不崩、也不静默放行）。
  - `command -v/-V`（含短旗标簇里的 v/V，仅检查其自身 option 前缀）→ 只读查询，safe；
  - `env` 仅带赋值/无 payload → safe；`env -S` / `--split-string`（含 `-iS` 簇形态）
    → confirm + 对可见 payload 递归评估；
  - `su -c <script>` → 递归评估 script；`su` 无 `-c` 时跳过用户名继续解包；
  - `chroot` 跳过 newroot 位置参数后继续解包；
  - `eval` 的剩余 token 拼接为脚本递归评估（含未解析段 → confirm）。
- **shell 内联脚本递归评估**：`sh bash zsh dash ksh fish csh tcsh` 的非 flag 参数按
  命令文本递归评估（`sh -c "rm -rf ~"` 不是免死金牌）；递归深度上限 4，守卫语义是
  「depth > 4 即升级」——实际评估到第 5 层调用时触发（对抗复审 LOW-17：spec 原写
  「上限 3」与实现不符，以实现为准对齐），超限 → confirm。
  `cmd /c`、`powershell/pwsh -Command` 的 payload 尽力用同一评估器递归（PS 的
  `Remove-Item` 等词在表内），`-EncodedCommand`/`-File` 等不可见 payload → confirm。
- **cwd 段级跟踪**（对抗复审 HIGH-1）：评估逐 invocation 进行，而 shell 的 cwd 是
  会话状态——不跟踪 `cd` 就等于让所有相对目标以固定基准分级，`cd ~ && rm -rf .ssh`
  会被当成删 `proj/.ssh` 放行。规则：
  - `cd`/`pushd` 的目标词可静态解析（`~`、绝对路径、可解析相对路径）时，更新后续
    段的 cwd，相对破坏性目标按**新 cwd** 重新定基再分级；`cd`（无参，= HOME）、
    `popd`、`pushd`（无参，交换栈顶）、`cd -`（OLDPWD）不可静态解析。
  - `env -C <dir>`/`env --chdir=<dir>`、`sudo --chdir <dir>`/`sudo -D <dir>` 只改变
    **该 wrapper payload** 的 cwd（不写回外层会话状态）。
  - **CDPATH 内联赋值**（对抗复核 F-3）：bash 的 cd 对相对目标**先查 CDPATH**，而前缀
    赋值（`CDPATH=/home/u cd .ssh`）与 `env CDPATH=… cd …` 对同一命令的内建可见——
    不跟踪就等于按「相对当前目录」定基，真实落点却在 CDPATH 目录下（`cd .ssh &&
    rm -rf *` 实际清空的是凭据库，静态却判工作区内 low）。规则：同一命令内可见
    `CDPATH=<值>` 赋值、且 cd 目标是 CDPATH 查找形态（相对、首段非 `.`/`..`、非绝对、
    非 `~` 前缀——这些形态 bash 不走 CDPATH）时，按「CDPATH 目录 + 目标」拼接候选
    重定基（`CDPATH=/home/u cd .ssh` → 后续相对目标以 `/home/u/.ssh` 为基准，
    `rm -rf *` 判 catastrophic）；CDPATH 值不可静态解析（`CDPATH=$X`）、含多个冒号
    条目或候选落点不可解析 → cwd 记 unresolved（后续相对破坏性目标 fail-closed
    ≥confirm）。CDPATH 命中与否静态不可分，取 bash 的首选候选（CDPATH 命中）符合
    recall 偏向；绝对目标不受影响。词法 fallback 同口径：只捕获段内命令词**之前**的
    `CDPATH=` 词元（命令词之后的 `CDPATH=` 是数据参数不是赋值）。
  - 新 cwd 不可静态解析（`cd $X`、命令替换、`cd -`、`popd`）→ 后续所有**相对**目标
    的破坏性操作 fail-closed 升至少 confirm；绝对目标不受影响（落点与 cwd 无关）。
  - 边界语义与 bash 一致：子壳（`(cd ~; …)` 的括号、`sh -c` 的子进程）内的 `cd` 不
    传播回外层——评估按相同边界保存/恢复；管道段各在子壳中运行，`cd` 不跨 `|`
    传播；`eval` 的 payload 在**当前 shell** 展开，其 `cd` 写回会话状态；命令替换
    `$(cd …)` 在子壳中执行，只继承、不写回。递归 payload（`sh -c`、`eval`、`env -S`、
    `su -c`、find `-exec` 代入）继承进入时的 cwd 跟踪状态。
  - 词法 fallback（subshell/if/while 形态）同样跟踪：括号深度保存/恢复 cwd 状态。
- **裸重定向语句**（对抗复审 HIGH-4）：unbash 对无命令词语句（`> /etc/passwd`）会
  整体丢弃 redirects，解析出空 argv——同一破坏行为写不写命令词是两种拼写，
  `> /etc/passwd` 与 `: > /etc/passwd` 必须同判。parser 对无命令词、无赋值前缀且
  AST 无 redirects 的 Command 节点，对原始文本做**词法重定向提取**（fd 前缀、
  `>` `>>` `>&` `&>` `>|` `<>` `<` `<<` 族、引号感知目标捕获），产出与 AST 同形的
  redirects，由同一套截断重定向规则分级。`>>` 追加不因此升级；`2>&1` fd dup 豁免。
- **动态命令名 → 至少 confirm**（对抗复审 MEDIUM-1）：命令名位（argv[0]）含 `$(`、
  反引号，或 parser 标记命令词含动态展开（`rm$IFS-rf$IFS~` 分词后真实执行
  `rm -rf ~`）→ 整个 invocation 至少 confirm——分级查表依赖可靠的命令名，命令名
  本身是运行时计算的就是「无法静态确定」。参数位的动态展开**不**因此规则升级
  （目标侧已有 unresolved 规则处理）。该规则覆盖 AST 路径与 find `-exec` 代入的
  合成段；词法 fallback 不做命令名位判定（属 R6 已知边界）。
- **git 全局旗标跳过后定位子命令**（对抗复审 LOW-13）：`git -C <dir> clean -fdx` 与
  `git clean -fdx <dir>` 是同一破坏行为。跳过 git 全局旗标（`-C <v>`、`-c <v>`、
  `--git-dir`、`--work-tree`、`--namespace`、`--super-prefix`、`--exec-path`，含
  `key=value` 形态）后再找子命令；`clean` 的显式路径操作数按**递归删除目标**分级，
  `-C <dir>` 存在且无显式路径时把 `<dir>` 本身按递归删除目标分级（等价
  `git clean -fdx <dir>`）；`-C` 的值不可静态解析 → confirm。无 `-C` 且无显式路径
  维持 low（天然有界于仓库工作树）。
- **命令替换递归**：argv/赋值/重定向目标里的 `$(…)`、`` `…` ``、`<(…)`/`>(…)` 内层
  文本递归评估——`x=$(rm -rf ~)` 的内层命令同样会执行。外层含替换的目标本身按
  未解析处理（confirm）。
- **find 专门处理**：
  - `-delete`：搜索根升级为**递归删除目标**参与分级（`find ~ -delete` → catastrophic）；
  - `-exec/-execdir/-ok/-okdir`：payload 递归评估；payload 含 `{}` 时按每个搜索根代入
    再评估；payload 非只读（只读白名单：`cat` `readlink`、sed 纯打印脚本）或终止符
    （`;`/`+`，含 AST 丢失 `\;` 的情形按 commandText 补判）缺失 → 额外 confirm；
  - `-fprint/-fprint0/-fls/-fprintf` 的输出文件按写目标分级（安全汇豁免）；
  - `-name/-printf` 等谓词的字面值不当作 action（`find / -name '-delete'` 是 safe）。
- **管道喂给破坏性命令 → confirm**：invocation 的 `operatorBefore` 为 `|`/`|&` 且解包后
  程序是破坏性动词（`find ~ | xargs rm`、`cat paths.txt | xargs rm -rf` 两段单独看
  都不暴露）。
- **破坏性动词无可解析目标 = 更可疑而非更安全** → confirm（含空字符串目标）。
  例外：`git clean` 无显式路径时天然有界于仓库工作树 → low。
- **破坏性动词表**（目标被检查，不代表命令本身被禁）：`rm rmdir shred unlink truncate
  dd mkfs* fdisk parted wipefs srm rimraf` + Windows 动词 `del erase rd format remove-item`；
  条件破坏：`git clean`、`chmod -R`、`chown -R`（含 `--recursive`）、
  **`tee`（非追加）**、**`sed -i`（含 gsed 同列，对抗复核 F-5：macOS brew 的 GNU sed
  以 `gsed` 之名安装，`gsed -i 's/x/y/' /etc/passwd` 与 `sed -i` 是同一破坏行为的
  两种拼写；对抗复审 HIGH-8：`tee /etc/passwd`（无 `-a`）与 catastrophic 的
  `> /etc/passwd` 是同一截断写行为的两种拼写；`sed -i`（含 `-i''`、
  `-i.bak`、`--in-place[=.suffix]` 簇形态）就地截断重写目标文件——两者目标都按
  **非递归截断写**分级）、**`cp`（仅目的操作数）**、**`mv`（源与目的）**
  （对抗复审 MEDIUM-2：cp 覆盖目的、mv 既删源又覆盖目的——被覆盖与被
  `>` 截断同罪；对抗复核 F-6a：**cp 的源操作数是读取不是破坏**，不按写目标分级
  （敏感读由既有类 3 熔断兜底），`cp /etc/passwd /etc/passwd.bak` 不再因源侧
  `/etc/passwd` 命中递归保护被拦截；**mv 源保持分级**——搬走=从原位置移除）。
  **cp/mv 目的操作数按「目录放置 vs 文件覆写」分级**（对抗复核 F-6a：
  catastrophic=永久 deny 无申诉，对无害形态必须降级）：
  - 目的以 `/` 结尾、或目的本体是保护表中的**目录条目**（home 本体、凭据目录、
    `~/.config` 系、`/etc`、`/usr`、`<盘>:/Windows`、盘符根等）→ 是「放入一个文件、
    不毁目录」→ **confirm**（`cp a.txt ~`、`cp a.txt /etc` 不再永久拒绝）；
  - 目的是**凭据递归保护区**内的具体路径（`~/.ssh/authorized_keys`、`~/.gnupg/*`）→
    **catastrophic**——覆写私钥与栽入 authorized_keys 后门同罪（「毁掉其中单个私钥
    与毁掉目录同罪」对写入同样成立）；
  - 目的是**其它递归保护区**（`/etc`、`/usr`、`/var/lib`、`<盘>:/Windows` 系、`/dev`
    设备节点等）内的具体路径：basename 命中**关键系统文件封闭清单**（`passwd`
    `shadow` `group` `gshadow` `sudoers` `fstab` `hosts` `crontab` `win.ini`
    `system.ini`）→ **catastrophic**（`cp evil /etc/passwd`、win 形
    `cp evil C:/Windows/System32/drivers/etc/hosts` 与 rm 同罪）；否则 → **confirm**
    （「新建文件」与「覆写未知已存在文件」静态不可分——不再永久 deny，也不静默放行；
    `cp /etc/passwd /etc/passwd.bak` 归此档：向 /etc 写入不是「有界破坏」，不给
    low，但 .bak 是否已存在不可知，一次确认即可消解）；
  - 其余目的按普通写目标分级（cwd 内 safe、temp 内 safe、区外 low）；含 glob 的
    目的、设备节点目的不降级。
  **`-t <v>`/`-t<v>`/`--target-directory[=<v>]`（cp/mv 同款，对抗复核 F-2）**：值是
  目的目录（此前 isFlagToken 只跳过 `-t` 不消费其值，`/etc` 被误当操作数、最后一个
  操作数=目的的前提不成立，`cp -t /etc passwd` 判 safe 静默放行）；源 basename 与
  目的目录均可静态拼接时，**拼接路径 `dest/basename` 同样进分级**（`cp -t /etc
  passwd` → `/etc/passwd` → catastrophic），目录本体按目录放置档参与取严合并。
  旗标解析与 `--` 分隔符照旧。
  `tee` 的 `-a`/`--append`（含短簇 `-ap`）是追加，不分级；操作数 `-` 是 stdout 豁免。
  `sed` 无 `-i` 时只写 stdout，不分级；`-i` 后紧跟的空操作数是 BSD 后缀（`sed -i '' …`）
  不是目标。
  `rimraf` 天生递归（无旗标也是整树删除）：工作区内记 low（与 `rm -rf dist` 同语义），
  不是无痕 safe。
  `dd` 的 `of=` key=value 操作数提取路径值参与分级（`of=/dev/null` 安全汇豁免）；
  `if=` 是读源不是写目标，不参与破坏分级（比 jcode 收窄一处误报：
  `dd if=/dev/zero of=disk.img` 是常规操作）。
- **truncate 重定向目标参与分级**：`>` `>|` `&>` 的目标按非递归写分级
  （`echo > /etc/passwd` → catastrophic；`> out.txt`（cwd 内）→ safe）；
  `>&` **按操作数判**：操作数是 fd 号或 `-`（`>&2`、`>&-`）时只是描述符操作、不算破坏，
  是文件名时 bash 语义等价于 `>word 2>&1` → 同样按截断写分级
  （`echo x >& /etc/passwd` → catastrophic）；`>>` 追加、heredoc/here-string
  （`<<` `<<-` `<<<`）与 `<` 不算破坏。
  heredoc **body 是数据不是命令**，不参与评估（jcode issue 922 教训）——AST 路径
  天然满足；词法 fallback（下条）不处理 heredoc，属已知边界。
- **HOME= 重赋值 → confirm**：判据是**赋值位**，不是 token 前缀——
  ① AST 的 envAssignment 名为 `HOME`（前导赋值 `HOME=/tmp rm -rf ~`）；或
  ② argv 里的 `HOME=` 词元，其**管辖命令名**（向左最近的非旗标、非赋值词元，wrapper
  透明）属于赋值型内建 `env export declare local typeset readonly set`。
  覆盖 `env HOME=…`、`sudo env HOME=…`、`export HOME=…`、`bash -c 'HOME=… …'`（经内联
  脚本递归）。对受信 homedir 的字面保护不受影响（`HOME=/tmp rm -rf ~` 仍 catastrophic）。
  与 jcode 的裸 `contains("HOME=")` 相比收窄到赋值位：`grep HOME= f`、`rg "HOME=" src`、
  `git log -S "HOME="`、`echo HOME=` 里的 `HOME=` 是**只读命令的数据参数**，不是赋值，
  不能升级（否则 build 模式下一次只读 grep 就丢掉 readonly 快径、被硬拒一轮）。
  recall 不减：真实重赋值形态全覆盖（见验收矩阵）。
- **词法 fallback（fail-closed）**：`hasParseErrors` 或 `hasUnsupportedSyntax`
  （subshell/if/while/case 等 AST 不支持形态）时，对原始文本做**引号感知**的粗切分
  再走同一套动词/目标分级——`(rm -rf ~)`、`if true; then rm -rf ~; fi` 判
  catastrophic；引号内的字符串（`echo "rm -rf ~"`）是单个 token、不会误判动词+目标对。
  fallback **同样分级重定向写目标与 HOME= 赋值位**（与 AST 路径同一口径）：
  `(echo x > /etc/passwd)`、`if true; then echo x >& /etc/passwd; fi` 判 catastrophic，
  而 `(echo x >> /etc/passwd)`、`(echo x >&2)`、`(grep HOME= f)` 不被误伤——否则一层
  括号就能把绝对 deny 变成 yolo 静默放行。
  **条件破坏动词的目标同样分级（对抗复核 F-7）**：`tee`（非 `-a`/`--append`）、
  `sed -i`（`gsed` 同列）、`cp`（目的操作数）、`mv`（源+目的）的目标在 fallback 走
  **同一套**分级函数——实现上与 AST 路径共用 overwrite-verbs.ts 的
  assessTee/assessSed/assessCopyMove（不复制两套逻辑，避免两条路径再次漂移）。
  此前 `assessRawText` 只对既有破坏性动词表产出 finding，一层括号即降级：
  `(cp evil /etc/passwd)`、`(sed -i s/x/y/ /etc/passwd)`、`(tee /etc/passwd)`、
  `(echo x | tee /etc/passwd)`、`if true; then cp evil /etc/passwd; fi` 判 safe，
  而同命令不带括号是 catastrophic——与上文「裸重定向语句」（HIGH-4）同威胁族。
  词法切分口径：参数按空白/引号切分到操作符段边界（`;` `&&` `||` `|`、控制词终结、
  破坏性动词名即止），引号已由 tokenizer 剥除；操作数含未解析 `$` 时原样进分级、
  按 unresolved → confirm（recall 偏向：切分含糊升级不放行）；`tee -a`/`--append`
  豁免、`sed` 无 `-i` 不分级、`sed -i ''` 的空操作数是 BSD 后缀、`cp -t`/
  `--target-directory` 形态与 AST 同一识别逻辑（共用函数，无第二种口径）；
  `>`/`>&` 的目标词仍由重定向分级处理，不进入动词参数。
  文本超长（>10k，解析器拒解）同样落入 fallback。fallback 找不到破坏性动词时不产生
  finding（非删除类命令不因解析失败被本层拦截——类 1 熔断的 fail-closed 照旧兜底）。
  **控制词边界**（对抗复核 F-1）：fallback 的操作符字符集只有 `;|&()<>\n`，而
  `then`/`do`/`else`/`elif`/`in`/`{`/`}`/`done`/`fi`/`esac` 等是普通词 token——其后的
  cd 拿不到段首标记，`if true; then cd ~; rm -rf .ssh; fi` 曾被判 low（真实执行删
  ~/.ssh，yolo 静默 allow），与上文「词法 fallback（subshell/if/while 形态）同样
  跟踪」直接矛盾。规则：评估器在**消费侧**跟踪命令位——token 处于段首、文本首位、
  或其前一个词是 shell 控制词（SHELL_CONTROL_WORDS 全集，含终结性的
  `done`/`fi`/`esac`/`}`——它们既终结上一条命令的词法影响域，也让后续命令重新处于
  命令位）时，cd/pushd/popd 更新 cwd 跟踪。命令位判定**不**改写 tokenizer 的
  segmentStart：find 的搜索根扫描与破坏性动词的目标扫描以「操作符段边界」截断，
  词法层改写会让 `find . -name then -delete` 的 `-delete` 落到段外被漏判（fail-open）。
  有效 bash 中控制词总是紧跟操作符边界（`;`/换行），cd 的目标词扫描因此天然不越过
  控制词。闭合形态：`if`/`while`/`until`/`elif`/花括号组五族的 `… cd ~;
  rm -rf .ssh …` → catastrophic，`then cd /etc; rm -rf passwd` 的目标正确归到
  `/etc/passwd`。子壳括号仍按 parenDelta 保存/恢复——`(cd ~ && make);
  rm -rf node_modules` 仍 low；`{ }` 组与循环体在当前 shell 运行，cd 影响按 bash
  语义延续；`cd ~ | rm x` 的 cd 不跨管道（confirm 来自管道喂 rm 规则）。配套
  fail-open 防护：解析器对部分畸形输入（如 `elif` 开头的残缺复合命令）返回零
  command 且不设任何错误标记，整段文本会被静默丢弃——评估入口把「非注释、非空的
  零 command 文本」按不可解析处理交给 fallback（纯注释行不执行命令，维持 safe）。

### R5 接线与优先级（状态所有者）

新模块 `core/src/tool/handlers/bash-target-risk/`：**纯函数、无 IO、可单测**。
homedir/platform 由调用方注入（breaker 与 bash.ts 用 `node:os`/`process.platform`，
与 breaker 既有 homedir 用法同款），模块自身不读环境。

唯一评估入口：`assessBashCommandTargetRisk(command, context) → TargetRiskAssessment`。
三个消费点，不新建旁路：

1. **capability 合并（bash.ts `resolveBashPermissionCapability`）**：
   - `assessment.level === "safe"` 且既有只读判定通过 → 保留 readonly 快径（low/无审批）；
     非 safe 一律取消 readonly 快径（目标维度发现了破坏面，只读结论不可信）。
   - `confirm/catastrophic` → 返回 `{ destructive: true, needsApproval: true,
     readOnly: false, riskLevel: "critical", sideEffectScope: "system" }`（含 permission
     子对象），与 entry 默认 high 取更严者生效；`safe/low` 对非只读命令返回 undefined
     （entry 默认 high+needsApproval 照旧）。
2. **熔断器新命中类（bypass-immune-breakers.ts）**：`checkCatastrophicBashTarget`
   排在既有三类**之前**（deny 严于 ask，首命中即返回）：
   - ruleId `breaker.bashTargetCatastrophic`，**behavior `"deny"`**——本模块第一个
     deny 级命中（ruleId 与既有三类同一构词：主语在前、判定在后，如
     `breaker.bashRootDelete`；实现、全部测试与 `bash-confirm-reflexive-gate.md`
     均用此名——ruleId 是策略地板/遥测/UI 的匹配键，spec 与实现必须同名）。
     既有约定「命中返回 ask 保留用户最终决定权」对 ask 级三类不变；
     catastrophic 级按 J1-1 产品决策改为 deny：「永不执行、任何论证不解锁」，用户
     最终决定权的体现是工具拒绝充当执行载体，用户仍可在工具外自行执行。
   - confirm 级**不注册**为熔断命中（本期）：yolo 下 confirm 命令仍直通，由 J1-2
     反射门收口；build 模式经 capability critical → 必 ask。

`PermissionService.checkPermission` 收口处（既有「只降级 allow」步骤）扩展：
decision 非 deny 时评估熔断器，`behavior === "deny"` 的命中把 **allow 与 ask 一并
降级为 deny**（deny 比两者都严，不违反「熔断器不可能放宽决策」不变量）；ask 级命中
维持「只降级 allow、已是 ask 保留原 ruleId」语义。既有 ask 级三类在 ask 决策下仍不
覆写。决策顺序（更新 R3 图的第 6 步）：

```
checkPermission(context, capability, projectRules, rulePolicy)
  ├─ 0. policyFloor.deny → deny（绝对最高，不变）
  ├─ 1. policyFloor.ask → ask（不变）
  ├─ 2. disallowedTools → deny（不变）
  ├─ 3-5. plan-mode / requiresUserInteraction / alwaysAsk（不变）
  ├─ 6. breakers：catastrophicTarget(deny 级) 命中 → deny（压过 allow 与 ask）；
  │      ask 级三类命中且 decision=allow → ask（原语义）
  ├─ 7. yolo fast-path（不变）
  └─ 8. 其余模式/规则判定（不变）
```

（实现上第 6 步仍在决策收口处统一执行：deny 级命中对 allow/ask 决策都生效，
ask 级命中只对 allow 生效——与上图语义等价，两个调用方 executor 与 input-recheck
自动同语义。）

3. **规则建议收窄（bash-command-permission-policy.ts）**：assessment 为
   `confirm/catastrophic` 时不生成稳定前缀通配规则（`safe=false` 路径），只允许
   精确命令规则——目标不可静态确定的命令不应产出可复用的 allow 前缀。
   `HIGH_RISK_ROOT_COMMANDS` 与其余前缀逻辑不动。

deny 后模型看到的文本（`createPermissionErrorResult` 既有通道）：

```
Bash command blocked: <finding.reason> (target: <finding.target>) — this target class
is never permitted through the Bash tool. No justification, permission rule, or mode
unlocks it. Narrow the target to a specific workspace path, or ask the user to run
the command themselves.
```

### R6 非目标 / 已知边界

- 不是沙箱：`sh -c "$(printf …)"` 级别的刻意混淆能骗过任何静态解析器——这正是
  catastrophic 层做成「小而绝对的路径判定」、confirm 层留给 J1-2 反射门的原因。
- 不感知符号链接；不解析 PowerShell 语法（尽力递归 + confirm 兜底）；heredoc body
  不参与评估（数据非命令）。
- brace 展开有静态枚举上限（128 个候选/序列项，嵌套深度 6）：超限不猜，判 confirm。
  超限**序列**（`{1..200}`）与超限**组合**（`{a..k}{a..k}{a..k}`）同一 fail-closed
  口径；`{a}` 单项字面不升级。
- **UNC/网络共享删除**（对抗复审 LOW-14）：`rm -rf \\server\share`、
  `\\?\UNC\server\share` 判 confirm 而非 catastrophic——远端共享的内容与挂载状态
  静态不可知（可能是备份源、可能是挂载点），但「远端数据不可恢复」不足以支撑
  **绝对 deny**（误报的代价是无申诉的永久拒绝）；confirm 给反射门一个确认回合。
  孤立 `//`（win32）同样 confirm；非 win32 平台 `//` 按 POSIX 折叠成 `/`
  （catastrophic，见 R3）。
- **全引号 tilde/brace 降级**（对抗复审 LOW-16）：`"~/{.ssh,.gnupg}"` 在 bash 里是
  字面相对路径（引号内不展开），catastrophic=永久 deny 无申诉通道的误报代价过高；
  降级为 confirm（不静默放行，给反射门申诉）。本条只针对「整个目标 token 被完整
  引号包裹且剥引号后含 tilde/brace 展开形」，外层无引号的 `~/{".ssh",x}` 仍走
  R3 候选剥引号 → catastrophic，不因此打开引号绕过。
- **brace/引号部分包裹噪声簇——登记为已知保守噪声，刻意不放宽**（对抗复核 F-6b）：
  `~/{".ssh",x}`、`~/{".ssh',x}`、`~/{".ssh,x"}`、`"~"/.ssh` 一类「引号只包裹部分
  备选项/路径段」的形态判 catastrophic。bash 语义上其中多数仍会展开命中凭据库
  （brace 展开先于 quote removal，HIGH-2 正是靠「候选剥引号后与无引号形态一致」
  闭合的），而「哪些引号位是展开抑制、哪些是字面字符」的精确判定需要对整条命令
  做完整引号状态机——引号处理的任何放宽都是 HIGH-2 的藏身处。登记理由：形态罕见、
  方向保守（宁多拦不漏放），代价是一次无申诉的永久拒绝；如现实使用中出现真实误报
  反馈，再评估专用降级规则，不预先放松。
- **动态命令名判定不覆盖词法 fallback**（对抗复审 MEDIUM-1 边界）：`$(rm) -rf ~`
  级别的命令名动态形态在 AST 路径与 find `-exec` 合成段升级；fallback 只在
  `hasParseErrors`/`hasUnsupportedSyntax` 时对原始文本词法扫描，命令名位判定
  依赖 AST 词边界，不做猜测。
- JS 包运行器只解包到**命令行可见的动词**：`npx rimraf ~` 覆盖；`npm run clean`/
  `pnpm run <script>`/`yarn <script>`/`bun run <script>` 的 script 体盲区
  （本节原边界⑥，最高优先）**已收口**——调用方异步预解析 package.json scripts 后
  经 `TargetRiskContext.packageScripts` 注入，`run` 族按 body 文本递归评估，
  规则、fallback 矩阵与决策链见 `apps/acode-cli/specs/npm-script-body-scan.md`
  （R2 wrapper 解包条目的「`npm run clean` … 仍是 safe」在此限定为 **map 未注入的
  legacy 上下文**；注入后的分级以新 spec 为准）。`node -e "<删文件的 JS>"/
  `pnpm exec node clean.js` 的破坏发生在 JS 源里，本层看不见（不解析 JS）——
  由既有 high+needsApproval 与 J1-2 反射门兜底。
- 不改变既有三红基线测试、不放宽任何既有防线。

## 验收场景（测试矩阵）

`tests/bash-target-blast-radius.test.mjs`（node:test + assert，`node --import tsx --test`）：

| 命令（cwd=/home/u/proj，home=/home/u） | 期望 |
|---|---|
| `rm -rf ~` / `rm -rf $HOME` / `rm -rf /home/u` / `rm -fr ~/` | catastrophic |
| `rm -rf ~/../..` | catastrophic（词法归约到 `/`） |
| `find ~ -delete` | catastrophic |
| `find . -exec rm {} +` | confirm |
| `cat x \| xargs rm -rf` | confirm |
| `HOME=/tmp rm -rf ~` | catastrophic（受信 home 不被重赋值洗白） |
| `dd of=/dev/sda` | catastrophic |
| `rm -rf ~/*` / `rm -rf /*` | catastrophic（裸 glob） |
| `rm -rf $UNKNOWN/..` | catastrophic（未解析 `..` 逃逸） |
| `rm -rf $TARGET` / `rm -rf $(cat list.txt)` | confirm |
| `env -S 'rm -rf /'` | ≥confirm |
| `(rm -rf ~)` / `if true; then rm -rf ~; fi` | catastrophic（词法 fallback） |
| `x=$(rm -rf ~)` / `sh -c "rm -rf ~"` / `sudo rm -rf ~` / `eval "rm -rf ~"` | catastrophic |
| `echo ok && rm -rf ~` / `true \|\| rm -rf /` / `cd /tmp; rm -rf $HOME` | catastrophic |
| `rm -rf node_modules`（cwd 内） | low |
| `rm -rf /tmp/scratch` | safe（temp 内含） |
| `rm -rf dist` / `rm -f a.txt` / `ls -la` / `git status` / `echo hi > out.txt` / `git clean -fdx` | safe/low（不打断） |
| `rm /dev/null` | catastrophic（显式删除设备节点） |
| `dd if=x of=/dev/null` | safe（安全汇豁免） |
| `~/.ssh` `~/.config`（本体） | catastrophic；`~/.config/app/x.toml` 非 catastrophic |
| Windows：`rm -rf C:\Users\Z\.ssh`、`rm -rf C:\Windows`、`rm -rf C:\`、`rd /s /q %USERPROFILE%`、`dd of=\\.\PhysicalDrive0` | catastrophic |
| macOS：`rm -rf ~/Library/Keychains`、`rm -rf /System` | catastrophic |
| Linux：`rm -f /etc/passwd`（递归保护内文件） | catastrophic；`rm -rf /home/u/other` | low |
| 熔断器：`evaluateBypassImmuneBreakers(bash("rm -rf ~"))` | `breaker.bashTargetCatastrophic` + behavior deny |
| service：yolo/build + `rm -rf ~` | deny（不是 ask）；yolo + `rm -rf ./build` | allow |
| 既有类 1：`rm -rf "$OUT"/` | 仍 `breaker.bashRootDelete` ask（confirm 级不抢 ruleId） |
| brace：`find ~/{.ssh,.gnupg} -delete` / `rm -rf ~/{.ssh,.gnupg}` / `rm -rf ~/{.ssh,{.gnupg,.aws}}` | catastrophic（逐候选取最严） |
| brace：`rm -rf {dist,build}`（cwd 内） | low；`rm -rf ~/{.ssh}`（bash 不展开） | low（字面目录名） |
| brace：组合数 > 128（`/tmp/{a..k}{a..k}{a..k}`） | ≥confirm（枚举上限 fail-closed） |
| Windows：`rm -rf C:/Users` / `rm -rf /c/Users`（win32）/ `cmd /c rd /s /q C:/Users` | catastrophic（精确表）；`rm -rf C:/Users/Z/proj/dist` | low |
| 扩展长度前缀：`rm -rf \\?\C:\Windows` / `rd /s /q \\?\C:\Windows` / `rm -rf //?/C:/Windows` / `rm -rf \\?\C:\Users\Z\.ssh` | catastrophic（前缀先剥再判，不落 glob 分支） |
| fallback 重定向：`(echo x > /etc/passwd)` / `if true; then echo x > /etc/passwd; fi` / `(echo x 2> …)` / `(echo x &> …)` | catastrophic |
| `>&` 重定向：`echo x >& /etc/passwd`（AST 与 fallback 同口径） | catastrophic；`>&2` / `>&-` / `>>` | safe |
| Windows 受信变量：`rd /s /q %WINDIR%` / `%SystemRoot%` / `rm -rf %APPDATA%` / `%LOCALAPPDATA%` / `%ProgramData%` / `%SystemDrive%` / `Remove-Item -Recurse $env:SystemRoot` | catastrophic；`%SOME_UNKNOWN_DIR%` / `%TEMP%` | confirm |
| glob 落点：`rm -rf /etc/pass?` / `rm -f /usr/li*` / `rm -rf /var/lib/mysql/da*` / `rm -rf ~/.ssh/id_*` / `rm -rf ~/.*` / `rm -rf ~/Doc*` / `rm -rf ~/**` / `rm -rf /b*` | catastrophic |
| glob 落点（宿主相关）：`rm -rf ~/[a-z]*` | linux confirm；win32/darwin catastrophic（大小写不敏感命中 `Documents`） |
| glob 不回归：`rm -f build-2026-*.json` / `rm -rf ./*` | low；`rm -rf /home/u/*/node_modules` | confirm |
| `HOME=` 数据参数：`grep HOME= f` / `rg "HOME=" src` / `git log -S "HOME="` / `echo HOME=` / `(grep HOME= f)` | safe（readonly 快径保留） |
| `HOME=` 赋值位：`HOME=/tmp rm -rf ~` / `env HOME=/tmp rm -rf ~/.ssh` / `sudo env HOME=/tmp rm -rf ~` / `(HOME=/tmp rm -rf ~)` / `bash -c 'HOME=/tmp rm -rf ~'` | catastrophic；`export HOME=/tmp` | confirm |
| JS 生态：`npx rimraf ~` / `bunx rimraf ~/.ssh` / `pnpm dlx rimraf ~` / `yarn rimraf /etc` / `npx rm -rf ~` / `pnpm exec rimraf /usr` / `rimraf ~` | catastrophic；`rimraf dist` / `pnpm exec rimraf dist` | low |
| JS 生态不回归：`npm run clean` / `node script.js` / `deno run x.ts` / `bun test` / `pnpm install` / `npm rm -g typescript` / `npx tsc --noEmit` | safe/low（不打断；`npm run` 族 map 未注入的 legacy 口径，注入后见 npm-script-body-scan.md） |
| F2 取值旗标：`npx --package x npm run clean`（clean body=`rimraf ~`） / `npx -c "npm run clean"` / `npx --call "npm run clean"` / `npm exec --package x -- rimraf ~` / `npm exec -c "npm run clean"` | catastrophic（yolo 不得静默 allow） |
| F2 不回归：`npx tsc --noEmit` / `npx rimraf dist` / `npx npm run clean`（既有 catastrophic） / `npx pnpm lint`（完整再解包不受保底网误伤） | 档位零变化 |
| cwd 跟踪：`cd ~ && rm -rf .ssh` / `cd / && rm -rf etc` / `cd /etc && rm -rf passwd` / `(cd ~; rm -rf .ssh)` / `sh -c 'cd ~ && rm -rf .ssh'` / `env -C ~ rm -rf .ssh` / `sudo --chdir /home/u rm -rf .ssh` / `cd ~/.ssh && rm -rf *` / `pushd ~; rm -rf .gnupg` | catastrophic |
| cwd 跟踪 fail-closed：`cd $X && rm -rf .ssh` / `popd; rm -rf .ssh` / `cd -; rm -rf .ssh` | ≥confirm（相对目标落点未知） |
| cwd 不回归：`cd dist && rm -rf *`（cwd 内） | low；`cd /tmp && rm -rf cache` | safe/low；`cd ~/projects/x && rm -rf build` | low |
| 裸重定向：`> /etc/passwd` / `> ~/.ssh/authorized_keys` / win 形 `> C:/Windows/win.ini` / `> /etc/passwd 2>&1` / `2> /etc/passwd` / `&> /etc/passwd` | catastrophic |
| 裸重定向不回归：`>> /etc/passwd`（追加） | safe；`echo hi > out.txt`（cwd） | safe；heredoc 语义不变 |
| brace 引号：`rm -rf ~/{".ssh",x}` / `find ~/{".ssh",x} -delete` / `shred -u ~/{".gnupg",x}` / `rm -rf ~/{'.ssh',x}` | catastrophic（候选剥引号） |
| brace 超限序列：`rm -rf /tmp/x{1..200}` / `rm -rf ~/x{1..200}` | confirm（可展开但超限 fail-closed）；`{1..128}` 仍枚举；`{a..k}{a..k}{a..k}` 仍 ≥confirm |
| 全引号 tilde/brace：`rm -rf "~"` / `rm -rf "~/.ssh"` / `rm -rf "~/{.ssh,.gnupg}"` | confirm（字面路径，不静默放行）；`"$HOME"` / `"C:\Users\Z\.ssh"` / `'%USERPROFILE%\.ssh'` 判定不变（非 tilde/brace 形） |
| Windows 尾点/尾空格：`rm -rf C:\WINDOWS.` / `rm -rf C:\WINDOWS.\System32` / `rm -rf "C:\WINDOWS \System32"` / `rm -rf C:\Users\Z\.ssh.` | catastrophic |
| 尾点不回归：`\\?\C:\dir.\file`（扩展命名空间） | 语义不变（字面保留）；`rm -rf dist.`（cwd 相对） | 按相对语义不误升 |
| `//` 根：`rm -rf //` / `rm -rf ///` / `rm -rf --no-preserve-root //` | catastrophic（非 win32）；win32 上 | confirm |
| 8.3 短名：`rd /s /q C:\PROGRA~1` / `rm -rf /c/PROGRA~1`（win32） | catastrophic；`rd /s /q C:\Users\ZHUA~1\.ssh` | ≥confirm |
| 8.3 不回归：`rm file~1.txt` / `rm dist/bundle~2.js`（相对） | safe（短名规则只适用 win32 形态绝对路径） |
| `..` 逃逸：`rm -rf $UNKNOWN/../etc` / `rm -rf $UNKNOWN/../../etc` / `find $UNKNOWN/../etc -delete` | catastrophic（弹栈消费未解析段） |
| `..` 不回归：`rm -rf $UNKNOWN/..` 仍 catastrophic；`rm -rf ../sibling`（可解析相对）不变；`rm -rf $PWD/dist` 仍 confirm |
| 截断动词：`echo pwn \| tee /etc/passwd` / `tee ~/.ssh/authorized_keys < k` / `sed -i 's/root/x/' /etc/passwd` / win 形 `echo pwn \| tee C:/Windows/win.ini` | catastrophic |
| 截断动词不回归：`tee out.txt`（cwd） safe；`tee -a log.txt` safe；`sed 's/x/y/' f.txt` safe；`sed -i 's/a/b/' src/main.ts`（cwd） safe/low |
| cp/mv：`cp evil /etc/passwd` / `mv /etc/passwd /tmp/x` / win 形 `cp evil C:/Windows/System32/drivers/etc/hosts` | catastrophic |
| cp/mv 不回归：`cp a.txt b.txt` / `mv x y`（cwd） | safe/low；`cp README.md ~/projects/x/` | low；`cp -r a b` / `mv -f x y` / `cp -- a b` 旗标解析正确 |
| 动态命令名：`rm$IFS-rf$IFS~` / `$(echo rm) -rf ~` / `` `echo rm` -rf ~ `` | ≥confirm |
| 动态命令名不回归：普通命令零影响；`rm -rf $(cat list.txt)`（参数位替换）仍走目标侧 confirm |
| git 全局旗标：`git -C ~ clean -fdx` | 与 `git clean -fdx ~` 同判 catastrophic；`git -C $X clean -fdx` | confirm；`git clean -fdx`（无 -C） | low 不变 |
| UNC：`rm -rf \\server\share` / `rm -rf \\?\UNC\server\share`（win32） | confirm |
| 受信变量平台门：linux ctx `rm -rf %WINDIR%` | confirm（不再 catastrophic）；win32 ctx `%HOMEPATH%` / `%HOMEDRIVE%%HOMEPATH%` / `%HOMEPATH%\.ssh` | catastrophic |
| 递归深度：第 5 层嵌套 payload | confirm（too deep）；4 层以内正常评估 |
| find 谓词不回归：`find ~ -type f -name '*.log'` 仍 safe；只读 `-exec cat/readlink/sed -n p` 仍 safe |
| fallback 控制词（F-1）：`if true; then cd ~; rm -rf .ssh; fi` / `while true; do cd ~; rm -rf .ssh; break; done` / `until false; do cd ~; rm -rf .ssh; done` / `{ cd ~; rm -rf .ssh; }` / `elif true; then cd ~; rm -rf .ssh; then :; fi` | catastrophic |
| F-1 目标归位：`if true; then cd /etc; rm -rf passwd; fi`（目标=/etc/passwd） | catastrophic |
| F-1 不回归：`case x in x) cd ~; rm -rf .ssh;; esac` / `(cd ~; rm -rf .ssh)` / `if true`+换行+`then`+换行+`cd ~`… | catastrophic；`(cd ~ && make); rm -rf node_modules` | low；`cd ~ \| rm x` | confirm（cd 不跨管道） |
| cp -t（F-2）：`cp -t /etc passwd` / `cp --target-directory=/etc passwd` / `cp -t/etc passwd` / `mv -t /etc passwd` | catastrophic（拼接 /etc/passwd） |
| F-2 不回归：`cp -t /tmp out.txt` | low；`cp a.txt /tmp/out.txt` | safe |
| CDPATH（F-3）：`CDPATH=/home/u cd .ssh && rm -rf *` / `env CDPATH=/home/u cd .ssh && rm -rf *` | catastrophic；`CDPATH=/home/u cd .ssh` | safe；`CDPATH=$X cd .ssh && rm -rf *` | confirm；`CDPATH=/home/u cd /etc && rm -rf passwd` | catastrophic（绝对目标不走 CDPATH） |
| F-3 不回归：`cd .ssh && rm -rf *`（无 CDPATH） | low |
| wrapper 表（F-4）：`busybox rm -rf ~` / `busybox sh -c "rm -rf ~"` / `busybox tee /etc/passwd` / `toybox rm -rf ~` / `sudo busybox rm -rf ~` | catastrophic；`busybox --help` / `busybox` | confirm（不崩、不静默放行） |
| gsed（F-5）：`gsed -i 's/x/y/' /etc/passwd` | catastrophic；`gsed 's/x/y/' f.txt` / `gsed -i 's/a/b/' src/main.ts` | safe；`sed -i 's/x/y/' /etc/passwd` | catastrophic 不变 |
| cp/mv 放置语义（F-6a）：`cp /etc/passwd /etc/passwd.bak`（源不再分级；目的 .bak 在 /etc 内、存在性不可知） | confirm；`cp a.txt ~` / `cp a.txt /etc` / `cp a.txt /etc/` / `mv a.txt /etc` | confirm；`cp evil /etc/passwd` / `cp evil /etc/shadow` / `cp evil ~/.ssh/authorized_keys` / win 形 `cp evil C:/Windows/System32/drivers/etc/hosts` | catastrophic；`cp a.txt b.txt`（cwd） | safe；`cp README.md ~/projects/x/` | low；`mv /etc/passwd /tmp/x` / `mv ~/.ssh/id_rsa /tmp/` | catastrophic |
| F-6b 噪声登记：`rm -rf ~/{".ssh',x}` / `rm -rf ~/{".ssh,x"}` / `rm -rf "~"/.ssh` | catastrophic（已知保守噪声，见 R6，不放宽） |
| fallback 覆盖动词（对抗复核 F-7）：`(cp evil /etc/passwd)` / `(sed -i s/x/y/ /etc/passwd)` / `(gsed -i 's/x/y/' /etc/passwd)` / `(tee /etc/passwd)` / `(echo x \| tee /etc/passwd)` / `if true; then cp evil /etc/passwd; fi` / `while true; do tee ~/.ssh/authorized_keys; break; done` / `(mv /etc/passwd /tmp/x)` | catastrophic（与 AST 路径同一套分级函数，同命令不带括号同判） |
| F-7 不回归：`(cp a.txt b.txt)` / `(tee out.txt)` / `(tee -a out.txt)` / `(sed s/x/y/ f.txt)` / `(gsed 's/x/y/' f.txt)` / `(cat file)` / `(echo hi > out.txt)` | safe/low（无害字面形态不升级） |
| F-7 fail-closed：`(cp evil $dest)` / `(sed -i s/x/y/ $target)`（未解析 `$`） | confirm（unresolved 口径，不静默放行） |
