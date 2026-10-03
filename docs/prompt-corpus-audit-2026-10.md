# ACode CLI 提示词资产静态审计报告（2026-10-03，第一轮）

审计执行：提示词优化批次三期间，按对照分析引入的 prompt-audit 方法论
（「找不再适配的**具体指令**，不是把文本改短」；「每个 token 自证其位」）对
ACode CLI 的模型面文本资产做的一轮**静态**审计。

**边界声明**：本轮是静态审计——核对文本声称的事实与代码实现的一致性、
文本之间的指令矛盾、承袭血脉文本的陈旧残留。**行为层验证**（指令是否仍被
模型正确遵循、强调是否过度触发）不在本轮：那需要 `apps/acode-cli/evals/`
的 live 判分能力（W8 脚手架已就位、live 基线报告未采集）。

**纪律**：发现只登记不顺手修——修复各自走独立的评审与提交（审计与被审计
文本的改动同批会污染两边）。

## 审计范围

| 面 | 覆盖 |
| --- | --- |
| 工具描述 | 41 个内建工具入口的描述构建点（`core/src/tool/handlers/*`），重点核对数字断言与工具引用 |
| system 段 | 注册表 16 段中本批次触及的 5 段 + 承袭文本抽查 |
| 子代理文本 | general-purpose / explore / common notes / workflow-actor |
| reminder 文本 | runtime-reminders 常量 + incoming-message 通道文本 |
| 技能 | bundled 5 技能（含本批新增）+ 与 system 段的分层去重 |
| 出站点文本 | WebFetch UA、WebSearch 描述等**外发**字符串 |

## 核对通过项（抽样证据）

1. **Read 描述的行数上限无漂移风险**：`read.ts:61` 用
   `${READ_DEFAULT_MAX_LINES}` 插值（contracts 常量 2_000），描述与实现同源。
2. **TodoWrite metadata 三上限与实现逐值一致**：描述写「max 16 keys、64-char
   keys、4 KB serialized」，实现 `todo-deps.ts:23-27`（16 / 64 / 4*1024）——
   当前一致（但见发现 F3 的形态问题）。
3. **EnterPlanMode 描述的工具引用全部存在**：AskUserQuestion ×5、
   ExitPlanMode ×2，两工具均在注册面。
4. **Agent 描述的工作流灰度门与注册面同源**（D1 修复后未回退）：
   `dynamicWorkflowEnabled === false` 时描述不含 CreateWorkflow（快照测试钉住）。
5. **本批三批新增文本自洽**：verify 技能「不跑测试」与 behavior.dynamic
   「先跑检查再声称完成」的表观张力已在技能文本内消歧（实现期自检 ≠ verify
   证据，边界句在 verify SKILL.md 三硬纪律节）；code-review 技能只说
   ::code-comment「何时用」，语法唯一承载在 desktop 段；side-chat 边界与
   PEER_PERMISSION_GUIDANCE 分工明确（历史通道 vs 消息通道）。
6. **技能根路径断言与实现一致**：verify/run 技能写 `.agents/skills/` 与
   `.acode/skills/` 双根，`adapters/src/skills/roots.ts:99-105` 确为合并发现。
7. **模型面无 locale 分叉、无 CJK**（既有 prompt-language-policy 测试 +
   本批三份新测试的 CJK 断言持续钉住）。

## 发现清单

### F1（中）WebFetch User-Agent 携带上游品牌 URL——外发陈旧残留

`core/src/tool/handlers/webfetch-constants.ts:11`：

```
WEBFETCH_USER_AGENT = "ACode-WebFetch/0.1 (+https://zcode.ai; coding-agent-cli)"
```

每次 WebFetch 都向目标站点外发 `zcode.ai`——上游产品（ZCode）的域名，
不是 ACode 的。这不是模型面文本，但它是**提示词资产的出站点兄弟**：
同属「产品对外自称」的文本面。风险：品牌混淆、上游域名失效后的死链、
以及站点按 UA 做的任何归类都归到别家产品。
**建议处置**：独立小提交改为 ACode 自己的标识（URL 换成仓库地址或删除
URL 段），同步核对是否有测试钉住旧 UA 字面量。

### F2（中）WebSearch 描述断言「US-only」——承袭的 provider 特定事实

