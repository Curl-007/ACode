/**
 * 引擎的结构化错误：稳定错误码、可序列化形态，以及跨 Boundary A 抛出的 {@link WorkflowError}。
 * 本模块依赖 schema 的 Violation 与终态明细；types.ts 再导出这些类型供调用方使用。
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
 * 稳定错误码。区分 node 级（拒绝单个 ask 的 promise）与 run 级（使整个 run 失败）：
 * - node 级：ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded——一次世界读取超过它那个 op 的上限（`files.grep`：2000 条命中或
 *   256KB 序列化，先到先拒；`git.diff`：512KB；见 `facade/world-read-caps.ts`）。它是 node 级
 *   而不是 run 级，靠的是**拒绝通道**而不是严重程度：世界读取返回一个脚本能 `catch` 的
 *   promise，所以"缩窄 pattern 或加个 glob"是一条脚本真能走的路。也刻意**不**折进
 *   DriverError——上限是脚本可以据以重写自己的契约，而靠匹配 message 文本区分两者，
 *   正是这个联合类型存在的目的所要防的。
 *   AgentBudgetExceeded——run 级预算保险丝（`facade/budget-caps.ts`，specs/workflow-budget-fuses.md）：
 *   一个 run 准入的 ask 总数到达 `maxAsksPerRun`（`details.limit:"total"`），或未结算 ask 积压
 *   到达 `maxPendingAsks`（`details.limit:"pending"`）。节点级而非 run 级，同一条拒绝通道论证、
 *   与 ReportCapExceeded 结论相反：`ask` 返回 PromiseLike，脚本可以 `catch` 后 `report()` 已
 *   完成的部分收尾（report 存在的意义正是让前 N-1 个任务的成果活下来）。两个限额共用一个码，
 *   因为作者的恢复动作相同（收窄扇出、少派发）；是哪道闸由结构化的 `details.limit` 区分，
 *   不从 message 文本里抠。同样刻意不折进 DriverError：预算是脚本可据以重写自己的契约。
 * - run 级：InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName——同一个 run 内两次 createActor 得到相同的**非空**有效名
 *   （有效名 = normalizePersona 后的 `spec.name`，persona.name 压过 name 实参）。规则对
 *   **所有** run 生效而不只是修订 run：具名 actor 是 amend-resume 缓存导入的身份键，而任何
 *   run 都是未来修订的潜在前驱，前驱里重名会让导入匹配歧义。匿名（名缺席或空串）不查、不禁——代价是没有缓存资格。
 *   字面量重名另有编译期 courtesy 诊断（analysis/actor-names.ts），但动态名只有运行期能查，
 *   所以这条才是真正的门。
 *   ReportCapExceeded——一个 run 超过 256 条报告，或单条 item 序列化超过 32KB
 *   （见 `facade/report-caps.ts`）。它是 run 级而不是 node 级，与上面 WorldReadCapExceeded 的
 *   分界同理、结论相反：`report` 返回 `void`，脚本**没有**可以 catch 的通道，除了 run 无处可放。
 *   也正因如此这两个数字必须宽到讲道理的脚本永远碰不到——脚本作者写不出恢复路径。
 *   同样刻意不折进 DriverError：上限是脚本可据以重写自己的契约。
 *   TokenBudgetExceeded——run 的累计 token 越过预算阈值（`facade/budget-caps.ts` 的
 *   maxTokensPerRun，或创建时显式给出的更严阈值；见 specs/workflow-budget-fuses.md R4）。
 *   与 ReportCapExceeded 同一条拒绝通道论证、同一个结论：token 累计发生在 ask 结算
 *   **之后**、由引擎记账（askStats），不在任何单次调用的返回通道上，脚本**没有**可以
 *   catch 的地方。判定是事后的（不做请求前预估——预估会把 provider 的计数变成引擎的
 *   猜测）：可能超顶一个在飞 ask 的量，刻意取舍。
 * - 构造期（run 尚未开始，引擎构造函数同步抛出）：ScriptHashMismatch
 * - 宿主级（**引擎从不产出**）：Interrupted——拥有该 run 的进程在结算之前就没了，由宿主在
 *   下一次构造时收敛那行永远停在 running 的记录（`cli-workflow/src/dynamic-workflow-run-service.ts`
 *   的孤儿收敛）。它必须是**独立的码**而不是复用 DriverError：脚本
 *   自己抛错也编码成 DriverError（`dynamic-workflow-runtime/src/harness.ts:311`），两者若同码，
 *   「进程被杀」与「脚本真失败」就只能靠 message 文本区分——而这正是本联合类型要避免的。
 *   ProviderStop——一个子代理（或工具侧）的模型请求撞上**确定性的**模型侧错误（认证失效、模型不在套餐里、配额耗尽等），driver 让
 *   run 以 `stopped(provider)` 停下而不是让节点失败；结构化明细在 `providerStop`。它是宿主级
 *   的另一条：引擎只在 `stop("provider", error)` 里原样落库。
 * 流程判断一律用这里的码，绝不匹配错误文本。
 */
