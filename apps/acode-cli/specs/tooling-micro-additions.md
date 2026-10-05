# 工具微增补：invalid 反馈护栏 + open 工具（K9）

方案条目：`docs/k-series-upgrade-plan.md` §K9。`invalid` 工具语义参照 jcode (MIT)
`crates/jcode-tool-core/src/lib.rs:48-92` 与其 tool 面的 invalid 注册（把模型发出的
畸形工具调用变成**显式可学习的反馈通道**而不是静默错误）；`open` 为 ACode 原生补面。
自撰实现，无拷贝。

两个独立小件，一个 spec 承载（同批实施，互不依赖）：

1. **invalid**：模型调用不存在的工具名 / 入参不符合 schema 时，今天的路径是引擎返回
   一条错误文本——模型常常重复犯错（尤其换模型/新工具上线时）。jcode 的做法是把这类
   反馈**注册成一个真工具**（名字就叫 `invalid`，描述写明「这是你上次畸形调用的回执」），
   错误文本经它规范化返回：工具名就近建议（模糊匹配最接近的合法名）、schema 违例
   字段逐条列出。模型对「工具结果」的注意力远高于裸错误串，修复率显著更高
   （jcode 以此支撑其 30+ 工具面的模型兼容性）；
2. **open**：agent 侧「打开/揭示文件、目录或 URL 给用户」的工具。ACode 平台服务已有
   `IPlatformService.openExternal(url)`（`packages/shared/src/platform.ts:626`）与
   可选 `openExternalFile?(path)`（`:652`）——**平台面已在，缺 agent 工具面**。
   场景：agent 完成构建让用户看产物、打开日志目录、打开预览 URL。

红线：invalid 不改变既有错误处理路径的**判定逻辑**（只改呈现形态）；open 不绕过
平台边界（AGENTS.md：平台操作必须经 `IPlatformService`，不直接 `window.acode` /
不 spawn `start`/`open` 命令）；两项都不新增权限档（open 的 URL/路径开箱走既有
confirm 分级面，见 R2）。

裁剪边界：jcode_docs 式自文档搜索**明确不做**（理由见「未做」§3）。

---

## 背景：已核实的现状

1. **畸形调用现状**：引擎对未知工具名/ schema 违例的错误文本路径在 runtime 的工具
   执行回执层（实施首日定位精确接线点——按 `tool/handlers/index.ts` 的注册表查找
   失败路径）；呈现为普通 error 字符串，无就近建议、无结构化违例清单；
2. **open 现状**：`platform.ts:626` `openExternal(url: string): void` 同步签名、
   `:652` 可选 `openExternalFile?(path)` 返回 `{success, error?}`——hooks 层
   （`packages/ui/src/hooks/`）已有消费方先例；agent 工具面无对应（`handlers/`
   目录无 open/reveal 文件，已核实）；
3. **工具注册模式**：`handlers/index.ts` 的 BUILT_IN 聚合 + port 门控注册
   （`runtime-tools.ts` 的 includeWorkflow 先例）。

## 产品规则

### R1 invalid 工具（`core/src/tool/handlers/invalid.ts`）

- 注册名为 `invalid` 的工具（描述：「引擎把畸形工具调用的回执经此工具返回——检查
  建议 corrected name 与字段违例清单，下一步用正确调用重试，不要重复原样调用」）；
- **接线点**：引擎工具分发处，对「unknown tool name」「schema 违例」两类失败的回执
  改为构造 `invalid` 工具的 result（判定逻辑/错误分类**零变化**——同样失败还是失败，
  变的只是呈现载体）；
- 回执结构（markdown 规范化）：
  - unknown name：原始名 + 就近建议（编辑距离 ≤2 的合法工具名列表，最多 3 个；
    无近似则列当前会话可用工具名全集——**全集来自注册表快照，不是硬编码**）；
  - schema 违例：违例字段逐条（路径 + 期望 + 实际类型；实际值**截断 200 字符**——
    防超长入参把回执变成投毒面）；
- **不存在的调用面不产生副作用**：invalid 是只读回执，畸形调用本身不执行任何工具；
- 该工具**不出现在模型可主动调用的注册表**（模型主动调 `invalid` 无意义——引擎侧
  合成的回执载体；schema 里定义为引擎内部使用，描述声明这一点）。

### R2 open 工具（`core/src/tool/handlers/open.ts`）

```
Open({ target: string            // URL 或 workspace 相对/绝对路径
       action?: "open" | "reveal" // 缺省 open；reveal=在文件管理器中定位
     })
→ { opened: boolean; kind: "url" | "file" | "directory"; detail?: string }
```

