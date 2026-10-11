// ============================================================
// FillWorkflowHole：确认之前的一切（resolveInput 与它的结构化失败）
// ============================================================
// 从 fill-workflow-hole.ts 拆出（amend-workflow-resolve.ts 的同款拆分）：那边是工具条目与
// handler，这里是**全流程唯一一次读世界**——fill 文本（`path` 读成文本）、run 草稿与停驻
// 事实（端口）、splice 与分析。落定之后，确认窗（prepareApproval）与 handler 面对的是同一
// 份 `spliced_script`。
//
// fill_unchanged（单槽记忆）：被拒的 fill 字节与上一次被拒的完全相同 ⇒ 结构化拒绝而不是
// 再报一遍同样的诊断——模型原样重提时它需要听到的是「重试没有用」，不是第二次同一封信。

import {
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputSchema,
  type FillWorkflowHoleInput,
} from "@acode/contracts";
import { spliceWorkflowHole, type CompileDiagnostic } from "@acode/dynamic-workflow";
import type { ToolHandlerFailure, ToolInputResolutionContext, ToolInputResolutionResult } from "../types.js";
import { formatWorkflowDiagnosticLines } from "./workflow-script-notes.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

/**
 * 本地失败码表。数值只是日志位；模型读的是 message，判别键在 message 前缀
 * （`workflow_hole_not_waiting:` / `workflow_fill_unchanged:` / …）。从 31 起编，与
 * ResumeWorkflowRun（11–15）、ResolveWorkflowQuestion（21–24）、AmendWorkflow（21–29）
 * 视觉分开——各表数值空间互相独立、禁止跨表比对。
 */
export const FILL_WORKFLOW_HOLE_ERROR_CODE = {
  FILLING_UNAVAILABLE: 31,
  HOLE_NOT_WAITING: 32,
  FILL_COMPILE: 33,
  FILL_UNCHANGED: 34,
  FILL_SOURCE: 35,
} as const;

const FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE = 400;

/**
 * 上一次被拒的 fill（单槽记忆，进程内）：key = `run_id#hole_ref`，bytes = fill 语句原文。
 * 与 analyzeScript 的单槽同一条纪律——只收敛「紧邻的重复」，不是通用缓存。纯内存：进程
 * 重启后清零（被拒历史本就该随会话翻篇）。
 */
let lastRejectedFill: { key: string; bytes: string } | null = null;

/** 服务端拒绝（fill_compile_failed）也要刷新记忆槽：handler 在收到端口拒绝时调用。 */
export function rememberRejectedFill(key: string, bytes: string): void {
  lastRejectedFill = { key, bytes };
}

/** 「本会话没有填充能力」。端口缺席与方法缺席回同一个失败（照 resolveQuestion 的先例）。 */
export function fillingUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILLING_UNAVAILABLE,
    message:
      "workflow_hole_filling_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole ref.",
  };
}

/** script/path 的 XOR 校验（归一化前才成立；归一化后 fill 与 spliced_script 同进同出）。 */
export function validateFillWorkflowHoleSource(input: unknown): { result: true } | ToolHandlerFailure {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const { script, path: filePath } = parsed.data;
  if (script !== undefined && filePath !== undefined) {
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE,
      message:
        "workflow_fill_source: pass the fill statements either inline as `script` or as a file `path`, not both.",
    };
  }
  return { result: true };
}

/** hole_ref → 站点 id（`hole#N@ordinal` 的 `hole#N` 段）。形态不符返回 undefined。 */
function holeSiteIdOf(holeRef: string): string | undefined {
  const at = holeRef.lastIndexOf("@");
  if (at <= 0 || !/^\d+$/u.test(holeRef.slice(at + 1))) return undefined;
  return holeRef.slice(0, at);
}

/**
 * 全流程唯一一次读世界（端口权威）：停驻事实与草稿 → splice → 分析。产物脚本写进入参的
 * `spliced_script`，确认窗（prepareApproval）重算的就是它——splice 后是新可执行代码，新的
 * world.run 命令集必须重新展示授权，防 fill 绕过授权面。
 */
export async function resolveFillWorkflowHoleInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const data = parsed.data;
  // 技能门先于一切解析：fill 是在写脚本代码（洞的函数体），没读过 dynamic-workflows 就拒绝。
  const refused = requireDynamicWorkflowSkill(context, FILL_WORKFLOW_HOLE_TOOL_NAME);
  if (refused) return refused;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.fillHole !== "function") {
    return fillingUnavailableFailure();
  }
  const cwd = context.workingDirectory ?? ".";

  // —— fill 文本落定（script 直取；path 读盘，读不出来点名文件）——
  let fill = data.script;
  if (fill === undefined && data.path !== undefined) {
    const file = await readWorkflowScriptFile({ cwd, inputPath: data.path, parseFrontmatter: false });
    if (!file.ok) {
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_SOURCE,
        message: `workflow_fill_file_unreadable: ${file.message} The hole is still waiting; nothing was spliced.`,
      };
    }
    fill = file.file.script;
  }
  if (fill === undefined) {
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE,
      message:
        "workflow_fill_source: pass the fill statements either inline as `script` or as a file `path`. The hole is still waiting; nothing was spliced.",
    };
  }

  // —— fill_unchanged：与上一次被拒的 fill 逐字节相同 ⇒ 重试没有用，换一句可判别的话。 ——
  const rejectionKey = `${data.run_id}#${data.hole_ref}`;
  if (lastRejectedFill?.key === rejectionKey && lastRejectedFill.bytes === fill) {
    return fillUnchangedFailure(data.run_id, data.hole_ref);
  }

  // —— 停驻事实与草稿（端口是唯一权威；getRunDetail 缺席时交给服务端判）——
  const siteId = holeSiteIdOf(data.hole_ref);
  const detail = await port.getRunDetail?.(data.run_id);
  if (
    detail !== undefined &&
    (siteId === undefined || !detail.pendingHoles?.some((hole) => hole.holeId === data.hole_ref))
  ) {
    return holeNotWaitingFailure(data.run_id, data.hole_ref);
  }
  const draft = await port.getScript?.(data.run_id);
  if (draft === undefined || siteId === undefined) {
    return holeNotWaitingFailure(data.run_id, data.hole_ref);
  }

  // —— splice + 分析：产物脚本进 `spliced_script`，确认窗重算读它 ——
  const spliced = spliceWorkflowHole(draft, siteId, fill);
  if (!spliced.ok) {
    rememberRejectedFill(rejectionKey, fill);
    if (spliced.reason === "hole_not_found") return holeNotWaitingFailure(data.run_id, data.hole_ref);
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_COMPILE,
      message: fillRejectedMessage(data.hole_ref, data.run_id, spliced.diagnostics),
    };
  }
  const analysis = analyzeScript(spliced.scriptText);
  if (!analysis.ok) {
    rememberRejectedFill(rejectionKey, fill);
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_COMPILE,
      message: fillRejectedMessage(data.hole_ref, data.run_id, analysis.diagnostics),
    };
  }
  return {
    result: true,
    input: {
      ...data,
      fill,
      spliced_script: spliced.scriptText,
    } satisfies FillWorkflowHoleInput & { fill: string; spliced_script: string },
  };
}

/** 同字节重提的拒绝（specs/workflow-holes.md 的 fill_unchanged）。 */
function fillUnchangedFailure(runId: string, holeRef: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNCHANGED,
    message:
      `workflow_fill_unchanged: these are byte-for-byte the statements that were just rejected for ` +
      `hole ${holeRef} of run ${runId}. Nothing was spliced and the hole is still ` +
      `waiting. Change the fill (the previous response named the exact errors and the fill file ` +
      `to edit), or leave the hole unfilled — resubmitting the same bytes cannot succeed.`,
  };
}

/** 「run 不在该洞等待」：现状 + 去哪取正确的 id（pendingHoles 是唯一发现面）。 */
export function holeNotWaitingFailure(runId: string, holeRef: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
    message:
      `workflow_hole_not_waiting: run ${runId} is not waiting at hole ${holeRef} (unknown ref, not ` +
      `reached yet, already filled, or the run is not in flight). Use GetWorkflowRun on the run to ` +
      `see its pending holes and their ids. Nothing was spliced and nothing was stopped.`,
  };
}

/** 被拒 fill 的文案：诊断行 + 「什么都没动」+ fill 文件（在场时）作为 Edit 再提的把手。 */
export function fillRejectedMessage(
  holeRef: string,
  runId: string,
  diagnostics: readonly CompileDiagnostic[],
  fillPath?: string,
): string {
  return [
    `The fill for hole ${holeRef} of run ${runId} does not hold:`,
    ...formatWorkflowDiagnosticLines(diagnostics, undefined),
    "",
    "Nothing was spliced and the hole is still waiting — the run keeps its draft untouched.",
    fillPath === undefined
      ? "Fix the statements and submit again."
      : `The fill file at ${fillPath} has the exact bytes; edit it and resubmit with \`path\` instead of pasting the statements again.`,
  ].join("\n");
}
