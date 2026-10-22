# ACode 1.0.3 深度 Review · 架构治理 / 依赖健康 / 门禁 / 小包

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + **四项门禁实跑**（typecheck/lint/architecture:check/knip:gate 均 exit 0），未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`architecture-policy.yaml` 纳管现状、ratchet、knip 依赖健康、CI/门禁覆盖、小包（acode-server-cli / harness-sdk / formal-proof / acode-cua）。

---

## 1. 层面整体评估

架构治理与门禁在 1.0.3 处于**健康且可信**状态：四项只读门禁（typecheck/lint/architecture:check/knip:gate）全部实跑 exit 0，architecture 0 new / 0 regrown，baseline 从历史 415 继续收紧到 **412**，managed 稳定在 **18 模块 / 854 文件**。依赖健康度良好：knip:gate（files/deps/devDeps/binaries）干净，793 未用导出 + 918 未用类型是**登记在案的 backlog**（不在门禁内），符合 ci.yml 注释约定。最大风险有三：一是 **legacy 5 模块文件数从历史 3463 涨到 4242**（+779），ui/web/desktop/services/acode-cli 仍未纳管，治理覆盖率被稀释；二是 **acode-cua 的「全表面 fail-closed」表述不精确**——服务端/Helper 面确实全部拒绝，但 `broker.js` 是**功能完整的 wire 客户端**，生产环境的 fail-closed 实际靠上游「插件未打包/未启用」门控兜底，而非占位包本身惰性；三是 **12 处 unlisted 依赖**（源码 import 但包未声明，靠 hoisting），knip:gate 的 `--include` 范围不含 unlisted 故未拦下。

## 2. 门禁实跑结果

| 命令 | 退出码 | 关键计数 |
|---|---|---|
| `pnpm typecheck`（三阶段） | **0** | packages 148.9s / desktop-renderer 3.8s / cli 18.1s（31/32 turbo 缓存命中） |
| `pnpm lint`（oxlint） | **0** | 167 warnings / **0 errors**，5397 文件 |
| `pnpm architecture:check` | **0** | violations 412 / baseline 412 / **new 0 / regrown 0** |
| `pnpm architecture:check --changed` | **0** | 同上（pre-push 路径） |
| `pnpm knip:gate` | **0** | 干净，仅 2 条 configuration hints |
| `pnpm knip`（full） | **1** | unlisted 12 / unused exports 793 / unused types 918 / dup exports 39（backlog，非门禁） |

> 注：worktree 初检时无 `node_modules`，首轮三门禁因缺依赖假失败；`pnpm install --frozen-lockfile --offline`（exit 0，52.9s）补齐后重跑，以上为真实结果。

## 3. 架构纳管现状

- **managed 18 模块 / 854 文件**：rpc, shared, provider, provider-node, session, storage, client, server, acode-server-cli, formal-proof, harness-sdk, model-option-map, acode-cua, acode-cli-contracts, acode-cli-runtime-task, acode-cli-workflow-run-read/-command, acode-cli-workflow。
- **legacy 5 模块 / 4242 文件**：services（根）、ui、web、desktop、acode-cli（大根）。
- **baseline 超限文件 412**（历史 415 → 现 412，ratchet 只减不增，继续收紧 3）。legacy over-limit = 412 = baseline，**0 new / 0 regrown**，ratchet 纪律有效。
- **resolver 三缺口进度**：① acode-cua 扁平 JS 包盲区已由 `global.aliasRules` 12 条显式映射消除（ARCH-04 已闭）；② server 通配导出 `./remote/*.js` 用**逐一显式登记**绕过（checker 仍不支持通配 `publicEntrypointMatches`，属有意 ratchet，新 deep-import 会失败逼回登记）；③ asset 导入豁免未见通用 resolver 支持。ui/web/desktop/services/acode-cli 纳管仍**前置未完成**——legacy 文件数 +779 说明这 5 个根在持续吸纳新代码却未收紧边界。

## 4. 依赖健康

- **knip:gate exit 0**（门禁范围内无未用文件/依赖/二进制）。2 条 hints：`**/.acode/**` 建议从 ignore 移除、`yauzl` 建议从 desktop ignoreDependencies 移除——均为提示非阻断。
- **full knip（exit 1，backlog）**：unlisted deps **12**（真实声明缺口，见下）、unused exports **793**、unused types **918**、dup exports **39**、unused namespace member **1**。exports/types 两类是 `docs/tech-debt-backlog.md` 登记的 backlog，ci.yml 明确不在门禁内。
- **unlisted 依赖（源码 import 但包未声明，靠 hoisting）**——已核实为真实缺口：
  - `packages/server/src/harness/translate.ts:24` import `zod`（type-only），server **未声明 zod**
  - `apps/acode-cli/packages/core/src/tool/handlers/deferred-tool-call.ts:14` import `zod`，core **未声明**
  - `apps/acode-cli/packages/node-repl-host/src/cua-bridge.ts:5` import `@modelcontextprotocol/sdk/types.js`，**未声明**
  - 余下多为 scripts/vite plugin（esbuild、vite、yazl、node-pty、ws、yaml），风险较低。
