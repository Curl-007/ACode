// ============================================================
// Tools Index - Core tool definitions
// ============================================================

// Re-export all tool types
export * from "./contract.js";
export * from "./json-schema.js";
export * from "./read.js";
export * from "./write.js";
export * from "./edit.js";
export * from "./apply-patch.js";
export * from "./bash.js";
export * from "./node-repl.js";
export * from "./glob.js";
export * from "./grep.js";
export * from "./webfetch.js";
// 对话内可视化（::visualize）的写入工具契约；技能门常量 VISUALIZE_SKILL_NAME 也在此。
export * from "./write-visualization-fragment.js";
// MCP 资源拉取工具的输出契约（specs/mcp-sampling-resources.md）。
export * from "./mcp-resources.js";
export * from "./agent.js";
export * from "./skill.js";
export * from "./todo.js";
export * from "./automation.js";
export * from "./off-peak.js";
export * from "./target.js";
export * from "./plan-mode.js";
export * from "./ask-user-question.js";
export * from "./send-message.js";
export * from "./respond-to-coordinator.js";
export * from "./task-output.js";
export * from "./task-stop.js";
export * from "./read-session-context.js";
export * from "./submit-result.js";
export * from "./websearch.js";
export * from "./workflow.js";
export * from "./create-workflow.js";
// 修订入口：名字常量被 core 的
// 分派、权限服务的 owner 规则、bootstrap 的 actor 禁用名单与 TUI/headless 旁路读走。
export * from "./amend-workflow.js";
export * from "./saved-workflow.js";
export * from "./save-workflow.js";
export * from "./list-saved-workflows.js";
// dwf 选型的发现面：名字常量被 core 的工具注册与
// bootstrap 的 actor 禁用名单读走，漏掉这行消费方拿不到 schema 与 LIST_MODELS_TOOL_NAME。
export * from "./list-models.js";
export * from "./eval-workflow-snippet.js";
export * from "./list-workflow-runs.js";
export * from "./get-workflow-run.js";
// 恢复入口与两个内省工具同族（run_id 键、端口探测失败同款）；漏掉这行消费方拿不到
// schema 与 RESUME_WORKFLOW_RUN_TOOL_NAME 常量，core 的扩名分派会静默失效。
export * from "./resume-workflow-run.js";
// 升级问答的两个工具面：actor 侧的 escalate 与主代理侧的
// ResolveWorkflowQuestion。名字常量被 core 的 allowlist 补回逻辑与 bootstrap 的 actor 禁用
// 名单读走，漏掉这两行会让那两处静默失效（照 resume-workflow-run 的同款注释）。
export * from "./escalate.js";
export * from "./resolve-workflow-question.js";
// 挖洞-填充的主代理侧（apps/acode-cli/specs/workflow-holes.md）：向停驻中的洞提交该处
// 函数体的语句。名字常量被 core 的工具注册/灰度门与 cli-workflow 的 actor 禁用名单
// 读走，漏掉这行会让那两处静默失效（照 resolve-workflow-question 的同款注释）。
export * from "./fill-workflow-hole.js";
// 跨会话全文搜索（K4）与开箱（K9）工具：名字常量与 schema 被 core 工具注册面读走，
// 漏掉这两行会让 handler 拿不到契约（照 escalate/resolve 的同款注释）。
export * from "./session-search.js";
export * from "./open.js";
// K6 Ambient 预算感知调度（specs/ambient-budget-scheduler.md R2）：Schedule 工具的
// schema 与名字常量。core 的 handler 工厂与 bootstrap 注册面读走；漏掉这行消费方
// 拿不到 SCHEDULE_TOOL_NAME 契约（照 session-search 的同款注释）。
export * from "./schedule.js";
export * from "./workflow-observation-display.js";
export * from "./tool-result-metadata.js";
export * from "./performance.js";
// 会话级 git worktree 生命周期三工具（specs/session-worktree-lifecycle.md）：
// EnterSessionWorktree / MergeBaseBranch / ReapSessionWorktrees 的名字常量、闭集
// reason 词表与写围栏 env 键（core 的 path-policy 与 adapters 的注入缝共同读取，
// 两包互不 import，键的单一事实源只能在这里）。漏掉这行 handler 拿不到契约。
export * from "./session-worktree.js";
// 回合收尾协议（apps/acode-cli/specs/turn-wrap-up.md）：TurnWrapUp 的 schema 与名字
// 常量（名字/上限的单一事实源在 shared v4，这里是 zod v3 producer 镜像）。core 的
// handler 与 turn 漏斗、TUI 的工具行分派读走；漏掉这行消费方拿不到契约。
export * from "./turn-wrap-up.js";
// 会话舰队七工具（apps/acode-cli/specs/session-fleet.md）：StartSession /
// SendToSession / ListSessions / HandOffToSession / SetSessionPermissionMode /
// ArchiveSession / DeleteSessions 的名字常量、schema、闭集 reason 词表与 note
// 截断单一事实源。core 的 fleet 模块与 handler、TUI 的工具行分派读走；漏掉这行
// 消费方拿不到契约（照 session-worktree 的同款注释）。
export * from "./session-fleet.js";
// 周期摘要（apps/acode-cli/specs/periodic-digest.md）：GenerateDigest 的分节/降级
// 警告闭集词汇唯一权威源。core/src/digest 模块与工具条目读走；漏掉这行
// generate-digest-tool.ts 报 TS2305（6 个词汇不解析）。
export * from "./digest.js";

// Shared types (only once to avoid duplicates)
export type { DiffHunk, GitDiff } from "./write.js";
