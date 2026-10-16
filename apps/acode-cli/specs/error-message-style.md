# 错误信息写作规范：七句式模板 + 认知诚实工具契约（T2-p3 / T2-p2）

价值提取第二轮波次（2026-10-15）W2-H1 交付。与 `error-taxonomy-injection-defense.md`
R1 闭集词表互补：词表管 reason 的**取值域**，本 spec 管自由文本的**句式**。模型面文本
自撰英文（`prompt-language-policy.md` R1/R7）；对照来源为第三方产品还原件的结构性
分析（仅本地、只读），原文不进仓库。

## 背景（已核实的现状）

- 「未做任何修改」类**原子性保证句**全仓零命中：变更类调用被拒（写围栏 enforce、
  权限拒绝）时不告诉模型「目标动没动过」。
- 模板③的 MCP 变体已随第一轮落地：`packages/adapters/src/mcp/index.ts:2272-2300`
  三处挂起文案（不可循环重试 + 挂起原因 + 恢复路径 + 报告用户义务）——登记为
  互证活例，不重复改动（owner 是 mcp 生命周期批）。
- list/search 族只报截断**事实**（truncated/pagination 行/partial 标记），无
  **措辞义务**；grep 有混合计数陷阱：count 模式 summary 总数完整、明细行分页
  （`packages/adapters/src/fs/index.ts:1241-1271`），两口径同屏无披露。

## 产品规则

### R1 七句式模板（错误面写作规范）

| # | 模板 | 要素 | 应用面 |
| --- | --- | --- | --- |
| ① | 原子性保证句 | 变更类调用失败必附「未做任何修改」等价句：停在动作之前、目标原样 | 写围栏 enforce 拒绝（本波落地） |
| ② | 反归因 + 自指阅读指南 | 先排除读者最可能误猜的原因；给出「文案里的词 ↔ 日志/清单点名步骤」的对照定位 | fleet unknown_session（本波：排除「标题当 id」误猜 + 指向 ListSessions） |
| ③ | 能力边界→委托→重试三段式 | 你修不了什么 → 准确命令/动作原样交给用户 → 用户做完后重试什么 | MCP 挂起指引（第一轮落地，互证）；enter-worktree branch_in_use（既有：改参数后重试） |
| ④ | 范围限定不可用 + 死端引导 | 只说这一处不可用 + 防过度泛化句（「其余照常」）+ 不建议注定失败的动作 | 围栏拒绝（本波：仅主 checkout 写入被拦）；not_owned_by_caller（本波：不猜 id） |
| ⑤ | 失败态行为规定 | 被拒后明确交代对用户说什么后果，而非沉默或伪装成功 | not_owned_by_caller（本波：报告用户而非重试） |
| ⑥ | enforcement 披露 | 被拦截 =「被拒绝而非被静默修复」，绝不悄悄改写输入再执行 | 现状核实：ACode 权限/校验面均显式拒绝，无静默修复面——确认在案，不改动 |
| ⑦ | 带验证门多步配方 | 无原子能力的多步操作（copy→verify→delete）每步点名验证门与失败后果 | 当前无此类操作面；登记为工具描述写作规范必备句式，跨域迁移类操作出现时适用 |

纪律：模板管句式不管取值（自由文本走 message/detail，reason 走闭集 token，互不
替代）；应用点文案变更必须配测试更新（既有正则钉保留 + 新增要素断言）；文案只写
模型能执行的动作，不写对 CLI 会话不可达的死路。

### R2 认知诚实工具契约（list/search 族描述的措辞义务）

1. **total 与 at_least 区分**：响应计数默认是「本页行数」，除非点名是 total；
   截断在场时向用户说「至少 N」，绝不把部分页呈现为全集。
2. **截断/越界空页语义**：截断标记必须可解读（什么被截、外面还有什么）；空页
   区分「真空集」与「翻过头」。现状：glob/ListWorkflowRuns/SessionSearch 显式标
   truncated；grep 以 pagination 行表达（描述教读法），offset 越界返回空页 +
   offset 行，如实登记不另造语义。
3. **混合计数陷阱披露**：同响应两种计数口径并存时点名谁是全量谁是页内（grep
   count 模式）。
4. **默认 limit 场景指引**：写清默认上限与何时调大（grep 默认 250 条、glob cap
   100、ListWorkflowRuns 默认 20 上限 50、SessionSearch 默认 10 上限 50）。
5. **响应形状自描述**：缺席/为真才在场的字段语义在描述里讲清（ListWorkflowRuns
   的 `possibly_interrupted`「annotation, not a verdict」是既有范例）。

### R3 示范应用登记（本波改动面）

1. `core/src/worktree/session-worktree-fence.ts` enforce 拒绝：+原子性保证句
   （nothing was modified，①）+范围限定与其余照常句（④）+替代动作（改写进
   worktree 内对应路径）。
2. `core/src/fleet/registry.ts` resolveOwned：unknown_session +活路指引
   （ListSessions；不在清单就如实报告用户，②④）；not_owned_by_caller +不可重试
   定性+行为规定（报告用户、不猜 id、不擅自重启同样工作，④⑤）；session_archived
   已含活路（ReadSessionContext），确认不改。
3. 四工具描述（R2 落地点，均在 `core/src/tool/handlers/`）：glob.ts（cap 100 +
   at-least，义务 1/2/4）；grep.ts（默认 250 + pagination 读法 + count 混合计数，
   义务 1/2/3/4）；list-workflow-runs.ts（count=本页行数 + limit 指引，义务 1/4）；
   session-search.ts modelInstructions（truncated 双语义：limit 截断或 500ms
   检索预算耗尽，见 session-search.md R4；义务 1/2/4）。SessionSearch description
   本体在 contracts（本波不动），义务由 modelInstructions 承载（registry.ts
   `toolDescriptionForProvider` 合成 Usage 段）。

### R4 分层

词表管取值域、本 spec 管句式，互不替代；MCP 挂起文案是③④⑤活例只互证不改动；
描述义务与 `tools-schema-token-metrics.md` 互补，义务句每工具 ≤3 句。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 七模板与五义务规范（唯一学说所有者） | 本 spec |
| 围栏/舰队所有权拒绝文案、四工具描述措辞义务 | session-worktree-fence.ts、fleet/registry.ts resolveOwned、各 handler 文件 |

## 验收场景

1. 围栏 enforce message 含：`write fence`（既有钉）、原子性保证句、范围限定句、
   worktree 替代路径。
2. unknown_session message 含：`never inferred`/`titles`（既有钉）、ListSessions 指引。
3. not_owned_by_caller message 含：不可重试定性、报告用户句、不猜 id 禁令。
4. 四工具描述/modelInstructions 各含 R2 义务要素（at least、默认上限、截断读法、
   计数口径），断言见 `tests/error-message-style.test.mjs`。
5. 既有测试零回归（session-worktree-fence / session-fleet-ownership /
   session-search）；验证命令 `--filter @acode/core typecheck` +
   `node --import tsx --test apps/acode-cli/tests/error-message-style.test.mjs`。

## 不在本项范围

⑥⑦为核实登记无落地改动面；permission 面 deny/ask 文案（WSA 所有权）；grep
formatter 不加显式 truncated 行（pagination 行已承载事实，实测模型仍误报再升级）；
websearch 描述（M1 所有权）。
