# Spec：插件市场安装事务化与管线硬化（omp 价值提取 T1#11）

## 背景

- 市场安装入口 `installMarketplacePlugin`（`apps/acode-cli/packages/adapters/src/plugins/marketplace.ts`）
  已有五类来源（github/git/git-subdir/sha-pin/zip-sha256）、浮动 ref fail-closed 门
  （specs/plugin-git-source-pinning.md）与 CDN 别名闭集
  （specs/plugin-official-marketplace-alias.md）。这些都是既有强项，本 spec 不回退。
- 缺口（oh-my-pi 价值提取台账 T1#11）：装前没有统一 validate 门；多插件 closure
  安装中途失败后目录级原子恢复存在、但注册表快照/跨目标整体回滚与 fail-loud 诊断
  不完整；没有 dry-run；市场 git 源规格（`plugin marketplace add <git-url>`）无 host
  白名单、无元字符黑名单、URL 内嵌凭据会随 source 原样落盘；MCP 声明只在运行时
  失效，安装期不校验。
- 机制参照（MIT，仅取语义）：oh-my-pi `docs/marketplace.md:137`（版本解析链）、
  `docs/plugin-manager-installer-plumbing.md:119/:127/:259-267`（安装期校验失败整体回滚、
  回滚矩阵、回滚失败追加报告）、`:82`（git 规格主机集合）、`:84`（凭据剥离）、
  `:240-241`（shell 元字符黑名单）。

## 产品规则

### R1 装前 validate 门（validate 失败即拒装，零副作用）

`validatePluginForInstall`（`install-validation.ts`）在插件源物化之后、目录激活之前执行。
**阻断项**（任一命中 → 安装失败，事务整体回滚）：

1. manifest 不可读/非 JSON 对象/name 非法（`plugin_manifest_invalid`）；
2. `strict !== false` 的条目落盘后找不到任何插件 manifest（`plugin_manifest_not_found`）；
3. manifest name 与目录条目 name 不一致（`plugin_manifest_invalid`）；
4. manifest 声明的 commands/agents/skills 路径（字符串/数组形式）逃逸插件根或不存在
   （`plugin_component_path_invalid`）；hooks 来源文件读取失败/路径逃逸
   （`plugin_hook_read_failed` / `plugin_component_path_invalid`）；
5. MCP 声明 schema 失败（`plugin_mcp_server_disabled`、`plugin_mcp_read_failed`、
   `plugin_mcp_invalid`、`plugin_component_path_invalid`）：stdio server 的 command
   在安装期必须可执行——含路径分隔符/绝对路径的按文件存在性校验，裸命令按 PATH
   解析（Windows 尊重 PATHEXT 常见可执行扩展）；缺失即阻断。含未解析
   `${...}` 模板的 command 跳过存在性校验（运行期值，不构成安装期事实）；
6. 版本解析链结果为空或不满足缓存路径安全形态
   `/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/` 且不含 `..`（`plugin_manifest_invalid`）。

**容忍项**（降级为 result.warnings / 校验诊断，不阻断）：运行期变量缺失
（`plugin_variable_missing`：user_config/env 在安装进程里不可解析属预期）、
unsupported component 类 warning、hook 不支持事件 warning、MCPB/DXT 声明 warning。
阻断/容忍的判定只看诊断码与 severity，不重复实现各检测器（单一事实源仍是
hook-sources/mcp/plugin-components 各自的检测逻辑）。

阻断错误以 `createPluginInstallValidationError`（`source-errors.ts`，诊断码
`plugin_manifest_invalid`）抛出，消息聚合全部阻断诊断，bootstrap 既有
`getPluginSourceDiagnosticCode` 映射直接可用。

### R2 版本解析链（catalog→plugin.json→package.json→SHA 前 7 位）

`resolvePluginInstallVersionChain` 是缓存目录版本段与安装记录 version 的唯一事实源，
优先级（ACode 语义 = 既有「manifest 优先」决策保持不变，补齐 omp 链的缺失环节）：

1. 落盘 plugin.json 的 `version`（`.acode-plugin` / `.claude-plugin` / `.codex-plugin` /
   `.cursor-plugin` 候选集，specs/plugin-foreign-manifest-compat.md）；
2. 插件根 `package.json` 的 `version`（新增环节，omp marketplace.md:137 同位）；
3. 目录条目 `version`；
4. 源身份锚点（sha/commit/zip sha256，`readPluginSourceIdentityPin`）前 7 位（新增环节）；
5. 兜底 `0.0.0`（不变）。

R1-6 的安全形态校验作用于链的最终结果。catalog 与 manifest 同时声明且不一致时
不阻断（omp 语义：按链取优先者），但产生 warning。

### R3 安装事务（快照→任一阶段失败整体回滚→回滚失败 fail-loud）