`websearch.ts:52` 描述首句「Search the web. Returns result blocks with titles
and URLs. US-only.」。该断言承袭自单一 provider 的上游血脉；ACode 的 WebSearch
是 provider 原生搜索（`model.properties.supportsNativeWebSearch` 门控），
接入非美区 provider 时「US-only」即为错误事实，会误导模型放弃可用搜索或
向用户传递错误限制。
**建议处置**：删除该断言，或改为随 provider 能力元数据条件生成；
属 `websearch` 工具描述所有者的独立小改。

### F3（低）TodoWrite 描述的三上限是硬编码数字——形态性漂移风险

当前值与实现一致（核对项 2），但描述里的 16/64/4KB 是**字面量**，实现常量
改名改值时描述不会跟着变。对照 Read 的插值模式（核对项 1），这是已知
更优形态未被采用。
**建议处置**：描述构建处改为从 `todo-deps.ts` 常量插值；或加一条
「描述-常量一致性」测试钉住（成本更低）。非紧急。

### F4（信息）子代理 git 纪律与 Bash 描述「仅用户要求时提交」的共存关系

general-purpose 子代理纪律说「任务包含提交时：只 stage 实际改动文件并报告
hash」；子代理同样收到 Bash 描述的「Commit or push only when the user asks」。
两者靠「任务授权传递用户要求」的条件语义共存，逻辑上不矛盾，但模型可能
在灰区犹豫（任务说 commit、Bash 描述说仅用户要求）。
**建议处置**：不改文本；列入 eval 观察项（subagent 族场景跑 live 判分时
留意 commit 犹豫形态），有证据再动。

### F5（信息）Bash 描述假定 `gh` CLI 在场

「Use the `gh` CLI for GitHub operations」无存在性条件句。承袭文本、影响轻微
（模型会自行发现 gh 缺失），登记不改。

## 后续建议（按依赖排序）

1. F1、F2 各自独立小提交（都是几行改动 + 测试核对）。
2. eval live 基线采集（W8 结转项）落地后，把 F4 与「强调过度触发」类
   行为问题并入首轮 hillclimb 轮次记录。
3. 本审计方法固化为周期活动：每次提示词批次合入后跑一轮静态核对
   （数字断言 ↔ 实现常量、工具引用 ↔ 注册面、外发字符串 ↔ 品牌），
   行为层按 eval 里程碑评。

## 修复记录（2026-10-03 同批）

- **F1 已修**：`WEBFETCH_USER_AGENT` 改为 `"ACode-WebFetch/0.1 (coding-agent-cli)"`
  ——移除 `zcode.ai` URL 段（ACode 无官方域名，UA 宁缺勿错）；唯一消费点
  `webfetch-network.ts:282` 随常量生效；`web-content-untrusted-discipline.test.mjs`
  增防回归断言（UA 不含 zcode、不含任何 URL 段）。
- **F2 已修**：WebSearch 描述首句删除「US-only」断言（`websearch.ts:52`，
  修复依据注释在文件内）；同测试文件增「US-only 不得回来」断言。
  W5 spec（`web-content-untrusted-discipline.md`）R3 的「既有三条 bullet 逐字保留」
  不受影响（首句不是 bullet）。
- **F3/F4/F5 维持登记**：F3（TodoWrite 数字插值化）非紧急；F4/F5 入 eval 观察项。

## 增补发现（同轮复扫）

### F6（中，产品决策级）`zcode://` deep link 协议为上游品牌标识

复扫发现桌面端以 `zcode://` 作为 OS 级注册的 deep link 协议：
macOS Finder 工作流脚本（`desktop/src/main/desktopFinderOpenFolderWorkflow.ts:25`）、
Linux deep link 注册与 .desktop 遮蔽处理（`desktopLinuxDeepLinkRegistration.ts:64,238`）、
OAuth 回跳（`desktopOAuthDeepLink.ts:257`）。这不是文本残留而是**功能性身份**：
改协议名 = 产品身份迁移（OS 注册、既有外部链接兼容、OAuth redirect URI 三处联动），
必须整体规划并保留旧协议兼容期，不能当字符串替换处理。
**建议处置**：独立立项（desktop 所有者），迁移方案需含 zcode:// 兼容窗口；
本轮不动。代码注释里的 `zcode-plan`（provider 业务错误码说明）是事实性引用，
不在发现范围。

## 数字与证据来源

- 全部行号以 2026-10-03 dev/0.0.2 检出为准（批次三提交前基线 + 批次三新增文本）。
- 静态核对命令与输出留在会话记录；发现项的证据文件路径均可复查。
- 本报告不含任何第三方产品原文（方法论为结构性借鉴，见
  `apps/acode-cli/specs/prompt-language-policy.md` R7 合规基线）。
