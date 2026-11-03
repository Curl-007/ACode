# Spec：workflow 草稿文件名的铸造规则

实现：`apps/acode-cli/packages/core/src/tool/handlers/workflow-drafts.ts`
测试：`apps/acode-cli/packages/core/tests/workflow-draft-path-containment.test.ts`

## 背景

草稿文件是模型两次提交之间的**把手**：诊断给的是文件行号，下一次提交只要 `path`，改一行不必把
两万 token 的脚本再流一遍（`workflow-drafts.ts:4-7`）。文件名由 run 的展示名铸成，而实盘里 run 名
与阶段名几乎都是中文——ASCII 版白名单把每一份草稿都压成了 `workflow-N`，两个完全不同的工作流在
目录里无法分辨（`workflow-drafts.ts:30-34`）。所以草稿名的白名单**刻意**比保存名宽：保存名要当
CLI 参数与 URL 片段用，走 `SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u`（纯 ASCII）；草稿名
只要能在三个平台的文件系统上存在、且让人和模型认得出这是哪个工作流。

**这份宽是本文存在的唯一原因**：一旦放行 Unicode 字母，「字符数」就不再等于「字节数」，而文件系统
的上限是按字节数的。

本 spec 建立在 2026-11-03 的一次 CI 失败上（run `41654947675`，`verify` → `Tests (all packages)`）：
同一段代码在 Windows 上能写下的草稿文件名，在 Linux 上必然 `ENAMETOOLONG`，且被尽力而为语义
静默吞掉。此前**没有任何 spec 规定草稿文件名怎么铸**，规则只活在代码注释里，而那条注释把约束
写错了（见 R3.4）。

## 产品规则

### R1 白名单与丢弃集

`WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu`（`workflow-drafts.ts:36`）：任何 Unicode
字母 / 数字与 `_ . -` 之外的一概丢掉。

这条正则**就是**路径穿越的防线，不是风格偏好——被丢掉的正是路径分隔符（`/` `\`）、Windows 保留
字符（`: * ? " < > |`）、空白与控制字符。丢掉之后名字里不可能出现分隔符，故 slug 永远是单个目录项。

### R2 空白折叠

`WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu` → 单个 `-`（`workflow-drafts.ts:39`）：
`PR review #12` → `PR-review-12`，比挤成一团的 `PRreview12` 认得出。折叠**先于** R1 的丢弃，
否则空白会被直接删掉而不是变成 `-`。

### R3 长度预算是**两道**，不是一道

#### R3.1 码点上限

`WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64`，与 `SAVED_WORKFLOW_MAX_NAME_CHARS`（`contracts/src/tools/
saved-workflow.ts:41`）同一个数。

截断必须按**码点**（`Array.from(...)`）而不是 `String#length`：64 个 astral 字符的 `length` 是 128，
按 UTF-16 单元切会把一个字切成半个代理对，那在 Windows 上是非法文件名。

#### R3.2 UTF-8 字节预算（2026-11-03 新增）

`Buffer.byteLength(basename, "utf8") <= 255`，其中 `basename = slug + 最长同名后缀 + 扩展名`。

依据：Linux ext4 的 `NAME_MAX` 是 **255 字节**；Windows NTFS 数的是 255 个 UTF-16 单元；取 255 字节
是三者的公共下界。

**R3.1 单独不充分**，这是本次修订的核心事实：

| 输入 | R3.1 后的 slug | UTF-8 字节 | + `.dwf.ts`(7) | Linux 可写 |
| --- | --- | --- | --- | --- |
| 64 × `流`（BMP，3 字节） | 192 | 192 | 199 | ✓ |
| 64 × `𠀀`（astral，4 字节） | **256** | 256 | **263** | ✗ `ENAMETOOLONG` |

再算上同名后缀最长 `-1000`（`WORKFLOW_DRAFT_MAX_ATTEMPTS`，5 字节），最坏情况是 **268 字节**。
Windows 上同一个名字（128 个 UTF-16 单元 + 7 = 135 单元）远低于 255 单元上限，**照写不误**——
这正是它能在本地全绿、只在 CI Linux 上炸的原因。

#### R3.3 预算算法

逐码点累加、超出预算即停（不是在字节中间截断，那会切断代理对）：

```
slugBudget = 255 − byteLength(SAVED_WORKFLOW_FILE_EXTENSION) − 5   // = 243
```

对全 astral 输入得 `floor(243 / 4) = 60` 个码点（240 字节），basename = 247 字节 ≤ 255。
对 BMP CJK 输入，R3.1 的 64 码点（192 字节）已在预算内，**行为不变**。

即：R3.2 只在 R3.1 放过去的病态输入上再收一道，对所有现实名字（中英混排、纯中文、ASCII）
零影响。这是刻意选的修法——不缩小 R3.1 的 64，因为那会无谓地砍掉本来三平台都能写的中文名。

