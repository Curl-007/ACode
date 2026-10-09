import { createWorkflowRunCommandContext } from "./contract.js";
import type { WorkflowRunCommandRuntime } from "./contract.js";
import type { TraceContext } from "@acode/contracts";

type StartInput = { name: string; scope?: "project" | "global"; args?: Record<string, unknown> };
type AmendInput = { runId: string; subagentModel?: string | null; maxConcurrency?: number | null };

declare const runtime: WorkflowRunCommandRuntime<StartInput, unknown, AmendInput, unknown>;

/** The host owns runtime and boundary; this context only fixes command ordering. */
export const exampleCommandContext = createWorkflowRunCommandContext({
  getRuntime: () => runtime,
  prepareUserExecutionBoundary: async () => {},
  traceContext: { traceId: "example" as TraceContext["traceId"] },
});