- **台账状态**：1.0.3 已回补 adapters/package.json 哈希（commit b6dce5e2），CI `third-party ledger inputs freshness` 步跑 `licenses.mjs reproducibility --inputs-only` 校验 2869 源文件哈希。

## 5. 小包边界

**acode-server-cli**（src 6057 行，managed，owner server-cli-supervisor，requires rpc/services/shared，有 test 脚本）：远程服务器 CLI + supervisor。公开入口 contract.ts / index.ts / main.ts（bin 真实入口）。内部 `contracts.ts`（复数，223 行 zod schema）有意不改名以绕开 max-contract-lines（只匹配 `contract.*` basename）。3 文件超限（cli.ts / packaging/stage.ts / supervisor/supervisor.ts）登记为 onboard-server-cli 例外，2026-12-31 到期。边界清晰。

**harness-sdk**（src 1684 行，managed，owner harness-sdk-client，requires shared，有 test 脚本）：Harness API v1 SDK，connect/launch 双模式。单层 app（直接持有子进程/fs/crypto IO，声明 domain 层会触发 domain-io，故合理选 app）。对外发布名预留 `@acode/sdk`。零超限例外。边界最干净。

**formal-proof**（src 1923 行，managed，owner formal-proof-model，requires []，**无 test 脚本 / 0 测试文件**）：形式化证明模型 + vite 应用。只导出 `./model`（无根导出），contract.ts 逐名转发 model.ts。model.ts 920 行不触发 max-contract-lines（非 `contract.*` basename）；main.ts/model.ts 超限登记 onboard-formal-proof 例外。**缺陷：managed 模块却无任何测试**，`pnpm test` 不覆盖它。

**acode-cua**（823 行 JS，managed，owner cua-permission-broker，requires []，无 test 脚本——14 个 cua-*.test.mjs 寄生在 `apps/acode-cli/tests/`）：fail-closed 核实结果——
- **服务端/Helper 面真 fail-closed**：`dispatchRequest`/`handleRequestLine` 直接 throw；`createProductCuaHelperHost` → 全方法 unavailable 的空 host；`loadRealNativeAddon` throw；所有权限请求返回 `{ok:false,reason:UNAVAILABLE}`；`isOfficialCuaPluginEnabledForWorkspace` 恒 false；`isCuaLocalDevelopmentRuntime` 恒 false；`isScreenCaptureProbeSuccess` 恒 false。这些面**确实全部关闭**。
- **客户端 wire 面是活代码**：`broker.js` 的 `callBrokerMethod`/`sendBrokerRequest`/`probeHelperHealth` 是**功能完整**的 socket 客户端（真连接、真收发、字节级行缓冲、possibly_sent 语义），不是占位。`index.js` 的 `createComputerUseRuntime` **仅在未传 brokerSocketPath 时** fail-closed；一旦有 socketPath，`execute()` 真的下发变更类动作（click/type/key…）。
- **生产 fail-closed 的真实兜底在上游门控**：`node.ts:2273` `cuaPluginEnabled = isACodeCuaInternalFeatureEnabled(env) || isOfficialCuaPluginEnabledForWorkspace()`。已核实 `acode-cua-plugin` **不是 workspace 成员、不在 cli deps、不在 SEA official plugin assets**，故默认构建 `cuaPluginEnabled=false` → socket env 从不注入 → 活客户端无 socket 可用 → fail-closed 成立。**但**设 `ACODE_CUA_DEV_MODE=1` 或 `ACODE_CUA_PRODUCT_HELPER=1` 即激活活路径（设计上的 dev 旋钮）。结论：占位包**非「所有表面惰性」**，而是「服务端面惰性 + 客户端面活、靠外部门控关闭」。

## 6. 问题清单

**[P2] acode-cua「全表面 fail-closed」表述与实现不符** — `packages/acode-cua/broker.js:175-217`（callBrokerMethod）/ `index.js:61-127`（createComputerUseRuntime）
- 描述：文档称「每个导出/命令都拒绝执行」，实际客户端 wire 面是功能完整实现，fail-closed 依赖上游插件门控 + 缺省无 socketPath。
- 证据：broker.js 真 `createConnection`+收发；index.js 仅 `if(!brokerSocketPath) return unavailable()`；生产关闭靠 `node.ts:2273` 的 `cuaPluginEnabled`（插件未打包）。
- 建议：修正 package.json description 与 CONTRACT.md，明确「服务端/Helper 面惰性 + 客户端面由 workspace 插件启用门控」，避免「占位包全惰性」的误读导致有人以为设 dev env 也安全。
- 验收：文档不再宣称所有表面拒绝执行，新增一条测试断言「无 socketPath 时 execute 返回 isError、有 dev env 但插件未启用时 node.ts 不注入 socket」。