- **平台面强制**：desktop/web 经注入的 platform port（`IPlatformService` 的注入形态）
  调 `openExternal`（URL）/`openExternalFile`（文件/目录）；`reveal` 动作若平台面
  无对应方法（`openExternalFile` 是可选成员）→ 返回 `opened:false` + detail 说明
  （能力探测，不 fail）；**平台面缺席 → 工具不注册**（port 门控，与 Workflow
  工具同款注册门）。**实施修订（2026-10-04）**：CLI/TUI 宿主由 bootstrap 提供
  **native opener port 实现**（`platform-open-port.ts`，execFile 系统 opener：
  win `cmd /c start` / mac `open` / linux `xdg-open`，不经 shell 字符串拼接）——
  这是**宿主侧**实现 port 接口，不违反 R2 的「工具不 spawn 开箱命令」红线（工具
  仍只经 port；desktop host 下发链接入后由宿主替换注入）；`reveal` 在 CLI 形态
  无能力 → opened:false 诚实降级；
- **分类判定**：URL（`http(s)://` 协议白名单——`http/https` 之外的协议一律拒绝，
  `file://`/自定义协议是逃逸面）vs 路径（经既有 workspace 路径治理工具解析——
  不手写格式，AGENTS.md Workspace Identity 章口径）；
- **权限**：`open` 是**用户可见的副作用面**——URL 开箱与文件开箱默认走 confirm
  分级（capability 中档 + needsApproval），与「agent 能替用户打开任意网页」的风险
  对齐；路径在 workspace 内且为目录 → 低档（打开目录管理器无破坏性）；
  workspace 外路径 → confirm（外部文件系统范围）；
- 每次调用记 info 级日志（event: `tool.open`，记 kind 与 opened，**不记 URL/路径
  本体**——路径/URL 可能含敏感段，对齐 J3-2 的日志纪律）。

### R3 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| invalid 回执 | 引擎分发层局部（合成产物，无状态） | 单次调用 |
| 工具名注册表快照 | 既有工具注册面（就近建议的数据源） | 既有 |
| 平台能力探测 | platform port（注入） | 进程 |
| open 权限判定 | 既有 permission 管线 | 既有 |

不变量：invalid 零副作用；open 零直接 OS 调用（全经 port）；两项均无新增持久状态。

## 常量

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `INVALID_SUGGEST_MAX` | `3` | R1 |
| `INVALID_SUGGEST_EDIT_DISTANCE` | `≤ 2` | R1 |
| `INVALID_VALUE_PREVIEW_CHARS` | `200` | R1 |
| `OPEN_URL_PROTOCOLS` | `["http:", "https:"]` | R2 |

## 接口

contracts：`OpenInputSchema/OutputSchema`（invalid 无入参 schema——引擎合成）；
core：`tool/handlers/{invalid,open}.ts`；引擎分发层一处接线（unknown/schema-fail 回执
载体切换）。

## 验收场景

测试：`apps/acode-cli/tests/tooling-micro-additions.test.mjs`。

**invalid**：
1. unknown name「Writee」→ 回执含建议 `Write`（编辑距离 1）；无近似名（「zzz」）→
   回执含当前注册表工具名全集；
2. schema 违例 → 逐字段路径+期望+截断实际值（201 字符入参截到 200 + 省略标记）；
3. 畸形调用**零工具执行**（被调用的伪造名不产生任何副作用——执行计数断言）；
4. 模型主动调 `invalid` → 引擎按 unknown-name 处理（回执说明该工具非主动调用面）；
5. 既有错误分类测试全绿（判定逻辑零变化——只有载体变化，分类断言重跑）。

**open**：
6. URL：`https://` 开箱经 port `openExternal` 断言；`file://`/`ftp://`/`javascript:`
   → 拒绝（协议白名单钉住）；
7. workspace 内目录 → 低档放行；workspace 外路径 / URL → confirm 面（needsApproval
   断言）；
8. 平台面缺失 → 工具不注册（CLI 形态断言）；`reveal` 无平台能力 → `opened:false`
   + detail（不 fail）；
9. 日志不含 URL/路径本体（只 kind+opened，源码断言）。

## 未做与取舍

1. **invalid 不做「自动重试」**：只反馈不代理重试——自动重写参数再执行是行为越权
   （模型应自己决定修正后的调用）；
2. **open 不做「等待用户查看后确认」**：开箱即回执（fire-and-forget 语义与
   `openExternal: void` 同构）；交互确认流是 UI 域概念；
3. **jcode_docs 自文档搜索不做**：jcode 的 `jcode_docs` 服务其大量内置文档（工具指南/
   最佳实践库），ACode 的对应面（AGENTS/DESIGN/specs）已有 context 注入体系
   （system prompt sections + skills），再做一个搜索工具是与 context 体系竞争的
   第二条知识通道（AGENTS.md 单一所有者原则）——不做；
4. **notify-email 的 SMTP 通知**（jcode 小件之一）：bots 渠道域，不在工具微增补里
   夹带。

## 第三方归属

invalid 工具语义参照 jcode (MIT) `tool-core`（畸形调用回执作为注册工具的呈现策略、
就近建议思路），自撰实现；open 为 ACode 原生补面，无外部参照。
