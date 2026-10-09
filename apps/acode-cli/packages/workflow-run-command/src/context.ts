import type {
  WorkflowRunCommandContext,
  WorkflowRunCommandDeps,
  WorkflowRunResumeResult,
} from "./types.js";

/**
 * Build the small application context shared by the GUI facade and future CLI command surfaces.
 *
 * This context owns ordering only. It deliberately does not create runs or keep a second owner,
 * journal, reservation, or lifecycle registry; those remain in the injected port/runtime.
 */
export function createWorkflowRunCommandContext<
  StartInput extends object,
  StartResult,
  AmendInput extends object,
  AmendResult,
  ResumeResult extends WorkflowRunResumeResult = WorkflowRunResumeResult,
>(
  deps: WorkflowRunCommandDeps<StartInput, StartResult, AmendInput, AmendResult, ResumeResult>,
): WorkflowRunCommandContext<StartInput, StartResult, AmendInput, AmendResult, ResumeResult> {
  const { getRuntime, prepareUserExecutionBoundary, resumePort, traceContext } = deps;
  const context: WorkflowRunCommandContext<
    StartInput,
    StartResult,
    AmendInput,
    AmendResult,
    ResumeResult
  > = {
    // Prepare exactly once per command. Runtime is intentionally read after the boundary resolves.
    startSavedWorkflow: async (input) => {
      await prepareUserExecutionBoundary({ traceContext });
      return getRuntime().startSavedWorkflowRun({ ...input, traceContext });
    },
    amendWorkflowRunSettings: async (input) => {
      await prepareUserExecutionBoundary({ traceContext });
      return getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
    },
  };

  if (resumePort !== undefined) {
    context.resumeWorkflowRun = async (input) => {
      const result = await resumePort.resume(input.workId);
      if (result.ok) {
        // The port replaces the live owner before resolving. Tracking is therefore the next event,
        // and it is skipped for every structured refusal.
        await getRuntime().trackResumedDynamicWorkflowRun({
          runId: result.runId,
          ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
          ...(input.name === undefined ? {} : { name: input.name }),
          traceContext,
        });
      }
      return result;
    };
  }

  return context;
}
