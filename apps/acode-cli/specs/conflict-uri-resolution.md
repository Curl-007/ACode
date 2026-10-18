# conflict:// 合并冲突解决面（read 检出 + write 拼接）

> 状态：实施中（UX 波第 1 件，编排器单人，配额墙窗口内）
> 机制参照：oh-my-pi (MIT) packages/coding-agent/src/tools/conflict-detect.ts、
> conflict-uri.ts、internal-urls/conflict-protocol.ts，Copyright (c) 2025 Mario
> Zechner & Stencil Labs。ACode 为 Node 栈重写 + 会话面适配，非逐行搬运。

## 背景与动机

git 合并冲突文件里的 `<<<<<<< / ======= / >>>>>>>` 标记块，现状 ACode 只能靠
模型对整文件 Edit 手工挑边——锚文本长、易错、多块文件极易漏。omp 的冲突面把
每个冲突块变成**一个稳定 URI**：`read` 输出检出并注册冲突块、尾注告知 id，模型
`write conflict://<id>` 一个 token（`@ours`/`@theirs`/`@base`）即整块解决；
`conflict://*` 支持批量按行指派。ACode 全仓现无任何冲突工具面（grep 零命中），
本项为纯增量。

## 产品规则

### R1 检测（零额外 IO）

- 扫描点 = read 文本输出路径（read-text.ts 的行收集产物），**不产生额外磁盘读**。
- 标记形态从严（omp 同款）：仅列 0 起始、精确前缀长度（`<<<<<<<`、`|||||||`、
  `=======`、`>>>>>>>`）后接行尾或「单空格+标签」的行才是 marker；普通以 `<`/`=`
  开头的代码行永不误判。
- 块完整性：opener + separator + closer 三者齐备才注册；closer 超出本次读取窗口
  的块丢弃（模型看到开标记后可加宽读取）。
- CRLF：扫描剥尾部 `\r`，存储 LF 归一；拼接回写时按文件原 EOL 形态恢复。
- base 段（`|||||||`，diff3 风格）可选：有则 `@base` 可用，无则 `@base` 报错。

### R2 注册与 id（会话键控，skill-path-activation 同哲学）

- `ConflictHistory` 按 sessionId 键控进程级 Map；id 会话内递增稳定（conflict://1…）。
- 同一块重复 read 不重复注册（按 文件路径+起始行+块指纹 识别，命中返回既有 id；
  文件被外部改动后旧条目失效、重新注册发新 id——id 不复用防陈旧拼接）。
- sessionId 缺席（测试/无会话执行面）= 不注册不报错，read 输出零变化（零回归面）。
- 生命周期：runtime beginShutdown 清理本会话历史（agent-runtime.ts 既有
  clearSkillPathActivations 旁）；进程亡故=缓存亡故，不持久化。

### R3 read 尾注（仅存在冲突时出现）

- 正文输出 verbatim 不变（不重写、不折叠冲突块）；尾部追加紧凑清单：
  每块一行 `conflict://<id> <path>:<startLine> (sides: ours/theirs[/base])`，
  加一行用法提示（write conflict://<id> + @ours/@theirs/@base token 或替换内容；
  conflict://* 批量）。
- 尾注字符预算：块数超过 50 时截断清单并给出总数（防巨型冲突文件刷屏）。

### R4 conflict:// 读形态（Read 工具 scheme 分支，skill:// 先例同款）

- `conflict://<id>` = 该块当前磁盘文本（含 marker 原样）；
- `conflict://<id>/<ours|theirs|base>` = 单侧内容；
- id 未注册/已失效 → 模型可操作错误（提示重新 read 源文件）；base 缺席报错。

### R5 write 解决语义

- `write { file_path: "conflict://<id>", content }`：
  - content 为单 token `@ours`/`@theirs`/`@base`/`@both` → 取对应侧替换整块
    （`@both` = ours 与 theirs 顺序拼接，行间不加 marker；`@base` 无 base 段报错）；
  - content 为其他字面量 → 视为替换内容整块拼接（模型自撰合并结果）。
- `write { file_path: "conflict://*", content }` 批量：content 每行
  `<id>: @token` 指派（`#` 前缀容错）；含非指派行则整份 content 作为共享替换
  依 omp 语义拒绝歧义形态（批量只收纯指派行，混合形态 fail-loud 给示例）。
- **写前磁盘重验证**：拼接前重读文件，注册区域（行号+marker 文本）必须与磁盘
  逐字节吻合；out-of-band 编辑 → fail-loud stale（要求重新 read），绝不盲拼。
- 同文件多块自底向上拼接（保上方锚有效）；**文件内 all-or-nothing**：任一块
  验证失败该文件零写入。
- 成功解决后：失效该文件全部已注册块（行号已位移）+ readFileState 失效 +
  fs 扫描缓存前缀失效（WI-2 既有纪律）+ 返回结果列出已解决 id 与剩余冲突数。

### R6 权限与审批

conflict:// write 是文件写操作：审批/权限走既有 write 面（URI 解析为真实
workspace 路径后判定），不因 scheme 形态绕过任何门禁；工作区外路径拒绝
（与 read/write 现有 path policy 同一裁决点）。

### R7 边界（不做面）

- 不做 git 层集成（status/rerere/checkout --ours 等由 Bash 面承担）；本面是纯
  文件文本层，git 无关（手工贴的冲突标记同样可用）。
- 不做交互式三方合并 UI；不做冲突块内 diff 渲染（read 原文已含）。
- ApplyPatch/Edit 工具不接 conflict://（仅 Read/Write 两面，omp 同款收口）。

## 所有权与落点

- 新模块 `core/src/tool/conflict/{detect,history,splice,uri,index}.ts`（各 ≤400 行）。
- read 侧钩子：read-text.ts（行收集产物处，最小 diff）；write 侧钩子：write.ts
  handler 入口 scheme 分支（write.ts 现 399 行贴限——输出构造段抽出
  write-output.ts 腾预算，行为零变化）。
- 清理接线：runtime/agent-runtime.ts beginShutdown（+1 行）。
- Read 工具 describe/schema：file_path 描述补 conflict:// 形态（contracts 面，
  与 skill:// 同句合并——共享桶由编排器落）。

## 验收场景

1. 检测矩阵：标准块/diff3 base 块/CRLF 文件/窗口截断块（丢弃）/伪标记行
   （`<div>`、`=====` 装饰线、缩进 marker）不误判。
2. id 稳定：同块重复 read 同 id；文件外部改动后重 read 发新 id、旧 id 失效。
3. read 尾注：有冲突才出现；50 块截断；sessionId 缺席零变化（零回归断言）。
4. conflict:// 读：整块/单侧/base 缺席报错/未注册 id 报错文案可操作。
5. write 解决：四 token 各自语义、字面量替换、批量指派、混合形态 fail-loud、
   stale 重验证拒绝（out-of-band 编辑注入）、同文件双块自底向上、
   all-or-nothing（一块 stale 全文件零写入）。
6. 解决后面：readFileState/扫描缓存失效、同文件其余块 id 失效、返回剩余计数。
7. 权限：conflict:// 写走既有审批面（桩断言判定入参与真实路径一致）。
8. 存量零回归：read/write 现有测试全绿；write.ts 抽取 write-output.ts 后行为
   逐字节等价（既有输出断言不动）。
