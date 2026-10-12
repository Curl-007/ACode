// Dynamic Workflow 编译与运行 ID：与 submit/amend/resume 入口共用的纯辅助。
import { createHash, randomUUID } from "node:crypto";
import {
  buildAskSpecs,
  collectHoleDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  deriveActorSubmitProfilesFor,
  lowerWorkflow,
  synthesizeAskSchemas,
  type CompileDiagnostic,
  type WorkflowProgram,
} from "@acode/dynamic-workflow";
import type { CompiledDynamicWorkflowScript } from "./dynamic-workflow-run-launch.js";

export function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

export function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > 2000 ? `${body.slice(0, 1999)}…` : body;
}

export function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }
  // 洞的编译期规则（9005）在这里是**第二道**闸：正门在工具层的 analyzeScript（作者看到的
  // 是结构化诊断而不是异常），这条服务侧防御守的是 fill 的重编译——fill 语句里嵌进
  // fan-out 回调的洞只能在这里被挡下（splice 产物直接走 startNewRun，不经工具层）。
  const holeDiagnostics = collectHoleDiagnostics(workflow, table);
  if (holeDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with invalid hole calls (${holeDiagnostics.length} diagnostics); no run was created`,
    );
  }

  const askSpecs = buildAskSpecs(table, schemas);
  return {
    askSpecs,
    actorSubmitProfiles: deriveActorSubmitProfilesFor(workflow, table, askSpecs),
    declaredRunCommands: new Set(worldRun.commands),
    lowered: lowerWorkflow(workflow, table).code,
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}

export function mintRunId(): string {
  return `dwfrun-${randomUUID()}`;
}
