// ============================================================
// amend-resume 导入：缓存构建器（自 dynamic-workflow-import.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 556 行超过 400 行门禁。三叶中的构建器一叶（预检/门与依赖形状在
// import-preflight.ts，resume 重建入口在 import-rebuild.ts）：三道门 + actor 候选构建 +
// 在飞 ask 接续 + world 队列。依赖方向：preflight ← build ← rebuild，无环。
// 不变式论证（非 journal 事实的兜底等）在原文件头注释。
//
// 两处共用同一套构建规则（提交侧与重建侧）：修订 run 的 journal 只包含已消费的执行前缀，
// 未消费的导入需要重建。已完成条目只由 journal 决定，遍历顺序取自 journal 的插入序；未完成 ask 的边界还依赖源转录。

import type { Logger } from "@acode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedWorldEntry,
  NodeRecord,
} from "@acode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  completedAsksHaveBoundaries,
  countSource,
  resolveTranscriptSource,
  type AmendImportDeps,
  type AmendImportOptions,
  type BuildImportedCacheResult,
  type ImportedCacheJournalReader,
} from "./import-preflight.js";

/**
 * 读取前驱 journal 与转录状态，构建 {@link ImportedRunCache}。
 * 已完成前缀由 journal 决定；未完成 ask 的接续还取决于源会话条数与静默状态。
 *
 * 三道门按序（先门后建：门不过时一行都不必读）：
 *   1. 前驱不存在 → `run_not_found`；
 *   2. 前驱非终态 → `not_amendable`；
 *   3. 前驱有 completed 但无 `messageBoundary` 的 ask → `missing_boundaries`。
 *
 * 门 3 之所以**严格到全表**（而不是只检查真正会被导入的那些）：无 marker 只有两种成因——
 * marker 列引入之前写下的 journal，与 driver 侧记账失败——两者都意味着「这个 run 的边界记账不可信」，
 * 而不是「这一条恰好没记上」。逐条放行等于让一个记账半坏的前驱产出一张看似完整的表，
 * 分歧时截断到一个错误的位置（模型看见的上文与 journal 记的边界悄悄错位）。
 * 缺少已完成 ask 边界的 journal 整体拒绝，不合成可能错误的转录边界。
 * 未完结的 ask 没有边界是**正常**的（它们从不进导入前缀），所以门只看 completed 行。
 */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
  options?: AmendImportOptions,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // 可修订集 = 任意终态，**刻意不复用** plain resume 的 isResumableRecord：那个谓词是
  // byte-identical resume 的门（stopped），而修订恰恰对它排除的两类
  // 最有用——脚本真失败（修 bug 保缓存）与 completed（温启动扩展分析）。两个集合各说各的。
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId);
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  const actors = new Map<string, ImportedActorCandidate>();
  for (const record of namedUniqueActors(journal.listActors(predecessorRunId), logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      nodes,
      predecessorRunId,
      ...(options?.quietSessions === undefined ? {} : { quietSessions: options.quietSessions }),
      ...(transcripts === undefined ? {} : { transcripts }),
    });
    if (candidate !== undefined) actors.set(name, candidate);
  }

  return {
    ok: true,
    cache: { actors, world: buildWorldQueues(nodes) },
    resumedFrom: predecessorRunId,
  };
}

/**
 * 前驱里的**可作候选**的 actor 行：名字非空 ∧ 该名在本 run 内唯一。
 *
 * 匿名不收（名字是缓存身份键，没有名字就没有可比对的坐标）；重名**两个都不收**——
 * 引擎的 `DuplicateActorName` 是后加的运行期不变式，早于它写下的 journal 里可以真的存在重名行，而「按名取候选」在那种前驱上是掷骰子。挑一个不如都不挑：代价是这两个 actor 全新重跑，而错挑的代价是把另一个 actor 的会话前缀当成本 actor 的上文。
 */
function namedUniqueActors(records: ActorRecord[], logger?: Logger): ActorRecord[] {
  const byName = new Map<string, ActorRecord[]>();
  for (const record of records) {
    const name = record.name;
    if (name === undefined || name === "") continue;
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [record]);
    else bucket.push(record);
  }
  const unique: ActorRecord[] = [];
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      unique.push(bucket[0]!);
      continue;
    }
    logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
      actorName: name,
      count: bucket.length,
      event: "dynamic_workflow.amend.duplicate_actor_name",
      module: "bootstrap.app",
    });
  }
  return unique;
}

