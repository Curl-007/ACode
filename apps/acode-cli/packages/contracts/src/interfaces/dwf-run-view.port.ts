// ============================================================
// Dynamic Workflow Run Port：run 内省 / 详情 / 恢复视图类型（叶子文件）
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出（批次 B 例外债务偿还：原文件超
// architecture-policy 的 max-file-lines）。run 内省段（List / Detail / Resume）整体下沉；
// 主端口文件 `export type *` 原样再导出，消费方导入路径不变。依赖四个既有叶子（error /
// artifact / fill-hole / roster），均为单向，无环。

import type {
  DynamicWorkflowRunError,
} from "./dynamic-workflow-run-error.port.js";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunPendingQuestion,
} from "./dwf-run-artifact.port.js";
import type {
  DynamicWorkflowRunPendingHole,
} from "./dynamic-workflow-fill-hole.port.js";
import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";

// ————————————————————————————————————————————————————————————————
// run 内省（ListWorkflowRuns / GetWorkflowRun 的取数面）
// ————————————————————————————————————————————————————————————————

/**
 * run 的生命周期状态。字面与 journal 的 `dwf_run.status` 同集，但**刻意在这里重新声明**
 * 而不是从 @acode/dynamic-workflow import：端口只承载 JSON 形状，引擎的词汇表一旦进
 * contracts，每个持有端口的层都会编译期依赖引擎内部类型（与 {@link DynamicWorkflowRunEvent}
 * 的 `type` 同一条论证）。
 *
 * 与 {@link DynamicWorkflowRunSnapshot} 的 status 刻意不同：后者是后台任务追踪器的词汇表，
 * 把 `pending` 折进 `running`。内省面必须保留 `pending`——「已提交、引擎还没建行」是一个
 * 模型能看懂且有意义的区别。
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * `stopped` 的原因：`user` 用户取消 / `model` 主代理
 * TaskStop / `provider` 确定性模型侧错误 / `interrupted` 持有进程亡故或沙箱故障 / `superseded`
 * 被一次 AmendWorkflow 停下并替代。前四者可 resume，`superseded` 不可（活的是它的后继）；
 * `errored`（脚本之错）不可。字面与引擎 `RunStopReason` 同集，刻意在这里重新声明。
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** {@link DynamicWorkflowRunPort.listRuns} 的查询袋。 */
export interface DynamicWorkflowRunListQuery {
  /**
   * 项目键，**必填**。字面等值匹配 `dwf_run.cwd`（写入侧原样落、读侧原样查）。
   * 端口不替调用方猜一个默认 cwd：工具面恒查 `context.workingDirectory`，模型无权跨项目扫库。
   */
  cwd: string;
  /** 返回条数上限，**必填**。钳制策略属于工具面（[1, 50]）；端口不做无界枚举。 */
  limit: number;
  /** 可选状态子集。缺省即不过滤；空数组即「不匹配任何状态」（回空列表）。 */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * 列表与详情**共同的截面**。标签、归属标注与时间戳三者在两条读面上必须逐字段同源——
 * 同一个 run 在列表里和详情里显示不同的名字或归属，是最难被测试抓住、又最直接损害信任的
 * 那类不一致。所以这里是一个共享的基接口，而不是两份各自演化的字段表。
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * 展示标签。**已烹熟**：实现侧（run service）按 name → 脚本首行 → runId 的顺序派生好，
   * 消费方直接展示。之所以不把原料（name / scriptText）交出去让工具层自己拼：那条兜底链
   * 是读时启发式，两个工具各拼一次就会漂移，而 scriptText 是端口上最大的一个字符串
   * （列表面根本不该为了取首行把 50 份脚本搬过边界）。
   */
  label: string;
  /** 标签来源：`"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy?: string;
  /** 本会话是否是这个 run 的发起方（journal 的 parent_session_id 命中，或在本会话注册表里）。 */
  ownedByThisSession: boolean;
  /**
   * 「本会话无法证实它还活着」：journal 非终态 ∧ 非本会话 ∧ 不在本会话注册表。可能是死进程
   * 的遗物，也可能是同进程兄弟会话正在飞的 run——所以这是**标注而非状态改写**，读面绝不
   * 替别人收尸（孤儿收敛的执行权只属于 owning 会话的构造时刻）。为真时才在场。
   */
  possiblyInterrupted?: boolean;
  /** journal 的 `time_created` / `time_updated`（epoch ms）。 */
  createdAt: number;
  updatedAt: number;
}

/** 列表的一项：共同截面 + 用量。刻意轻——无 actors、无节点计数、无产物预览。 */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** 直读 `dwf_run.spent_tokens`（run 级 token 用量的唯一权威）。 */
  spentTokens: number;
}

