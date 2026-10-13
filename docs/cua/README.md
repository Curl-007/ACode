# CUA 设计文档索引（上游 ZCode 逐字移植）

本目录（`docs/cua/`）与同级 `docs/cua-permission-broker/` 收录从上游
[`zai-org/ZCode`](https://github.com/zai-org/ZCode)（Apache-2.0，`Copyright 2026 Z.AI Co., Ltd`）
**逐字复制**的 23 份 Computer Use 设计与规范文档。它们是 U14「Windows Computer Use producer
自建」的权威设计约束——上游已踩过的坑（WGC 视觉捕获、指针基础、原生剪贴板、能力真实性、
frame 像素缩放回归、AX 动作状态一致性、两阶段就绪时序）在此有第一手记录，供 ACode 侧
producer spec 直接参照，避免重新发明。

**本 README 是 ACode 原创索引，不属上游复制内容**，故不在
`third-party/copied-components.json` 的 `roots` 内、也不受其 Apache-2.0 归属约束。

## 出处与完整性

- 上游 revision：`aac4755666d09fdcd70272fcf063c077a639015f`（release v3.15.1）。
- 23 份文件字节级逐字复制，**未做任何内容修改**（含格式化）：
  `docs/cua/` 14 份 + `docs/cua-permission-broker/` 9 份。
- 完整性由上游 git blob 对象 ID 证明，经三条独立路径复核：staging manifest 的 sha256 列、
  `raw.githubusercontent.com` 全新抓取、以及 clone 的 git 对象存储直查。
- 许可登记见 `third-party/copied-components.json` 的 `ZCode CUA design documents` 条目；
  Apache-2.0 全文快照见 `third-party/upstream/606c36ba….txt`。
- 这些文件在 `.oxfmtrc.json` 中按**文件级**精确排除出 `oxfmt`（豁免范围严格等于这 23 份），
  以免格式化器改写上游字节、静默破坏已登记的哈希链。ACode 自己后续写进本目录的文档**不受**该豁免。

## 阅读本批文档时必须知的 ACode 偏离

上游文档以 ZCode / macOS 为语境撰写。**下列偏离使部分字面描述在 ACode Windows 线上不成立**；
凡与本仓当前源码或 ACode 侧 spec 冲突处，一律以后者为准。

| 上游字面                                                                                                            | ACode 现状                                                                                                                          | 依据                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ZCODE_CUA_PERMISSION_BROKER_SOCKET`                                                                                | `ACODE_CUA_PERMISSION_BROKER_SOCKET`                                                                                                | `packages/acode-cua/broker.js:6`                                              |
| `ZCODE_CUA_PERMISSION_BROKER_TOKEN`（bearer token）                                                                 | **语义已换**：`ACODE_CUA_PLUGIN_AUTHORITY`（config-provenance 随机数）。socket + authority **成对**才构成有效凭据组，不是单一 token | `packages/shared/src/runtimeEnv.ts:141`；`packages/services/src/node.ts:1173` |
| `~/.zcode/cli/config.json`、`~/.zcode/cli/log`                                                                      | `~/.acode/…`                                                                                                                        | 品牌前缀整体 ZCode→ACode                                                      |
| `apps/zcode-cli/packages/zcode-cua-plugin`（11 处引用）                                                             | **不存在**。ACode 无 plugin SDK 客户端包；其 `computer-use-client.mjs` 属角色 A 待移植资产                                          | U14 §7.3                                                                      |
| `packages/desktop/scripts/windows-cua-helper-assets.mjs` / `computer-use-producer.mjs` / `sharp-package-assets.mjs` | **不存在**，属阶段 5 打包资产                                                                                                       | U14 §7.5 阶段 5                                                               |
| bundle id `dev.zcode.cua-helper` 系                                                                                 | `dev.acode.cua-helper` / `dev.acode.cua-helper.dev`                                                                                 | `packages/acode-cua/broker-helper-constants.js`                               |

### macOS 专属机制：ACode Windows 线不适用

上游文档含大量 macOS TCC / LaunchServices / Accessibility / Screen Recording 语义
（TCC 27 处、LaunchServices 8 处、Accessibility 14 处、Screen Recording 13 处），
尤其 `cua-permission-broker/zcode-cua-permission-broker.md` 描述的 **peer-verification 设计**
（`SecCodeCheckValidity`、bundle id `dev.zcode.app` + Team-pin、`getpeereid` / `LOCAL_PEERPID`
进程树校验）是 macOS 签名 Helper 的准入链。

- ACode Windows producer（角色 A）走 **named pipe + socket/authority 凭据组**，不经 macOS 代码签名祖先门。
- 按 U14 **决策三**：保留 token（authority）鉴权，**peer-identity 迁移延后**——上游那套 macOS
  code-signing ancestry gate 不是 ACode Windows 线的落地目标，只作机制参考。
- macOS-only 的宿主面（`createProductCuaHelperHost` / `requestHelper*PermissionViaLaunchServices` /
  installer / `reapOrphanedHelpers` 等）在 ACode 保持 fail-closed，Windows 走已实现的
  `WindowsCuaHelperHost`（`packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts`）。

## 权威 ACode 侧 spec（行为冲突时以此为准）

上游文档是**设计约束与踩坑记录**，不是 ACode 的行为契约。ACode 侧 CUA 行为以下列为准：

- `packages/acode-cua/specs/broker-wire-protocol.md` — 链路乙 wire 契约（transport/framing、
  错误码映射、`CUA_NOT_READY` 信封、health 探测、14 方法表、delivery-state / `possibly_sent`）。
- `packages/acode-cua/specs/module-boundary.md` — 模块边界、不变量 1–4、角色 A/B 划分。
- `packages/acode-cua/CONTRACT.md` — 公开面与 fail-closed 现状。
- `docs/upgrades/product-and-support-2026-10.md` §7 — U14 六阶段计划与验收场景 C01–C15。

## 安全纪律（AGENTS.md / U14 §7.7，随文档一并生效）

- 截图与 UI 树内容按 `web-content-untrusted-discipline` 同等对待：不可信输入，不得当指令执行。
- `pluginAuthority`（原上游 token 位）是当前唯一敏感凭据，不得出现在 child argv、进程标题、
  日志、错误文本、telemetry 或可复制 UI 文本中。上游文档中「token 不落 argv / 不落日志」的
  纪律在 ACode 同样强制。
- 能力真实性优先于覆盖面：宁可少实现方法并显式报 `ACTION_UNAVAILABLE`，不得返回空结果冒充成功。

## 文件清单

### `docs/cua/`（14 份）

- `2026-08-18-ax-action-state-consistency.md` — AX 动作回执与按需观察契约
- `2026-08-18-frame-pixel-zoom-regression.md` — frame 像素缩放回归
- `2026-08-18-subagent-computer-use-unavailable-spec.md` — subagent 作用域 CUA 不可用
- `2026-08-19-cua-target-app-display-metadata-spec.md` — 目标应用显示元数据
- `2026-08-24-cua-node-repl-sdk-migration-spec.md` — node_repl SDK 迁移
- `2026-08-25-cua-authority-verdict-audit.md` — authority 判定审计
- `2026-08-25-cua-permission-error-passthrough.md` — 权限错误透传
- `2026-08-25-cua-request-access-onboarding-spec.md` — request_access 引导
- `2026-08-27-computer-use-unsupported-environment-ui-spec.md` — 不支持环境的 UI
- `2026-09-14-windows-cua-indicator-repair-spec.md` — Windows CUA 指示器修复
- `cua-pip-session-consumer-integration.md` — PiP 会话消费端集成
- `cua-tool-app-identity-summary.md` — 工具/应用身份汇总
- `windows-product-runtime.md` — Windows 产品运行时
- `windows-source-development.md` — Windows 源码开发运行手册

### `docs/cua-permission-broker/`（9 份）

- `2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md` — Helper 生命周期与 agent 运行时隔离
- `2026-09-21-cua-helper-lazy-startup-spec.md` — Helper 懒启动
- `cua-agent-recovery-admission-gate.md` — agent 恢复准入门
- `cua-dev-mcp-runtime-assets.md` — dev MCP 运行时资产
- `cua-helper-installation.md` — Helper 安装
- `cua-helper-permission-onboarding.md` — Helper 权限引导
- `local-dev-helper-runbook.md` — 本地 dev Helper 运行手册
- `windows-transport-ready.md` — Windows `transport_ready` 两阶段就绪
- `zcode-cua-permission-broker.md` — CUA permission broker 产品边界（含 macOS peer-verification，见上「不适用」）
