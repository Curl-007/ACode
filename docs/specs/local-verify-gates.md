# 本地验证门禁与 CI 反馈回路

## 背景与根因

2026-11-03 针对「推上去 CI 才红、反复修反复等」的反馈回路做量化排查，确认三条根因，
均以实测数据为依据（run `41559024844`，`dev/1.1.1`，全绿基线）：

- **G1 本地零门禁**：`git ls-files .husky` 为空——仓库没有任何入库 hook 文件；
  `core.hooksPath` 指向 `.husky/_`，其中只有 husky 自带 shim，shim 找不到
  `.husky/pre-push` 即静默放行。`package.json` 的 `prepare: husky` 只装壳，不产生检查。
  `ci.yml` 顶部注释（2026-10-05 审查）已记载「husky 钩子未入库」，此后未补。
- **G2 本地门禁与 CI 门禁不对齐**：文档指定的推送前门禁 `pnpm verify:pre-push`
  （AGENTS.md、README 双语、git-collaboration.md 三处）= `lint && architecture:check --changed`，
  只覆盖 `ci.yml` `verify` 的 8 道门中的 1.5 道。**未覆盖**：`typecheck`、`knip:gate`、
  third-party ledger 新鲜度、`Build CLI workspace`、`Lint CLI workspace`（`apps/acode-cli`
  是独立 workspace，根 `pnpm lint` 扫不到）、`pnpm test`。失败只能在 runner 上首次暴露。
- **G3 单轮反馈 17 分钟**：关键路径 = `verify` 13m45s → `remote-ssh` 3m15s（`needs: verify`）。
  `windows-verify` 8m22s 与 `verify` 并行且早 5 分钟结束，**不在关键路径上**。
- **G4 治理检查把 gitignored 产物当源码**（落地本 spec 时实测发现）：
  `scripts/architecture/policy.mjs` 的 `walk` 只按目录名跳过 `node_modules/dist/out/coverage/.git`，
  不查 git 忽略规则，于是落在源码目录里的构建产物被按后缀收进治理输入——
  `apps/acode-cli/packages/browser-use-plugin/scripts/{browser-client,relay-server}.mjs`
  由同目录 `build.mjs` 生成、被该包 `.gitignore` 第 2-3 行显式忽略。CI 的干净检出没有这些文件，
  故 **CI 恒绿而本地恒红**：实测本地 `violations 412 / baseline 410 / new 2`，
  同一 commit 的 CI `Architecture check` 为 success（410 / 410 / 0）。
  这条与 G1 叠加是致命的：hook 入库后会因一个 CI 永远看不见的产物阻断每次推送，
  而 `git-collaboration.md` 又禁止 `--no-verify`。修法见 R6。

`verify` 13m45s 的步骤级分解（占比 90% 的是两项）：

| 步骤 | 耗时 |
| --- | --- |
| Install dependencies | 31s（pnpm store 缓存命中） |
| **Typecheck** | **4m10s** |
| Lint / Architecture / Knip / Ledger / Build CLI / Lint CLI | 2s / 12s / 10s / <1s / 11s / 4s |
| **Tests (all packages)** | **8m15s** |

`Tests` 8m15s 的内部构成：18 段 `duration_ms` 求和 497s，与步骤耗时吻合；
**最大单包 292.7s（4m53s）占 59%**，其余 17 段合计 3m24s。

### 承重事实：测试串行不可放宽

`package.json` 的 `test` 用 `--workspace-concurrency=1`。本机（win32、Node v25.9.0）实测：

| 跑法 | 结果 |
| --- | --- |
| `pnpm --filter acode-cli test`（独占，即 CI 的方式） | pass 3286 / **fail 0**，2m16s |
| 同一包在 `pnpm -r --workspace-concurrency=4 run test` 下 | pass 3263 / **fail 3** |
| 三个失败文件各自单跑 | 全绿（26 / 8 / 9 pass） |

失败者为 `tests/acp-host-adapter.test.mjs`、`tests/concurrency-diagnostics.test.mjs`、
`tests/cua-failclosed-gating.test.mjs`——均在跨包资源争用下红、独占时绿。
结论：**`--workspace-concurrency=1` 是承重墙，不是保守默认值**；调大并发等于用放宽门禁
换速度，禁止。负载敏感本身是测试缺陷，登记 `docs/tech-debt-backlog.md`，不得靠串行长期掩盖。

