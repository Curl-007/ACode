# npm run script 体扫描（R6 边界⑥收口）

> 隶属 bash 目标 blast-radius 风险分级层（J1-1，spec
> `apps/acode-cli/specs/bash-target-blast-radius.md`）。该 spec R6 登记的最高优先边界
> 「JS 包运行器只解包到命令行可见的动词」——`npm run <script>`/`pnpm run <script>`/
> `yarn <script>`/`bun run <script>` 解包后只看到动词 `run`，package.json script 体
> 内容不可见——本文收口其中 npm/pnpm/yarn/bun 的 **run 族**。
> make/just、deno task、`node -e`、npm install 生命周期钩子仍为登记边界（见 R7）。

## 背景与证据

- `package.json` 的 `"clean": "rimraf ~"` 时，`npm run clean` 在收口前判 safe：
  grammar.ts 的 wrapper 解包把 `npm`/`pnpm`/`yarn`/`bun` 解到第一个位置参数 `run`，
  `run` 不在破坏性动词表内 → safe → yolo/autoApproveHighRisk 静默放行。
- 实测基线（收口前，探针）：`npm run clean`、`npm run $X`、`yarn clean`、
  `bun run clean`、`npm test` 全部 safe；`pnpm exec rimraf ~` 已由 exec 解包覆盖
  （catastrophic），不在本边界内。
- 决策链实测（收口前）：capability 把 confirm/catastrophic 升到 `riskLevel: critical`，
  但 `PermissionService.checkPermissionByMode` 的 yolo 分支不看 riskLevel，直接
  `allow("mode.yolo")`；bypass-immune-breakers 的 deny 级命中类是 yolo 下唯一的 deny
  通道，而它是**纯函数、自己重建 TargetRiskContext**，拿不到 script 体 → `npm run clean`
  （body=`rimraf ~`）在 yolo 下静默 allow。这是「脚本化删除」绕过绝对 deny 的完整链路。

## 产品规则

### R1 状态所有权与模块边界（宪法不变）

- `tool/handlers/bash-target-risk/**` 保持**纯函数、零 IO、不读环境**
  （types.ts 头注释是模块宪法）。script 体由**调用方异步预解析后注入**。
- 注入通道：`TargetRiskContext.packageScripts?: readonly PackageScriptSource[]`：

  ```ts
  /** 一个包的 package.json scripts 预解析结果（R6 边界⑥收口）。 */
  export interface PackageScriptSource {
    /** package.json 所在目录（npm scripts 的执行 cwd；body 评估的 trackedCwd 基准）。 */
    readonly directory: string;
    /** scripts map（仅字符串值；解析失败/超限的文件不产生条目）。 */
    readonly scripts: Readonly<Record<string, string>>;
  }
  ```

