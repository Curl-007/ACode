// workflow run 的**状态词汇组**：物理词表（受建表 CHECK 约束）、孤儿收敛写进 failure_json
// 的结构化 interrupted code、管理面逻辑态词表。2026-10-18 自 ./script.ts **纯移动**而来
// （script.ts 顶过 managed 模块 400 行硬上限）；导出面经 script.ts 原样再导出，消费方
// 经 @acode/contracts 的导入路径逐名不变（同 ./script-usage.js 先例）。
// physical→logical 的唯一**映射函数**仍在 cli-workflow 的 script-workflow-run-status.ts。

/**
 * `workflow_run.status` 的**物理**词汇——受建表 CHECK 约束，不迁移。
 *
 * ⚠ 这不是逻辑词汇。「宿主进程在 run 结算前退出」这件事**没有**自己的物理词，它落成
 * `cancelled` + `failure_json` 里的结构化 code（见 bootstrap 的 script-workflow-run-status.ts）。
 * 这与 dwf 逐字同构：`dwf_run.status` 的 CHECK 集同样不含 `stopped`，dwf 把逻辑态
 * `stopped{reason}` 编码成物理 `cancelled` + `{"stopReason": …}` 信封，映射只活在
 * `dwf-journal-codecs.ts` 一个文件里。
 *
 * 曾经试图往这里加一个 `interrupted`：CHECK 约束当场拒写（`CHECK constraint failed: status in`），
 * 而假 store 的单测撞不到它——只有对着真实库跑一遍才暴露。放宽约束要重建整张表
 * （三张表外键引用它），代价与风险都远大于按既有模式编码。
 */
export const SCRIPT_WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ScriptWorkflowRunStatus = (typeof SCRIPT_WORKFLOW_RUN_STATUSES)[number];

/**
 * 孤儿收敛写进 `failure_json` 的结构化 code（物理 `cancelled` 行靠它分辨「宿主进程没了」
 * 与「用户停的」）。这是一份**落库契约**，唯一定义在 contracts（存储读面要拿它在 SQL 层
 * 展开 interrupted 的物理表达），cli-workflow 的 script-workflow-run-status.ts（唯一映射
 * 函数所在）从这里引用同一个值；改它等于改落库数据，要连解码与 SQL 判据一起改。
 */
export const SCRIPT_WORKFLOW_INTERRUPTED_CODE = "ScriptWorkflowInterrupted";

/**
 * 管理面的**逻辑**状态词表 = 物理六词 + `interrupted`。
 *
 * `interrupted` 没有物理词（CHECK 约束不放行）：它 = `cancelled` 且 `failure_json.code`
 * 命中 {@link SCRIPT_WORKFLOW_INTERRUPTED_CODE}。physical→logical 的唯一映射函数在
 * cli-workflow 的 script-workflow-run-status.ts（`logicalScriptWorkflowStatus`）；存储读面
 * 的 `logicalStatuses` 过滤把这份映射展开成 SQL（json_extract 判据），两侧一致性由
 * 对真实 SQLite 的 store 测试逐行互钉。
 */
export type ScriptWorkflowLogicalRunStatus = ScriptWorkflowRunStatus | "interrupted";
