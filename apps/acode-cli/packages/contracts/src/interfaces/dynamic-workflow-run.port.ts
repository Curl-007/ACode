// ============================================================
// Dynamic Workflow Run Port - dwf 引擎 run 的提交 / 观察 / 取消边界
// ============================================================
// 拆分说明（批次 B 例外债务偿还）：原文件 1068 行，超 architecture-policy 的
// max-file-lines（400）。按读写面拆出四个叶子，本文件保留 run 快照、Port 接口本体与
// 全部既有 `export type *` 原样再导出；消费方导入路径不变：
//   - dwf-run-submit.port.ts：提交 / 修改 / 取消的请求-结果类型；
//   - dwf-run-artifact.port.ts：用户面产物与待答问题类型；
//   - dwf-run-event.port.ts：事件日志分页 / 载荷限界 / serializeWorkflowArtifact 再导出；
//   - dwf-run-view.port.ts：run 内省（列表 / 详情 / 恢复）视图类型。


// 架构断环（specs/architecture-contracts-module.md）：结构化失败类型下沉到叶子文件
// dynamic-workflow-run-error.port.ts——workspace 文件引用 DynamicWorkflowRunError，
// 本文件又 `export type * from` workspace 文件，定义若留在本文件即成两文件级 import 环。
// 此处 import 供 run 快照使用 + 原样再导出，`@acode/contracts` 的导入路径与导出面不变。
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run-error.port.js";
import type {
  DynamicWorkflowRunProgressPayload,
} from "../events/session.events.js";
import type {
  WorkflowTaskSnapshot,
} from "./workflow.port.js";
import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "./dynamic-workflow-run-retune.port.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "./dynamic-workflow-run-workspace.port.js";
// 挖洞-填充（specs/workflow-holes.md）的请求/结果类型住在叶子文件
// dynamic-workflow-fill-hole.port.ts（max-file-lines 拆分先例）。此处 import 供 fillHole
// 端口成员使用；停驻洞类型 DynamicWorkflowRunPendingHole 已随详情页类型移入
// dwf-run-view.port.ts。下方原样再导出，导入路径不变。
import type {
  DynamicWorkflowFillHoleRequest,
  DynamicWorkflowFillHoleResult,
} from "./dynamic-workflow-fill-hole.port.js";
export type * from "./dynamic-workflow-fill-hole.port.js";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowResolveQuestionResult,
} from "./dwf-run-artifact.port.js";
import type {
  DynamicWorkflowRunWaitOptions,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEvent,
} from "./dwf-run-event.port.js";
import type {
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitOptions,
  DynamicWorkflowRunSubmitResult,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
} from "./dwf-run-submit.port.js";
import type {
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSessionSummary,
} from "./dwf-run-view.port.js";

