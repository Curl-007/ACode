// K1 会话级语义召回通道（specs/memory-semantic-recall.md R6/R9）：
// turn-loop 主 turn 开始处采集 query（最新用户消息纯文本投影）→ 检索管线选 top-K
// → J3-2 injector 全量协议注入（capture→verify→dedupe 四层→render，reference 形态）
// → 以 reminder 动态段（system-reminder source: memory_semantic_recall）进入当前 turn。
// 通道实例（injector+检索管线+去重账本+度量账本）挂 runtime 字段，会话唯一所有者，
// **不用模块级全局**（J3-2 R5/R7 的既有要求）。

import { join } from "node:path";

import { traceContextToLogContext, type TraceContext } from "../deps.js";
import type { RuntimeMessageEntry, RuntimeMessageMessageEntry } from "../../agent/message-history.js";
import { isRuntimeAttachmentEntry } from "../../agent/message-history.js";
import {
  createMemoryRecallInjector,
  resolveMemoryIdentityKey,
  type MemoryRecallInjector,
} from "../../memory/recall/pending.js";
import {
  RETRIEVAL_CONSTANTS,
  createMemoryRetrievalPipeline,
  createRecallMetricsLedger,
  recallQueryHash,
  type MemoryRetrievalPipeline,
  type RecallMetricsLedger,
} from "../../memory/recall/retrieval/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

/** 会话级通道实例（R9 状态所有权表：runtime 字段，生命周期=会话）。 */
export interface MemorySemanticRecallChannel {
  /** J3-2 注入通道：闭包内持有四层去重账本（R5/R7），随本实例会话级存在。 */
  injector: MemoryRecallInjector;
  pipeline: MemoryRetrievalPipeline;
  metrics: RecallMetricsLedger;
}

/**
 * 每 turn 的语义召回注入入口。返回 reminder 正文（注入成功时）或 null（本轮不注入：
 * 静默期/空 query/记忆停用/检索零候选/注入协议拒绝或抑制——全部是正常分支，不 warn）。
 * 检索层与注入层都不改写上下文快照；context section（冻结索引）不被触碰（R6）。
 */