- **谁预取**：`tool/handlers/bash-package-script-context.ts`（新，接线层）——
  `collectBashPackageScriptSources(command, {workingDirectory, workspaceRoot})`，返回
  `{ sources, scannedDirectories }`：
  - 从 workingDirectory（缺省 workspaceRoot；两者皆缺 → 空）向上逐级找最近的
    package.json，读出 `scripts`；到文件系统根或 64 级深度上限为止（深度上限是
    登记边界，见 R7）；
  - 用**宽匹配正则**从命令原文提取目录选择器候选（`--filter`/`-F`/`--dir`/`-C`/
    `--prefix`/`--cwd`，含 `=` 粘连与引号包裹形态），对每个静态可解析候选再各做一次
    向上走（pnpm `--filter ./x` 按 workspaceRoot 与 cwd 双基准解析，宁多读不少读）；
  - **cd/pushd 目标提取（对抗验证 F1①）**：npm 的就近语义跟的是**执行时 cwd**，
    `cd sub && npm run clean` 的最近包在 sub 里——只从初始 cwd 向上走会漏读子包，
    模块端拿根包 map 充数判 safe（yolo 静默放行 body 灾难命令）。因此对命令原文
    静态提取 `cd <dir>`/`pushd <dir>` 目标（宽匹配，含子壳/`sh -c` 内层；动态值
    `$X`、`-`、无参形态提取失败静默跳过，由 F1② 兜底），对每个静态可解析目标各做
    一次向上走；
  - **body 第二遍扫描（对抗验证 F1①）**：嵌套 body（`"release:cli":
    "pnpm --dir sub run release"`）里的选择器/cd 目标是 npm 真实会执行的包，只在
    命令原文提取会漏。对已收集 source 的 scripts body 文本再做一遍选择器/cd 提取
    并向上走，迭代到无新 source；受总量上限 12 约束；
  - 文件大小上限 1 MiB，超限视为不可解析；JSON 解析失败/`scripts` 非字符串 map →
    视为不可解析，且**向上走止于该层**（对抗验证 F4：npm 读到的是这份坏文件、
    命令天然失败——不得越过它改用更上层包的 map，那是过严误报）；**异步读
    （node:fs/promises）、容错不抛**——任何失败只损失条目，绝不让预取抛错阻断
    权限链路；
  - 按归一化目录去重，总量上限 12 个 source；source 因超限被丢弃时，发起该次
    向上走的整段目录区间**不记入** `scannedDirectories`（覆盖证据与注册事实必须
    同源，丢弃即失权——模块端对该区间 fail-closed，不得放行）；
  - 返回 `scannedDirectories`：实际读过/走过的目录列表（**扫描覆盖证据**，对抗验证
    F1②）。某次向上走以「读到可解析包并注册」或「走到根/深度上限确无包」收尾时，
    其走过的目录才是覆盖证据。
  宽匹配是有意为之：预取端**宁可多读**，解析语义的精确判定在纯模块端——预取端
  少读了会 fail-closed（模块端对「静态选择器但无 source」「目标目录未被扫描覆盖」
  升 confirm），不会 fail-open。
- **谁注入**：
  - `bash.ts` 实现 `ToolEntry.resolvePermissionCapabilityContextAsync`（新钩子，
    tool/types.ts），返回 `{ packageScripts, scannedDirectories }`；
  - executor 的 `resolveToolPermission`（permission-flow.ts）与 hook 改写复核
    （permission-input-recheck.ts）**await 该钩子**，把结果并入
    `ToolRuntimePermissionCapabilityContext`（新可选字段 `packageScripts`、
    `scannedDirectories`）——该
    context 同源喂给 capability 合并、规则建议收窄（hasUnverifiableTargetRisk）与
    `PermissionContext.packageScripts`；
- `PermissionContext.packageScripts` 再经 `breakerContextFromPermissionContext` 与
  `BashReflexGateRequest` 传给熔断器与反射门——三个 permission 层消费点（capability
  critical / breaker deny / reflex gate）拿到**同一份**注入，不另建旁路。
  `scannedDirectories`（对抗验证 F1② 的覆盖证据）沿同一链路透传：
  `ToolRuntimePermissionCapabilityContext` → `PermissionContext` →
  `BypassImmuneBreakerContext` / `BashReflexGateRequest` → `TargetRiskContext`——
  三个消费点的模块端覆盖判定必须同源，缺任何一段都会让 confirm 在该消费点退回
  enclosing 误判（yolo 直通）。
  - `resolveToolCallCapabilityFlags`（ToolCallStarted 投影）保持同步、不注入：
    投影只供订阅者观察，不参与权限判定（登记边界，R7）。
- **生产保证**：Bash 的 capability 链路在 permission-flow 内必然经过 await 钩子——
  cwd 可达 package.json 时 map 一定注入。legacy 调用方（不经 executor 的直连
  PermissionService、手工构造 TargetRiskContext 的单测）缺省不注入 → 维持收口前
  行为（run 直通 safe），见 R6 fallback 矩阵。

### R2 解析语义（npm 行为）

- **最近 package.json**：从命令执行 cwd 向上走，取最近一个含可解析 package.json 的
  目录（到 workspaceRoot 之后继续、到文件系统根或 64 级为止——npm 自己走到根，
  workspace 之上存在 package.json 时 npm 真的会用它）。cwd 在子包内时读**子包**的
  scripts（monorepo 主场景）。
