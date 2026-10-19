# skill:// 读协议（技能携带脚本/模板资产的沙箱化 Read 分支）

需求源：omp 价值提取波 2 WI-13（台账 T1#13「skill:// 读协议」）。机制参照
oh-my-pi（MIT）`docs/skills.md:178-207`（`skill://` URL behavior：裸名=SKILL.md、
子路径=技能目录内资产、拒绝对路径/`..`/越界、realpath 防 symlink 逃逸、目录返回列表、
缺失显式报错）与 `:219-226`（MCP skill 兜底——本批**不移植**，见裁决总览）；实现参照
`packages/coding-agent/src/internal-urls/skill-protocol.ts`（skillTargetPath 双层校验）与
`internal-urls/filesystem-resource.ts`（validateRelativePath/ensureWithinRoot）。
Copyright (c) 2025 Mario Zechner & Stencil Labs。本项以按 ACode 端口面重写为主，不搬代码。

## 背景：已核实的现状（基线 007c22c）

| 事实 | 位置 |
| --- | --- |
| SKILL.md 全文只经 Skill 工具加载（strip frontmatter + 变量展开 + live-build 注入），技能目录内 references/templates/scripts 资产无 URI 面，只能靠文档提示的绝对路径 Read | `core/src/tool/handlers/skill.ts:41-124` |
| Read handler 对 `file_path` 一律走 `resolveWorkspacePath`（相对路径按 cwd 解析）；`skill://x` 会被拼成 `<cwd>\skill:\x` 形态的假路径再报 file-not-found | `core/src/tool/handlers/read.ts:160-165`、`core/src/tool/path-policy.ts:16-47` |
| 技能发现/优先级机制齐备：roots 顺序 = config extraRoots(project,10…) → 用户 `~/.acode/skills`(20)/`~/.agents/skills`(30) → 项目目录链 `.acode`/`.agents`(40…) → extraResolvedRoots（plugin+bundled，调用方带 priority）；discoverSkills 按 priority 升序迭代、按 path 去重、按 name 稳定排序 | `adapters/src/skills/roots.ts:20-59,94-105`、`adapters/src/skills/index.ts:62-96` |
| 同名赢家语义：`loadSkill` 在排序产物上 `find(name === request ∥ qualifiedName === request)`，稳定排序使同名条目保持 root priority 序 → 高优先层赢；plugin 技能带 `qualifiedName = <pluginName>:<skillName>` | `adapters/src/skills/index.ts:98-133,265-278,298-300` |
| plugin 扫描不跟随符号链接（根/子目录/SKILL.md 三粒度全拒）；用户级根保持跟随（symlink 导入是受支持功能）。但**技能目录内部的资产级 symlink 两层都未校验** | `adapters/src/skills/scan.ts:16-24,45-80` |
| `SkillPort` 契约只有 discoverSkills/loadSkill 两方法；`ToolExecutionContext.skillPort` 可选，executor 已透传；core 不依赖 @acode/adapters（端口注入） | `contracts/src/skills/index.ts:122-128`、`core/src/tool/types.ts:162`、`core/src/tool/executor/impl.ts:47` |
| `FileSystemPort` 无 realpath 面；core handlers 已有直接使用 `node:fs` 的先例（bash-image-output 等） | `contracts/src/interfaces/file-system.port.ts:280-322` |
| 模型可见技能清单注入点在 `core/src/context/sections/skills.ts`（WI-10 独占面，本批不碰） | — |
| Grep 的 `path` 参数同样只走 `resolveWorkspacePath` → `fileSystemPort.searchText` | `core/src/tool/handlers/grep.ts:54-72` |
| 架构 ratchet：`read.ts` 527 行 legacy 超限（指纹不含行数，存量增长不产新违规）；`adapters/src/skills/index.ts` 361 行已收回上限内（再超 400 即 regrown 违规）；新文件 ≤400 行 | `.architecture-baseline.json`、`scripts/architecture/index.mjs:382-403` |

## 裁决总览

