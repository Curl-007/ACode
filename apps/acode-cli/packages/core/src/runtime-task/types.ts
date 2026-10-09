import type {
  AgentOutput,
  DynamicWorkflowRunError,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@acode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp"
  // K3 overnight run（specs/overnight-execution.md 接口节）：run 的唯一 UI 投影面，
  // 与 local_* 工具任务区分——它不是工具派生的，生命周期绑定 supervisor（R1）。
  | "overnight"
  // K2 对话内 swarm plan（specs/swarm-task-graph.md R4）：plan 的 runtime-task 投影。
  // 不并入 local_workflow（legacy Workflow 工具，不可取消）也不并入 local_dynamic_workflow
  // （dwf run，端口取消）：本联合按「取消语义」分组（见顶部注释），plan 的停止面是
  // PlanControl 工具（模型侧 retry/cancel），GUI TaskStop 分派对它应答 not supported
  // 而不是误路由到任何 workflow 停止分支——overnight 新增成员的同款先例。
  | "swarm_plan"
  // K6 ambient cycle（specs/ambient-budget-scheduler.md R3）：AmbientRunner fork 的隐藏
  // 后台周期任务。非工具派生（runner 驱动），生命周期绑定 runner cycle——overnight 的
  // 同款先例（本批写面内允许的唯一联合扩展：一行成员 + 两处 exhaustive switch 标签）。
  | "ambient";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
  /**
   * K3 overnight run 的运行面摘要（specs/overnight-execution.md R2/R4/R5）：
   * phase / 任务卡片计数 / 内存趋势。registry 只存储不解释——它是通用投影面，
   * overnight 语义归 supervisor 所有；类型收窄为 string 以免 runtime-task 反向依赖
   * overnight 模块的相位枚举（依赖方向：overnight → runtime-task，单向）。
   */
  overnight?: {
    runId: string;
    phase: string;
    cardCount?: number;
    memoryTrend?: {
      samples: number;
      firstRssBytes?: number;
      lastRssBytes?: number;
    };
  };
}

export interface TaskNotificationInput {
  agentId?: string;
  description?: string;
  error?: string;
  outputFile?: string;
  /**
   * workflow run 的渐进产物（`report(item)`），completed / failed / cancelled 一律携带。
   * `count` 是**真实总条数**，`shown` 是预览里的条数——两者不等即预览是局部的，全量经 run id 可取。
   * 缺席即整节 `<reports>` 不出现（零条时不发空节）。
   */
  reports?: { count: number; preview: string; shown: number };
  /**
   * workflow run 的**用户面产物**，completed / failed / cancelled
   * 一律携带。字段语义与 `reports` 同规：`count` 是真实总件数，`shown` 是清单里的行数。
   * 缺席即整节 `<artifacts>` 不出现（零件时不发空节）。
   *
   * ⚠ 术语：这里的 artifact 是脚本发布给用户看的产出，与本结构的 `result`（脚本顶层返回值，
   * 引擎内部也叫 artifact）无关——两者在同一条通知里并列出现。
   */
  artifacts?: { count: number; preview: string; shown: number };
  /**
   * workflow run 专属：在 XML 之后追加交付物呈现指引。
   * legacy `Workflow` 与 dwf 共用 `local_workflow` 通知形状，但它的通知逐字节不变，所以由调用方
   * 按分派名显式打开，而不是按 taskType 推断。
   */
  deliveryGuidance?: boolean;
  result?: string;
  status: string;
  /**
   * dwf run 的真实终态词：`status` 是后台任务追踪器
   * 的通用词汇（stopped 折成 killed、errored 折成 failed），`<status>` 行与呈现指引要说真话
   * 就读这个；缺席即 legacy `Workflow` / 非终态，照旧走 `status`。
   */
  runStatus?: Extract<DynamicWorkflowRunLifecycleStatus, "completed" | "errored" | "stopped">;
  /**
   * workflow run 为什么停下（只在 `runStatus === "stopped"` 时在场）。`user` 让呈现指引明说
   * 「这是用户的决定，不要自行恢复」；`model` 是模型自己 TaskStop 的；`provider` 是确定性
   * 模型侧错误（`failure.providerStop` 带明细）；`interrupted` 是持有进程亡故。
   */
  stopReason?: DynamicWorkflowRunStopReason;
  /**
   * workflow run 的脚本文件，**已经写成模型面该看到的样子**（工作区相对或绝对，
   * `describeWorkflowScriptPath`）。在场时
   * `errored` 与 `stopped(model)` 的呈现指引把下一步从「改好脚本再内联提交」换成「就地编辑
   * 那个文件、再用 `path` 修订」——一份两万 token 的脚本不该为了改一行再流一遍。
   *
   * 缺席即这个 run 没有可编辑的文件（草稿写不下去的项目、本特性之前发起的 run），指引逐字节
   * 退回旧话。相对化在调用方做一次：本模块是纯格式器，不认识工作目录。
   */
  scriptPath?: string;
  /**
   * workflow run 的结构化失败（errored 恒在场；stopped 只对 provider / interrupted 在场）。带
   * `providerStop` 时 `<error>` 块由文案表铸造（原因 → 动作 → 事实行 → 原文行），而不是
   * 只贴一句 provider 原文——主代理读完必须知道该做什么。
   */
  failure?: DynamicWorkflowRunError;
  stderrFile?: string;
  stdoutFile?: string;
  subagentType?: string;
  summary: string;
  taskId: string;
  taskType: RuntimeTaskType;
  toolUseId?: string;
  usage?: {
    durationMs?: number;
    modelUsage?: ModelUsage;
    toolUseCount?: number;
    totalTokens?: number;
  };
}