export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "AgentBudgetExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "TokenBudgetExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  // ——————————— 用户面产物———————————
  // ⚠ 术语：这一批 artifact 全是**用户面产物**（脚本发布给用户看的产出），与
  // `RunSettlement.artifact`（顶层返回值）无关。
  //
  // 通道按**成员族**分裂，与 WorldReadCapExceeded / ReportCapExceeded 的分界同一条论证：
  // 内容成员（`file`/`markdown`）返回 promise，脚本可 catch，所以是节点级拒绝；预置成员
  // 返回 void，没有可拒绝进去的地方，所以同样的事实在那一族是 failRun。三个 driver 侧的
  // 码（Missing/Outside/TooLarge/StoreUnavailable）只可能来自内容成员，故恒为节点级。
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  // 第二个 id 想当 primary：内容成员是节点级拒绝，
  // 预置成员是 failRun——与上面几条同一条分界。
  | "ArtifactPrimaryConflict";

/**
 * 值不匹配的结构化比对（哪一侧变了）。记录里的值是 `expected`，本次传入的是 `got`。
 * 排查 resume 被拒的人需要的是这两个值，而不是从 message 里正则抠——流程判断与展示
 * 都不该依赖错误文本。
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/**
 * `AgentBudgetExceeded` 的结构化明细：是哪道闸（`total` = run 的 ask 总量，`pending` =
 * 未结算积压）、上界是多少、判定时刻的计数是多少。流程判断看 `limit`（结构化字段，
 * 不匹配 message 文本），展示与日志三个数一起用。
 */
export interface AgentBudgetDetails {
  limit: "total" | "pending";
  cap: number;
  actual: number;
}

/** 错误的可序列化形态，落 journal（dwf_node.error_json / dwf_run.failure_json）。 */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  /** 只在 `code === "ProviderStop"` 时在场。 */
  providerStop?: ProviderStopDetails;
  /** 只在 `code === "AgentBudgetExceeded"` 时在场。 */
  details?: AgentBudgetDetails;
}

/**
 * 跨 Boundary A 抛出的结构化错误。带稳定 code 与可选的 violations / finalText / mismatch，
 * 使脚本侧 try/catch 与上层都能按结构处理，而不依赖字符串匹配。
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations?: Violation[];
  readonly finalText?: string;
  readonly mismatch?: WorkflowErrorMismatch;
  readonly providerStop?: ProviderStopDetails;
  readonly details?: AgentBudgetDetails;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    extra?: {
      violations?: Violation[];
      finalText?: string;
      mismatch?: WorkflowErrorMismatch;
      providerStop?: ProviderStopDetails;
      details?: AgentBudgetDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (extra?.violations !== undefined) this.violations = extra.violations;
    if (extra?.finalText !== undefined) this.finalText = extra.finalText;
    if (extra?.mismatch !== undefined) this.mismatch = extra.mismatch;
    if (extra?.providerStop !== undefined) this.providerStop = extra.providerStop;
    if (extra?.details !== undefined) this.details = extra.details;
    if (extra?.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  /** 转为可序列化形态落 journal。 */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    if (this.details !== undefined) json.details = this.details;
    return json;
  }

  /** 从 journal 记录重建（replay 命中失败节点时用）。 */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
      details: json.details,
    });
  }
}

/**
 * {@link WorkflowErrorCode} 的运行时码表。`Record<…, true>` 让穷尽性由编译器强制——联合里
 * 新增一个码而忘了在这里登记，typecheck 直接失败，guard 因此永不落后于词汇表。
 */
const WORKFLOW_ERROR_CODE_TABLE: Record<WorkflowErrorCode, true> = {
  ValidationFailed: true,
  ResultNotSubmitted: true,
  DriverError: true,
  WorldReadCapExceeded: true,
  AgentBudgetExceeded: true,
  Cancelled: true,
  ContextLimit: true,
  ReportCapExceeded: true,
  TokenBudgetExceeded: true,
  InputHashMismatch: true,
  UnknownActor: true,
  MissingAskSpec: true,
  DuplicateActorName: true,
  ScriptHashMismatch: true,
  Interrupted: true,
  ProviderStop: true,
  ArtifactSourceMissing: true,
  ArtifactPathOutsideWorkspace: true,
  ArtifactTooLarge: true,
  ArtifactStoreUnavailable: true,
  ArtifactVersionCapExceeded: true,
  ArtifactKindMismatch: true,
  ArtifactCapExceeded: true,
  ArtifactSpecInvalid: true,
  ArtifactRedeclared: true,
  ArtifactUndeclared: true,
  ArtifactPrimaryConflict: true,
};

/**
 * 运行时 guard：一个未知值是否属于 {@link WorkflowErrorCode} 词汇表。harness 据它决定
 * 沙箱回传的未捕获错误能否按原 code 重建——线形态（WireError）带 code，而沙箱不是安全
 * 边界（脚本可以自造任意 `e.code`），没有这道 guard，一个编造的码会污染 failure_json 的
 * 稳定词汇表。查表用 hasOwn：`in` 会把 `toString` 这类原型链键也放进来。
 */
export function isWorkflowErrorCode(code: unknown): code is WorkflowErrorCode {
  return typeof code === "string" && Object.hasOwn(WORKFLOW_ERROR_CODE_TABLE, code);
}