`MarketplaceInstallTransaction`（`install-transaction.ts`）覆盖一次
`installMarketplacePlugin` 调用触及的全部持久化状态：

- **快照内容**：`installed_plugins.json` 原始文本（缺失记 null）在事务开始时快照；
  每个插件缓存目标目录在**首次触碰前**（激活前）快照「存在性 + 有界内容清单
  （相对路径，上限 4000 项/深度 8，超限记 truncated）」。目标目录只有激活瞬间才
  会变化，因此逐目标触碰前快照等价于「安装开始前快照将被触及的状态」。
- **回滚语义**（对应 omp 回滚矩阵 :259-267）：下载/校验/解包/落位任一阶段失败 →
  先执行既有目录级 activation rollback（恢复 backup），再由事务层：
  1. 把 `installed_plugins.json` 恢复为快照原文（原缺失则删除该文件）；
  2. 逐目标核对快照（存在性 + 清单），能修复的当场修复（快照不存在而现状存在 →
     删除）；content 级恢复仍依赖 activation backup，backup 恢复失败时在状态文件
     里登记 backup 路径供人工恢复；
  3. 任一步失败或核对不匹配 → 在 `<storageRoot>/.install-transactions/failed-<txid>.json`
     落一份可诊断状态文件（事务 id、阶段、pluginId、原始错误、逐项回滚错误、
     快照摘要、backup 路径），并把回滚失败追加进抛出的错误消息（omp
     「rollback failure is appended to the reported error」语义）；回滚完全成功时不留
     状态文件，原始错误追加「rolled back」说明后照常抛出。
- 事务结束（成功）→ `finalize`：仅清理内存态，不删 activation 既有 backup 语义。
- 卸载（`uninstallMarketplacePlugin`）不在本 spec 范围（登记为后续项）。

### R4 dry-run（全部校验 + 计划生成，零持久化写盘）

`installMarketplacePlugin({ dryRun: true })`：

- 目录获取走只读路径：磁盘已有 catalog 直接读；缺失时按 known record source 以
  `persist:false` 拉取（含官方别名 canonical 归一），失败即报错——绝不触发
  `ensureDefaultPluginMarketplaces`/`addMarketplace` 的落盘分支；
- 插件源物化到 OS 临时目录（finally 清理），全部 R1 校验与版本链照常执行；
- 不创建/替换缓存目录、不写 `installed_plugins.json`、不产生事务状态文件；
  storageRoot 前后文件树逐字节一致；
- 返回 `{ closure, installed: [], plan }`：plan 逐条列出 pluginId、动作
  （install/replace）、当前与计划版本、计划缓存目录、非阻断校验诊断。真实安装
  走同一计划代码路径（先计划后执行），不产生平行实现。

### R5 来源规格硬化（git URL 规格）

1. **市场 git 源 host 白名单**（omp :82 主机集合）：`parseMarketplaceSourceInput` 与
   `resolveRepositoryMarketplaceSource`（github/git 两类市场源的统一物化上游）对
   git URL 规格执行 `MARKETPLACE_GIT_SPEC_ALLOWED_HOSTS` =
   {github.com, www.github.com, gitlab.com, bitbucket.org, codeberg.org, git.sr.ht}；
   协议沿用插件门的白名单（https/ssh/git+https/git+ssh，明文 http 拒绝）。
   **范围边界**：插件源门（`git-source-pinning.ts`）保持 github-only **不放宽**——
   市场清单是用户显式添加的个人来源，插件代码源是不可信目录内容，两道门宽严
   有别是有意分层（specs/plugin-git-source-pinning.md §3 的既有边界在本 spec 收口）。
2. **URL 内嵌凭据剥离**（omp :84）：`user:token@host` 形式的 URL 在**落任何持久化
   文件之前**剥离 userinfo 并告警。执行点（全部收口在
   `source-spec-hardening.ts#stripPluginSourceCredentials`，深遍历 source 形态值，
   幂等）：市场目录条目 `source.url`（normalize 层，含随 manifest.raw 落盘的
   marketplaces/<id>/marketplace.json 副本）、`addMarketplace` 输入 source（落
   known_marketplaces.json 前）、安装记录 source（落 installed_plugins.json 前）。
   剥离后私有仓库认证依赖 git credential helper / SSH（omp 同语义）。告警面：
   `PluginMarketplaceManifest.credentialRedactions`（normalize 层收集）→ 校验诊断
   warning 与安装 result.warnings；`KnownMarketplaceRecord.credentialRedaction`
   （addMarketplace 收集）随记录持久化。