| 项 | 裁决 | 理由 |
| --- | --- | --- |
| Read 工具 `skill://` scheme 分支（裸名=SKILL.md 全文、子路径=资产） | **做**（core `read.ts` 最小分支 + 新 `read-skill.ts` 解析/沙箱） | 本批主体；解析出物理路径后整体复用既有 image/video/PDF/text 管线，offset/limit/缓存/行号免费获得 |
| 名称→技能根解析 | **复用** `SkillPort.discoverSkills` + 与 `loadSkill` 相同的 find-first 赢家语义；**不改** adapters、**不改** contracts | 「查清现状复用，不重建」；一致性由测试钉住（skill:// 赢家 === loadSkill 赢家） |
| 沙箱硬边界（绝对路径/`..`/realpath 逃逸/控制字符） | **做**，对**所有**技能层生效（比 omp 更严：omp 仅对 plugin 技能做 realpath containment） | plugin 内容不可信；用户技能资产级 symlink 同样可指向 `~/.ssh` 等，URI 面必须自守 |
| 越界/缺失错误的可操作信息 | **做**：拒绝与 not-found 均附该技能根**一层列表**（目录带 `/` 后缀，上限 100 条）；目录目标报「是目录」+ 该目录一层列表 | 一层列表有界、便宜、足够模型自纠；全目录树在深技能下不可控 |
| 同名冲突命名空间 `<ns>/<name>` 双段形（omp 形） | **登记不做**（T2「skill 同名冲突命名空间」另项）；ACode 现状 `qualifiedName = <plugin>:<name>` 单段形已可经 `skill://<plugin>:<name>` 命中 | 命名空间化是独立 T2 项，本批不扩名法 |
| Grep 工具 `skill://` root | **登记不做**：技术上低成本（grep.ts:54 分支复用本批 resolver，约 10 行），但 `grep.ts` 不在本波所有权清单（六代理同树并发，越权改动即冲突面） | 诚实裁决：成本≈低、所有权≈禁改 → 登记；后续批次直接 import `read-skill.ts` 的 `resolveSkillUriDirectory` 即可 |
| MCP skill 兜底（omp `:219-226`：无本地技能命中时转发 MCP 广告的同名 URI 资源） | **登记不做** | ACode 无「MCP 服务器广告 skill:// 资源」的基础设施面（无 internal-url router、无资源目录等待语义）；引入需先有 MCP 资源读协议，另批 |
| 提示词面：Read 工具 description 增补 skill:// 形态 | **做**（read.ts 内一行改写，本波所有权内） | 模型经工具 description 即知形态存在 |
| 提示词面：available-skills 清单段增补 | **登记为申请**（WI-10 独占 `core/src/context/**`） | 见「共享桶/他波面申请」 |
| contracts `file_path` 的 `.describe()` 增补 | **登记为申请**（contracts 不在本波所有权） | 同上 |

## 产品规则

### R1 · scheme 语法

- `skill://<name>` → 该技能 `SKILL.md` **原始全文**（含 frontmatter；与 Skill 工具的
  strip/展开语义刻意不同——这是文件读取，不是技能调用）。
- `skill://<name>/<relative-path>` → 技能目录内资产；`<name>` 与 `<relative-path>` 均经一次
  `decodeURIComponent`（单层解码，与 omp 一致；`%252e` 双写解码后是字面 `%2e`，无害）。
- scheme 前缀大小写不敏感（`SKILL://` 等价）；`<name>` 与 `<relative-path>` 本身大小写敏感
  （Windows 文件系统的大小写不敏感由 OS 层兜底，不做二次归一）。
- 结尾 `/` 或全斜杠路径（`skill://name/`、`skill://name//`）：前者等价裸名（SKILL.md），
  后者视为寻址技能目录本身 → 目录列表错误（R4-E10）。
- 本 URI **不是** WHATWG URL：`?`/`#` 无特殊语义，按字面进路径（模型带 `#anchor` 时得到
  not-found + 资产清单，可自纠）。`<name>` 可含 `:`（plugin qualifiedName 形
  `<plugin>:<skill>` 直接可用）。
- 解析出物理路径后整体落入既有 Read 管线：行号、offset/limit、token 截断、readFileState
  缓存（`file_unchanged` 桩）、image/video/PDF 分派全部与普通路径一致；schema 层二进制
  扩展名门（`UNSUPPORTED_BINARY_EXTENSIONS`）对 skill:// 同样生效（按 URI 尾部扩展名判定）。

### R2 · 发现与赢家（复用，不重建）

- 名称解析唯一入口 = `context.skillPort.discoverSkills({ workingDirectory })`（含
  disabledPaths 剔除、bundled/plugin/项目/用户全部 root 层），随后
  `skills.find(s => s.name === name || s.qualifiedName === name)` —— 与
  `NodeSkillAdapter.loadSkill` 的 `matchesSkillRequest` 语义逐字一致（find-first on
  priority-stable sorted array = 高优先 root 的裸名赢家）。一致性由验收场景 S7 钉住。
- `skillPort` 缺席（技能特性关闭/未接线）→ E4 不可用错误，不做任何路径回退搜索。

