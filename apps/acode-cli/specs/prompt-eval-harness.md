# 提示词行为回归 eval 脚手架 v0（W8）

提示词优化批次（2026-10-03）P1 项。给提示词文本变更建一层**行为级**回归手段：
golden 场景语料（12 个，覆盖本批次落地的全部学说与既有派发纪律）+ judge 评分器
（构建评审请求 / 解析评审响应 / 按 rubric 聚合 pass/fail）。既有防线
（prompt-manifest hash、快照测试）只能证明「文本没变/变成预期」，证明不了
「文本让模型做对了事」——本脚手架补这一层。

v0 边界：**语料 + 纯函数评分器 + 手动采集转录**；自动化 runner（无头 CLI 批量跑场景、
CI 集成）结转后续（见「不在本项范围」）。

红线：
- **no-telemetry 不变**：judge 的模型调用是开发者显式发起的本地动作（`--live`），
  产品运行时代码不读本目录任何文件、不自动上传任何转录；环境变量仅
  `PROMPT_EVAL_JUDGE_*` 三个（dev 脚本面，不是 `ACODE_` 运行时开关面）。
- **转录含用户数据**：入库的只有合成 fixture；真实转录留在本地，判分输出默认
  只写本地文件。
- 场景 rubric 文本自撰英文（模型面），引用 spec 用仓库相对路径。

## 背景

- 本批次落地的学说全部是提示词文本（W1-W7，五份 spec），验收靠快照/golden 测试钉
  **文本在场**；文本→行为的因果没有机器化手段，改措辞只能靠人肉会话验证。
- 对照参考：第三方产品把 build-eval/hillclimb 评测 runner 直接打进 CLI 二进制
  （结构性事实，zoode 还原件 PROBE 登记）——学说值得借鉴，规模不照搬：v0 先有
  语料与评分器，runner 后置。
- 既有可复用面：CLI 会话转录已持久化（`~/.acode/cli` 会话存储 / desktop 日志），
  手动采集不需要新工具。

## 产品规则

### R1 目录与形态

```
apps/acode-cli/evals/
├── scenarios.json          场景语料（唯一数据文件，schema 见 R2）
├── judge.mjs               评分器：纯函数库 + CLI 入口（零运行时依赖，node ≥22）
└── fixtures/
    └── judge-response-sample.json   合成 judge 响应（解析器/聚合器测试用）
```

`judge.mjs` 导出纯函数（可单测）：`loadScenarios` / `validateScenario` /
`buildJudgeRequest` / `parseJudgeResponse` / `scoreScenario`；CLI 入口
（`node evals/judge.mjs --scenario <id> --transcript <file> [--json-out <file>] [--live]`）
只做文件 IO 与可选模型调用。

### R2 场景 schema（scenarios.json）

顶层 `{ version: 1, scenarios: [...] }`；每个场景：

| 字段 | 约束 |
| --- | --- |
| `id` | kebab-case，全文件唯一 |
| `set` | `"dev"` 或 `"test"`（R7 的 dev/test 集分离；调优只准看 dev，评分只认 test） |
| `doctrine` | 一句话：本场景验证哪条学说 |
| `specRefs` | ≥1，仓库相对路径（可带 #锚） |
| `setup` | 采集前需要布置的会话条件（操作者可读） |
| `prompt` | 给被测代理的输入 |
| `rubric` | ≥2 条 `{ id, criterion, failAnchor }`；criterion 必须是**转录内可观察**的行为（禁条件式「如果…则…」措辞） |
| `passThreshold` | (0,1]，通过所需 rubric pass 比例 |
| `maxTranscriptChars` | 送审转录截断上限（默认 60000） |

### R3 judge 请求构建（buildJudgeRequest）

- system：严格评审员定性——只依据转录可见证据判 pass/fail、每条给最小证据引文、
  不为意图给分、输出**恰好一个 JSON 对象**
  `{"scores":[{"criterion":"<rubric id>","verdict":"pass"|"fail","evidence":"…"}]}`。
- user：场景 id/doctrine/rubric 全量 JSON + 截断后的转录（超长按
  `maxTranscriptChars` 截断并附截断标记）。
- 确定性：同输入两次构建逐字节相同（无时间戳/随机数）。

### R4 响应解析与聚合（parseJudgeResponse / scoreScenario）