/**
 * `listRuns` 的返回。刻意是一个对象而不是裸数组：页级字段（如 {@link truncated}）是纯追加
 * 改动，而裸数组只能整体换形状。
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * 这个项目还有更多 run 没进这一页。**为真时才在场**。
   *
   * 判据是「多取一条」（实现侧按 `limit + 1` 查询后回落），不是 `length === limit`：后者在
   * 条数正好等于 limit 时误报，而误报会让模型去追一页不存在的历史。同一个惯例在 v4 网关的
   * 事件分页上（`hasMore`）已经用过一次。
   */
  truncated?: boolean;
}

/**
 * run 的进度与用量（观察面，没有任何上限）。`nodesObserved`
 * 是**已落库节点的行数**（三态之和），绝不冒充「总步数」：动态工作流没有静态总数，而
 * `queued` 只存在于事件相位、不落库。
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** 一个 actor 站点实例。`persona` 刻意不出：整段 system prompt 是端口上天然无界的字段。 */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** 一条 `log()` 叙事。 */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** 已按端口的字符串上限（{@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}）有界化。 */
  message: string;
  /**
   * 这条事件落 journal 的时刻（`dwf_event.time_created`）。序号定位，时刻回答「多久以前」——
   * 情势截面的三组字段都按这一把尺算年龄，叙事尾巴没有理由用另一把。**没有这一列的老
   * journal 上缺席**，读侧据此不给年龄，绝不用读时的 `Date.now()` 兜底。
   */
  at?: number;
}

/** 单 run 详情：共同截面 + 进度 + 情势截面 + 按终态分叉的产物 / 失败。 */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * 本 run 自己的并发上界，语义同 {@link DynamicWorkflowRunSnapshot.maxConcurrency}：只在低于当前
   * 天花板时在场。刻意不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个很少设置的字段加宽。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型，语义同 {@link DynamicWorkflowRunSnapshot.subagentModel}：只在设过时
   * 在场。与 `maxConcurrency` 同理不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个
   * 很少设置的字段加宽。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本文件，语义同 {@link DynamicWorkflowRunSnapshot.scriptPath}：只在记下过文件时
   * 在场。`GetWorkflowRun` 据它在 `<amendable>` 里把下一步说成「就地编辑这个文件」。
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** `log()` 事件的尾巴，按时序（sequence 升序）。无 log 事件即空数组。 */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些
   *
   * **脚本没声明阶段、也一个都没进过时整字段缺席**——那样的 run 没有阶段这回事，
   * 发一个空数组读起来像「阶段表是空的」，是另一句话。
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * 子代理花名册，按 actor 行的顺序（= 铸造顺序）。**恒在场**，一个 actor 都没有的 run 是空
   * 数组：与 `phases` 不同，「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
   *
   * 与并列的 `actors` 刻意不合并：`actors` 是一张恒定的身份表（siteId / ordinal / name），
   * 消费者已经按它 join；这里的每一项都是**读时快照**，同一个 run 隔一秒读就不一样。
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** run 整体还在不在动（见 {@link DynamicWorkflowRunHealth}）。恒在场。 */
  health: DynamicWorkflowRunHealth;
  /**
   * 脚本的顶层返回值，**原值**（未序列化）。只有 completed 的 run 才在场；`undefined` 产物
   * 即整字段缺席。
   *
   * 为什么不在这里序列化：面向模型的文本投影已经有唯一实现（core 的
   * `serializeWorkflowArtifact`，完成通知与 TaskOutput 共用它）。端口再做一次，就会出现
   * 「同一个 run 的产物在通知里和在本工具里长得不一样」——正是那份共用要排除的损失类别。
   * 所以序列化留在 core，端口只负责把原值送到边界。
   */
  result?: unknown;
  /** errored 恒在场；stopped 只对 provider / interrupted 在场。code 原样透出，不折叠。 */
  error?: DynamicWorkflowRunError;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * 与 {@link DynamicWorkflowRunSnapshot.pendingQuestions} **同源同投影**（都读进程内的升级
   * 停驻表，都在零条时整字段缺席），只是换了一条读面：快照服务后台任务追踪器，本字段服务
   * `GetWorkflowRun`——而后者是**模型侧唯一的发现面**。这条链路不是可选的锦上添花：升级通知
   * 有两条已知的丢弃路径（stale branch generation / shutdown），查询是这两条路径的兜底，`resolveQuestion` 的 `unknown_question` 文案也明确让模型来这里找 qid。
   * 缺了它，那两处承诺都会指向一个什么都不返回的工具。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 此刻停驻在这个 run 上、等主代理提交代码的洞（挖洞-填充）。
   *
   * 与 `pendingQuestions` **不同源**：升级的「现在还欠谁」是进程内停驻 deferred 的活事实
   * （重放在进程亡故后说谎）；洞的等待**就是 journal 事件的事实**（hole-reached 起期、
   * hole-filled / run-settled 止期），所以这里从事件归约（与 run 面板同一个 shared reducer），
   * 冷读与热读给出同一份表。零条时整字段缺席，与 `pendingQuestions` 同一条「无则缺席」惯例。
   * 这是 `FillWorkflowHole` 的 **hole_ref 发现面**：`hole_not_waiting` 的拒绝文案指向这里。
   */
  pendingHoles?: readonly DynamicWorkflowRunPendingHole[];
  /**
   * 本 run 的用户面产物（任意状态都附；journal-backed，与 {@link DynamicWorkflowRunSnapshot.artifacts}
   * 同源）。`GetWorkflowRun` 据此告诉模型「这些已经以卡片呈现给用户了，按标题引用即可」。
   * 零件时整字段缺席。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** {@link DynamicWorkflowRunPort.resume} 的结构化失败原因。 */
