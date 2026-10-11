// ============================================================
// Dynamic Workflow Run Service：fillHole（挖洞-填充的 supersede 续跑链）
// ============================================================
// specs/workflow-holes.md 的服务端实现。为什么继续 = amend/supersede 而不是原地改脚本：
// resume 的 scriptHash 逐字节校验（engine.ts 构造期）使「同 runId + 新脚本」根本走不通，
// 而 fill 的产物恰恰是一份新脚本——于是复用 amend 的整条链（停前驱 → 等结算 → 从 journal
// 导入缓存 → 启动后继），再补两件 fill 特有的事：
//   1. splice：读 run 草稿，把洞调用 AST 级替换成 `await (async () => { <fill 语句> })()`
//      （dynamic-workflow 的 spliceWorkflowHole，确定性纯函数）；
//   2. `hole-filled` 事件：成功后记到**前驱**的事件流上（holeId + 后继 id + 新旧
//      scriptHash + fill 文件），journal 与进度两条轨同发——`reduce(transcript) ≡
//      reduce(events)` 的黄金不变式因此覆盖 hole 事件。
//
// 顺序就是全部的语义（被拒时零副作用：前驱照旧停驻、草稿未动）：
//   1. 在飞 + 在该洞等待的判定（注册表 + journal 事件）；
//   2. splice + 重编译——诊断 ⇒ `fill_compile_failed`，**在前驱被停之前**拒绝；
//   3. amend 链（预检 → 停前驱 → 导入 → 启动后继）；
//   4. 成功后记 hole-filled。
// 「每 run 每洞至多一次 fill」不需要独立的账本：fill 成功即前驱 settle
// （superseded），此后的 fill 在第 1 步就得到 `hole_not_waiting`。