- **script 名解析**：
  - 显式 `run`/`run-script`（npm）：其后（跳过 run 级旗标）第一个位置参数是 script 名；
  - npm 别名：`npm test/start/stop/restart` = `npm run <同名>`；
  - pnpm/yarn/bun 裸名直呼：`pnpm lint` = `pnpm run lint`；裸名命中各管理器的
    **native 动词表**（install/add/remove/update/publish/exec/dlx/x/init/…，bun 另含
    test/build/repl/pm）时不按 script 处理——`pnpm install` 会执行的是依赖树生命周期
    钩子（供应链面，R7 范围外），不是本包 scripts map 的字面查找；
  - `npm` 裸名只认四个别名（npm 语义：其余裸名报错退出）；
  - `npm run`（无名）/`yarn run`（无名）→ npm 打印用法后失败，无害 → safe。
    **限定（对抗验证 F3）**：仅限非管道、非 xargs payload 位——`echo clean |
    xargs npm run` / `xargs npm run < names.txt` 的名字来自 stdin，npm 真会执行
    `npm run clean`；`{}` 及含 `{}` 的名（`xargs -I{} npm run {}`）在 xargs/管道位
    同样按动态名 confirm。裸 `npm run`（无名、无管道）维持 safe。
- **pre/post 钩子**：`pre<name>`/`post<name>` 在 map 中存在时一并评估（npm/yarn
  classic/pnpm 默认自动执行；recall 偏向）。执行顺序 pre → main → post；
  `npm run x -- <args>` 的转发参数只拼进 main body。
  **main 缺失时不评估钩子（对抗验证 F6）**：`<name>` 不在 map 且命令未带
  `--if-present` 时，npm 报 Missing script 直接退出、钩子不执行——评估 pre/post 是
  过严误报，跳过；`--if-present` 语境下 npm 真会跑 pre/post，保留评估（recall 偏向）。
- **body 评估**：body 文本走既有 `assessText` 递归（深度守卫 MAX_RECURSION_DEPTH
  沿用；body 内嵌套 `npm run other` 经同一 map 继续递归）。body 评估的
  **trackedCwd = package.json 所在目录**（npm scripts 以包根为 cwd），相对目标按它
  定基；body 内 `cd` 后的段级跟踪与顶层同一套语义。
- **词法 fallback 同口径**：subshell/if/while 包裹的 `npm run x`（fallback 路径）
  用同一套解析与 body 递归（经注入的 assessText 回调），一层括号不得降级（F-1 哲学）。
- **选择器旗标**（目标包解析）：
  - cwd 基准：`--prefix`（npm）、`-C`/`--dir`（pnpm）、`--cwd`（yarn）——按当前
    trackedCwd 解析；粘连形 `-C<path>`/`-F<path>` 模块端与空格形**同口径拆值**
    （对抗验证 F5：预取端正则支持粘连而模块端只认精确 token 时，同一形态两侧
    结论漂移，粘连形错落 unknown-flag confirm）；
  - **扫描覆盖证明（对抗验证 F1②）**：目标目录解析出的 enclosing 命中只有在该
    目录的「最近包已扫描」时可信任——`scannedDirectories` 含目标目录，或命中
    source 就在目标目录本身（读出该 source 必然读过它）。目标目录**严格深于**
    enclosing 且不在覆盖内（如 `cd sub` 落进未扫描子包）→ confirm：无法证明没有
    更近的 package.json 时不放行；选择器目标**不匹配任何 source** 时同样 confirm，
    **禁止回落 enclosing**（嵌套 body 错位的根因之一：`--dir sub` 命中不了 sub 的
    source 时回落根包 map，评的是错的 body）。`scannedDirectories` 缺省（legacy
    调用方/单测直注入 map）时维持 enclosing 信任（现行为），生产链路（executor
    预取）总是提供；
  - workspaceRoot 基准：`--filter`/`-F`（pnpm）——`./x`、`../x`、绝对路径、盘符路径、
    含 `/` 的路径形按路径选择器；纯名字按包名选择器（静态不可解析 → confirm）；
    路径形按 workspaceRoot 与 cwd **双基准**解析，命中的 source 都评估（宁多不少）；
  - 旗标值含 `$`/反引号/`%`/`*`/`?` → 动态，不可解析；
  - run 前缀里出现**未收录的旗标**（含取值旗标粘连形态之外的一切认不出的 `-` 开头
    token）→ fail-closed confirm（`npm --userconfig <f> run clean` 这类取值旗标若被
    当布尔跳过，会把 script 名错位成取值，漏掉 body——认不出来就升级）。
    已收录：取值 `--prefix/-C/--dir/--cwd/--filter/-F/--workspace/--registry/--cache/
    --userconfig/--proxy/--https-proxy/--tag/--scope/-C`；布尔 `--silent/-s/
    --if-present/--verbose/-d/--stream/--recursive/-r/-w/-D/--ignore-scripts/
    --offline/--prefer-offline/--frozen-lockfile/--no-color/--color/--progress/
    --unsafe-perm`；`--` 之后的 token 全部按位置参数；
  - `--prefix ./missing`（目标目录无包）的 enclosing 语义（对抗验证 F7 登记）：
    npm `--prefix` 把目标当项目根（读该目录的 package.json，不向上走），而 pnpm
    `-C` 从目标向上走——本实现统一按 enclosing（最深）口径，目标目录不可读时
    向上命中祖先包属**过严方向、可接受**（误报代价有限、方向宁严不松）。F1② 落地
    后该形态**未**自然变为 confirm：选择器向上走若在祖先目录读到可解析包并注册，
    覆盖证明成立，enclosing 信任照旧——如实登记为「ancestor 命中即评估祖先 body」
    的现口径，不追加特判。