推论：同机并发被否，测试提速只剩**进程/机器隔离**（拆 job）一条路，而其下限就是最大单包
4m53s。据此评估拆 job 收益 ≈ 2m45s（17m → 14m15s），代价是 workflow 结构性改动与每个 job
重复 install/build。本 spec **不纳入**该改动；若后续要做，须先在此追记分包方案与实测收益。

## 规则与所有者

### R1. 本地门禁单一入口

1. `scripts/verify-local.mjs` 是本地验证门禁的唯一编排入口，根 `package.json` 的
   `verify:ci` 与 `verify:pre-push` 都只调用它，不得在 `package.json` 内联 `&&` 串接门禁命令
   （与 cli-validation-gates.md 规则 5「typecheck 单一入口」同理：内联串接会催生旁路）。
2. 门禁清单在 `scripts/verify-local.mjs` 中声明一份。每条门的命令与 `ci.yml` `verify` 的
   `run` 逐字一致；含 `typecheck` 的门必须逐字 `pnpm typecheck`，不得内联单入口。
3. 阶段执行器复用 `scripts/lib/gate-runner.mjs`（从 `typecheck-gate.mjs` 提取的公共实现：
   行前缀、计时、汇总、失败复现命令）。`typecheck-gate.mjs` 的对外契约不变——
   `TYPECHECK_STAGES`、`TypecheckGateUsageError`、`runTypecheckGate` 与其阶段清单、
   `--only` / `--stages-file` / `--sequential` 语义全部保持，受
   `apps/acode-cli/tests/typecheck-gate.test.mjs` 保护。
4. 任一门失败即退出非零、指名门 id 与可复现命令；已跳过的门必须逐条打印「跳过」，
   不得只在汇总里静默标记（沿用 typecheck-gate 的不静默降级约定）。

### R2. 执行顺序：便宜的先跑

5. 本地门禁顺序按**单次成本升序**，而非照抄 CI 顺序：
   `lint`(2s) → `architecture`(12s) → `knip`(10s) → `ledger`(<1s) →
   `typecheck`(4m10s) → `build-cli`(11s) → `lint-cli`(4s) → `tests`。
   依据是上表实测：前四门合计 <30s，绝大多数机械失败在 30s 内暴露，而不是等最慢的
   `typecheck` 跑完 4 分钟才知道 lint 早就红了。
6. CI 的步骤顺序不因本 spec 调整——`ci.yml` 现有顺序有既存注释依据（Typecheck 的 cli 阶段
   产出 dist，供后续 Build/Tests 复用），改序属独立提案。
7. `tests` 门 `dependsOn: build-cli`：`core`/`cli` 测试经 tsx 引 `apps/acode-cli` 源码，
   源码按包名解析兄弟包 `dist/`，干净树无 dist 会 `ERR_MODULE_NOT_FOUND`
   （ci.yml:80-84、ci-platform-matrix.md R1.3 同因）。`--only tests` 时该依赖自动带上。

### R3. 两档范围

8. `pnpm verify:ci`（`--full`）：8 道门全跑，`tests` 为全量。语义 = `ci.yml` `verify` 的本地等价，
   用于「本地绿则 CI 绿」的确证。
9. `pnpm verify:pre-push`（默认档）：前 7 道门全跑（含全量 `typecheck`），`tests` 只跑
   **受影响包**（R4）。理由：`docs/git-collaboration.md` 明令「禁止用 `--no-verify` 绕过仓库
   检查提交或推送」，hook 是硬门禁；把 8m15s 全量测试塞进 pre-push 会让人被自己的规则锁死，
   实际后果是想办法绕过 hook，比没有 hook 更糟。
10. `.husky/pre-push` 入库，内容为调用 `pnpm verify:pre-push`。hook 失败必须阻断推送：
    不加 `|| true`、不做超时降级、不强制 `exit 0`。两条容易踩空的前提：
    - **不依赖可执行位**：`core.hooksPath` 指向 `.husky/_`，git 执行的是 husky 的 shim，
      shim 内 `h` 以 `sh -e "$s"` 调用用户 hook（实测 `.husky/_/h`），故 `core.filemode=false`
      的 Windows 检出同样生效。`.husky/_/.gitignore` 内容为 `*`，入库的只有 `pre-push` 一个文件。
    - **`.gitattributes` 必须对 `.husky/*` 强制 `eol=lf`**：hook 文件无扩展名，既有的
      `*.mjs` / `*.sh` 规则覆盖不到它。`sh -e` 执行 CRLF 脚本会把 `\r` 带进命令名
      （`pnpm\r` → command not found），于是 `core.autocrlf=true` 的检出上 hook **静默失效**——
      它要拦的门禁全部不跑且不报错，与 G1 的后果同型。由
      `apps/acode-cli/tests/verify-local-gate.test.mjs` 断言 `git check-attr eol` 为 `lf`。
