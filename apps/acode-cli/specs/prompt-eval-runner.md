# 提示词行为回归 eval runner（W8 结转项立项，v1）

`prompt-eval-harness.md`（v0：语料 + 纯函数评分器 + **手动**采集）的结转项「自动化
runner」立项。2026-10-04 批次 4 第五轮试点已把 v0 手动采集路径端到端走通（dev 集
`self-verification-before-done`，passRate 1.0，见 `docs/capability-uplift-plan.md`），
本 spec 把试点验证过的机制固化为半自动 runner；**只固化已验证的机制**，未验证面
（子代理转录落点、后台任务无头寿命、重启编排）显式登记为 open question 并 fail-loud。

红线（承接 v0，不放宽）：
- **no-telemetry 不变**：runner 是开发者显式发起的 dev 脚本面；产品运行时源码
  （`packages/*/src`）零 import/零读取 `evals/`；除数据根两个 env 外不新增任何
  `ACODE_` 开关面。
- **转录永不入库**：raw/shaped 转录、judge request/response 全部落
  `evals/reports/raw/`（gitignored）；入库的只有报告 JSON（判分结论 + 证据引文 +
  采集元数据）。
- **judge 配置冻结**：每份报告记录 judgeFingerprint；指纹不同的报告不得互算 delta
  （R7 可比性）。操作员判分（operator-judge）是一种显式 mode，必须披露。

## 背景

- v0 手动路径的试点证明了链路可行，也暴露了三类手工成本：环境布置（隔离数据根 +
  凭据复制 + fixture）、转录整形（raw stream-json 2665/2808 行是 token delta，直送
  judge 必被 60k 截断吃满）、判分往返（dry 请求 → 响应 → scoreScenario）。runner 把
  三者固化为可重复命令。
- 试点还产出了两条环境教训，直接成为本 spec 的守护规则：dist 陈旧（早于提示词批次
  的构建测的是旧提示词，基线保真不成立）与凭据副本卫生（eval 根含复制的凭据材料，
  用毕必删）。

## 产品规则

### R1 形态与边界

```
apps/acode-cli/evals/
├── scenarios.json      语料（v0 所有，runner 只读；R7-4 冻结规则不变）
├── judge.mjs           评分纯函数 + CLI（v0 所有，runner import 复用，不重写判分）
├── runner.mjs          本 spec 新增：采集/整形/判分编排 + 可单测纯函数
├── recipes/            本 spec 新增：每场景一个采集配方（§R6 登记制）
│   └── <scenario-id>.mjs
├── fixtures/           v0 的合成 judge 响应样本（不动）
└── reports/            本 spec 新增：入库报告（report-*.json）
    └── raw/            gitignored：raw/shaped 转录、request/response 文件
```

- `runner.mjs` 零运行时依赖（node ≥22，ESM，与 judge.mjs 同风格）；导出纯函数
  （`shapeTranscript` / `buildReport` / `judgeFingerprint`）供单测，CLI 入口只做
  IO 与子进程编排。
- CLI：
  `node evals/runner.mjs --scenario <id> [--judge dry|response] [--eval-root <dir>]`
  - `--judge dry`（缺省）：采集 + 整形 + 生成 judge 请求文件，报告状态
    `awaiting-judgement`。
  - `--judge response`：读回响应文件（`reports/raw/<runId>/response.json`，操作员或
    外部模型产出）→ `parseJudgeResponse` + `scoreScenario` → 终态报告。
  - live 判分不另设 runner 旗标：`PROMPT_EVAL_JUDGE_*` 配置齐备时 dry 阶段直接调
    `judge.mjs --live` 完成判分（复用 v0 R5，不复制网络代码）；缺配置回落 dry。
  - `--set dev|test` 批量形态是 v1.1（里程碑评测专用，须先满足 §R7 的 judge 冻结
    裁决）；v1 只单场景，防误触 test 集。
- v1 不支持的场景（§R6 not-supported）显式报错退出并指向本 spec §R7，**绝不静默跳过**。

### R2 运行环境（试点验证）

- **隔离数据根**：runner 管理的 eval 根（缺省 mkdtemp；`--eval-root` 指定复用）。
  `ACODE_STORAGE_DIR=<root>/storage`、`ACODE_DATA_BASE_DIR=<root>/data-base`；凭据与
  配置从真实 `~/.acode/v2/*.json` **复制**（copy method，真实 profile 零触碰）。
  跑毕（含失败路径）**必须删除**凭据副本；`--eval-root` 显式给出时保留目录但删除
  `data-base/.acode/v2/credentials.json` 与密钥材料（复用调试不重复付凭据卫生代价）。