**[P2] formal-proof 是 managed 模块却零测试** — `packages/formal-proof/package.json`（无 test 脚本）/ 0 个 *.test.*
- 描述：managed 18 模块中唯一无测试入口者，`pnpm test`/CI 不覆盖其 model.ts（920 行证明模型）。
- 证据：`find packages/formal-proof -name '*.test.*'` = 0；package.json scripts 只有 dev/build/preview/typecheck/lint。
- 建议：补 `test` 脚本（`node --import tsx --test`）与 model.ts 核心不变量测试，或显式登记为「模型无运行时行为、仅类型/编译验证」的例外并在 spec 说明。
- 验收：`pnpm --filter @acode/formal-proof test` 可跑，或例外登记入 architecture-coverage.md。

**[P3] 12 处 unlisted 依赖不在 knip:gate 范围** — `packages/server/src/harness/translate.ts:24`（zod）、`apps/acode-cli/packages/core/.../deferred-tool-call.ts:14`（zod）、`apps/acode-cli/packages/node-repl-host/src/cua-bridge.ts:5`（@modelcontextprotocol/sdk/types.js）
- 描述：源码 import 但包未声明，靠 pnpm hoisting 解析，hoist 布局变化即断。
- 证据：核实三包均未声明对应依赖；knip full 报 unlisted（12），但 `knip:gate --include files,dependencies,devDependencies,binaries` 不含 unlisted 类别故 exit 0。
- 建议：给 server/core/node-repl-host 补声明对应 devDependencies（多为 type-only），或将 unlisted 纳入 gate 的 `--include`。
- 验收：补声明后 `pnpm knip` unlisted 计数下降，gate 仍 exit 0。

**[P3] legacy 文件数增长稀释治理覆盖率** — `architecture:check` 输出 legacy 4242 文件（历史复核 3463，+779）
- 描述：ui/web/desktop/services/acode-cli 五根持续吸纳新代码却未纳管，managed 覆盖率（854/5096≈17%）被摊薄。
- 证据：两轮 architecture:report 的 legacy 文件计数差；resolver 三缺口仅 acode-cua 扁平包已闭，通配/asset 仍缺。
- 建议：按历史定价推进 ui/web/desktop 纳管前置的 resolver 通配入口支持，优先纳管增量最快的根。
- 验收：下一轮复核 legacy 文件数下降或 managed 模块数 >18。

**[P3] knip 2 条 configuration hints 未清理** — `knip.jsonc`（`**/.acode/**` ignore、`yauzl` desktop ignoreDependencies）
- 描述：knip 建议移除，当前为无害提示。
- 建议：核实 `.acode/**` 是否仍会落进树（运行时产物）、desktop yauzl 是否仍被外置，清理失效条目。
- 验收：hints 归零或确认保留理由写入注释。

## 7. 历史问题回归核对（ARCH-01..06）

| 编号 | 历史状态 | 当前 1.0.3 核实 |
|---|---|---|
| **ARCH-01** | 已修复（校验迁移清零） | **保持**：rpc managed、公开入口 contract.ts+index.ts、40 descriptor 机械门禁在；architecture:check rpc 无违规。 |
| **ARCH-02** | 已修复（SSH 主机密钥），Win smoke PASS | **保持**：server managed、remote/* 显式登记入口；macOS/Linux 真实 GUI 矩阵仍待真实环境（非本只读 review 可验）。 |
| **ARCH-03** | 已修复（CI 覆盖 CLI+Renderer） | **保持**：ci.yml 有 typecheck（三阶段单一入口）、Lint CLI workspace、Tests all packages 步；实跑 typecheck 三阶段全 done。 |
| **ARCH-04** | 大幅推进（managed 5→18） | **保持 18 模块 / 854 文件**（历史 776，+78）；剩余 ui/web/desktop/services/acode-cli 未纳管，resolver 通配/asset 缺口仍在（见 §3）。 |
| **ARCH-05** | 已修复（包名+别名解析） | **保持**：acode-cua aliasRules 12 条生效，context 显示 12 公开入口全部解析；`@/*` alias 进发现结果。 |
| **ARCH-06** | 已修复（ratchet 复长检测） | **保持**：architecture-ratchet.md 契约明确物理行口径；实跑 regrown after ratchet = 0，baseline 412 未刷掩盖。 |

**净变化**：baseline 415→**412**（-3，ratchet 兑现）；managed 文件 776→**854**（+78）；legacy 文件 3463→**4242**（+779，治理覆盖率被摊薄，见 P3）。六项历史问题**无一回归**，ARCH-04 的剩余纳管仍是唯一开放的大项。

## 8. 修复入口建议

打开 `packages/acode-cua/CONTRACT.md`，把「全表面 fail-closed」改成「服务端面惰性 + 客户端面由插件启用门控」（2 分钟）——这是本次唯一需要纠偏的表述性风险。