11. CI 不缩减覆盖：`ci.yml` 继续跑全量 `pnpm test`。按变更范围只服务本地快循环，
    **不得**进 CI——`ci.yml` 顶部注释确立的「绿」的唯一权威判定不接受图推导的覆盖裁剪。

### R4. 受影响包的判定与回退

12. 基线取 `@{upstream}`（pre-push 场景即「本次待推送的提交」），无 upstream 时依次回退
    `origin/dev`、`origin/main`；基线不可解析时**跑全量**并打印原因，不得静默缩小范围。
13. 选择器用 `pnpm -r --filter "...[<base>]" run test`（变更包 + 其依赖方），
    并保持 `--workspace-concurrency=1`（承重事实）。
14. **根级配置变更强制全量**：`--filter` 只看包目录，看不见影响全局的根级输入。命中以下任一
    路径即跑全量并打印原因：`pnpm-lock.yaml`、根 `package.json`、`pnpm-workspace.yaml`、
    `tsconfig*.json`、`.oxlintrc.json`、`knip.jsonc`、`architecture-policy.yaml`、
    `.architecture-baseline.json`、`scripts/**`、`.github/workflows/**`、`mise.toml`。
15. 受影响集合为空时明确打印「无受影响包」，不得把「没跑测试」显示成「测试通过」。

### R5. 缓存纪律的边界

16. `warm-cache.yml` 增开 **Windows pnpm store 生产者**（键前缀 `pnpm-store-Windows-`），
    `windows-verify` 改为 `actions/cache/restore`（只 restore 不 save）。这是
    ci-platform-matrix.md R1.5 预留的后续动作，Windows leg 已稳定（近期 run 全绿）。
    收益是每次 run 省 ~1m34s 冷装（Windows runner 计费倍率 2×）；**不缩短关键路径**，
    因 Windows leg 本就与 `verify` 并行且提前结束。
17. **不引入 `.turbo` / `.tsbuildinfo` 缓存**。理由：这类缓存的价值取决于每次 CI run 回写，
    而本仓纪律是「消费方只 restore、生产方只有 warm-cache」（omp 事故：每 PR 各存一份
    ~500MB store，吃掉 9.4GB/10GB 配额）。warm-cache 只在锁文件变更时触发，产出的 turbo 条目
    对后续 typecheck 命中率极低，等于付配额买不到收益。要真正压缩 `typecheck` 的 4m10s，
    只有 turbo remote cache（需 `TURBO_TOKEN` secret 与外部服务）一条路，属独立提案。
18. 任何缓存改动不得使消费方产生 save；`setup-node` 的 `cache: pnpm` 仍禁用（会 save）。

### R6. 治理输入必须与 CI 的检出等价

19. 架构检查的源码发现（`scripts/architecture/policy.mjs` 的 `discoverFiles`）在按目录名跳过
    之外，**还须剔除被 git 忽略的路径**，实现见 `scripts/architecture/git-ignored.mjs`。
    理由：治理的对象是纳入版本控制的源码；构建产物不是源码，且 CI 的干净检出没有它们，
    不排除就产生「本地红 / CI 绿」的不等价（G4）。
20. 判定权威用 `git check-ignore --stdin -z`，**不得**硬编码产物路径：tracked 文件永远不会被
    判为 ignored，故该过滤只可能剔除「未纳入版本控制的产物」，不会漏掉真实源码；
    路径走 stdin 而非 argv，绕开 Windows ~32KB 命令行长度上限（全仓源码路径数千条）。
    `check-ignore` 退出码 1 表示「没有路径被忽略」，是正常结果，不得当错误。
21. **失败降级方向是保留原集合**：git 不可用（非仓库检出等）时宁可多报，也不静默缩小治理范围——
    后者等于让门禁在无人察觉时失效。
22. 该修复在 CI 上是恒等变换（干净检出无 ignored 文件），因此不改变 `.architecture-baseline.json`
    的既有基线；基线条目全部来自 tracked 文件这一点由「CI 报 410 / baseline 410 / new 0 且 success」
    反向确证。

### R7. ledger 门与根 package.json 的耦合

23. `third-party/inventory.json` 的 `inputs` 登记了根 `package.json` 的 sha256（它声明依赖，
    故在台账范围内），因此**任何对根 `package.json` 的改动都会让 ledger 门红**，
    即使改动与依赖无关（例如只增删 scripts）。这不是误报，是台账的设计意图。