- **转发参数**：script 名之后的 token（含 `--` 之后）拼进 main body 一起评估——
  `npm run clean -- ~` 真实执行 `rimraf dist ~`（body=`rimraf dist` 时）。

### R3 fallback 矩阵（recall 偏向 × 日常零摩擦）

| 形态 | 判定 | 依据 |
|---|---|---|
| `npm run clean`（body=`rimraf dist`，cwd=包根） | **low**（递归删除在工作区内） | 日常命令零摩擦 |
| `pnpm lint`（body=`oxlint`）/ `npm run build`（body=`node scripts/build.js`） | **safe** | 日常命令零摩擦 |
| body=`rimraf ~` / `rm -rf ~/.ssh` / `cd ~ && rm -rf .ssh` | **catastrophic** | body 走同一套路径保护表 |
| 动态 script 名（`npm run $X`、命令替换、含 `*`/`?`） | **confirm**（map 注入时） | 要跑哪段 body 静态不可知 |
| 路径选择器静态可解析且 source 已注入 | 对目标包目录解析 scripts（trackedCwd=目标包根） | R2 |
| 路径选择器静态可解析但**无对应 source**（目录不存在/不可读/未预取到） | **confirm** | fail-closed：宁可一次确认，不静默放行（npm 端该命令多半也会失败，代价有限） |
| 包名选择器（`--filter web`）、`--workspace <name>`、`-r`/`--recursive`、bare `-w` 之外的不可解析目标 | **confirm** | 会跑哪些包的 scripts 静态不可界 |
| 未知旗标（run 前缀） | **confirm** | 解析错位 = body 不可见 |
| `npm run` / `yarn run`（无名，非管道/非 xargs 位） | **safe** | 命令天然失败（用法错误） |
| xargs payload 位/管道喂入的无名 run（`echo clean \| xargs npm run`、`xargs npm run < names.txt`、`echo clean \| npm run`） | **confirm** | 对抗验证 F3：名字来自 stdin，npm 真会执行；body 静态不可知 |
| xargs 位 `{}` 名（`echo clean \| xargs -I{} npm run {}`） | **confirm** | 对抗验证 F3：按动态名口径 |
| 静态名不在 map（无 `--if-present`） | **safe** | 命令天然失败（Missing script，pre/post 不执行，对抗验证 F6） |
| 静态名不在 map + `--if-present`（pre/post 存在） | 按 pre/post body 评估 | npm 静默跳过 main 但钩子仍跑（对抗验证 F6） |
| 无 package.json（预取确认向上找不到） | **safe** | 同上 |
| package.json 不可解析（JSON 坏/超限 1 MiB） | **safe，向上走止于该层**（登记） | npm 读到的是这份坏文件、命令天然失败；不得改用更上层包的 map（对抗验证 F4：那是过严误报） |
| trackedCwd 被 `cd` 出所有已注入包、且落点不可证明有包 | **confirm** | cd 后的最近 package.json 未扫描（罕见路径，fail-closed） |
| `cd sub && npm run clean`（sub 包 body 危险；含 `cd sub;`/`pushd sub`/`cd ./sub`/子壳/`sh -c` 变体） | **catastrophic** | 对抗验证 F1①：cd 目标预取 + 就近语义命中子包 body |
| `cd sub && npm run clean`（sub 未被预取覆盖：动态 `cd $D`、超限丢弃等①失效形态） | **confirm** | 对抗验证 F1②：目标目录严格深于命中 enclosing 且不在 scannedDirectories 覆盖内，禁止 enclosing 充数 |
| 嵌套 body 选择器目标未预取（root `release:cli`=`pnpm --dir sub run release`，sub body 危险） | **catastrophic**（①覆盖后）；①失效 → **confirm**（②兜底，禁回落 enclosing） | body 第二遍扫描 + 覆盖证明（对抗验证 F1） |
| 选择器目标目录无 source（`npm --prefix ./missing run clean`，祖先包 body 危险） | 按祖先 body 评估（过严登记，见 R2/F7） | npm --prefix 目标当项目根；enclosing 统一口径（对抗验证 F7） |
| **map 未注入（legacy 调用方/纯同步上下文）** | **维持现行为（run 直通 safe）+ 本 spec 登记边界** | 模块零 IO 宪法；生产链路（executor → bash.ts）保证注入 |
| `npm test` 别名 | 走 map 的 `test` body | R2 |
| `prebuild`/`postbuild` 含 `rm -rf /etc/passwd` 时 `npm run build` | **catastrophic** | pre/post 一并评估 |
| 嵌套 `npm run a`（a=`npm run b`，b=`rm -rf /etc/passwd`） | **catastrophic**；链深超 MAX_RECURSION_DEPTH → **confirm** | 递归守卫沿用 |
| body 含未解析变量做破坏目标（`rm -rf $OUT/../etc`） | 既有 unresolved/`..` 逃逸规则生效 | 同一评估器 |
| `pnpm --filter ./packages/x run evil`（x 的 body 危险） | **catastrophic** | 选择器→source→body |

### R4 决策链（body catastrophic 在 yolo 下必须 deny）

实测结论（收口前）：capability critical 在 yolo 下**不是 deny**——
`checkPermissionByMode` 的 yolo 分支不看 riskLevel 直接 `allow("mode.yolo")`；
bypass-immune-breakers 的 deny 级命中类（`breaker.bashTargetCatastrophic`）是 yolo
下唯一 deny 通道，但它纯函数自建 context、拿不到 map。因此收口方案是**延长既有
deny 通道而不是新造一条**：

- `BypassImmuneBreakerContext` 增加可选 `packageScripts`，`checkCatastrophicBashTarget`
  把它并入 `assessBashCommandTargetRisk` 的 context；
- `PermissionService.checkPermission` 收口处的 breaker 评估经
  `breakerContextFromPermissionContext` 自动携带 `PermissionContext.packageScripts`；
- 端到端效果：`npm run clean`（body=`rimraf ~`）在 **yolo → deny**，ruleId 沿用
  **`breaker.bashTargetCatastrophic`**（同一命中类：catastrophic 目标档——命中路径经
  script body 发现不改变类别；spec 与实现同名）。deny 文案走既有通道（finding reason
  + target 展示 body 内命中的具体目标）。
- confirm 级 body（`npm run $X`、未知旗标、不可解析选择器）：capability critical →
  build 必 ask；yolo 下由反射门收口——`BashReflexGateRequest` 同样携带
  `packageScripts`，门内评估判 confirm → 首轮 `gate.bashConfirmReflex.reflect` deny +
  四问回喂，有效 justification 后 ask lane 收敛 ask / allow lane 留审计放行
  （specs/bash-confirm-reflexive-gate.md R5/R7 语义不变）。
