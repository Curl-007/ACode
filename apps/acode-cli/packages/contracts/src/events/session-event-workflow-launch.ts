// ============================================================
// Session Event workflow launch payloads - 启动轮元数据与后台结果元信息
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载工作流启动轮元数据（WorkflowLaunchMeta 及有界函数）与后台结果元信息
// （TurnAttachmentMeta / WorkflowNotificationMeta / BackgroundResultOriginMeta 等），
// 供 turn 叶复用。依赖方向（DAG）：tools/tool-result-metadata / tools/saved-workflow →
// 本文件 → turn 叶 → session.events.ts 桶。
// boundWorkflowLaunchMeta 使用全局 Buffer.byteLength（Node ambient global），无需 import。

import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";

/**
 * 附件渲染（additive）：用户输入附件的轻量展示元信息，随 TurnStarted 下发，
 * v4 投影据此填 userInput row 的 attachments。
 * 只承载展示所需字段，不含内容本体（内容经 resolve/persist 走 FilePart/artifact）。
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** 内容引用（本地路径 / artifact URI）；data URL 等无稳定引用时缺省。 */
  ref?: string;
}

/**
 * workflow 通知的结构化载荷。
 * 发射侧铸造、有界（summary≤500 / result≤4000 / error≤2000 / reports.preview 逐条≤500、≤8 条 /
 * artifacts ≤8 条、title≤120 / question·context≤4000）；与 shared 的
 * workflowNotificationMetaSchema 保持手工同步。
 * 批量通知轮刻意不携带——一轮一张 manifest 的对应关系在批量下不成立。
 */
export type WorkflowNotificationMeta =
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      /** `status === "stopped"` 才在场。 */
      stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
      summary: string;
      result?: string;
      resultForm?: "prose" | "json";
      resultTruncated?: true;
      error?: string;
      reports?: { count: number; shown: number; preview: string[] };
      /**
       * 用户面产物的 chips 载荷：≤ 8 条，
       * 超出（含被种类过滤掉的）置 `artifactsTruncated`。
       *
       * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与同一载荷上的
       * `result`（脚本顶层返回值，引擎内部也叫 artifact）是两件不同的东西。
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** run 的交付物；清单以它带头。只有它带 `description`（完成卡的交付物行要念）。 */
        primary?: true;
        description?: string;
      }[];
      artifactsTruncated?: true;
      durationMs?: number;
    }
  | {
      kind: "escalation";
      qid: string;
      actor: string;
      question: string;
      context?: string;
      askedAt?: number;
    }
  /** run 级停滞：每个 stall 段一条，不是终态。 */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    }
  /** hole 停靠中途唤醒（specs/workflow-hole-wake.md）：每个 hole-reached 至多一条。 */
  | {
      kind: "hole-waiting";
      holeId: string;
      ordinal: number;
      stage: string;
      prompt: string;
    };

/** 独立后台结果轮的展示元信息；批量轮可复用代表任务身份并合成 title，不从通知文本反向解析。 */
export interface BackgroundResultOriginMeta {
  /** `workflow` 是 dynamic-workflow run（workId ≡ runId），复用整条后台通知管线。 */
  backgroundSource: "bash" | "subagent" | "workflow";
  workId: string;
  title: string;
  /** 只在 backgroundSource === "workflow" 的单条通知轮上在场；manifest 渲染的唯一数据源。 */
  workflowNotification?: WorkflowNotificationMeta;
}

/**
 * turn 是否承载真实 Agent 执行。controlOnly 只为可见控制输入建立时间线边界，
 * 不得推进 session running/activeWorks，也不应产生“工作中/已工作”状态。
 */
export type TurnExecutionKind = "agent" | "controlOnly";

export type OffPeakRunType = "init" | "resume";

export type TurnBackgroundAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: OffPeakRunType;
      automationId?: never;
    }
  | {
      automationId?: undefined;
      offPeakTaskId?: undefined;
      offPeakRunType?: never;
    };

/**
 * 中枢直接启动已保存工作流的启动轮元数据。同一份同时写进 user message 的 `metadata`（冷恢复来源）与 `TurnStarted`
 * payload（活投影来源）——冷热同形，投影据它画启动卡而不是显示文本。
 */