/**
 * 一个候选 actor 的可导入前缀 + 转录源。任一环节缺料即回 `undefined`（该 actor 全新重跑）。
 *
 * **降级而不失败**是这里的总基调（与门的「整体拒绝」相反）：缺前缀、缺 persona、链上无会话、
 * 源会话被清理，全都只是「这个 actor 没有缓存」——journal 里没有缓存行就是没有，不撒谎。
 * 唯一会整体拒绝的是边界记账不可信，因为那会让**已收下的**候选截断到错误位置。
 */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  nodes: NodeRecord[];
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, journal, logger, nodes, predecessorRunId, quietSessions, transcripts } = input;
  const name = actor.name!;

  // persona 是引擎在 createActor 时同步落的冻结身份，所以正常必在场；缺席只可能是被外力改写过的行。运行期比对没有比对物就无从谈起 persona 一致性——弃候选而不是拿 `{}` 顶。
  if (actor.persona === undefined) return undefined;

  const { entries, next } = completedAskPrefix(nodes, actor);
  // 既没有完结前缀、前缀后面也没有在飞的 ask：这个 actor 确实一点可导入的东西都没有。
  // 早退省掉下面的链行走与一次转录读。
  if (entries.length === 0 && next?.status !== "running") return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // 链上没有任何祖先持有该 actor 的会话（从未建过，或会话已被清理）。全保真转录是本特性的
    // 裁决，没有转录就没有可接续的上文——降级为全新 actor。
    logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
      actorName: name,
      event: "dynamic_workflow.amend.transcript_source_missing",
      module: "bootstrap.app",
      runId: predecessorRunId,
    });
    return undefined;
  }

  // 空前缀的边界是 0（没有任何完结交换，接续位置只能从 0 往后算）。
  const boundary = entries.length === 0 ? 0 : entries[entries.length - 1]!.messageBoundary;
  // 转录条数**只读一次**：源诚实性检查与在飞 ask 的接续位置用的是同一个数。读两次等于给同一个事实开两个观察窗，而它们之间可以不相等。
  const messageCount =
    transcripts === undefined ? undefined : await countSource(transcripts, source.sessionId);
  if (transcripts !== undefined && (messageCount === undefined || messageCount < boundary)) {
    logger?.warn?.(
      "Dynamic workflow amend: transcript source shorter than boundary, import dropped",
      {
        actorName: name,
        event: "dynamic_workflow.amend.transcript_source_short",
        messageBoundary: boundary,
        module: "bootstrap.app",
        sessionId: source.sessionId,
      },
    );
    return undefined;
  }

  const inFlight = resolveInFlightAsk({
    actor,
    boundary,
    ...(logger === undefined ? {} : { logger }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(next === undefined ? {} : { next }),
    predecessorRunId,
    ...(quietSessions === undefined ? {} : { quietSessions }),
    sourceSessionId: source.sessionId,
  });
  // 前缀为空且接续没谈成：这个候选一个字节都带不走，收下它只会让引擎为一张空表建会话。
  if (entries.length === 0 && inFlight === undefined) return undefined;

  return {
    persona: actor.persona,
    entries,
    ...(inFlight === undefined ? {} : { inFlight }),
    transcriptSourceSessionId: source.sessionId,
    ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
  };
}

/**
 * 前驱停下时**还在飞**的那条 ask。五个条件缺一不可：
 *
 *   1. 紧接前缀的那个位置上有一行，且它是 `running`——被取消的 ask 保留 running 行，所以停掉的
 *      run 也有；`failed` 与序号空洞都不是「还在飞」，它们只是前缀停下的另外两种理由；
 *   2. 转录源就是前驱**自己**那一行的会话：那半场未完的对话只存在于这里，从更早祖先解析出的源只承载完整前缀（chain 上每一跳都只保证前缀等价）；
 *   3. 数得出会话条数（有转录面且读得到）——没有数就没有接续位置，driver 也无从截断；
 *   4. 该会话已经**静默**，见 {@link AmendImportOptions.quietSessions}；
 *   5. 条数**严格大于**前缀边界。排队却从未派发的 ask 没有多出来的转录可带，而一个等于边界（或为 0）的 messageCount 会让 driver 播种出一段「其实就是前缀」甚至空无一物的种子，却把 actor 标记成接续过——分歧判定与转录内容随之对不上。
 *
 * 任一条不成立都只是**不接续**（完结前缀照旧导入），与本模块「降级而不失败」的总基调一致。
 */
