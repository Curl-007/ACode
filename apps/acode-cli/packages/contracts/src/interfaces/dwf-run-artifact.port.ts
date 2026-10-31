// ============================================================
// Dynamic Workflow Run Port：用户面产物与待答问题类型（叶子文件）
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出（批次 B 例外债务偿还：原文件超
// architecture-policy 的 max-file-lines）。主端口文件 `export type *` 原样再导出，
// 消费方导入路径不变。

/**
 * 一个用户面产物的一个版本（journal `dwf_node.result_json` 上 `ArtifactVersionRecord` 的
 * JSON 镜像）。**刻意在这里重新声明**而不是从 @acode/dynamic-workflow import：端口只承载
 * JSON 形状（与 {@link DynamicWorkflowRunLifecycleStatus} 同一条论证）。
 *
 * 内容产物（`file` / `markdown`）填 `contentType` / `bytes` / `uri` / `sourcePath`；预置看板
 * （`chart` / `table` / `metrics` / `board`）填 `spec`。字节永不在这里——`uri` 指向
 * tool-artifact store。
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 发布时刻（epoch 毫秒）。driver 恒写入。 */
  publishedAt: number;
  /** 这一版属于 run 的交付物。 */
  primary?: true;
}

/** 用户面产物的成员种类（facade `artifact.*` 的六个成员）。 */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * 一个用户面产物：id 下的全部版本（按版本号升序）+ 喂给它的标签 report 计数。
 * `title` / `description` / `contentType` / `sourcePath` / `spec` 取**最新版**的值，方便
 * 只关心「现在是什么」的读者不必自己翻 versions。
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 最新版号（= versions 末项的 version）。 */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。 */
  itemCount: number;
  /** run 的交付物（至多一件）。`artifacts` 清单以它带头，其余按首次发布顺序。 */
  primary?: true;
}

/** 喂给某个预置产物的一条 `report` 条目，按 journal sequence 定位（看板的取数面）。 */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
}

/** {@link DynamicWorkflowRunPort.listArtifactItems} 的分页袋（cursor = journal sequence，严格大于）。 */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  /** 必填；调用方可传「上限 + 1」探测 hasMore，实现方不得再钳。 */
  limit: number;
}

/** {@link DynamicWorkflowRunPort.readArtifact} 的返回：某个版本的全部字节。 */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** 一个停驻中的升级问题。字段与 `escalation-raised` 事件同源，另加提问时刻。 */
export interface DynamicWorkflowRunPendingQuestion {
  /** 全局唯一的问题 id（形如 `dwfq-<runId 片段>-<seq>`）；`resolveQuestion` 只认它。 */
  qid: string;
  /** 提问的 actor，`refToString` 形态（如 `actor#1@1`）。恒在场，且在 run 内唯一定位。 */
  actor: string;
  /**
   * 这个 actor 的人类可读名（脚本里 `agent("poet")` 的 `"poet"`）。
   *
   * **匿名 actor 缺席本字段，且这里不合成任何兜底标签**：兜底是渲染决策，通知面与侧栏各有
   * 各的合适写法（一个要读成句子，一个要塞进一列）。在这里合成一个「actor#1@1」当名字，
   * 只会让两个消费者都拿不回「这个 actor 其实没有名字」这条事实。
   */
  actorName?: string;
  question: string;
  /** actor 补充的上下文（`escalate` 的可选 `context`）。 */
  context?: string;
  /** 提问时刻（epoch ms）。主代理据它判断「这个问题已经等了多久」。 */
  askedAt: number;
}

/**
 * {@link DynamicWorkflowRunPort.resolveQuestion} 的结构化拒绝理由。三者对模型是**三个不同的
 * 下一步**，所以必须可分辨：去快照里取正确的 id / 什么都不用做 / 这个 run 已经不需要答案了。
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  /** 注册表里没有这个 qid：拼错了，或来自已亡故进程的陈旧 id（停驻项不持久化）。 */
  | "unknown_question"
  /** 这个问题已经被回答过，actor 早已带着那次答案继续。 */
  | "already_resolved"
  /** qid 所属的 run / ask 已不在飞行中（被取消、失败或已结束），没有人在等这个答案。 */
  | "run_not_in_flight";

/**
 * `resolveQuestion` 的结构化结果。失败走 reason 而不是 throw，与
 * {@link DynamicWorkflowRunSubmitResult} 同一条论证：三种理由全是调用方可预期的业务分支。
 *
 * `message` 由实现侧写好（陈述现状与下一步）而不是留给工具层拼：判别键与文案分开维护，
 * 两处迟早会说不同的话，而这里的读者是模型——它读到的就是它的下一步。
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };
