// ============================================================
// Dynamic Workflow Run Service：resume 入口与入口上下文（EntryContext）
// ============================================================
// 从 dynamic-workflow-run-submit.ts 拆出：崩溃恢复入口 `resumeDynamicWorkflowRun` 与三条入口
// （submit / amend / resume）共用的 {@link DynamicWorkflowRunEntryContext}。
//
// EntryContext 住在这里而不是 submit：submit 需要再导出 resume，若 EntryContext 留在 submit、
// resume 叶再回头引它，就是一条 submit ↔ resume 类型环（架构检查把 type import 计为依赖边）。
// 于是两样都落在本叶，submit 单向依赖本叶。
//
// resume 的纪律（与 submit 半边方向相反、绝不共用门——见 run service 文件头不变式 1）：
//   - 只接受 byte-identical 的存量脚本：先编译诊断、再校验 scriptHash，重建导入缓存失败也绝不拖垮；
//   - reservation 先于第一次 await（resumeAdmissions），成功/失败都必须释放；
//   - 注册表条目整条换血：新 AbortController、新控制面、新结算 promise。
//
// 本叶不持有状态：注册表、停驻表、结算簿记、admission 集合都经 EntryContext 从 service 递进来。

import type { DynamicWorkflowRunResumeResult } from "@acode/contracts";
import {
  collectDiagnostics,
  createWorkflowProgram,
  type Caps,
  type RunSettlement,
} from "@acode/dynamic-workflow";
import { rebuildImportedCacheForResume } from "./dynamic-workflow-import.js";
import { launchDynamicWorkflowRun } from "./dynamic-workflow-run-launch.js";
import {
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import {
  isResumableRecord,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";
import {
  boundedResumeDiagnostics,
  compileProgram,
} from "./dynamic-workflow-run-compile.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-deps.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";

/**
 * 两条入口要用的 service 内部状态。全是**引用**而不是副本：注册表与停驻表是 service 的那一份，
 * `trackSettlement` 是 service 的结算簿记（终态进条目、失败归一、结算通知），`caps` 是 submit
 * 路径上按当下并发探测算出的上界（resume 沿用 journal 记录里的 caps，不经它）。
 */
export interface DynamicWorkflowRunEntryContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  /**
   * 同一 runId 的 resume admission reservation。它与 runs 同属 service，
   * 只占住 rebuild/launch 的 await 窗口，成功后仍以 runs 为运行态权威。
   */
  resumeAdmissions: Set<string>;
  escalations: WorkflowEscalationRegistry;
  /**
   * 本次启动的 caps。入参是**请求的**并发上界（`CreateWorkflow` / `AmendWorkflow` 的
   * `max_concurrency`，已由工具层归一成一个数或缺席）：缺席即天花板，给了就钳到 [1, 天花板]。
   */
  caps: (requestedMaxConcurrency?: number) => Caps;
  trackSettlement: (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ) => Promise<RunSettlement>;
}

/** `DynamicWorkflowRunPort.resume` 的实现体。 */
export async function resumeDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  runId: string,
): Promise<DynamicWorkflowRunResumeResult> {
  const { deps, runs, resumeAdmissions, escalations } = ctx;
  const record = deps.journal.getRun(runId);
  if (record === undefined) return { ok: false, reason: "not_found" };
  // in-process 在飞的同 runId：journal 状态是 running，本就不可恢复；单列 reason 是
  // 因为它与「不可恢复的终态」对调用方是不同的动作（等它结算 vs 放弃）。
  const live = runs.get(runId);
  // reservation 必须在第一次 await（编译 / rebuild / launch）之前完成；否则两个并发
  // resume 会同时通过 live 检查，并在 rebuild await 之后各自覆盖 runs 条目、启动两个沙箱。
  if (resumeAdmissions.has(runId) || (live !== undefined && live.terminal === undefined)) {
    return { ok: false, reason: "already_running" };
  }
  resumeAdmissions.add(runId);
  try {
    // 被修订替代的 run 单列 reason：与「不可恢复的终态」对调用方是不同的动作（去看后继 vs 放弃）。
    if (record.status === "stopped" && record.stopReason === "superseded") {
      return { ok: false, reason: "superseded" };
    }
    if (!isResumableRecord(record)) return { ok: false, reason: "not_resumable" };
    // scriptText 落库始于 workflow-live-run；更早的记录没有可重跑的脚本。
    if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };

    // 老 run 的 journal 原文是按**当时**的 facade 写的，重构后
    // 可能不再通过类型检查。compileOnce 对脏脚本是硬失败（那是接线错误的通道），resume 撞上它却是
    // 一条用户可预期的业务分支——结构化拒绝 + 有界诊断，UI / TUI / 工具面据此指向 AmendWorkflow，
    // 而不是一条泛化的「执行失败」。诊断与随后的编译共用同一个 Program，仍是「编译一次」。
    const workflow = createWorkflowProgram(record.scriptText);
    const diagnostics = collectDiagnostics(workflow.program);
    if (diagnostics.length > 0) {
      deps.logger?.warn?.("Dynamic workflow resume refused: stored script no longer compiles", {
        diagnosticCount: diagnostics.length,
        event: "dynamic_workflow.resume.compile_failed",
        module: "bootstrap.app",
        runId,
      });
      return {
        ok: false,
        reason: "compile_failed",
        message: boundedResumeDiagnostics(runId, diagnostics),
      };
    }
    const compiled = compileProgram(record.scriptText, workflow);
    // 服务端先验（引擎构造时仍二次校验，防御纵深）：记录自身被外力改写（scriptText 与
    // scriptHash 不再自洽）时不建注册表条目、不启动——引擎侧同步抛错会把条目簿记成
    // failed 终态，掩盖「记录仍可修复」这个事实。
    if (record.scriptHash !== undefined && record.scriptHash !== compiled.scriptHash) {
      deps.logger?.warn?.("Dynamic workflow resume refused: script hash mismatch", {
        event: "dynamic_workflow.resume.script_hash_mismatch",
        expected: record.scriptHash,
        got: compiled.scriptHash,
        module: "bootstrap.app",
        runId,
      });
      return { ok: false, reason: "script_mismatch" };
    }

    // 修订 run 的 resume：重建导入缓存。
    // 已消费的命中在本 run 的 journal 里是真行、照常 replay 短路；未消费的导入只活在内存里，
    // 不重建就会在这一次续跑里变成 live 重跑。重建与提交时构建是同一个纯函数读同一份前驱
    // journal，所以确定性成立——引擎据本 run 的记录行重推分歧点（imported-cache.ts 的
    // reconcileRecorded），两侧因此不会错位。
    //
    // **重建失败绝不拖垮 resume**：前驱 journal 是修订 run 的存续依赖，但只是加速结构——
    // 丢了变贵，不变错。前驱被清理 / 边界门不再通过时照常无缓存启动，未消费的导入退化成
    // live 重执行，而 run 自己的 journal 行仍然逐条 replay。
    const rebuilt =
      record.resumedFrom === undefined
        ? undefined
        : await rebuildImportedCacheForResume(deps, {
            predecessorRunId: record.resumedFrom,
            runId,
          });

    // 替换注册表条目：同 runId、新 AbortController、新结算 promise——cancel 从此恢复可用。
    // 必须先于 launch（文件头不变式 5：条目是 watcher 的前提）。
    const resumedSubagentModel = readRunSubagentModel(deps.journal, runId);
    const resumedScriptPath = readRunScriptPath(deps.journal, runId);
    const controller = new AbortController();
    // 与 submit 路同规：新条目 = 新 AbortController + 新控制面。上一世的句柄绑的是已经结算的那个
    // 引擎，留着它会让 retune 对一个死引擎说话。
    const control = createWorkflowRunControl();
    const entry: RunRegistryEntry = {
      controller,
      control,
      startedAt: new Date(),
      // 本 run 生效的并发上界：**resume 路以 journal 行为准**（一次就地 retune 已经把新值写进
      // `caps_max_concurrency`，所以行里那个就是这一世要跑的上界）。抄进条目是为了让
      // `retuneConcurrency` 与两条读面只剩一条规则——有条目就读条目。
      maxConcurrency: record.caps.maxConcurrency,
      ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      // 枚举面的间隙元数据（见 RunRegistryEntry）：resume 的权威在 journal 记录里，
      // 这里只是同一事实的内存副本。cwd 与下面 launch 的取值同源。
      cwd: record.cwd ?? process.cwd(),
      ...(record.name === undefined ? {} : { name: record.name }),
      scriptText: record.scriptText,
      // 子代理模型：读一次事件头抄进条目（见 RunRegistryEntry.subagentModel）。值在建 run 那一世
      // 就写死在 `run-launched` 上、本 run 余生不变，所以抄下来不会与事件分叉；抄了之后两条读面
      // 只剩一条规则——有条目就读条目，只有冷行才去扫事件。
      ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
      // 脚本文件：与子代理模型同一条读、同一条论证（建 run 那一世写死、余生不变，抄下来不会
      // 与事件分叉）。resume 之后两条读面因此照旧「有条目就读条目」。
      ...(resumedScriptPath === undefined ? {} : { scriptPath: resumedScriptPath }),
      settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
    };
    runs.set(runId, entry);

    entry.settlement = ctx.trackSettlement(
      runId,
      entry,
      launchDynamicWorkflowRun({
        // caps 沿用 journal 记录：spentTokens 是对着这套 caps 累计的，
        // 重算等于悄悄挪门柱。
        caps: record.caps,
        compiled,
        cwd: record.cwd ?? process.cwd(),
        deps,
        ...(record.name === undefined ? {} : { name: record.name }),
        // resume **重放**存下来的实参，永不接受新的：一次 run 的身份包含它的实参，
        // 与「只对 byte-identical 脚本有效」是同一条纪律。resume 入口刻意没有实参形参，
        // 所以这里唯一的来源就是 journal 记录；没有这一列的老行（缺席 → 沙箱
        // 读作 `{}`）。换实参 = 一次新的 run = 一次新的确认窗。
        ...(record.args === undefined ? {} : { args: record.args }),
        // 子代理模型也不下传：它与锚点同住 `run-launched`，建 run 那一世就写死了，launch 侧
        // 自己从 journal 的事件头读回（上面抄进条目的是同一个读）。与 caps / args 同一条纪律
        // ——一次 run 的身份包含它跑在哪个模型上，resume 重放存下来的那一份、永不接受新的。
        ...(record.parentSessionId === undefined
          ? {}
          : { parentSessionId: record.parentSessionId }),
        // 两条入口共用同一张停驻表（见上面的字段注释）。
        escalationRegistry: escalations,
        // 控制面与停驻表不同：**每条入口各造一个**（它绑的是这一世的引擎与这一世的座位闸门）。
        control,
        runId,
        scriptText: record.scriptText,
        signal: controller.signal,
        ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
        // 与 submit / amend 同一条：resume 起来的 run 照样可能成为下一次修订的前驱。
        onQuiescenceProbe: (probe) => {
          entry.quiescence = probe;
        },
        // resumedFrom 不再下传：createRun 早在提交时就把它写死了，resume 路径上引擎命中既有
        // 行、根本不走 createRun。只有重建出来的缓存需要下去。
        ...(rebuilt === undefined ? {} : { importedCache: rebuilt }),
      }),
    );

    return {
      ok: true,
      runId,
      ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    };
  } finally {
    // 成功时 runs 已经先登记，失败/拒绝时也必须释放 reservation，避免一次 rebuild 故障
    // 把后续所有恢复永久锁死。
    resumeAdmissions.delete(runId);
  }
}
