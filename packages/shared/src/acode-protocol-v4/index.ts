// ACode Protocol v4 —— 数据模型草稿。
//
// 本包纪律：只放 schema 类型 + 纯函数
// （coalesce/conflation/apply），运行时（通道层缓冲、订阅注册表、调度）一律不进本包。
// 与旧 packages/shared/src/acode-protocol 并存。
export * from "./core.js";
export * from "../background-bash-output.js";
export * from "./rows.js";
export * from "./toolDisplay.js";
// U11：工具图片的受授权附件引用（ref 形态）与其形态校验；toolDisplay.ts 单向依赖它。
export * from "./tool-media-ref.js";
export * from "./create-workflow-display.js";
export * from "./workflow-observation-display.js";
export * from "./snapshot.js";
export * from "./workflow-runs.js";
export * from "./workflow-runs-reducer.js";
// workflowRuns 的键级增量（diff / apply / 规范键序）；op 本身在 delta.js。
export * from "./workflow-runs-delta.js";
// 界留下的痕迹：被拒实例计数、条目预算、步数读法；表满时的腾位；以及给旧消费者的裁剪。
export * from "./workflow-runs-caps.js";
export * from "./workflow-runs-eviction.js";
export * from "./workflow-runs-tables.js";
export * from "./workflow-runs-legacy.js";
// swarm plan 的专用状态键族（编排方案 Phase 2；刻意不翻译进 dwf 词表，见文件头）。
export * from "./swarm-plan.js";
export * from "./workflow-artifact.js";
// ⚠ 与上一行只差一个 s，且两个 artifact 不同义：单数 = 引擎内部的「脚本顶层返回值」的
// 序列化；复数 = 脚本 `artifact.*` 发布给用户看的产出。见 workflow-artifacts.ts 的文件头。
export * from "./workflow-artifacts.js";
// 对话内可视化（::visualize）的分块读取契约。
export * from "./visualization-read.js";
// 运行时网络观测（agent 进程内）的 v4 词汇。
export * from "./network-capture.js";
// Overnight（K3）完成信号（agent 进程内 supervisor → host → main）的 v4 词汇。
export * from "./overnight-completion.js";
// 归档会话 header 冷读（legacy M1 前置件：给 UI 归档任务 header 兜底一条 v4 只读路径）。
export * from "./session-header-meta.js";
// M2-2 session 控制面：goalControl / closeSession 的 command result variants
// （specs/m2-2-session-control.md；command.ts 仅列引用，实体在本叶）。
export * from "./session-control.js";
// M2-4 inbound 交互面：六反向请求（permission/userInput announce + providerRuntimeHeaders/
// officialMcp/browser×2 真 RPC）与两条通知（CUA 事件 / 凭据取消）的 wire schema
// （specs/m2-4-inbound-interaction.md；transport.ts 仅登记方法名）。
export * from "./inbound-interaction.js";

// M2-7 定时任务 + Off-Peak 七法（inbound RPC）wire schema 叶
// （specs/m2-7-automation-offpeak.md；transport.ts 仅登记方法名）。
export * from "./automation-offpeak.js";
// 插件管理面（M2-5：plugins.js 域零件；plugins-queries.js 读六法 list/overview/describe/
// validate/referenceCatalog/resolveSuggestedReference；plugins-commands.js 写十法
// setEnabled/marketplace×3/install/uninstall/update/restoreBuiltin/configure/resetConfig；
// cancelOperation 保留 legacy 词，见 spec §4）。
export * from "./plugins.js";
export * from "./plugins-queries.js";
export * from "./plugins-commands.js";
// M2-6：已保存工作流 GUI 中枢（与 workflow-runs* 会话内执行面不同域）/ Skill 引用 catalog /
// MCP server 列表的 v4 query/command 面（specs/m2-6-workflows-skills-mcp.md）。
export * from "./workflows.js";
export * from "./skills.js";
// M2-3 session 读写面：read/resume/list/messages/events/subscribe 六 query params +
// runtimePreferences 推送载荷 + createSession 命令 parity 字段形状
// （specs/m2-3-session-readwrite.md）。
export * from "./session-readwrite.js";
export * from "./mcp.js";
// M2-8：workspace 运行时面（readPresentation / generateText / cancelGenerateText）/
// workspace 授权与策略同步面（hooks/trustGrant + update*×4）/ provider+process 域
// （updateAccountConfig / testModelConnectivity / childProcesses）的 v4 面
// （specs/m2-8-workspace-provider-process.md）。
export * from "./workspace-runtime.js";
export * from "./workspace-policies.js";
export * from "./provider-process.js";
// 工作区 transcript（files.* / git.* / world.run 的回放）。
export * from "./workflow-workspace.js";
export * from "./attachment-ref.js";
export * from "./attachment-faults.js";
export * from "./delta.js";
export * from "./coalesce.js";
export * from "./profiles.js";
export * from "./apply.js";
export * from "./transport.js";
export * from "./wire.js";
export * from "./wire-codec.js";
export * from "./wire-reassembly.js";
export * from "./wire-assembler.js";
export * from "./wire-fault.js";
export * from "./sessions-index.js";
export * from "./sessions-index-workflow-activity.js";
export * from "./workspace-config.js";
export * from "./command.js";
export * from "./workflow-run-settings-command.js";
// 脚本工作流管理面（apps/acode-cli/specs/script-workflow-management-surface.md §4）：
// listScriptWorkflowRuns / listScriptWorkflowDefinitions 两个只读查询的 payload/result。
export * from "./script-workflow-management.js";
export * from "./input-intent.js";
export * from "./submission.js";
export * from "./fork.js";
export * from "./telemetry.js";
export * from "./controller.js";
export * from "./workspace-hook-review.js";
export * from "./cuaPermission.js";
export * from "./capabilities.js";
// T1-c3 波 2（specs/protocol-attachment-typed-errors.md）：typed error 分层 / commandId
// 取代语义 / answers 代答申报 / 权限检查进度信号 / pending 提示清单判代 / 规则 where 三态。
export * from "./typed-call-error.js";
export * from "./command-redelivery.js";
export * from "./attach-answers.js";
export * from "./permission-check-status.js";
export * from "./pending-permission-hints.js";
export * from "./permission-rule-where.js";
// 回合收尾载荷（apps/acode-cli/specs/turn-wrap-up.md）：工具名/上限的单一事实源 +
// 客户端解析面。承载通道是 toolCall row 的 input（无 schema 透传），本文件不加 row kind。
export * from "./turn-wrap-up.js";

export {
  executionOutputPreviewSchema,
  type ExecutionOutputPreview,
} from "../execution-output-preview.js";

export { bashOutputDisplaySchema } from "../bash-output-display.js";
export { modelSelectionSchema, type ModelSelection } from "../model-selection.js";

export * from "../localTtft.js";