export async function buildSemanticMemoryRecallReminderBody(
  runtime: AgentRuntimeInternal,
  input: {
    entries: readonly RuntimeMessageEntry[];
    traceContext: TraceContext;
  },
): Promise<string | null> {
  // 与 Extraction 通道对齐的 gate：远程 workspace 的 fileSystemPort 打到远端机器，
  // resolve 出的记忆目录路径在远端不存在（记忆目录是本地 cliStorageRoot 形态），
  // 检索只会在远端读出空目录/报错，本轮不开放远程检索（specs/memory-semantic-recall.md
  // 未做 §4 同源：跨项目/跨端记忆面需要独立产品决策）。
  if (runtime.isRemoteWorkspace()) return null;
  const fileSystem = runtime.fileSystemPort;
  if (!fileSystem) return null;
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return null;
  const cliStorageRoot = runtime.config.memory?.cliStorageRoot;
  if (!cliStorageRoot) return null;

  // R6 query 采集：最新真实用户消息的纯文本投影（图片/附件 block 天然被剥离——
  // 投影只取 text block）；空 query 跳过本轮检索。
  const query = latestRealUserPlainTextQuery(input.entries);
  if (!query) return null;
  // R6 静默期：会话首轮（最新用户消息之前没有任何真实对话）不检索——第一条用户
  // 消息就是任务书，检索噪声大于收益；从第二轮起启用。
  if (RETRIEVAL_CONSTANTS.RECALL_FIRST_TURN_SKIP && isFirstConversationTurn(input.entries)) {
    return null;
  }

  const channel = ensureChannel(runtime, { cliStorageRoot, fileSystem });
  const scope = {
    identityKey: resolveMemoryIdentityKey({
      workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      workspacePath: runtime.workspaceRoot,
    }),
    memoryRoot,
  };
  const startedAt = Date.now();

  // 检索层异常按 fail-open 处理（R1：检索可以降级，注入永不放松）：通道任何一步抛错
  // 都只损失本轮注入，绝不阻塞主 turn 的模型请求。
  try {
    const retrieval = await channel.pipeline.retrieve({
      query,
      scope,
      traceContext: input.traceContext,
    });
    if (retrieval.status === "rejected") {
      await channel.metrics.record({ event: "discarded", reason: retrieval.reason });
      return null;
    }
    await channel.metrics.record({
      candidateCount: retrieval.candidates.length,
      durationMs: Date.now() - startedAt,
      event: "retrieval",
      phaseMask: retrieval.phaseMask,
      topK: RETRIEVAL_CONSTANTS.RECALL_TOP_K,
    });
    if (retrieval.candidates.length === 0) return null;

    // 注入层：候选路径限定 top-K（R1「capture 只对这 K 条」），presentation=reference
    // （R6：memory_N 指代，不渲染路径/name；不可信声明段由 J3-2 渲染层带出）。
    const injection = await channel.injector.inject({
      candidatePaths: retrieval.candidates.map((candidate) => candidate.entry.filePath),
      identityKey: scope.identityKey,
      memoryRoot,
      presentation: "reference",
      traceContext: input.traceContext,
    });
    switch (injection.status) {
      case "injected":
        await channel.metrics.record({
          entryCount: injection.snapshot.entries.length,
          event: "injected",
          queryHash: recallQueryHash(query),
        });
        return injection.text;
      case "suppressed":
        await channel.metrics.record({ event: "suppressed", reason: injection.reason });
        return null;
      case "discarded":
        await channel.metrics.record({ event: "discarded", reason: injection.reason });
        return null;
      case "empty":
        return null;
    }
  } catch (error) {
    // 中止信号上抛（turn 已被取消，不是通道故障）；其余异常 fail-open + warn
    // （与 project-memory-extraction.ts 的 isAbortError 同一口径）。
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    runtime.logger?.warn("Memory semantic recall channel failed open", {
      ...traceContextToLogContext(input.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "memory.recall.channel_failed",
      module: "core.memory",
      status: "failed",
    });
    return null;
  }
}

/**
 * 惰性构造会话级通道（R6/R9）。injector 与 pipeline 共用同一个 fileSystem 端口实例
 * （检索层与注入层的文件视图一致，签名判定才同源）。度量账本落数据根目录
 * `memories/metrics/`（R8）。
 */
function ensureChannel(
  runtime: AgentRuntimeInternal,
  deps: { cliStorageRoot: string; fileSystem: NonNullable<AgentRuntimeInternal["fileSystemPort"]> },
): MemorySemanticRecallChannel {
  if (runtime.memorySemanticRecallChannel) return runtime.memorySemanticRecallChannel;
  // injector 先构造、pipeline 引用同一实例：账本与协议状态单一所有者（R9）。
  const injector = createMemoryRecallInjector({
    fileSystem: deps.fileSystem,
    logger: runtime.logger,
  });
  const channel: MemorySemanticRecallChannel = {
    injector,
    metrics: createRecallMetricsLedger({
      logger: runtime.logger,
      metricsRoot: join(deps.cliStorageRoot, "memories", "metrics"),
    }),
    pipeline: createMemoryRetrievalPipeline({
      fileSystem: deps.fileSystem,
      injector,
      logger: runtime.logger,
    }),
  };
  runtime.memorySemanticRecallChannel = channel;
  return channel;
}

/**
 * 最新真实用户消息的纯文本投影（R6）：只取 text block，图片/视频/PDF 等 block
 * 天然剥离。找不到真实用户消息（纯 synthetic/automation 输入）返回 undefined。
 */
export function latestRealUserPlainTextQuery(
  entries: readonly RuntimeMessageEntry[],
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "user") continue;
    if (entry.metadata?.source !== "real_user") continue;
    const text = plainTextProjection(entry);
    return text.trim().length > 0 ? text : undefined;
  }
  return undefined;
}

function plainTextProjection(entry: RuntimeMessageMessageEntry): string {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 会话首轮判定（R6 静默期）：整个可见历史里只有一条真实用户消息、且其后没有任何
 * assistant 回复——即「这条消息就是任务书」。resume 场景历史恢复后天然非首轮。
 * attachment（reminder 等）不参与判定。
 */
export function isFirstConversationTurn(entries: readonly RuntimeMessageEntry[]): boolean {
  let realUserCount = 0;
  for (const entry of entries) {
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "assistant") return false;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      realUserCount += 1;
      if (realUserCount > 1) return false;
    }
  }
  return realUserCount === 1;
}