- 决策顺序不变：policyFloor → disallowedTools → 模式判定 → 收口处 breaker（deny 级
  压过 allow/ask）→ 反射门（无 breaker 命中时）。

### R5 接缝（接线图）

```
Bash 工具调用
  └─ executor call-runner → resolveToolPermission（async，接缝所在）
       ├─ resolveRuntimePermissionContext(deps)            （同步基准 context）
       ├─ await entry.resolvePermissionCapabilityContextAsync(input, ctx)
       │    └─ bash.ts → collectBashPackageScriptSources（异步 IO，接线层）
       │         ├─ cwd 向上走读 package.json（≤1MiB，容错）
       │         └─ 正则宽提取 --filter/--dir/-C/--prefix/--cwd 候选 → 各自向上走
       ├─ enriched context → capability（bash.ts：assess with packageScripts）
       ├─ enriched context → resolveBashPermissionRulePolicy（通配前缀收窄同一视角）
       └─ PermissionContext{ packageScripts } → PermissionService.checkPermission
            ├─ bypass-immune-breakers（deny 级：body catastrophic → deny，yolo 亦然）
            └─ BashConfirmReflexGate（confirm 级：反射门，yolo/build 同一语义）

hook 改写复核（permission-input-recheck.ts）重复同一 await——改写后的命令可能
指向不同选择器，必须重新预取（与首次判定同源同语义）。
```

### R6 legacy 边界（显式登记）

- map 未注入的调用方：`npm run x` 维持 safe 直通——与收口前行为逐字节一致。生产
  Bash 链路（executor → bash.ts 钩子）保证注入；不经 executor 的 PermissionService
  直连调用方（agent-runtime/project-memory-agent 自建实例等）若未传
  `PermissionContext.packageScripts`，其 breaker/反射门评估看不到 body（现状不变）。
- `resolveToolCallCapabilityFlags`（ToolCallStarted 副作用旗标投影）不注入：投影层
  无异步接缝且不参与权限判定。

### R7 范围外 / 已知边界（明确登记）

- **deno task**（deno.json tasks）：接缝同款可行但 deno.json 是 JSONC（注释/尾逗号），
  需第二套解析器；`deno task` 使用密度显著低于 npm run 族 → 登记为边界，暂不做。
- **make/just**：Makefile 文法（目标/依赖/recipe 行、变量展开）不同，明确范围外。
- **npm install 生命周期钩子**（preinstall/install/postinstall 及依赖树供应链面）：
  明确范围外——`pnpm install` 不按本包 scripts map 的字面查找处理（native 动词表）。
- **`node -e`/`node script.js`/`pnpm exec node clean.js`**：JS 源内删除不解析
  （bash-target-blast-radius R6 既有登记，维持）。
- 预取向上走深度上限 64 级：更深的目录链里 npm 会找到的 package.json 本层看不见
  （病态路径，登记）。
- 预取宽匹配正则对包裹在嵌套引号/命令替换内的选择器可能漏提取 → 模块端 fail-closed
  confirm 兜底，不 fail-open。
- cd/pushd 目标提取（F1①）同为宽匹配：动态值（`cd $D`）、`cd -`、无参 `cd`（=HOME）
  提取失败静默跳过——这些形态 npm 的落点静态不可知，由模块端 F1② 覆盖证明
  （trackedCwd unresolved 或目标未被扫描 → confirm）兜底。body 第二遍扫描受
  MAX_SOURCES=12 与去重约束：超限丢弃的 source 不产生覆盖证据（模块端对该区间
  fail-closed），极端嵌套链的更深层目标登记为边界。
- pnpm `--filter` 的路径/包名双语义按「路径形 → 双基准解析；名字形 → confirm」的
  保守口径实现；yarn berry / npm `--workspace <name>` 按不可解析 confirm。

## 验收场景（测试矩阵）

`tests/npm-script-body-scan.test.mjs`（node:test + assert，仓库根
`node --import tsx --test`；OS temp 目录造假 package.json 树，绝不碰真实用户数据）：