/** 启动元数据上的 display 只允许 create_workflow 这一种投影（与 shared 行 schema 同形）。 */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * 设置轮的「改了什么」：只有改动过的设置在场，
 * 每项 from / to 缺一端即那一端是默认（模型 = 会话模型，上限 = 本机上限）。`ceiling` 是本机上限，
 * 供「13 → 4」这种读法。与 shared 的 `workflowSettingsAmendMetaSchema` 同形。
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * 被这次调整替代（或接着跑）的那个 run。**缺席即就地生效**：只改并发上界、run 又还在飞时，
   * 那次「配置」既不停这次 run 也不另起一次，于是没有前驱可指——`runId` 指的就是被调整的那一个。
   * 与 shared 的 `workflowSettingsAmendMetaSchema` 同形。
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** run 的身份（≡ backgroundTaskId ≡ cancelBackgroundWork 的 workId）。 */
  runId: string;
  /**
   * 启动这次 run 的合成 toolCall id（中枢启动 `launch-<uuid>`，设置轮 `settings-<uuid>`；
   * 工具卡 → 详情页关联键）。
   */
  toolCallId: string;
  /**
   * 工作流名（解析结果，非用户/模型可覆盖）；启动卡题名与会话标题都取它。中枢启动恒在场；设置轮取被
   * 调整的 run 自己的名字，无名 run 即缺席（UI 换用兜底词，不拿 run id 当标题）。
   */
  name?: string;
  /** 解析出的实际作用域（不是请求里可能缺席的 scope）。只属于中枢启动：设置轮没有保存文件可指。 */
  scope?: SavedWorkflowScope;
  /** 保存文件的落点，用于详情/诊断；不参与执行。只属于中枢启动。 */
  path?: string;
  /** 本次 run 的实参（已按声明校验并回填默认值）；有界见 {@link boundWorkflowLaunchMeta}。 */
  args?: Record<string, unknown>;
  /** 工作流说明（saved 元数据的 description），有界 ≤ 500 字符。 */
  description?: string;
  /**
   * 启动前编译得到的 `create_workflow` 结果 display（有界因果图 + 诊断），与 CreateWorkflow 工具行
   * `display` 同一投影、同一构造函数。run 详情侧板按 toolCallId 找「发起行」取图——直接启动没有
   * 工具行，图就从这里取。
   */
  display?: WorkflowLaunchDisplay;
  /**
   * 本次 run 实际执行的脚本原文（与 `port.submit.scriptText` 同一份）。工具路径把它放在工具入参
   * `input.script` 上供侧板 Script 区读取，这里是同一事实的启动轮落点；有界见
   * {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS}（超界整体缺席，侧板 Script 区随之缺席）。
   */
  script?: string;
  /** 设置轮才在场：这次 run 是用「配置」从哪个 run 修订来的、改了什么。 */
  amend?: WorkflowSettingsAmendMeta;
}

/** {@link WorkflowLaunchMeta.args} 的 JSON 序列化上界（字节）。超界即丢，换成一个标记键。 */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** {@link WorkflowLaunchMeta.description} 的字符上界。 */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * {@link WorkflowLaunchMeta.script} 的字符上界。工具路径的 `input.script` 本就不设界地进转写，
 * 这里取一个远大于任何合理 dwf 脚本、又能挡住误塞整份仓库的上限；超界整体缺席而非截断
 * （半截脚本对 Script 区没有意义，图仍在 display 里）。
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * args 超界时的替身键。真实实参永远走模型面的规范句（那份不截断），这里的元数据只喂启动卡；
 * 一个大到 4KB 的实参袋在卡上本就无从展示，所以整体替换成单条可读标记而不是硬塞。用省略号
 * 作键：它落在 `SAVED_WORKFLOW_NAME_PATTERN` 之外，不可能与真实实参名相撞。
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * 把启动轮元数据收进边界内。args 序列化后超 {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES} 即整体
 * 换成 `{ "…": "arguments omitted (N bytes)" }` 标记（见 {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY}）；
 * description 超 {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} 即截断加省略号。铸造侧就地调用，
 * 让 message metadata 与 TurnStarted payload 拿到同一份有界值。
 */
export function boundWorkflowLaunchMeta(input: WorkflowLaunchMeta): WorkflowLaunchMeta {
  const bounded: WorkflowLaunchMeta = {
    runId: input.runId,
    toolCallId: input.toolCallId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.args !== undefined) {
    const serialized = JSON.stringify(input.args);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    bounded.args =
      bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES
        ? { [WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY]: `arguments omitted (${bytes} bytes)` }
        : input.args;
  }
  if (input.description !== undefined) {
    bounded.description =
      input.description.length > WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS
        ? `${input.description.slice(0, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS - 1)}…`
        : input.description;
  }
  // display 已在构造处（createCreateWorkflowDisplay + boundCausalityGraph）限长，原样透传。
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // amend 块本身有界（两个模型串由调用方取自已解析的规范形，与 run 状态同一条上界）。
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}