function resolveInFlightAsk(input: {
  actor: ActorRecord;
  boundary: number;
  logger?: Logger;
  messageCount?: number;
  next?: NodeRecord;
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  sourceSessionId: string;
}): ImportedInFlightAsk | undefined {
  const { actor, boundary, logger, messageCount, next, quietSessions, sourceSessionId } = input;
  if (next === undefined || next.status !== "running") return undefined;

  const drop = (reason: string): undefined => {
    logger?.info?.("Dynamic workflow amend: in-flight ask not carried", {
      actorName: actor.name,
      event: "dynamic_workflow.amend.in_flight_dropped",
      module: "bootstrap.app",
      reason,
      runId: input.predecessorRunId,
      sessionId: sourceSessionId,
    });
    return undefined;
  };

  if (actor.sessionId === undefined || actor.sessionId !== sourceSessionId) {
    return drop("transcript_source_is_ancestor");
  }
  if (messageCount === undefined) return drop("no_transcript_count");
  // 缺席 = 全部静默（见 {@link AmendImportOptions.quietSessions}）。
  if (quietSessions !== undefined && !quietSessions.has(sourceSessionId)) {
    return drop("session_not_quiescent");
  }
  if (messageCount <= boundary) return drop("no_transcript_beyond_prefix");

  return { inputHash: next.inputHash, messageBoundary: messageCount };
}

/**
 * 该 actor 的**最长全 completed ask 前缀**（按 actorSeq 0..k 连续），外加**紧接其后**那一行。
 *
 * 前缀在第一个非 completed 处停死，三种停法同一处理：失败、崩溃中（running）、序号空洞。
 * 失败的 ask 对新 run **无约束力**（模型有随机性，修订常常就是为了越过一次失败），所以它自己不导入；但跳过它去导入其后的条目会走私上下文——被跳过那一轮的问答仍在源会话转录里，而缓存却声称它没发生过。停在第一个非 completed 处是唯一自洽的读法。
 *
 * `next` 就是**让前缀停下的**那一行（空洞时缺席）。它与前缀同来同走，因为「在飞的那条 ask」
 * 按定义正是这一行：另起一次遍历去找 `actorSeq === entries.length` 的行，等于把「紧接前缀」这个坐标在两处各算一次。
 */
function completedAskPrefix(
  nodes: NodeRecord[],
  actor: ActorRecord,
): { entries: ImportedAskEntry[]; next?: NodeRecord } {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of nodes) {
    if (node.kind !== "ask") continue;
    if (node.actorSiteId !== actor.siteId || node.actorOrdinal !== actor.ordinal) continue;
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") {
      return { entries, ...(node === undefined ? {} : { next: node }) };
    }
    // 边界必在场：门 3 已对整个前驱把关，所以这里不是乐观读而是不变式的兑现。
    const entry: ImportedAskEntry = {
      inputHash: node.inputHash,
      result: node.result,
      messageBoundary: node.messageBoundary!,
    };
    if (node.stats !== undefined) entry.stats = node.stats;
    entries.push(entry);
  }
}

/**
 * world 节点的内容表：`inputHash` → 按 journal 插入序排好的记录队列（第 n 次出现对第 n 条）。
 *
 * 键直接用**前驱记录的 inputHash**，不重算：引擎对 `{op,args}` 的哈希口径（engine.ts 的 worldRead）就是写进这一列的那个值，重算一遍等于在这里复制一份哈希契约，而它一旦漂移，表面上是「缓存莫名不命中」。
 *
 * 只收 completed：失败的世界读取重新执行（失败对新 run 无约束力），running 的更不必说。
 * world-run 与 world-read 同表——导入 world-run 是**安全特性**而不是优化：修订续跑绝不静默重放一次已 journal 的效应（部署脚本跑两次）。
 */
function buildWorldQueues(nodes: NodeRecord[]): ReadonlyMap<string, ImportedWorldEntry[]> {
  const world = new Map<string, ImportedWorldEntry[]>();
  for (const node of nodes) {
    if (node.kind !== "world-read" && node.kind !== "world-run") continue;
    if (node.status !== "completed") continue;
    const queue = world.get(node.inputHash);
    const entry: ImportedWorldEntry = {
      inputHash: node.inputHash,
      kind: node.kind,
      result: node.result,
    };
    if (queue === undefined) world.set(node.inputHash, [entry]);
    else queue.push(entry);
  }
  return world;
}
