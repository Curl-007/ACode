import type { TraceContext } from "@acode/contracts";

/** Port result used by the resume command. Refusals are business values, not exceptions. */
export type WorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: string; message?: string };

export interface WorkflowRunResumePort<
  Result extends WorkflowRunResumeResult = WorkflowRunResumeResult,
> {
  resume(runId: string): Promise<Result>;
}

export interface WorkflowRunCommandRuntime<
  StartInput extends object,
  StartResult,
  AmendInput extends object,
  AmendResult,
> {
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  startSavedWorkflowRun(input: StartInput & { traceContext?: TraceContext }): Promise<StartResult>;
  amendWorkflowRunSettings(
    input: AmendInput & { traceContext?: TraceContext },
  ): Promise<AmendResult>;
}

export interface WorkflowRunCommandDeps<
  StartInput extends object,
  StartResult,
  AmendInput extends object,
  AmendResult,
  ResumeResult extends WorkflowRunResumeResult = WorkflowRunResumeResult,
> {
  getRuntime: () => WorkflowRunCommandRuntime<StartInput, StartResult, AmendInput, AmendResult>;
  prepareUserExecutionBoundary(input: { traceContext: TraceContext }): Promise<void>;
  traceContext: TraceContext;
  resumePort?: WorkflowRunResumePort<ResumeResult>;
}

export interface WorkflowRunCommandContext<
  StartInput extends object,
  StartResult,
  AmendInput extends object,
  AmendResult,
  ResumeResult extends WorkflowRunResumeResult = WorkflowRunResumeResult,
> {
  /** Present only when the host supplied a resume port. */
  resumeWorkflowRun?: (input: { workId: string; name?: string }) => Promise<ResumeResult>;
  startSavedWorkflow(input: StartInput): Promise<StartResult>;
  amendWorkflowRunSettings(input: AmendInput): Promise<AmendResult>;
}
