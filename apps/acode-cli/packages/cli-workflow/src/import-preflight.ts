// ============================================================
// amend-resume 导入：预检、拒绝理由与依赖形状（自 dynamic-workflow-import.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 556 行超过 400 行门禁。按「预检/门 + 依赖形状 → 构建器 → resume 重建」拆成三叶：
//   - import-preflight.ts（本叶）：预检与门 3 的谓词、三个拒绝理由、构建依赖（deps/options）、
//     转录源解析与条数读取；
//   - import-build.ts：缓存构建器（依赖本叶的类型与谓词）；
//   - import-rebuild.ts：resume 侧的重建入口（依赖前两叶）。
// 依赖方向：preflight ← build ← rebuild，无环；叶子不反向 import 原文件（原文件降为桶，
// 只原样再导出原有 4 个公开符号）。本叶与原文件头共用同一套不变式论证（见原文件头注释）。

import type { Logger, SessionId } from "@acode/contracts";
import type {
  ActorRecord,
  ImportedRunCache,
  NodeRecord,
  RunRecord,
} from "@acode/dynamic-workflow";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * 构建导入缓存所需的 journal 读面：三个读方法，全部按 runId。
 *
 * 结构上是引擎 `JournalStorePort` 的真子集（生产直接把 journal 传进来），窄化的理由与 {@link ActorTranscriptStore} 同款：构建器只读这三样，声明成整个端口会让「导入构建依赖
 * journal 的全部能力（含写）」变成一句真话——而它一个字节都不写。**前驱只读**是不变式，让类型把它说出来。
 */
export interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string): ActorRecord[];
  listNodes(runId: string): NodeRecord[];
}

/**
 * 导入构建被拒的三个理由。**判别键而非文案**：模型据它选下一步动作（换 run / 等它结算 /
 * 放弃修订走全新 run），所以三者必须可分辨。可操作文案归工具层。
 *
 * 与端口的 `DynamicWorkflowRunSubmitRefusalReason`（contracts）**逐字面同集**：service 把这里的
 * reason 原样交出去，所以两处一旦漂移就是编译错误，而不是一个悄悄变成 `undefined` 的判别键。
 * 刻意不从 contracts import：本模块是领域侧的构建器，端口词汇表反过来依赖它才是正确方向。
 */
export type ImportedCacheRefusalReason =
  /** journal 里没有这个前驱 run。 */
  | "run_not_found"
  /** 前驱仍在飞（非终态）。修订**任意终态** run 都合法，含 completed。 */
  | "not_amendable"
  /** 前驱有已完结但缺消息边界的 ask：无 marker 前驱整体拒绝（无回退降级）。 */
  | "missing_boundaries";

/** 构建结果：成功带表与 lineage 指针，失败只带判别键。 */
export type BuildImportedCacheResult =
  | { ok: true; cache: ImportedRunCache; resumedFrom: string }
  | { ok: false; reason: ImportedCacheRefusalReason };

/**
 * amend 预检的两个拒绝理由：与端口的 `DynamicWorkflowRunAmendRefusalReason` 逐字面同集。
 * 没有 `not_amendable`——在飞的前驱由 amend 停下，不是被拒。
 */
export type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

export type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * amend 的**预检**：前驱存在 ∧ 每个已完结 ask 都有消息边界。**不看状态**——这两条都是前驱
 * journal 的性质，停止不会改变它们，所以在停止之前就能判定；预检过了再停，被拒的 amend 才
 * 不会留下一个被白白停掉的 run。在飞 run 的已完结 ask 早已连边界一起落库，所以对在飞前驱的预检与对已结算前驱的一样决定性。
 */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  if (!completedAsksHaveBoundaries(journal.listNodes(predecessorRunId))) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 * 门 3 的谓词，预检与构建共用：无 marker 只有两种成因——marker 列引入之前写下的 journal，与 driver
 * 侧记账失败——两者都意味着「这个 run 的边界记账不可信」，所以严格到全表而不是只看会被导入的那些。未完结的 ask 没有边界是**正常**的（它们从不进导入前缀），所以只看 completed 行。
 */
export function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 * 构建导入缓存要的三样依赖。字段名与 `DynamicWorkflowRunServiceDeps` 逐字对齐（本接口是它的结构子集），所以 run service 的两个调用点直接把 `deps` 原样递进来——多一层改名映射，就多一处会漂移的接线，而漂移的症状是「转录面明明接上了却不做诚实性检查」这类静默降级。
 */
export interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   * 会话转录读面。在场时多做一道**源诚实性检查**（见 {@link countSource} 的读者注释）；缺席时候选照收——driver 侧的种子兑现仍会大声失败，那是 corruption 级的兜底。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * 构建期能看到的**运行期旁证**，与 journal 事实相对。今天只有一条：哪些前驱会话已经写完了。
 *
 * 刻意不进 {@link AmendImportDeps}：deps 是装配（journal、转录面、logger），一个进程里从头到尾是同一份；本对象是**这一次构建**才成立的观察，两次构建可以不同。混进 deps 会让「同一份 deps 必给同一张表」这句话变味。
 */
export interface AmendImportOptions {
  /**
   * 已**静默**（不再有在写的 turn）的前驱会话 id。只影响在飞 ask 的接续：完结前缀的边界是 journal 事实，与会话此刻长不长无关。
   *
   * **缺席 = 全部静默**，而不是「全都不静默」。两个调用点各取一半：amend 刚 abort 掉在飞前驱，被中止的 turn 可能仍在落最后几条消息，所以它带着 driver 算出的集合进来；resume 侧的重建（{@link rebuildImportedCacheForResume}，经原文件桶导出）面对的是一个早已结算、本进程里没有 driver 的前驱，没有任何东西在写它的会话——缺席即此。方向反过来的话，重建出的表会比提交时那张少一个 `inFlight`，而两侧必须是同一张表（见原文件头）。
   */
  quietSessions?: ReadonlySet<string>;
}

/**
 * 沿 `resumed_from` 链回溯**最近一个**持有该名 actor 会话的祖先 run。
 *
 * 为什么需要走链：run B 里某 actor 全程命中缓存 ⇒ B 从未给它建过会话（惰性创建），于是
 * B→C 的修订要接续该 actor 时，转录只存在于 A。count 边界跨前缀复制不变，所以在链上任何持会话祖先处，B 抄来的边界值都直接可用——这正是链式修订成立的根基。
 *
 * `resolvedModel` 与会话取自**同一行**：pin 的意义是「接续这段转录时别换模型」，取自别的行就是在为一段不属于它的转录做承诺。
 *
 * 环防御（seen）是纯防御：supersede 只能指向已终结的更早 run，构造不出环。但这个 while 若真遇到损坏数据就是死循环，而防御的代价是一个 Set。
 *
 * （住在预检叶：构建器（import-build.ts）单向取用它，叶子不反向依赖构建器。）
 */
export function resolveTranscriptSource(input: {
  actorName: string;
  journal: ImportedCacheJournalReader;
  startRunId: string;
}): { sessionId: string; resolvedModel?: string } | undefined {
  const { actorName, journal, startRunId } = input;
  const seen = new Set<string>();
  let runId: string | undefined = startRunId;

  while (runId !== undefined && !seen.has(runId)) {
    seen.add(runId);
    const matches = journal.listActors(runId).filter((actor) => actor.name === actorName);
    // 0 = 这一代根本没有这个 actor（链对该名字断了）；>1 = 重名，按名取会话是掷骰子。
    // 两种都停在这里而不是继续上溯：上一代的会话不是**这段**转录的源。
    if (matches.length !== 1) return undefined;
    const actor = matches[0]!;
    if (actor.sessionId !== undefined) {
      return {
        sessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      };
    }
    runId = journal.getRun(runId)?.resumedFrom;
  }
  return undefined;
}

/**
 * 源会话此刻的消息条数；读失败回 `undefined`。
 *
 * 两个读者共用这一次读取（见构建器的 `buildActorCandidate`）：
 * - 检查源会话是否达到已完成前缀的边界。条数不足或无法读取时，构建器丢弃该候选，让后继重新执行；driver 复制转录时仍会拒绝短于边界的源，防止写入不完整的上下文。
 * - 计算未完成 ask 的接续位置（见构建器的 `resolveInFlightAsk`）。
 *
 * 条数口径必须与 driver 记账及 core 历史恢复一致，均使用同一消息存储接口。
 */
export async function countSource(
  transcripts: ActorTranscriptStore,
  sessionId: string,
): Promise<number | undefined> {
  try {
    return (await transcripts.messages({ sessionID: sessionId as SessionId })).length;
  } catch {
    return undefined;
  }
}