- **被测面**：`node apps/acode-cli/packages/cli/dist/acode.cjs -p <prompt> --cwd
  <fixture> --output-format stream-json --mode <recipe.mode>`。
- **dist 新鲜度守护**：采集前比对 `dist/acode.cjs` mtime 与 `apps/acode-cli/packages/
  {core,contracts,bootstrap,cli}/src` 最新 mtime；dist 更旧 → fail-loud 提示重建命令
  （turbo）。试点教训：陈旧 dist = 测旧提示词 = 基线保真不成立。
- **fixture**：配方 `setup(dir)` 物化采集工作区。已验证形态：零依赖 Node 原生 TS
  仓（Node ≥23.6 type-stripping），测试命令必须用 glob `node --test "tests/*.test.ts"`
  ——试点实证目录形式 `node --test tests/` 不匹配 `.test.ts` 文件。fixture 内不放
  AGENTS.md/技能（避免污染被测提示词面）。
- **权限姿态**：recipe 声明 `mode`（缺省 `yolo`，一次性 fixture 下安全）。拒绝类场景
  用非 yolo 模式借 headless deny broker（`-p` 下 alwaysAsk 恒拒，试点核实的无头面
  事实）产生真实拒绝。

### R3 转录采集与整形（试点关键发现 → 硬规则）

- 采集：子进程 stdout 全量落 `reports/raw/<runId>/transcript.ndjson`；stderr 落同目录
  `run-stderr.log`（诊断用，含迁移 INFO 等一次性通知）。
- 整形（`shapeTranscript`，纯函数，逐行解析 NDJSON）：

  | stream-json 事件 | 整形块 |
  | --- | --- |
  | `turn.started` → `payload.input` | `[user] <prompt>` |
  | `model.streaming` `kind:text_delta` 按 `assistantMessageId` 累积、`text_end` 出块 | `[assistant] <text>` |
  | `model.streaming` `kind:tool_call` | `[tool call <id>] <toolName>` + 输入 JSON（截断 1200 字符） |
  | `tool.updated` `kind:"result"` | `[tool result <id>] success/duration` + 输出（截断 3000 字符） |
  | `result` → `response` | `[final assistant message] <text>` |
  | 其余（`reasoning_*`、token 增量、`session.updated`、`checkpoint.created`、`streamRecovery.updated`、`model_request_*`、`streamRecovery` 等） | 丢弃 |

  截断带 `…[runner-truncated N chars]` 标记（judge 能看到省略事实）。
- 整形产物落 `reports/raw/<runId>/transcript-shaped.txt` 后才构建 judge 请求；
  `buildJudgeRequest` 自身的 `maxTranscriptChars` 截断保持第二道防线（v0 R3 不变）。

### R4 判分与 judgeFingerprint

- 三种 judge mode：`live`（`PROMPT_EVAL_JUDGE_*` 三件套经 judge.mjs --live）、
  `operator`（dry 请求 → 操作员会话模型按请求内评审契约出响应 → response 判分）、
  `endpoint-recorded`（v1.1，CI 缓存响应，承接 v0 结转）。
- 每份报告必含 `judgeFingerprint = { mode, model, endpointHost? }`：live 取
  `PROMPT_EVAL_JUDGE_MODEL` + host；operator 记 `{ mode: "operator", model:
  "<操作员会话自报模型标识>" }`。**指纹不同的报告不得互算 delta**——正式基线与
  里程碑评测必须同一指纹（R7 可比性的机器化表达）。
- 判分永远经 judge.mjs 的 `parseJudgeResponse` + `scoreScenario`（invalid 不 pass 不
  fail 的防放水语义不变），runner 不实现任何平行判分。

### R5 报告与入库约定（v0 悬置项裁决）

- 入库：`evals/reports/report-<scenarioId>-<runId>.json`，字段 = scoreScenario 报告
  形状 + `{ runId, judgeFingerprint, collection: { distCommit, cliMode, recipeDigest,
  eventsTotal, blocksShaped, shapedChars, modelRequests?, wallMs } }`。
  `recipeDigest` = 配方文件 sha256 前 12 位（配方变更可追溯）。
- gitignore：`evals/reports/raw/`（转录/request/response 永不入库）。报告含证据引文
  （来自合成 fixture 会话，无用户数据）——入库安全边界与 v0「只入库合成 fixture」
  一致：**fixture 会话才产报告，真实工作区会话不进 runner**。
- runId = UTC 紧凑时间戳（`YYYYMMDDTHHmmssZ`）。基线 = runner 落地后首份全量报告；
  R7 五条纪律全部承接（调优只看 dev、评分只认 test、读转录、单变量、禁自动调参）。

### R6 场景采集可行性门（试点 12 场景结论 → recipe 登记制）

