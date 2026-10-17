# 设置文档三段式写作规范（T2-p4②）

价值提取第二轮波次（2026-10-15）W2-SEC5 交付。与 `error-message-style.md` 互补：
那份管**失败信息**的句式（事后），本 spec 管**设置项文档**的结构（事前）——用户在
配置一个开关之前，文档要让他能推理出「我该怎么设、设错了会怎样」。所有文本自撰；
对照来源为第三方产品还原件的结构性分析（仅本地、只读），原文不进仓库、厂商代号
与其配置键字面名不入本仓。

## 背景（已核实的现状，基线：当前检出）

- ACode 的设置文档散在三类面：①spec 的产品规则节（如
  `subprocess-env-credential-allowlist.md` R2 的 ACODE_TOOL_ENV_INHERIT_ALLOWLIST）；
  ②README 的设置/环境段（如 `packages/debug/README.md` 的抓包代理 env、
  `apps/acode-cli/README.md` 的插件 manifest env 展开规则）；③设置 UI 描述字段
  （ui locales——本批不改文案，只登记规范约束）。
- 现状通病：**只写行为，不写推理**。「Missing variables disable the affected MCP
  server and produce a plugin diagnostic」说了会发生什么，没说为什么这样设计、
  用户撞上时怎么定位、有没有更精细的替代。用户把秘密写进明文配置面、把缓存 TTL
  设得比 token 生命周期长这类**可预见的误设**，文档没有前置拦截。
- 参照证据产品对同一问题的形态（还原件结构性分析）：其设置描述普遍是
  「动机 → 失败模式推理 → 边界与替代」的压缩三段——例如静态 headers 配置直接
  内嵌「勿放 API key，token 走 credential helper，冲突 helper 赢」的边界句；
  helper TTL 配置内嵌「设 ≤ token 生命周期，否则 crash-loop 的进程会用过期缓存
  环境复活」的失败链。

## 产品规则

### R1 三段式定义（每个设置项文档的必备结构）

| 段 | 回答的问题 | 纪律 |
| --- | --- | --- |
| **动机** | 这个设置服务什么合法需求？为什么是设置而不是写死？ | 一段说清「谁会需要它、默认值为什么是现在这个」；不复述字段类型/格式（schema 管） |
| **失败模式推理** | 设错了会发生什么？为什么以那种方式失败？ | 必须写因果链（条件→机制→可观察症状），不写「请谨慎使用」；至少覆盖最常见的一个误设 |
| **边界与替代** | 来源/优先级限制是什么？什么场景不适用、该用什么？ | 点名唯一来源与冲突裁决（哪个值赢）；有更精细通道时必须给指引 |

- 三段可以压缩进两三句话，但**不可缺段**：只有行为描述（「what it is」）不构成
  设置文档。
- 失败模式必须从**用户视角可观察的症状**写起（报错在哪、什么现象），再给根因——
  与 `error-message-style.md` 模板②（反归因+自指阅读指南）同向：文档负责事前，
  错误信息负责事后，两边用词应互指（文档点名的症状 = 报错文案点名的症状）。
- 优先级/冲突句是硬要求：凡存在多个入口（启动 env、项目配置、UI、per-destination
  注入）的设置，必须写明谁覆盖谁；「冲突时 helper 赢」「项目配置只能收紧」这类
  裁决句就是本段的目标形态。

### R2 应用面与语言

- 适用面：spec 产品规则节中的设置项条目、README 的环境/配置段、设置 UI 描述字段
  （locales）。ui locales 文案的全量改写是独立批（本批只登记规范，不动文案）。
- 语言随文件既有语言（英文 README 用英文、中文 spec 用中文）；模型面文本仍走
  `prompt-language-policy.md`，本规范只管**人类用户**读的设置文档。
- 长度纪律：三段式不是加长许可——单个设置项文档目标 ≤ 8 行（UI 描述字段 ≤ 3 句），
  推理密度优先于篇幅。

### R3 示范改写（本批交付的三个真实面 + 一个预留面）

1. **ACODE_TOOL_ENV_INHERIT_ALLOWLIST**（`subprocess-env-credential-allowlist.md`
   R2，本批已改写）：动机=默认剥离打断合法工作流、裁决权在用户；失败模式=
   忘配时子进程侧认证失败而根因在启动 env 侧（排查断层）、通配过宽放大暴露面；
   边界=唯一来源启动 env、固定黑名单不受其恢复、per-destination 注入是更精细替代。
2. **debug 抓包代理 env**（`packages/debug/README.md`，本批已改写）：动机/失败模式/
   边界三段覆盖 ACODE_HTTP_PROXY / ACODE_AGENT_CA_CERT / ACODE_DEBUG_NETWORK_CAPTURE
   ——含「本地 CA 只用于 debug 抓包面」的边界句。
3. **插件 manifest env 展开**（`apps/acode-cli/README.md` Variables 节，本批已改写）：
   动机=插件配置需要引用安装期才知道的路径/用户配置；失败模式=缺变量时**该 server
   被禁用并产出诊断**（而非展开为空串静默跑坏）；边界=只有 ACODE_ 前缀 env 会展开、
   user_config 走 manifest 声明。
4. **凭据 helper 预留面**（`packages/provider/specs/credential-helper-context.md`）：
   helper TTL（≤ token 生命周期的失败链推理）与 HELPER_CONTEXT 五值的文档按本规范
   先行写成——设置面尚未存在，文档结构先立，落地时直接沿用。

## 验收场景

1. 本批三个示范面改写后各自可指认三段（评审 checklist：动机/失败模式/边界各至少
   一句）。
2. 新增设置项的 spec/README 文档评审按 R1 表检查；缺段视为文档未完成（与
   「先更新 spec 再实现」同批执行，AGENTS.md 核心原则）。
3. 文档点名的失败症状与对应错误文案用词一致（跨 `error-message-style.md` 联检）。

## 不在本项范围

- ui locales 存量设置描述的全量三段式改写（独立批；本批的规范条目对其生效）。
- 厂商设置文档正文的引用或改写（纪律：对照只在还原件分析层，文本一律自撰）。
- 设置项本身的增删改（本 spec 只管文档写法，不改任何设置语义）。