import { createHash } from "node:crypto";
import type {
  DynamicWorkflowFillHoleRequest,
  DynamicWorkflowFillHoleResult,
} from "@acode/contracts";
import {
  spliceWorkflowHole,
  type CompileDiagnostic,
  type RunEvent,
} from "@acode/dynamic-workflow";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { compileOnce } from "./dynamic-workflow-run-compile.js";
import { readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import { parseModelPickerValue } from "@acode/shared/model-selection";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-deps.js";
import { amendDynamicWorkflowRun, type DynamicWorkflowRunEntryContext } from "./dynamic-workflow-run-submit.js";

/** hole_ref 的形态：`hole#N@ordinal`。服务端只信 journal 里铸出来的那种。 */
const HOLE_REF_PATTERN = /^(.+)@(\d+)$/;

/**
 * `DynamicWorkflowRunPort.fillHole` 的实现体。ctx 与 submit/amend 共享同一份注册表、
 * 停驻表与结算簿记（见 {@link DynamicWorkflowRunEntryContext}）；本文件不持有自己的状态。
 */
export async function fillWorkflowHole(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowFillHoleRequest,
): Promise<DynamicWorkflowFillHoleResult> {
  const { deps, runs } = ctx;
  const { runId, holeId, fill } = request;

  // ——— 1. 在飞 + 在该洞等待 ———
  // 在飞判定看本进程注册表（与 amend 同一条纪律：journal 说 running 而注册表没有它，是
  // 别的进程的 run，本 service 停不了也填不了）。
  const entry = runs.get(runId);
  if (entry === undefined || entry.terminal !== undefined) {
    return {
      ok: false,
      reason: "hole_not_waiting",
      message: holeNotWaitingMessage(
        runId,
        holeId,
        entry === undefined
          ? "it is not running in this session (it settled, or another process owns it)"
          : "it has already settled",
      ),
    };
  }
  const ref = HOLE_REF_PATTERN.exec(holeId);
  if (ref === null) {
    return {
      ok: false,
      reason: "hole_not_waiting",
      message: holeNotWaitingMessage(
        runId,
        holeId,
        "a hole ref is shaped `hole#N@ordinal` (e.g. `hole#1@1`) — take it from GetWorkflowRun's pending holes",
      ),
    };
  }
  // 等待判定读 journal 事件（hole 的等待**就是**事件事实：hole-reached 起期、hole-filled /
  // run-settled 止期；与升级停驻的内存 deferred 不同源，见 detail.pendingHoles 的注释）。
  const waiting = waitingHoleOf(deps.journal.listEvents(runId, {}), holeId);
  if (waiting === undefined) {
    return {
      ok: false,
      reason: "hole_not_waiting",
      message: holeNotWaitingMessage(
        runId,
        holeId,
        "the run never parked at that hole (unknown id, or it has not been reached yet)",
      ),
    };
  }

  // ——— 2. splice + 重编译（前驱仍是活的；被拒时零副作用） ———
  const draft = entry.scriptText ?? deps.journal.getRun(runId)?.scriptText;
  if (draft === undefined) {
    return {
      ok: false,
      reason: "hole_not_waiting",
      message: holeNotWaitingMessage(runId, holeId, "its journal row has no stored script to splice"),
    };
  }
  const previousScriptHash = sha256(draft);
  // 形态已在上面验过（`site@ordinal`）；空串的站点 id 会落进 splice 的 hole_not_found。
  const spliced = spliceWorkflowHole(draft, ref[1] ?? "", fill);
  if (!spliced.ok) {
    return spliceFailureFor(spliced.reason, spliced.diagnostics, runId, holeId, request.fillPath);
  }
  // 重编译在前驱被停**之前**：诊断 ⇒ 洞仍等待、草稿未变、什么都不被停。compileOnce 与
  // amend/submit 的启动编译是同一个函数（含 9005 洞规则——fill 里嵌进 fan-out 回调的洞
  // 只能被这道闸挡下）。
  let compiled;
  try {
    compiled = compileOnce(spliced.scriptText);
  } catch (cause) {
    return {
      ok: false,
      reason: "fill_compile_failed",
      message: fillCompileMessage(runId, holeId, request.fillPath, cause),
    };
  }

  // ——— 3. amend 链：停前驱 → 导入 → 启动后继 ———
  // 并发上界沿用前驱**落库的那一份**（fill 不改设定，静默换档不是 fill 的事）；子代理模型
  // 同理（修订链上换模型是 AmendWorkflow 的显式动作）。阶段表由工具层从同一份 splice 产物
  // 的分析里算好递进来。
  const predecessorModel = readRunSubagentModel(deps.journal, runId);
  const amended = await amendDynamicWorkflowRun(ctx, {
    scriptText: spliced.scriptText,
    cwd: request.cwd,
    predecessorRunId: runId,
    parentSessionId: request.parentSessionId,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    // 注册表条目的间隙副本与 journal 行同源（submit 时落的就是钳过的生效值）。
    maxConcurrency: entry.maxConcurrency,
    ...(predecessorModel === undefined ? {} : { subagentModel: parseModelPickerValue(predecessorModel) }),
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    trace: request.trace,
  });
  if (!amended.ok) {
    // 预检被拒（缺消息边界记账的远古 journal）：前驱未被停、洞仍在等。结构化拒绝而非
    // throw——这是调用方可预期的业务分支，且有明确的下一步（放弃 fill，改走整脚本修订）。
    deps.logger?.info?.("Dynamic workflow hole fill refused by the amendment preflight", {
      event: "dynamic_workflow.hole_fill.preflight_refused",
      module: "bootstrap.app",
      holeId,
      predecessorRunId: runId,
      reason: amended.reason,
    });
    return {
      ok: false,
      reason: "hole_not_waiting",
      message:
        `Run ${runId} is waiting at hole ${holeId}, but its journal predates transcript-boundary ` +
        `bookkeeping, so the fill cannot continue it along the revision chain (reason: ` +
        `${amended.reason}). The hole is still waiting and nothing was stopped. Splice the fill ` +
        `in by hand and continue with AmendWorkflow on the revised script instead.`,
    };
  }

  // ——— 4. hole-filled：成功后记到前驱的事件流（journal + 进度双轨） ———
  recordHoleFilled(deps, runId, {
    type: "hole-filled",
    holeId,
    succeededBy: amended.runId,
    previousScriptHash,
    nextScriptHash: compiled.scriptHash,
    ...(request.fillPath === undefined ? {} : { fillPath: request.fillPath }),
  });
  const importClosed = deps.journal
    .listEvents(runId, {})
    .some(({ event }) => event.type === "import-cache-closed");
  deps.logger?.info?.("Dynamic workflow hole filled; run superseded by its successor", {
    event: "dynamic_workflow.hole_fill.superseded",
    module: "bootstrap.app",
    holeId,
    predecessorRunId: runId,
    runId: amended.runId,
  });
  return {
    ok: true,
    runId: amended.runId,
    ...(amended.supersededRunId === undefined ? {} : { supersededRunId: amended.supersededRunId }),
    ...(request.fillPath === undefined ? {} : { fillPath: request.fillPath }),
    cacheImported: !importClosed,
    ...(importClosed
      ? {
          cacheImportedReason:
            "The predecessor run's workspace was modified after some results were recorded " +
            "(a mutating tool or a live world.run closed its import cache), so cached work is " +
            "not trusted and the affected steps re-run. Safety over reuse; the rest of the " +
            "finished work still imports.",
        }
      : {}),
  };
}

/**
 * journal 事件里这个洞的「等待事实」：最后一条 hole-reached(holeId) 之后没有 hole-filled
 * 同 id、也没有 run-settled ⇒ 在等。返回那条 reached 事件（供诊断），否则 undefined。
 */
function waitingHoleOf(
  stored: readonly { event: RunEvent }[],
  holeId: string,
): { event: RunEvent } | undefined {
  let reached: { event: RunEvent } | undefined;
  for (const item of stored) {
    const { event } = item;
    if (event.type === "hole-reached" && event.holeId === holeId) reached = item;
    if (event.type === "hole-filled" && event.holeId === holeId) return undefined;
    if (event.type === "run-settled") return undefined;
  }
  return reached;
}

/** splice 三种结构化失败 → fill_compile_failed / hole_not_waiting（hole_not_found 即未知 id）。 */
function spliceFailureFor(
  reason: "hole_not_found" | "fill_invalid" | "script_invalid",
  diagnostics: readonly CompileDiagnostic[],
  runId: string,
  holeId: string,
  fillPath: string | undefined,
): DynamicWorkflowFillHoleResult {
  if (reason === "hole_not_found") {
    return {
      ok: false,
      reason: "hole_not_waiting",
      message: holeNotWaitingMessage(runId, holeId, "no hole site in the run's script matches it"),
    };
  }
  return {
    ok: false,
    reason: "fill_compile_failed",
    message: [
      `The fill for hole ${holeId} of run ${runId} does not hold:`,
      ...diagnostics.map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`),
      "",
      "Nothing was spliced and the hole is still waiting — the run keeps its draft untouched.",
      fillPath === undefined
        ? "Fix the statements and submit again."
        : `The fill file at ${fillPath} has the exact bytes; edit it and resubmit with \`path\` instead of pasting the script again.`,
    ].join("\n"),
  };
}

function fillCompileMessage(
  runId: string,
  holeId: string,
  fillPath: string | undefined,
  cause: unknown,
): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const bounded = detail.length > 2000 ? `${detail.slice(0, 1999)}…` : detail;
  return [
    `Splicing the fill into run ${runId} produced a script that does not compile (hole ${holeId}):`,
    bounded,
    "",
    "Nothing was spliced and the hole is still waiting — the run keeps its draft untouched.",
    fillPath === undefined
      ? "Fix the statements and submit again."
      : `The fill file at ${fillPath} has the exact bytes; edit it and resubmit with \`path\`.`,
  ].join("\n");
}