### R3 · 沙箱规则表（硬边界，全部在读取前判定）

| # | 规则 | 判定 | 违反 → 错误 |
| --- | --- | --- | --- |
| R3.1 | 名字非空 | decode 后 `name.length > 0` | E1 |
| R3.2 | 无控制字符 | name 与 relative-path 均不含 `\0` | E3 |
| R3.3 | 拒绝绝对路径 | `isAbsolute(rel)` ∥ `^[A-Za-z]:`（盘符形，跨平台一律拒——含大小写盘符）∥ 以 `/` 或 `\` 开头 ∥ UNC `//`/`\\` | E6 |
| R3.4 | 拒绝 `..` 段 | `rel.split(/[\\/]/)` 任一段 === `..`（decode 后判定，覆盖 `%2e%2e%2f`、`..\` 混合分隔符） | E7 |
| R3.5 | 词法包含 | `resolve(skillDir, rel)` 必须落在 `resolve(skillDir)` 内（win32 大小写不敏感比较；R3.3/R3.4 后的纵深防御） | E7（复用 traversal 文案） |
| R3.6 | realpath 包含 | `realpath(target)` 必须落在 `realpath(skillDir)` 内（win32 大小写不敏感比较）→ 捕获资产级 symlink/junction 逃逸，含中间目录链接；技能根自身是 symlink（用户级受支持形态）时两侧同取 realpath，不误伤 | E8 |
| R3.7 | 目标类型 | realpath 后 stat：目录 → E10；非常规文件且非目录 → E12 | E10/E12 |

判定顺序 = 表序（先词法后 realpath：词法拒绝不需要触碰文件系统）。R3.6 的 realpath 失败
（ENOENT/悬空链接）→ E9 not-found（附资产清单），不泄露存在性差异。

### R4 · 错误信息契约（模型可操作；全部 CoreError `ToolExecutionFailed`、`recoverable: true`，context.code 为机器面闭集）

| id | context.code | 消息形状（英文，模型面） |
| --- | --- | --- |
| E1 | `skill_uri_malformed` | `Invalid skill:// URI: "<uri>". Expected skill://<name> (reads the skill's SKILL.md) or skill://<name>/<relative-path> (reads an asset inside that skill's directory).`（percent 解码失败同族：`Invalid percent-encoding in skill:// URI: "<uri>". Use the literal path text instead.`） |
| E3 | `skill_uri_sandbox_rejected` (rule `control-character`) | `Rejected skill:// path: control characters are not allowed: "<uri>".` |
| E4 | `skill_uri_unavailable` | `skill:// reads are unavailable: no skill registry is configured for this session. If you know the skill's absolute path, read that path directly.` |
| E5 | `skill_uri_unknown_skill` | `Unknown skill: "<name>". Available skills: <ids>. Read skill://<name> for a skill's SKILL.md, or skill://<name>/<relative-path> for an asset.`；无技能时 `<ids>` = `none`。`<ids>` = 全部可命中名（name ∪ qualifiedName）排序去重，上限 200 |
| E6 | `skill_uri_sandbox_rejected` (rule `absolute-path`) | `Rejected skill:// path: absolute paths are not allowed ("<rel>"). Paths are relative to the skill directory. Assets in skill "<name>": <listing>` |
| E7 | `skill_uri_sandbox_rejected` (rule `path-traversal`) | `Rejected skill:// path: ".." segments are not allowed ("<rel>"). Paths are relative to the skill directory. Assets in skill "<name>": <listing>` |
| E8 | `skill_uri_sandbox_rejected` (rule `root-escape`) | `Rejected skill:// path: it resolves outside the skill directory (symlink escape): "<uri>". Assets in skill "<name>": <listing>` |
| E9 | `skill_uri_not_found` | `File not found: <uri>. Assets in skill "<name>": <listing>` |
| E10 | `skill_uri_is_directory` | `"<uri>" is a directory, not a file. Entries: <listing-of-dir>. Read one of its files, e.g. <uri>/<first-entry>.` |
| E12 | `skill_uri_invalid_target` | `skill:// URI must resolve to a file or directory: "<uri>".` |

`<listing>` = 目标目录**一层**条目名排序列表，目录带 `/` 后缀，上限 100 条，超出追加
` … (+N more)`；readdir 失败时整个 ` Assets in skill…`/` Entries: …` 后缀省略（错误主体
不依赖列表成功）。列表只含名字，不含磁盘路径（与 omp「消息只提 URL」一致；技能根路径
本已经 Skill 工具暴露，非泄密面，但保持 URI 面自洽）。