24. 处置分两种，不得混用：
    - **依赖树未变**（只改 scripts/version 等）：用台账自己的口径
      （`hashBytes`，UTF-8 读出后 CRLF→LF 再 sha256，见 `scripts/third-party-reproducibility.mjs:57`）
      重算该文件的 hash，对 `inventory.json` 做**单条文本替换**。必须保留其余字节逐字不变
      （缩进、键序、CRLF 行尾），否则 CI 的 `full` 模式会 diff 出格式漂移。
      重算值应与 `--inputs-only` 报出的「实际」值一致，作为口径交叉验证。
    - **依赖树有变**（增删/升降依赖）：必须走 `licenses-notices.yml` 在 CI Linux 上全量重生成、
      下载 artifact 后提交。**不得在 Windows 上跑 `node scripts/licenses.mjs notices` 并提交**——
      `packages` / `notInstalled` / `noticesSha256` 等派生字段依赖平台相关的 optional deps，
      本机会算错。
25. 台账 `inputs` 的 scope 不含仓库脚本、文档与测试（实测 `scripts/typecheck-gate.mjs`、
    `docs/specs/ci-platform-matrix.md`、`apps/acode-cli/tests/typecheck-gate.test.mjs` 均未登记），
    故新增这类文件不需要登记，`--inputs-only` 也不会因它们漂移。

## 验收

1. `pnpm verify:ci --list` 打印 8 道门及其命令，与 `ci.yml` `verify` 的 `run` 逐字一致；
   含 `typecheck` 的门为 `pnpm typecheck`。
2. 注入验收：制造一处 lint 违规后 `pnpm verify:pre-push` 在 `typecheck` 开始前即退出非零，
   输出指名 `lint` 与复现命令；修复后同一入口退出 0。
3. 跳过可见性：任一门失败时，其后未执行的门逐条打印「跳过」，汇总不把它们显示为通过。
4. hook 生效：`git ls-files .husky` 含 `pre-push`；在红状态下 `git push` 被阻断且未产生推送。
5. 回归保护：`apps/acode-cli/tests/typecheck-gate.test.mjs` 全绿（提取 gate-runner 未改其契约）；
   `pnpm typecheck` 退出 0。
6. 范围回退：删掉 upstream 后 `pnpm verify:pre-push` 跑全量并打印回退原因；
   改动根 `package.json` 时同样跑全量。
7. 空集合可见：在无包变更的提交上 `verify:pre-push` 打印「无受影响包」而非「测试通过」。
8. `warm-cache.yml` 出现 Windows 生产者（`runs-on: windows-latest`、键前缀 `pnpm-store-Windows-`、
   probe→save→prune 三步、写入步 `continue-on-error`）；`windows-verify` 出现
   `actions/cache/restore` 且全 workflow 无 `actions/cache/save`、无 `setup-node` 的 `cache: pnpm`。
9. 串行承重不被削弱：`package.json` 的 `test` 仍为 `--workspace-concurrency=1`。
10. 本地与 CI 的架构检查等价：在存在 gitignored 构建产物的工作树上 `pnpm architecture:check`
    输出 `new: 0`，且 `violations` 与 CI 同 commit 的数字一致（实测两侧均 410）。
11. CI 对齐可被机器证伪：`apps/acode-cli/tests/verify-local-gate.test.mjs` 解析 `ci.yml` 的
    `verify` 步骤，断言每道门的 `ci.run` 与之逐字一致且无未覆盖的门禁步骤——
    CI 加门而本地未同步时该测试必须红。

## 未验证边界

- workflow 改动无法本地实跑（禁止 push 触发真实 runner）。验收 8 以静态核对 YAML 为准，
  Windows 缓存条目的实际命中率与配额占用以首批真实 run 为准。
- 受影响包判定依赖 pnpm `--filter "...[<base>]"` 的图推导；本 spec 只保证「不确定就跑全量」，
  不对图推导的完备性作断言。CI 全量测试是最终兜底。
- 负载敏感测试的根因（争用的是端口、临时目录还是 CPU 时序）未定位；本 spec 只确立
  「不得靠调大并发换速度」，根因修复见 tech-debt 登记项。
- 本机 Node v25.9.0 与 `mise.toml` 钉住的 24.14.0 / CI 的 24 不一致，属环境问题而非门禁缺口；
  上述本机实测结论以「独占 vs 并发」的对照成立，不依赖具体 Node 次版本。