function holeNotWaitingMessage(runId: string, holeId: string, why: string): string {
  return (
    `Run ${runId} is not waiting at hole ${holeId}: ${why}. Use GetWorkflowRun on the run to see ` +
    `its pending holes and their ids; a hole only waits while its run is in flight and has ` +
    `reached the site. Nothing was spliced and nothing was stopped.`
  );
}

/**
 * hole-filled 的双轨记录：journal 的 dwf_event（appendEvent 分配 sequence）+ 进度事件
 * （toProgressPayload 同一条铸造链）。与引擎 record() 的两轨语义对齐，但走服务侧直发——
 * 引擎活在前驱的 harness 里，service 摸不到它；journal 是同一个 store，sequence 单调性
 * 由 appendEvent 保证。
 */
function recordHoleFilled(
  deps: Pick<DynamicWorkflowRunServiceDeps, "journal" | "onRunEvent" | "logger">,
  runId: string,
  event: Extract<RunEvent, { type: "hole-filled" }>,
): void {
  try {
    const stored = deps.journal.appendEvent(runId, event);
    deps.onRunEvent?.(
      toProgressPayload({ event, runId, sequence: stored.sequence }),
      {},
    );
  } catch (error) {
    // 与 respondToParkedEscalation 同一条取舍：观察事件写不进去不得吞掉一次**已经发生**的
    // 填充（后继 run 已在飞）；记 warn，事实活在 splice 产物与新旧 scriptHash 里。
    deps.logger?.warn?.("Dynamic workflow hole-filled event not journaled", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.hole_fill.event_failed",
      holeId: event.holeId,
      module: "bootstrap.app",
      runId,
    });
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
