import {
  collectVisibleACodeBackgroundTaskControlItems,
  getACodeBackgroundTaskControlItemElapsedMs,
  isActiveACodeBackgroundTaskControlItem,
  parseACodeBackgroundTaskControlItems,
  type ACodeBackgroundTaskControlItem,
  type ACodeBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type ACodeBackgroundBashJobStatus = ACodeBackgroundTaskControlStatus;
export type ACodeBackgroundBashJob = ACodeBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseACodeBackgroundBashJobs(value: unknown): ACodeBackgroundBashJob[] {
  return parseACodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveACodeBackgroundBashJob(job: ACodeBackgroundBashJob): boolean {
  return isActiveACodeBackgroundTaskControlItem(job);
}

export function getACodeBackgroundBashJobElapsedMs(
  job: ACodeBackgroundBashJob,
  now = Date.now(),
): number {
  return getACodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleACodeBackgroundBashJobs(
  jobs: readonly ACodeBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ACodeBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleACodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    ACodeBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: ACodeBackgroundTaskControlItem): job is ACodeBackgroundBashJob {
  return job.taskKind === "bash";
}
