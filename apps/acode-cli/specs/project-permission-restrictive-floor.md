# 项目级 permission 只能收紧不能放宽（restrictive floor）

安全加固 P1-6。定义仓库携带的项目配置对权限的影响边界：项目来源的 `permission` **只能收紧、不能放宽**。

## 背景

仓库携带的项目配置（`acode.json` / `.acode/config.json`）此前被无条件合并，其中：

- `permission.allowedTools` 命中 `packages/.../core/src/permission/service.ts` 的 `this.config.allowedTools.has(toolName)`，**按裸工具名整体放行**，绕过 build 模式的审批弹窗；
- `permission.autoApproveHighRisk` / `allowMediumRiskInAuto` 放宽高风险动作的审批；
- `permission.mode: "yolo"` 把会话直接抬到全权限档。

克隆一个恶意仓库即可静默预放行 Bash/Write/Edit。最有力的证据是**不对称**：同一份配置文件里的 `hooks` 走了完整信任门（`config_project_hooks_pending_trust`、bundleDigest、review flow），唯独更危险的 `permission` 不经任何信任确认即生效——即「明知仓库配置要门控，却独漏了 permission」。

## 产品规则

- **项目配置只能收紧、不能放宽**。放宽类字段（`allowedTools`、`autoApproveHighRisk`、`allowMediumRiskInAuto`、`mode`）在项目来源被**剥离**；收紧类字段（`disallowedTools`）**保留**——剥离它会削弱安全（用户明确禁用的工具又活了）。
- 剥离时发出 `config_project_permission_restricted` 诊断（warning），消息列出被忽略的键名，让用户知道仓库携带的权限放宽未生效。
- 全部 permission 字段都是放宽类时，`permission` 键整体移除（不留空对象参与合并）。
- 与 permission 无关的项目配置（`ui`、`storage`…）不受影响。`mcp` 当时同样不受本规则
  影响，但项目作用域的 **stdio 型** MCP server 已另行纳入信任门（默认 untrusted、不自动
  spawn，见 `specs/project-mcp-trust-gate.md`）——仓库携带的可执行进程声明与 hooks 同级
  门控，不再属于「不受影响」清单。

## 为什么用「restrictive floor」而不是接进 hooks 信任管线

把项目 permission 接进 hooks 的 digest 信任管线（`workspace-hook-trust-*`）在语义上并不贴合：那条管线是**逐条声明 + bundleDigest + review item** 的模型，为「仓库携带的可执行 hook 代码」设计；permission 规则是纯数据、无 digest、无执行副作用。硬塞进去需要造一套 permission 专用的 review item，成本高且与既有 review UX 混淆。

「只能收紧」这条规则用一个同步纯函数就能表达，不需要异步信任状态，且与 Claude Code `policySettings` / Codex `requirements.toml` 的**同一哲学**（低层只能收紧、不能放松）一致。将来若要做完整的托管策略地板（P2），本规则天然是它的一个特例。

## 状态所有者与写入路径

- **唯一收敛点**：`apps/acode-cli/packages/adapters/src/config/project-config.adapter.ts` 的 `normalizeProjectConfig`（剥离）与 `loadProjectConfigFile`（诊断）。与 hooks 的剥离同一函数、同一时机，保证「项目配置进入可执行 RuntimeConfigPatch 之前」这个边界只有一个。
- **诊断 code**：`config_project_permission_restricted`（`config/schema.ts` 的 `ConfigDiagnosticCode` 联合），在 `config-factory.ts` 的两个 resolver（log message / log event）里都有分支。

## 不影响用户自己的授权

用户在会话里点「Always allow in this project」写入的是 **session store 的 projectRules**，经 `permission/service.ts` 的 `matchesProjectRules` 路径生效；仓库携带的是 **`config.allowedTools`**，经 `this.config.allowedTools.has()` 路径生效。两条来源不同，本规则只剥离后者，前者照常工作。

## 接口

`normalizeProjectConfig(config, baseDir)` 与 `loadProjectConfigFile(path, options)` 签名不变；新增模块内私有 `restrictProjectPermission(permission) -> { retained, stripped }`。

## 验收场景

见 `apps/acode-cli/tests/project-permission-restriction.test.mjs`（仅用 mkdtemp 临时 fixture 仓库，不触碰真实工作区）：

1. 项目 `allowedTools` / `autoApproveHighRisk` / `allowMediumRiskInAuto` / `mode` 被剥离；全为放宽字段时 `permission` 键整体消失。
2. 项目 `disallowedTools` **保留**（收紧必须存活）。
3. 剥离时发出 `config_project_permission_restricted` 诊断（warning），消息含被忽略的键名。
4. 经 `loadProjectConfigs`（工作目录发现，含 `.acode/config.json` 嵌套形态）同样剥离并上报诊断。
5. 与 permission 无关的项目配置（如 `ui.theme`）不受影响。
6. 新诊断 code 在 `config-factory.ts` 的 message 与 event 两个 resolver 里都有分支（防止落到「文件加载失败」兜底而误报性质）。
