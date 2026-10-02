# Spec：插件 git 源 commit 固定与 host 白名单（安全加固 P2 #8）

## 背景与威胁

- zip 源已强制 sha256（`readRequiredZipPluginSourceSha256`），但仓库型源（github / git /
  git-subdir / url:git）此前只有「可选的」锚定：
  - git clone 走 `--depth 1` 浮动 branch/HEAD，仅当清单写了 `sha`（或兼容写法 `commit`）
    才 checkout 固定 commit；
  - GitHub Archive 快路径用 `zipball/<pin>`，pin 缺省时是 **HEAD**，branch ref 每次下载
    内容可变；
  - git fallback **无 host 白名单**：`git clone` 可以指向任意主机（含任意 gitlab/自建/
    内网地址），只有 Archive 快路径限 github.com。
- 威胁模型：
  1. **清单投毒/仓库劫持**：浮动 ref 的插件源在市场清单被篡改或上游仓库被投毒后，
     用户每次「安装/更新」都会拉到新的任意代码且无法审计、无法复现；
  2. **任意 git fetch oracle**：恶意清单可让 Agent Host 向任意主机发起 git clone
     （内网探测、SSRF、把带凭据的 git helper 指向攻击者主机）。

## 需求（plan 原文）

> 8. **插件 git 源 commit 固定**（`apps/acode-cli/packages/adapters/src/plugins/marketplace.ts:1410-1424`）：
>    zip 源已强制 sha256（好），但 git 源仍 `--depth 1` clone 浮动 branch/HEAD、仅
>    `if(sha)` 才 checkout、git fallback 无 host 白名单（只有 archive 快路径限 github.com）。
>    要求 git 源 commit 固定 + host 白名单。

## 行为规则

### 1. Commit 固定（pin）

判定函数 `resolvePluginRepositorySourcePinDecision`（`git-source-pinning.ts`，
纯函数，不跑 git）：

| 条件 | 决定 |
| --- | --- |
| `sha`/`commit` 字段非空（`readPluginSourceIdentityPin` 解析，含 zip sha256 兼容写法） | `install-pinned`（现状保留：clone 后 checkout 锚点） |
| `ref` 本身是 40 位 commit SHA | `install-pinned`（`git clone --branch <40hex>` 本就无法工作，按锚点处理） |
| 无锚点且 source 声明 `allowFloatingRef: true` | `install-floating`（显式 opt-in，行为同旧版） |
| 其余（浮动 branch/tag/缺省 HEAD） | `reject-floating`，拒绝安装并给可操作诊断 |

- **执行点**：`marketplace.ts#resolveRepositoryPluginSource` 入口的统一策略门
  （`throwIfRepositoryPluginSourcePolicyViolated`）。放在 Archive 快路径之前，因为
  浮动 ref 在 Archive 路径同样不安全（zipball/branch 每次下载内容可变）；该函数是
  `resolveGitPluginSource` 的唯一上游，覆盖全部仓库型插件源。
- **拒绝消息**面向清单作者：`add an immutable "sha" (or "commit") … or set
  "allowFloatingRef": true …`，经 `createPluginSourcePolicyError` 包成
  `plugin_marketplace_invalid` 诊断（URL 经 redact，无 userinfo 泄漏）。
- **校验期预警**：`validateMarketplaceEntryShape` 用同一纯判定，在浏览/校验阶段就产出
  error 诊断，商店详情页能提前说明「为什么装不了」；zip 源的 sha256 强校验保持原样。

### 2. Host 白名单（git fallback）

- 白名单常量 `PLUGIN_REPOSITORY_ALLOWED_HOSTS`（`github-archive-source.ts`，
  `github.com` / `www.github.com`）提升为**单一事实源**：Archive 快路径与 git fallback
  共用；扩展新 host 只改这一处并更新本 spec。
- `isPluginGitSourceHostAllowed(url)`（纯函数）：
  - 协议只允许 `https:` / `ssh:` / `git+https:` / `git+ssh:`；明文 `http:` 与未知协议拒绝
    （凭据与内容明文过网）；
  - host 归一小写后必须在白名单内；兼容 scp-like SSH 语法 `git@host:path`；
  - 解析失败一律不允许（fail closed）。
- **执行点**：与 pin 门同处 `resolveRepositoryPluginSource`。效果：`github` 简写源不受影响；
  `git`/`git-subdir`/`url:git` 源 host 不在白名单时在物化前被拒绝——非 GitHub 的 git 托管
  （gitlab 等）从「静默允许」变为「明确拒绝并提示改用 sha256 校验的 ZIP 源」。

### 3. 范围边界（诚实声明）

- **市场清单本身的 git 源**（用户 `plugin marketplace add <git-url>`，`cloneMarketplaceSource`
  / `resolveRepositoryMarketplaceSource`）**不在本次收紧范围**：市场清单跟踪上游 main 是
  合理默认，且清单内容要过 manifest 解析与来源守卫；pin 化市场清单需要「清单冻结+显式
  升级」的产品设计，作为后续项记录在 plan P2/P3 跟进。
- **marketplace 自身的 URL 快路径**（`parseMarketplaceSourceInput`）不变。

## 向后兼容取舍（关键决策）

- **默认拒绝浮动 ref 是有意为之（fail closed）**。理由：
  1. 仓库内调查：bundled/official 插件全部走 CDN zip（sha256 强校验）或 `filesystem`/`sea`
     指针，**不使用 git 浮动源**；仓库内没有任何 marketplace fixture 依赖浮动 git 源。
     受影响的是第三方市场的 git 源条目，而那正是威胁模型本身。
  2. 已安装插件的缓存不受影响（发现层直接用已落盘的 install root），只有新的
     安装/更新需要清单作者补 `sha` 或显式 opt-in。
  3. 直接「警告放行」会让投毒后的浮动清单继续静默分发任意新代码，等于不设防。
- **逃生门**：清单作者对单个 source 写 `"allowFloatingRef": true` 即恢复旧版浮动行为，
  语义是「我明确接受浮动 ref 的供应链风险」，不是默认降级；未来若需要用户级/企业策略
  强制关闭该逃生门，应挂在托管策略地板（P2 策略地板项），不在本 spec 扩展。
- 拒绝/白名单违规都是 `plugin_marketplace_invalid` + severity error：与既有
  「url source type 不支持」「zip sha256 非法」同形态，UI 既有错误呈现直接可用。

## 验收

- 纯判定函数（`apps/acode-cli/tests/plugin-git-source-pinning.test.mjs`，不真跑 git）：
  - sha/commit 存在 → `install-pinned`；40 位 hex ref → `install-pinned`；
  - 浮动 branch/HEAD 无 opt-in → `reject-floating` 且 reason 含修复指引；
  - `allowFloatingRef: true` → `install-floating`；非 true（字符串/缺省）→ 仍拒绝；
  - host 白名单：github.com（大小写/www/带路径）放行，gitlab/任意 IP/明文 http/无法解析
    → 拒绝；scp-like `git@github.com:owner/repo.git` 放行，`git@evil.com:...` 拒绝；
  - 组合判定：host 违规优先于 pin 缺失；zip 源形态不受影响（不进仓库源判定）。
- 安装链路接线（code review + 现有 plugin 流程不回归）：仓库型源在物化前被门拦截；
  github zipball/checkout 的既有 pinned 路径行为不变。
