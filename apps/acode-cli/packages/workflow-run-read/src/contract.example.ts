import type { DynamicWorkflowRunSummary } from "@acode/contracts";
import {
  lineageFields,
  resolveDynamicWorkflowRunLabel,
} from "./contract.js";

/** 仅展示读面组合方式；不持久化派生字段，也不创建 run owner。 */
export function projectRunReadExample(input: {
  runId: string;
  name?: string;
  scriptText?: string;
  resumedFrom?: string;
  supersededBy?: string;
}): Pick<DynamicWorkflowRunSummary, "label" | "labelSource"> & {
  resumedFrom?: string;
  supersededBy?: string;
} {
  return {
    ...resolveDynamicWorkflowRunLabel(input),
    ...lineageFields(input.resumedFrom, input.supersededBy),
  };
}