/**
 * run 快照：沿用 {@link WorkflowTaskSnapshot} 的形状（后台任务追踪器与通知管线按它读），
 * 只把 `output` 放宽——workflow run 的产物是脚本的顶层返回值，形状由脚本决定，不是 legacy
 * `Workflow` 工具的输出类型。legacy 端口本身不加宽（两套 workflow 机制不共用端口）。
 *
 * `reports` 是脚本 `report(item)` 交出的渐进产物**原值**，按报告顺序，来自 journal 的
 * `kind = "report"` 节点行——那是这些条目的持久家（`workflowRuns.reports` 只是有界的
 * memory-only 展示面）。完成通知据此在 completed / failed / cancelled 三态下一律回投：
 * 一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是 `report` 存在的理由。
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * run 的真实终态词。基类的 `status` 是后台任务
   * 追踪器的通用词汇（`stopped` 折成 `cancelled`、`errored` 折成 `failed`），通知与工具文案
   * 要说真话必须读这两个字段；`stopReason` 只在 `runStatus === "stopped"` 时在场。
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** 发起这个 run 的会话（journal 的 parent_session_id；注册表条目在场时取它的）。 */
  parentSessionId?: string;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /**
   * 本 run 自己的并发上界（`dwf_run.caps_max_concurrency`），**只在低于当前天花板时在场**：
   * 跑在天花板上的 run 没有可说的（「无则缺席」，与 `reports` 同规）。`AmendWorkflow` 的
   * `resolveInput` 据它决定省略 `max_concurrency` 时沿用什么。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型（journal 事件 `run-launched` 上的那一个），规范形
   * `providerId/modelId[$reasoningLevel]`，**只在设过时在场**：继承会话模型的 run 没有可说的
   * （「无则缺席」，与 `maxConcurrency` 同规）。
   * 这里是字符串而不是 {@link ModelSelection}：读面只用来显示与原样回填，没有人按字段取值。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本文件（绝对路径，journal 事件 `run-launched` 上的那一个）。**只在这个 run 记下过文件时在场**。
   *
   * 终态通知据它把「改好脚本再内联提交」换成「就地编辑那个文件、再 `path` 修订」，所以它必须
   * 能从快照读到；用户面一概不显示（与 `subagentModel` 不同，后者会进桌面的 run 面板）。
   */
  scriptPath?: string;
  /** 结构化失败（与 {@link DynamicWorkflowRunDetail.error} 同源）；基类的 `error` 是它的 message。 */
  failure?: DynamicWorkflowRunError;
  /**
   * 本 run 及其 lineage 的**活动**时长（毫秒）：本 run 的每一世加上每个前驱的每一世，世与世
   * 之间的空档不计。完成卡的「时间」格报的就是它。
   *
   * 与 `reports` / `artifacts` 同规**只在终态在场**（`getTask` 被反复轮询，而消费者只有终态
   * 通知），且 journal 说不出话时整字段缺席——不是 0。缺席即读侧退回 `completedAt − startedAt`：
   * 那是结算它的那个进程自己看到的一世，一个更保守但永不虚报的答案。
   */
  activeDurationMs?: number;
  reports?: readonly unknown[];
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * **从内存注册表投影，不是 journal 重放**：journal 里有 `escalation-raised` 与
   * `escalation-resolved` 两类事件，但「现在还欠谁一个答案」是进程内的活事实——重放出来的
   * 未配对 raised 在进程亡故后只会说谎（停驻的 deferred 早已随进程消失，resume 会让 actor
   * 重新提问、得新 qid）。
   *
   * 这是通知被丢弃（stale branch generation / shutdown drop）之后的**查询兜底**：主代理任何
   * 时候都能经既有观察面重新发现待答问题。零条时整字段缺席（不发空数组）。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 发布的**用户面产物**，按首次出现顺序，来自
   * journal 的 `kind = "artifact"` 行——那是版本历史的持久家（`workflowRuns.artifacts` 只带
   * 最新版元数据）。与 `reports` 同规：**只在终态**读（`getTask` 被反复轮询，而产物行的
   * 消费者是终态通知与 GetWorkflowRun）；零件时整字段缺席。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与本类型的 `output`
   * （脚本顶层返回值，引擎内部叫 `RunSettlement.artifact`）无关。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * workflow run 的窄端口。与 legacy {@link import("./workflow.port.js").WorkflowPort} 并列而非
 * 合并：后者服务 `Workflow` 工具与 `workflow_*` 旧表，共用一个端口等于在接口层把
 * 「独立于既有 workflow 机制」这条边界重新耦合回去。
 *
 * 取消没有专属 RPC：详情页按钮与后台面板的停止共用既有的 v4 `cancelBackgroundWork`
 * 命令，它落到这里的 {@link cancel}（runId ≡ workId）。
 */