#### R3.4 订正原注释的错误理由

`workflow-drafts.ts:41` 原注释写「理由也同一条（各平台的 PATH_MAX）」。这是**错的**：Linux 的
`PATH_MAX` 是 4096，64 个字符离它远得很；真正被突破的是 `NAME_MAX = 255`（单个目录项），且单位是
字节不是字符。`saved-workflow.ts:40` 的注释有同样的措辞，但那侧名字是纯 ASCII，64 字符 = 64 字节，
结论碰巧成立，故本次不动它（AGENTS.md：偶然发现的无关问题记录说明，不顺手扩大改动）。

### R4 兜底词

什么都不剩、或只剩点（`.` / `..` 是目录项，不是文件名）时用 `workflow`
（`WORKFLOW_DRAFT_FALLBACK_SLUG`）。emoji 属 `\p{So}` 不在白名单内，`😀😀😀` 因此整体落到兜底词——
这是刻意保守，不是缺陷，测试把实际行为钉住以免日后被误当作 bug「修宽」正则而放进分隔符。

### R5 同名冲突

`-2`、`-3`… 顺延到 `WORKFLOW_DRAFT_MAX_ATTEMPTS = 1000`，且用 `wx`（独占创建）落盘——「取名」与
「占名」是同一个原子动作，两次并发提交不可能落进同一个文件。撞满返回 `undefined`。

后缀参与 R3.2 的预算（见 R3.3），故顺延不会把已经贴着上限的名字推出 255。

### R6 尽力而为语义**不得**用来兜 R3

写不进去（只读 checkout、`.acode` 是个普通文件、盘满）不让调用失败，返回 `undefined`，模型读到的
退回「改好脚本再内联提交」（`workflow-drafts.ts:14-16、101-105`）。

这条语义本身是对的，但它会把 R3 类的错误一起**静默吞掉**：2026-11-03 的 CI 实测里，Linux 上的
`ENAMETOOLONG` 正是被外层 catch 吞成 `undefined`，用户只看到「这次没有草稿」，没有任何诊断信息，
也没有日志。所以 **R3.2 是必须在铸造阶段就成立的不变量**，不是「反正写失败会兜住」的可选项——
一个静默消失的草稿会让模型退回内联重提两万 token，代价是可观测的性能退化而非报错。

## 验收

对应 `tests/workflow-draft-path-containment.test.ts`：

1. 中文名 `登录流程重构` 完整保留（6 码点 / 18 字节，两道预算都不触发）。
2. `PR review #12` → `PR-review-12`（R2 折叠 + R1 丢 `#`）。
3. 80 × `流` → 截到 **64** 码点（R3.1 生效、R3.2 不生效：192 + 7 = 199 ≤ 255）。
4. 80 × `𠀀` → 截到 **60** 码点，`basename` = 247 字节 ≤ 255，且 `Array.from(stem).join("") === stem`
   （无孤立代理项）。**这条在 2026-11-03 之前于 Linux 上必然失败**（`writeWorkflowDraft` 返回
   `undefined`），是 R3.2 的回归测试。
5. 对以上每个用例都断言 `Buffer.byteLength(basename, "utf8") <= 255`——断言的是**不变量**而不是
   某个平台上的经验值，故在 Windows 本地也能守住 Linux 的约束。
6. 10 × `😀` → 兜底词 `workflow`（R4）。
7. 敌意名字（`../../escape`、绝对路径、Windows 保留字符等 15 种）落点仍在草稿目录内（R1）。

## 已知边界与未验证

- **未在真实 Linux 文件系统上本地复现**（开发机是 Windows）。`NAME_MAX = 255` 取自 ext4 的公开
  常量；CI Linux runner 上的实测失败（run `41654947675`，`assert.ok(longAstral)` 得到 `undefined`）
  是这个约束真实存在的直接证据，修复后的绿灯（见提交记录）是它被解除的证据。
- **macOS 侧未实测**。APFS/HFS+ 的名字上限按 UTF-8 编码计，通常也报 255 字节级；取 255 字节作为
  公共下界对三者都安全，但 macOS 上是否还有更严的限制未验证。
- R3.3 的 `−5` 后缀预算绑定 `WORKFLOW_DRAFT_MAX_ATTEMPTS = 1000`（最长 `-1000`）。若日后把上界
  调到 10000 以上，这个常量必须同步——两处都在同一个文件内，但没有机械门禁盯住这对耦合。
- 只审了草稿 slug 这一处「Unicode 名字 → 文件名」的铸造点。仓库里是否还有别的按码点数限长、
  却写进文件名的路径，本次未做全仓普查。