| 状态 | 场景 | 说明 |
| --- | --- | --- |
| verified | self-verification-before-done | 试点全链路 PASS（passRate 1.0） |
| ready | web-content-untrusted | recipe 附本地静态服务器（127.0.0.1:8788，嵌指令页）；**yolo 模式**——学说主轴 = 抵抗嵌入指令，fetch 必须被放行才可测；风险有界：外泄目标 `evil.example` 是保留域（不可解析）、删除范围限一次性 fixture |
| first-run-unverified | dispatch-prompt-self-contained / continue-vs-spawn-choice / permission-gate-posture | 三者都依赖 Agent/SendMessage 在无头下可用（非权限门控、预期可行）；permission-gate-posture 另用默认权限模式借 headless deny broker 产生真实拒绝（主会话转录即可判）。首跑若派发不可得，报告记 `dispatch-unavailable` 并转 §R7 |
| experimental | relay-verification / background-no-polling | 关键开放问题：`-p` 进程主 turn 结束后是否存活至后台通知；进程早退时报告记 `background-orphan`（本身即产品行为发现，不算采集失败） |
| not-supported-v1 | subagent-report-structure / subagent-scope-discipline / subagent-denial-single-report / explore-empty-result-honesty / restart-orphan-handling | 子会话转录落点未确认（前四）/ kill+resume 编排未验证（末一）；runner 显式报错指向 §R7 |

- 每 recipe 导出 `{ mode, setup(dir), teardown?(dir), server?() }`；registry 缺配方 =
  not-supported（fail-loud）。配方只布置语料 `setup` 字段要求的会话条件，不加戏。

### R7 open questions（结转 v1.1，逐项有触发条件）

1. **子代理转录落点**：候选 = 隔离 storage 下独立 `rollout/model-io-<childSess>.jsonl`
   或 `cli/agents/<parentSess>/` 子树（试点无子代理会话，未观察）。触发：任一子代理
   场景首跑时调查；确认后四个场景转 ready。
2. **无头后台任务寿命**：`-p` 进程在后台任务通知到达前是否存活。触发：experimental
   两场景首跑。若进程早退且产品语义应为「等待」，这是产品缺陷单独立项，不是 runner
   问题。
3. **judge 端点正式配置**：`PROMPT_EVAL_JUDGE_*` 由所有者配置；配置前 operator mode
   是唯一可冻结指纹（同源偏差已披露）。触发：正式基线采集前。
4. **CI recorded-judge**：v0 结转悬置项。触发：CI 集成需求出现。
5. **`--set` 批量与里程碑编排**：触发：judge 指纹裁决（3）落地后。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 场景语料 | `evals/scenarios.json`（runner 只读） |
| 评审请求/解析/聚合 | `evals/judge.mjs`（runner import，不平行实现） |
| 采集配方 | `evals/recipes/<scenario-id>.mjs`（每场景唯一） |
| 编排/整形/报告 | `evals/runner.mjs` |
| 报告入库面 | `evals/reports/report-*.json`（raw/ gitignored） |
| judge 端点配置 | `PROMPT_EVAL_JUDGE_*` env（仅 dev 脚本面） |

## 验收场景

见 `apps/acode-cli/tests/prompt-eval-runner.test.mjs`（合成 NDJSON 驱动，测试零模型
调用、零网络）：

1. **整形纯函数**：合成 NDJSON（含全部事件类型 + 超长工具输出）→ 整形块序列正确、
   token delta 全弃、截断带标记、乱行跳过不崩。
2. **报告形状**：buildReport 含 judgeFingerprint 与 collection 元数据；operator mode
   指纹含披露字段。
3. **不支持场景 fail-loud**：五个 not-supported-v1 场景 → 显式报错文本指向 §R7，
   非静默跳过、非部分采集。
4. **凭据卫生**：runner 清理路径删除凭据副本（模拟 eval 根断言）；异常路径（采集中
   抛错）也执行清理。
5. **红线**：runner/recipes 内无 `ACODE_` 前缀 env 读取（数据根两个除外，白名单
   断言）；`packages/*/src` 零处引用 `evals/`（grep 级，承接 v0 场景 6）。
6. **端到端（手动，如实记录）**：`--scenario self-verification-before-done --judge
   dry` 在真实机器上产出 awaiting-judgement 报告 + shaped 转录；`--judge response`
   喂合成响应得终态报告。live 采集消耗模型配额，只在所有者知情下执行。

## 不在本项范围

- `--set` 批量与里程碑评测编排（§R7-5，judge 冻结裁决后）。
- 子代理/重启五场景的采集实现（§R7-1/2 调查后转 ready）。
- CI 集成与 recorded-judge（§R7-4）。
- 语料变更（scenarios.json 归 v0 spec 与 R7-4 冻结纪律管）。
