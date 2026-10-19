# Spec：自定义 slash 命令位置参数与单遍模板渲染

来源：omp 价值提取波 2 WI-15（台账 T2「slash 命令位置参数」行 + 九路报告要点存档⑦第 5 项）。
机制参照 oh-my-pi（MIT）`packages/coding-agent/src/utils/command-args.ts` 的
`substituteArgs` / `parseCommandArgs` 与 `docs/slash-command-internals.md` §6；只搬模板
替换语义，不搬其 prompt.render/Handlebars 面（ACode 无对应物）。

## 事实源与所有权

- **唯一实现（本波）**：`apps/acode-cli/packages/cli/src/custom-command-expand.ts`
  （`expandCliCustomCommandPrompt`）。消费方：`cli/src/command-center-custom.ts
  buildCustomCommandPrompt` ← `cli/src/command-center/handlers/custom.ts`（TUI 交互与
  `acode -p` 非交互的 command-center 派发路径）。
- **守护测试**：`apps/acode-cli/tests/custom-command-positional-args.test.mjs`。
- **第二展开面（本波所有权外，见 W1）**：`apps/acode-cli/packages/contracts/src/commands/
  index.ts` 的 `expandCustomCommandTemplate`（bootstrap `resolveACodeCustomCommandPrompt`
  → create-app input-facade 路径，desktop-agent/ACP 直提原文时生效）。两处是仓库既有的
  同语义双拷贝（含各自的 `splitCustomCommandArguments` 副本），本波只改 cli 拷贝。

## 模板语法表（渲染作用于命令文件正文）

| 占位符 | 语义 | 缺位/非法时 |
| --- | --- | --- |
| `$ARGUMENTS` | 整体替换为原始参数串（`input.args.trim()`，保留引号与内部空白原样） | 无参数 → 空串 |
| `$@` | 聚合，**等价 `$ARGUMENTS`**（同一原始参数串） | 同上 |
| `$N`（N 为任意位数数字，含 `$0`） | 第 N 个位置参数（1-based，引号分组切分后、引号已剥离） | 缺位 → 空串（边界裁决：`$3` 但只给 2 个参数 ⇒ 渲染为空串，不报错、不保留字面量）；`$0` → 空串 |
| `$@[start]` / `$@[start:]` | 从第 start 个（1-based）参数取到末尾，`" "` 连接 | start<1 或 start 超出参数个数 → 空串 |
| `$@[start:length]` | 从第 start 个起取 length 个，`" "` 连接 | start<1 / 越界 / length≤0 → 空串 |

非法/畸形切片形态按正则备选序回退（与 omp 一致）：`$@[2`（未闭合）、`$@[a]`、
`$@[2:-1]`（length 组只收 `\d*`）中切片备选不匹配，裸 `$@` 备选命中 ⇒ 渲染为
「参数串 + 畸形尾巴字面量」（如 `$@[2:-1]` → `a b c[2:-1]`）。占位符本身不支持转义
（无 `\$1` 语法，omp 与 ACode 现状一致）。

## 单遍渲染语义（防注入，核心裁决）

1. **单遍**：一次 `String.replace(ARGUMENT_PLACEHOLDER_PATTERN, …)` 扫描完成全部占位符
   替换；**替换结果不再进入扫描**——参数值里出现的 `$1`/`$@`/`$ARGUMENTS` 一律按字面
   文本保留，不做二次展开。正则备选序与 omp 一致：切片 → `$ARGUMENTS` → `$@` → `$N`。
2. **存量行为差异（有意的防注入加固）**：旧实现是两遍（先 `replaceAll("$ARGUMENTS")`
   再全文 `replace(/\$(\d+)/g)`），参数值内的 `$N` 会被第二遍展开、并把
   `usedArgumentsPlaceholder` 置真（吞掉 fallback 追加）。单遍化后：占位符判定与替换
   都只看模板本身。`$ARGUMENTS` 令牌自身的替换语义不变（仍是原始 trim 串、仍替换全部
   出现），存量「模板不含占位于参数值里」的命令零回归。
3. **`usedArgumentsPlaceholder`**：模板匹配到任一占位符形态（`$ARGUMENTS`/`$@`/切片/
   `$N`）即为真（对齐 omp `templateUsesInlineArgPlaceholders` 的 shell 形态集）。
   为假且有参数时保留既有 fallback：正文尾追加 `\n\nUser arguments:\n{args}`。
4. **`$ARGUMENTS`/`$@` 取值裁决**：用 ACode 既有的「原始 trim 串」，不采用 omp 的
   `args.join(" ")`（重新 join 会把引号分组归一化、改变存量 `$ARGUMENTS` 输出——
   违反零回归约束）。因此 `$@` 与各 `$N` 的拼接结果在含引号参数时可能不同形，属预期。

## 参数切分规则（存量保留，不改）

`splitCliCustomCommandArguments`（本文件既有实现）维持原样：单/双引号分组、引号剥离、
反斜杠转义（引号内外均生效）、任意空白（`/\s/`）分隔、空引号参数（`''`/`""`）丢弃、
未闭合引号消费到串尾不报错。**与 omp `parseCommandArgs` 非 strict 模式的已记录差异**：
omp 不支持反斜杠转义、只按空格/Tab 分隔；ACode 支持转义且按任意空白分隔。裁决：保留
ACode 既有切分（已上线行为，改动即回归），差异在此登记，不追平。

## 其余不变面

- 动态 shell 展开（`` !`…` `` / ```` ```! ```` 围栏）在 cli 路径仍旧拒绝
  （`usesUnsupportedDynamicShell` 抛错），本波不放开。
- `argumentCount` = 切分后位置参数个数（缺位占位符不影响该计数）。
- 返回体 prompt 骨架（`Run custom command /…`、来源行、skills 指令行）不变。

## 接线需求 / 登记项（本波所有权外）

| # | 项 | 说明 |
| --- | --- | --- |
| W1 | contracts 拷贝同步 | `contracts/src/commands/index.ts expandCustomCommandTemplate`（bootstrap resolver 路径：desktop-agent/ACP/直提原文）仍是旧两遍语义，无 `$@`/切片。同步补丁 = 把本文件的单遍渲染函数与切片语义原样移植（两处已是刻意双拷贝，无共享点可复用）。未同步前，使用新语法的命令在 facade 路径按字面量渲染（显性降级，不静默出错） |

## 验收场景

1. `$1`/`$2`/`$9`/多位数 `$10` 按位替换；缺位（`$3` 只有 2 个参数）与 `$0` → 空串。
2. `$@` 与 `$ARGUMENTS` 渲染结果逐字节相同（= 原始 trim 串）；多处出现全部替换。
3. 切片：`$@[2]`、`$@[2:]` 取到末尾；`$@[1:2]` 取两个；`$@[0]`/`$@[99]`/`$@[2:0]` → 空串；
   畸形形态（`$@[2:-1]`/`$@[a]`/未闭合 `$@[2`）按备选序回退为 `$@` 聚合 + 字面尾巴。
4. 单遍防注入：参数值含 `$1`/`$ARGUMENTS`/`$@` 时按字面保留，不二次展开，且不置
   `usedArgumentsPlaceholder`（fallback 追加照常发生）。
5. 引号分组：`a "b c" 'd e'` → `$1=a`、`$2=b c`、`$3=d e`、`argumentCount=3`；
   反斜杠转义与空引号丢弃行为与存量一致。
6. 存量零回归：仅含 `$ARGUMENTS` 的模板、无占位符模板的 fallback 追加、shell 语法拒绝、
   返回体骨架逐一不变。