### R5 · 提示词面

- Read 工具 description（read.ts，本波所有权内）：`file_path` 条目改写为
  “absolute path, or a `skill://<name>` / `skill://<name>/<relative-path>` URI …”，
  使模型在工具面即知形态存在。
- available-skills 清单段（context/sections/skills.ts）与 contracts describe 增补 →
  见「共享桶/他波面申请」。

## 状态所有权与事件顺序

无新增持久状态。只读分支：`read handler → isSkillUri 判定 → read-skill 解析
（discoverSkills → 赢家 → R3 沙箱 → 物理路径）→ 既有 Read 管线（fileSystemPort.stat →
readFileState 缓存判定 → readTextFileForModel / image / video / pdf）`。readFileState 的
唯一所有者与键形态（物理路径）不变；skill:// 与等价绝对路径读取共享同一缓存条目
（同一物理文件同一事实，无第二真相源）。权限面：Read 的 patternSources=["path"] 按
URI 原文匹配规则串，`skill://` 前缀可被 deny 规则字面命中；沙箱判定在 handler 内独立
成立，不依赖权限层。

## 验收场景（tests/skill-uri-read.test.mjs）

- S1 裸名读 SKILL.md 全文（含 frontmatter 原文）；`skill://demo/` 等价裸名。
- S2 子路径资产读取 + offset/limit 复用既有管线（startLine/numLines 正确）。
- S3 percent-encoded 路径（空格 `%20`）命中带空格文件名。
- S4 scheme 大小写不敏感（`SKILL://demo`）。
- S5 plugin qualifiedName（`skill://testplug:pskill`）命中。
- S6 未知技能 → E5，Available 含既有技能名与 qualifiedName。
- S7 同名冲突：双层各放 `dup-skill`，skill:// 赢家 === `adapter.loadSkill` 赢家
  （高优先 root），内容断言到层。
- S8 `..` 三类形态（`../`、`..\`、`%2e%2e%2f`）→ E7，且消息含资产清单。
- S9 绝对路径四形态（`C:/…`、小写盘符 `c:\…`、`/etc/passwd`、UNC `//server/share`）→ E6。
- S10 盘符形技能名（`skill://C:/Users/x`）→ E5（name=`C:`，不触盘）。
- S11 NUL（`a%00b`）→ E3。
- S12 symlink 逃逸 → E8（文件 symlink；无权限环境跳过并以目录 junction 覆盖 win32
  形态）；技能内指向内部的 symlink → 放行读出目标内容；技能根自身是链接
  （用户级 symlink/junction 导入的受支持形态）→ 放行（S12d）。
- S13 不存在资产 → E9 + 清单含 `SKILL.md`、`references/`。
- S14 目录目标 → E10 + 该目录清单；全斜杠路径 → E10。
- S15 skillPort 缺席 → E4。
- S16 零回归：同 context 普通绝对路径文本读取不变；二次 `skill://demo` 命中
  readFileState → `file_unchanged`。
- S17 空名（`skill://`）→ E1。

## 已知限制

- TOCTOU：realpath 校验与管线实际读取之间存在竞态窗口（omp 同构）；进程内只读工具、
  窗口毫秒级，接受并登记。
- `discoverSkills` 每次 skill:// 读取全量扫描（与 Skill 工具 `loadSkill` 同成本），
  无缓存；热点化后另批考虑发现缓存，不在本批造第二真相源。
- Grep 的 skill:// root、MCP 兜底、`<ns>/<name>` 命名空间双段形：均登记未做（裁决总览）。
- posix 平台上 `C:\x` 形态不是绝对路径，但 R3.3 按盘符形跨平台一律拒绝（宁紧勿松；
  副作用是 posix 下字面名 `c:foo` 的资产不可经 skill:// 读，可用绝对路径读）。

## 共享桶/他波面申请（本批未动，登记待裁决）

1. `contracts/src/tools/read.ts:69` `file_path` 的 `.describe()` 追加一句
   “or a skill://<name>[/<path>] URI”（一行，字符串面）——contracts 不在本波所有权。
2. WI-10 面：`core/src/context/sections/skills.ts` available-skills 清单段追加一行
   “Assets of a listed skill can be read directly via skill://<name>/<relative-path>.”
   ——技能元数据注入点的最小增补，属 WI-10 独占桶。
3. 后续波：`core/src/tool/handlers/grep.ts` 增加 skill:// root 分支（复用
   `read-skill.ts` 导出的目录形解析，约 10 行）。