3. **shell 元字符黑名单**（omp :240-241 git 规格集）：`;` `&` `|` 反引号 `` ` `` `$`
   `(` `)` `{` `}` `<` `>` `\` 与空白符（含换行/CR/tab）出现在**将要进入
   spawn/git 调用的值**（仓库型插件源的 url/ref、市场 git 源的 url/ref）即拒绝。
   `execFile` 参数数组本不走 shell，黑名单是纵深防御（防后续实现改 shell 形态、
   防 git 参数注入）。zip/url 型 HTTP 源 URL 只过凭据剥离不过元字符门（不进 spawn）。

### R6 既有强项不回退

浮动 ref fail-closed 门、zip sha256 强校验、CDN 别名闭集、官方 CDN 分片、
archive 快路径与 git fallback 的既有行为全部保持；本 spec 只在其上叠加。

## 状态与所有权

- 事务状态唯一所有者：`MarketplaceInstallTransaction`（进程内对象 + 磁盘快照）。
- `installed_plugins.json` / 缓存目录的所有权不变（marketplace.ts 写路径唯一），
  事务层只读快照、失败时恢复，不引入第二条写路径。
- 新模块分层：`source-spec-hardening.ts` / `install-validation.ts` 为纯判定+本地 IO
  助手（不触网络）；`install-transaction.ts` 执行文件系统副作用；`marketplace.ts`
  是编排者。依赖方向 marketplace.ts → 三者 → helpers/hook-sources/mcp，
  无反向依赖、无循环。

## 失败语义

| 阶段 | 失败行为 | 回滚 |
| --- | --- | --- |
| 目录获取（dry-run 只读拉取） | 报错终止 | 无状态变化 |
| 源物化（clone/archive/zip） | 报错终止 | 临时目录清理；无状态变化 |
| validate 门阻断 | 报错终止（聚合诊断） | 无状态变化（未激活） |
| 缓存目录激活（单插件） | activation 自身恢复 | 既有 backup rename 语义 |
| closure 后续插件失败 | 整体失败 | 已激活目标 activation rollback + 事务层核对修复 + 注册表恢复 |
| 注册表写入失败 | 整体失败 | 同上（注册表恢复为快照原文） |
| 回滚自身失败 | fail-loud | 落 `.install-transactions/failed-<txid>.json`，错误消息含状态文件路径与 backup 线索 |

## 验收

`apps/acode-cli/tests/plugin-install-transactions.test.mjs`：

- 回滚：closure 前一插件激活成功、后一插件下载失败 → 前者缓存目录消失、
  installed_plugins.json 内容逐字节复原、storageRoot 树前后一致；
- 注册表恢复单元：事务 begin→改写→rollback → 快照原文复原；回滚失败
  （注册表路径被替换为目录）→ 状态文件生成且错误消息含路径；
- 凭据剥离：带 `user:token@host` 的目录市场 persist 后，marketplace.json /
  known 记录 / parse 输出均无 token，且出现 credentialRedaction 告警；
- 元字符黑名单：ref/url 携带 `;` `|` `` ` `` `$` 等被纯判定拒绝，
  `parseMarketplaceSourceInput` 对带元字符的 git 规格抛错；
- host 白名单：市场 git 规格指向 gitlab/codeberg 等放行（纯判定），
  非白名单主机拒绝；github 简写不受影响；
- dry-run 零副作用：前后 storageRoot 文件树一致、plan 条目与真实安装结果一致、
  随后真实安装成功；
- validate 失败零副作用：manifest 缺失 / 声明路径缺失 / MCP command 缺失 /
  版本不安全 → 拒装且树前后一致；
- 版本链：plugin.json 优先、package.json 兜底、sha 前 7 位兜底；
- 既有 `plugin-git-source-pinning.test.mjs`（sha 锚定门 + github-only 插件源白名单）、
  `plugin-official-marketplace-alias.test.mjs`（别名闭集）不回归。

## 边界与已知限制（诚实声明）

- CLI/协议层的 `--dry-run` 旗标接线在 bootstrap/core（非本变更所有权），本变更
  只交付 adapters 公共入口的 `dryRun` 能力；上层接线另行立项。
- MCP 可执行校验只覆盖 command 字段；args 中的脚本路径（如
  `${ACODE_PLUGIN_ROOT}/dist/server.js`）不校验（无法区分「运行期生成」与「缺失」，
  误报风险大于收益）。
- 版本链引入 package.json/sha7 兜底后，无版本、有锚点的插件其缓存路径从
  `0.0.0` 变为 `<sha7>`：一次性迁移成本（旧目录由官方缓存清理机制回收），换
  版本键控缓存的正确性。
- 凭据剥离是对「目录作者写错」的防线；剥离后需要凭据的私有 git 源必须改用
  credential helper / SSH（有意行为，与 omp 一致）。
- 市场级 dry-run 在 catalog 不在磁盘时仍需网络拉取（只读），与其他代理并发运行
  时靠既有 per-storageRoot 语义隔离，事务不提供跨进程锁（与现状一致）。