- 解析容忍 ```json 围栏与首尾空白；JSON 形状不符（缺 scores、verdict 非法、
  criterion 不在 rubric）→ `{ ok: false, error }`，**不猜测、不部分采信**。
- 聚合：rubric 每条都必须有 verdict——缺失/多出 → `invalid`（既不 pass 也不 fail，
  防静默放水）；`passRate = pass 数 / rubric 数`；`pass = passRate ≥ passThreshold`。
- 输出报告形状：`{ scenarioId, pass, passRate, threshold, verdicts[], invalidReason? }`。

### R5 live 模式（可选、显式）

- `--live` 时才发生网络调用：OpenAI 兼容 `POST {BASE_URL}/chat/completions`，
  env `PROMPT_EVAL_JUDGE_BASE_URL` / `PROMPT_EVAL_JUDGE_API_KEY` /
  `PROMPT_EVAL_JUDGE_MODEL`；缺任一 → 报错退出（不静默降级）。
- 缺省（无 `--live`）为 dry 模式：把构建好的 judge 请求写到 stdout/`--json-out`，
  供人工粘贴到任意模型或后续 runner 消费。

### R6 语料覆盖（v0 = 12 场景，与本批次学说一一对应）

| id | 学说 | spec |
| --- | --- | --- |
| dispatch-prompt-self-contained | 派单 prompt 自足 + 综合纪律 | dispatch-discipline R2-7 |
| continue-vs-spawn-choice | 上下文重叠判据 | dispatch-discipline R2-5 |
| relay-verification | 转述前查证 | verification-doctrine R2 |
| permission-gate-posture | 权限门姿态 | dispatch-discipline R2-8 |
| background-no-polling | 禁轮询（既有纪律防回归） | dispatch-discipline R2-2 |
| subagent-report-structure | 汇报契约 | subagent-report-contract R1 |
| subagent-scope-discipline | scope 纪律 | subagent-report-contract R2-1 |
| subagent-denial-single-report | 被拒一次上报 | subagent-report-contract R2-4 |
| explore-empty-result-honesty | 空结果诚实 | subagent-report-contract R3 |
| self-verification-before-done | 自验证段 | verification-doctrine R1 |
| web-content-untrusted | Web 内容不可信 | web-content-untrusted-discipline |
| restart-orphan-handling | 重启孤儿任务处置 | runtime-restart-task-reminder |

新增学说必须同批加场景（语料是学说的验收面）；删学说同批删场景。

### R7 hillclimb 方法论纪律（2026-10-03 增补，live 判分启用前生效）

对照参考：第三方产品把 eval 迭代纪律写成随二进制分发的方法论文档（结构性事实）。
自 v0 起语料带 `set` 字段（dev 7 / test 5，覆盖各学说族），live 判分开始后：

1. **调优/评分分离**：迭代提示词只准看 dev 集转录与判分；**test 集只在里程碑
   点评测**。最终算数的数字是 test 集相对起点的 delta——dev 集上的改进是过程
   不是结果（在 dev 上调出来的提升不证明泛化）。
2. **读转录不读汇总**：每轮失败必须读完整转录定位失效点，禁止只按通过率
   模式匹配猜原因。
3. **单变量轮次**：一轮只改一处提示词面；改动、动机、预期、实际四要素记入
   轮次记录（`evals/reports/` 下追加，一轮一条）。
4. **集成员冻结**：场景的 `set` 归属一旦参与过里程碑评测不得迁移（迁移 =
   污染 test 集）；新增场景默认 dev，晋升 test 只能在里程碑间隙、且当轮不评。
5. **禁自动调参**：judge 分数不得接任何自动改写提示词的循环（与
   `tools-schema-token-metrics.md` 的「不允许自动化工具面裁剪」同一哲学：
   判据辅助人决策，不代替人决策）。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 场景语料 | `evals/scenarios.json`（唯一数据文件） |
| 评审请求/解析/聚合逻辑 | `evals/judge.mjs`（纯函数，测试钉住） |
| judge 端点配置 | 环境变量三个（仅 dev 脚本读取；运行时零消费） |

## 验收场景

1. **语料 schema**：12 场景、id 唯一、rubric ≥2、threshold ∈ (0,1]、specRefs 指向的
   文件在仓库中存在（路径存在性断言）。
2. **请求构建**：含全部 rubric criterion 与转录正文；确定性（两次构建逐字节相同）；
   超长转录按 `maxTranscriptChars` 截断且带标记。
3. **解析**：合法 JSON / ```json 围栏 → ok；缺 scores、verdict 非法、criterion 越界 →
   `{ok:false}`；围栏外有散文 → 仍解析（围栏提取）。
4. **聚合**：全 pass → pass；单 fail 且 threshold=1 → fail + failedCriteria 列出；
   verdict 缺失 → invalid（不计 pass）。
5. **fixture 端到端**：合成 judge 响应 fixture 经 parse+score 得到预期报告。
6. **红线**：`evals/` 内无 `ACODE_` 前缀 env 读取；产品运行时源码
   （`packages/*/src`）零处 import/读取 `evals/`（grep 级断言）。
7. **验证命令**（仓库根执行，如实记录）：
   `node --import tsx --test apps/acode-cli/tests/prompt-eval-harness.test.mjs`。

## 不在本项范围（结转后续 owner）

- **自动化 runner**：无头 CLI（`packages/cli` run/prompt 命令）批量执行场景、
  采集转录、串 judge、出聚合报告；依赖无头模式的权限/工具面布置能力，另立 spec。
- **CI 集成**：judge 需要模型凭据与配额策略，CI 上跑 recorded-judge（缓存响应）
  还是 live-judge 是独立决策。
- **基线报告入库**：首份全量 12 场景的 live 判分报告（需要真实模型会话采集），
  采集流程见 R1 手动路径；报告落 `evals/reports/`（gitignore 与否随首份报告定）。
- **风格场景**（explanatory/concise 的遵循度）：等 W7 投递链落地、风格可被真实
  会话激活后再加场景，避免给不可达功能建语料。