export type DynamicWorkflowRunResumeErrorReason =
  /** journal 里没有这个 run。 */
  | "not_found"
  /** run 不在可恢复集里（completed 或 errored；只有 stopped 可恢复）。 */
  | "not_resumable"
  /** run 被一次 AmendWorkflow 停下并替代：活的是后继，重放它等于把同一件事做两遍。 */
  | "superseded"
  /** 同 runId 的 run 正在本进程内飞行。 */
  | "already_running"
  /** 记录缺 scriptText（落库该字段之前的老 run），没有可重跑的脚本。 */
  | "script_missing"
  /** 记录的 scriptHash 与按 scriptText 重算的不一致（记录自身被外力改写过）。 */
  | "script_mismatch"
  /**
   * 记录的 scriptText 在**当前** facade 下不再通过类型检查（facade 重构后的老 run）。逐字重放
   * 只会失败；出路是按当前 facade 改写脚本后走 AmendWorkflow。`message` 携带有界诊断。
   */
  | "compile_failed";

/**
 * resume 的结构化结果。失败走 reason 而不是 throw：五种原因全是调用方可预期的业务分支
 * （错误码而非错误文本做流程判断，house rule），throw 只留给真正的接线故障。
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * {@link DynamicWorkflowRunPort.listRunsForSession} 的 run 摘要。字面与 journal 的
 * `dwf_run.status` 同集，但**刻意在这里重新声明**：端口只承载 JSON 形状，引擎词汇表一旦
 * 进 contracts，每个持有端口的层都会编译期依赖引擎内部类型。
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
  toolCallId?: string;
  /**
   * 展示标签，服务端读时派生（`name` → 脚本首行 → runId，见 bootstrap 的
   * `resolveDynamicWorkflowRunLabel`）。可选是为了**偏斜安全**：老服务端不发这个键，
   * 读侧回落到 runId 即可——列表少一个标签是退化，不是错误。
   *
   * 与 `resumable` 同理由集中在服务端：两处各拼一次兜底，同一个 run 在
   * `/dwf list` 与工具卡上会显示不同的名字。
   */
  label?: string;
  /**
   * 最后更新时间（epoch 毫秒，来自 journal 的 `dwf_run.time_updated`）。可选同上：
   * 老服务端缺席，读侧不显示时间列。列表排序仍由存储层负责（最近更新在前），
   * 这个字段只供展示——读侧不要拿它重排，否则与服务端的 tie-break 漂移。
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
  failureCode?: string;
  failureMessage?: string;
  /**
   * 是否可恢复。**服务端按 resume 门的同一个谓词算好**：UI 若自行按 status+failureCode
   * 重新推导，两处谓词总有一天不一致——按钮亮着但命令被拒。
   */
  resumable: boolean;
  /**
   * 跑这条 run 的是哪套工作流系统。**缺席即 `"dwf"`**：所有既有 run（老服务端发的、
   * journal 冷回放出来的）都没有这个键，而它们全是 dwf 的。
   *
   * 追加可选字段是本 schema 既定的偏斜安全做法（`label` / `toolCallId` 同理由）：老服务端
   * 不发这个键，读侧按缺省解释即可——少一枚徽标是退化，不是错误。反过来往闭集枚举里
   * **加值**才是破坏性偏斜，所以这里只加键、不改任何既有词表。
   *
   * 目录页据此挂徽标，与详情侧栏的状态头同一套措辞：两套 run 现在共用这一个查询与
   * 同一个目录，不标出来用户无从分辨，也无从理解为什么某些动作对某条 run 缺席。
   */
  dialect?: "dwf" | "script";
}