| 命令（context 注入对应 map） | 期望 |
|---|---|
| `npm run clean`（body=`rimraf dist`，cwd=包根） | low |
| `pnpm lint`（body=`oxlint`）/ `npm run build`（body=`node scripts/build.js`） | safe |
| `npm run pwn`（body=`rimraf ~`） | catastrophic |
| `npm run pwn`（body=`rm -rf ~/.ssh` / `cd ~ && rm -rf .ssh`） | catastrophic |
| 端到端：PermissionService yolo + `npm run pwn`（body=`rimraf ~`） | **deny，ruleId `breaker.bashTargetCatastrophic`**（非静默 allow） |
| `npm test`（body 危险） | catastrophic（别名走 body） |
| `prebuild`/`postbuild` 含 `rm -rf /etc/passwd` 时 `npm run build` | catastrophic |
| 嵌套 `npm run a`（a=`npm run b`，b=`rm -rf /etc/passwd`） | catastrophic |
| 嵌套链深超 MAX_RECURSION_DEPTH | confirm（fail-closed） |
| `npm run $X` | confirm |
| `npm run`（无名） | safe |
| 静态名不在 map / 无 package.json（空 source 列表 + cwd 未变） | safe |
| `pnpm --filter ./packages/x run evil`（x body 危险，source 已注入） | catastrophic |
| `--filter` 名字形 / 动态值 / 静态路径无 source | confirm |
| 最近 package.json：cwd 在子包读子包 scripts（temp 两层树） | 子包 body 生效 |
| body=`rm -rf $OUT/../etc` | catastrophic（既有 `..` 逃逸规则） |
| map 未注入（legacy） | `npm run clean`/`npm run $X` 均 safe（现行为不变） |
| subshell：`(npm run pwn)`（body=`rimraf ~`，fallback 路径） | catastrophic |
| 预取接线：temp 树上 `collectBashPackageScriptSources` | 最近 source + `--filter`/`--dir` 候选注入正确；JSON 坏/超限容错 |
| 未知旗标：`npm --userconfig f run clean`（body 危险） | confirm（fail-closed） |
| `pnpm install` / `npm publish` / `bun test`（native 动词） | 不按 script 处理（safe 直通不变） |
| F1①：temp 树 root `clean`=`echo ok`、sub `clean`=`rimraf ~`，`cd sub && npm run clean`（及 `cd sub;`/`pushd sub`/`cd ./sub`/子壳/`sh -c` 变体） | catastrophic（预取注入子包 source） |
| F1①：嵌套 `release:cli`=`pnpm --dir sub run release`（sub `release`=`rimraf ~`） | catastrophic（body 第二遍扫描） |
| F1②：`cd $D && npm run clean` / sub 未覆盖时的 `cd sub && npm run clean` | confirm（覆盖证明缺失不放行） |
| F1 不回归：初始 cwd 直接 `npm run clean`（body 危险）→ catastrophic；`pnpm lint` 等日常命令 → safe；`cd dist && rm -rf *` 等非 run 族不变 | 不回归 |
| F2：`npx --package x npm run clean` / `npx -c "npm run clean"` / `npx --call …` / `npm exec --package x -- rimraf ~` / `npm exec -c "npm run clean"` | catastrophic（取值旗标消费 + `-c` 按 sh 递归 + `--` 后按 payload；见母层 R4 wrapper 条款） |
| F2 不回归：`npx tsc --noEmit` / `npx rimraf dist` / `npx npm run clean`（既有 catastrophic） | 档位零变化 |
| F3：`echo clean \| xargs npm run` / `xargs npm run < names.txt` / `echo clean \| xargs -I{} npm run {}` | confirm |
| F3 不回归：裸 `npm run`（无名无管道）→ safe；`xargs npm run clean`（body 危险）→ catastrophic；`echo ~ \| xargs rm -rf` → confirm | 不回归 |
| F4：子目录 package.json 坏 JSON、父包同名 body 危险，`npm run x` | safe（止走，不用父包 map） |
| F5：`pnpm -Cpackages/x run evil` / `pnpm -F./packages/x run evil`（x body 危险） | catastrophic（与空格形同判） |
| F6：`npm run nosuch`（无 `--if-present`，`prenosuch` 危险） | safe（钩子不评估） |
| F6：`npm run nosuch --if-present`（`prenosuch` 危险） | catastrophic（钩子保留评估） |
