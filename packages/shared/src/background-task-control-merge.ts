import type { ACodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeACodeBackgroundTaskControlItems(
  current: readonly ACodeBackgroundTaskControlItem[],
  updates: readonly ACodeBackgroundTaskControlItem[],
): ACodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