export interface DynamicWorkflowRunPort {
  /** 编译一次并启动引擎；返回 runId（即 backgroundTaskId）。 */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * 修订一个 run：预检前驱 → 铸新 id → 前驱在飞则以 `{ superseded: newRunId }` 取消并等它结算
   * → 从前驱导入缓存 → 启动新 run（见 {@link DynamicWorkflowRunAmendRequest}）。预检被拒即
   * 结构化失败且**什么都没动**。老宿主可能没有这个方法（可选成员）：工具层按能力探测归一成
   * 「本会话不支持修订」。
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * run 自己并发上界的天花板（`max(1, min(16, availableParallelism() − 2))`，每进程一个值）。同步、无副作用。
   *
   * 工具层的两个读者：`CreateWorkflow` / `AmendWorkflow` 的 `resolveInput` 把模型给的
   * `max_concurrency` 钳到它之下（确认窗显示的必须是将要生效的值），`GetWorkflowRun` 据它决定
   * 一个 run 的上界是否值得一提。**可选成员**（消费方 `typeof` 探测）：端口 stub 不必为它陪跑，
   * 缺席时工具层不钳、原样下传（端口实现自己还会钳一次）。
   */
  concurrencyCeiling?(): number;
  /**
   * 就地改一个**在飞** run 自己的并发上界：同一个 runId、不铸后继、不 supersede、不导入缓存、在飞 ask 一个不丢。
   *
   * 与 {@link amend} 并列而非合并：修订换的是**脚本**，代价是停下前驱、铸新 run、从缓存重放；
   * 而「只把这个 run 调慢一点」不该付那笔账。两个调用方（`AmendWorkflow` 的 handler 与 GUI 的
   * `amendWorkflowRunSettings`）读同一个答案，于是「什么算一次 retune」只有一个定义。
   *
   * 三件事在一个同步片里发生或者一件都不发生：换引擎的 caps（调度器现读）、写
   * `dwf_run.caps_max_concurrency`（resume 因此续在新上界上）、记一条 `run-caps-changed`。
   * 服务另把自己那份内存上界一并挪动，于是快照、详情与 `GetWorkflowRun` 立刻报新值。
   *
   * **可选成员**（消费方 `typeof` 探测），理由同 {@link resume}：端口 stub 不必为一条控制面全员
   * 陪跑，而「端口缺席」与「方法缺席」对调用方是同一个业务事实——回落到一次真正的修订。
   */
  retuneConcurrency?(
    request: DynamicWorkflowRunRetuneRequest,
  ): Promise<DynamicWorkflowRunRetuneResult>;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * 停下一个 run：中止在飞 ask 并 kill 子进程，run 结算 `stopped(initiator)`。`initiator`
   * 缺省 `user`；主代理经 TaskStop 停的传 `model`（原因从此落库，不再只活在后台任务注册表里）；amend 路径传 `{ superseded: newRunId }`。
   * 未知 runId 返回 false。
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** 按 cursor 翻取事件日志；越界 cursor 返回空页而非报错。 */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * 按项目（cwd）枚举 run，最近更新的在前。服务 `ListWorkflowRuns` 工具。
   *
   * **可选成员**，照 {@link cancel} 之前的先例（消费方 `typeof` 探测）：实现方只有在 journal
   * 带内省查询时才提供它，既有的端口 stub 也不必为一个只读枚举面全员陪跑。消费方对
   * 「端口缺席」与「方法缺席」给同一个业务失败——对模型这是同一件事（本会话没有这个能力）。
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * 单 run 详情（进度摘要 + 产物 / 失败）。服务 `GetWorkflowRun` 工具。未知 runId 返回
   * `undefined`（消费方归一成 `run_not_found`），**不做 wait/block 语义**——等待是
   * {@link waitForTask} 的活，这里是即时快照。可选成员的理由同 {@link listRuns}。
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * run 存档的脚本原文（`dwf_run.script_text`，resume 重放的同一份字节），逐字节、不做任何处理。
   * `AmendWorkflow` 的两处读它：省略脚本时把前驱的脚本回填进
   * 入参，以及 `path` 修订的 `script_unchanged` 预检——
   * 那必须比字节而不能比哈希，工具侧读到的是文件内容，不是编译产物。GUI「配置」走同一条读路。
   *
   * 单独一条读面而不是 {@link DynamicWorkflowRunSnapshot} 的字段：快照被后台追踪器反复轮询，而
   * 脚本是端口上最大的一个字符串（{@link DynamicWorkflowRunSummary.label} 同一条理由）。未知 run
   * 与「记录里没有脚本」（落库之前的老 run）都回 `undefined`——对调用方是同一个事实：没有可沿用的
   * 脚本。只读、不看服务是否已关闭。**可选成员**（消费方 `typeof` 探测），理由同 {@link listRuns}：
   * 缺席时省略脚本的修订当场失败，`script_unchanged` 预检则被跳过（它是网，不是门）。
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * 恢复一个已取消 / 被进程死亡打断的 run：同 runId 重跑（引擎走 resume 分支，journal
   * 命中短路、未完结节点重新派发）。门在实现侧：只有 `cancelled` 或 `failed` 且失败编码为
   * `Interrupted` 的 run 可恢复。
   *
   * **可选成员**，照 {@link listEvents} 之前 cancel 的先例（消费方 `typeof` 探测）：
   * 端口 stub 不必为 resume 面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * 枚举**本服务父会话**名下的 run 摘要（最近更新在前，journal-backed）。UI 的重启后发现面：
   * `workflowRuns` 投影跨进程不存活，工具卡 join 与 Resume 按钮的可用性只能从这里还原。
   * 刻意不收 parentSessionId 参数——服务实例本就按父会话构造（per-app），让调用方传任意
   * 会话等于开一个跨会话读洞。可选成员的理由同 {@link resume}。
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * 冷回放：把**本服务父会话**名下、本进程
   * 没跑过的 run 从 journal 回放成进度事件载荷——与 live 时 `onRunEvent` 交出的是**同一种**
   * 载荷、同一条铸造链，冷物化把它们当内存事件喂给同一个 reducer，`workflowRuns` 投影因此
   * 在重启前后逐字节一致。
   *
   *   - 上界与投影的淘汰同（最近更新的 8 条），最旧的 run 在前；
   *   - `excludeRunIds`：调用方内存里已有事件的 run（本进程跑过 / 正在跑）不回放；
   *   - 行是终态而事件流没有 `run-settled` 的 run（进程死亡后被孤儿收敛改写的行）追加一条
   *     **内存态**合成 settle 载荷（携行的 status / failure / resumable），绝不写进 journal。
   *
   * 可选成员的理由同 {@link listRunsForSession}：内存 journal 没有枚举面，回放无物可还原。
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * 回答一个 actor 升级上来的阻塞问题。服务
   * `ResolveWorkflowQuestion` 工具。
   *
   * 只收一个不透明 token 而不是 `(runId, qid)` 对：qid 全局唯一（跨 run），多 run 并发时
   * 让模型自己配对是错配的温床。答案原样成为 actor 那次 `escalate` 调用的工具结果，
   * actor 的轮次随即继续；run 状态全程不动（升级是 ask 内部的一次慢工具调用，
   * 不是 run 生命周期事件）。
   *
   * **可选成员**，照 {@link resume} 的先例（消费方 `typeof` 探测）：端口 stub 不必为一个
   * 应答面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * 填一个停驻中的洞（挖洞-填充，apps/acode-cli/specs/workflow-holes.md）。服务
   * `FillWorkflowHole` 工具。
   *
   * 继续 = amend/supersede 链（resume 的 scriptHash 逐字节校验使原地改脚本不可行）：
   * 服务端读 run 草稿、把洞调用 splice 成 `await (async () => { <fill 语句> })()`、重编译
   * （诊断 ⇒ 拒绝且洞仍等待）、以 superseded 停下前驱、从前驱导入缓存、启动后继 run，并记
   * `hole-filled` 事件（含 splice 摘要与新旧 scriptHash）。**每 run 每洞至多一次 fill**：
   * 前驱 settle 后即 `hole_not_waiting`，语义由 supersede 链天然钉死。
   *
   * **可选成员**，照 {@link resolveQuestion} 的先例（消费方 `typeof` 探测）：端口 stub 不必
   * 为一个填充面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  fillHole?(request: DynamicWorkflowFillHoleRequest): Promise<DynamicWorkflowFillHoleResult>;
  /**
   * 本 run 的用户面产物清单（journal `kind = "artifact"` 行按 id 分组、版本升序）。UI 冷恢复与中枢详情的 durable 读法。
   * 未知 runId 返回 `undefined`。**可选成员**，理由同 {@link listRuns}（journal 带产物
   * 读面时才提供；消费方 `typeof` 探测）。
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
   * 越界 cursor 返回空页而非报错。可选成员，理由同 {@link listArtifacts}。
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * 读某个产物版本的字节：**先**在 journal 里确认 `(runId, artifactId, version)` 有一行
   * `completed` 记录，再按行上的 `uri` 经 tool-artifact store 取——调用方传来的任何 id 都
   * 不直接成为路径。无此版本 / 非内容产物 /
   * store 缺席 → `undefined`。分块归网关（v4 `workflowRunArtifactRead`，≤ 512 KiB 一块）。
   * 可选成员，理由同 {@link listArtifacts}。
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * 本 run 的工作区 transcript：journal 里
   * `kind ∈ {world-read, world-run}` 的行按落库先后，**不带正文**。
   *
   * 授权与 {@link readArtifact} 同一条链：run 必须属于本服务的父会话，否则 `undefined`
   * （与「无此 run」同一个答案——不告诉越权的调用方它猜对了哪一半）。正文可能含工作区文件
   * 内容，所以清单也不放行别的会话。可选成员，理由同 {@link listArtifacts}。
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化。授权链同 {@link listWorkspaceNodes}；
   * 无此节点 / 非 world 行 / 不是你的 run → `undefined`。可选成员，理由同 {@link listArtifacts}。
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// 结构化失败的两个类型住在 dynamic-workflow-run-error.port.ts（断环叶子），原样再导出。
export type * from "./dynamic-workflow-run-error.port.js";

// 情势截面（阶段 / 子代理 / 健康）的类型住在 dynamic-workflow-run-roster.port.ts（同上），
// 此处原样再导出以保持 `@acode/contracts` 的导入路径不变。
export type * from "./dynamic-workflow-run-roster.port.js";

// retune（就地改在飞 run 的并发上界）的三个类型住在 dynamic-workflow-run-retune.port.ts，
// 同上原样再导出。
export type * from "./dynamic-workflow-run-retune.port.js";

// 工作区 transcript 的六个类型住在 dynamic-workflow-run-workspace.port.ts，同上原样再导出。
export type * from "./dynamic-workflow-run-workspace.port.js";

// 拆分叶子（批次 B 例外债务偿还）：原样再导出，`@acode/contracts` 导入路径不变。
// 事件叶携带 serializeWorkflowArtifact 运行时再导出，用 `export *`；其余为 type-only 叶。
export type * from "./dwf-run-submit.port.js";
export type * from "./dwf-run-artifact.port.js";
export * from "./dwf-run-event.port.js";
export type * from "./dwf-run-view.port.js";
