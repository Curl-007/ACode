// ============================================================
// Tool Scheduler - Tool execution scheduling
// ============================================================

import type { ModelToolSideEffectScope, ToolCallId } from "@acode/contracts";
import { createCoreError, CoreErrorType } from "@acode/contracts";

// -----------------------------------------------
// Types
// -----------------------------------------------

export interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface ToolScheduleItem {
  toolCallId: ToolCallId;
  toolName?: string;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

export interface ToolDependency {
  toolCallId: ToolCallId;
  toolName?: string;
  dependsOn: ToolCallId[];
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

// -----------------------------------------------
// Scheduler
// -----------------------------------------------

interface ToolSchedulerOptions {
  maxConcurrency?: number;
  readOnlyTools?: Set<string>;
}

const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * D5 只读诊断投影（specs/concurrency-diagnostics-projection.md R1/R3）：scheduler 域能如实
 * 报告的两个事实。scheduler 是纯函数式分组器、不跟踪在飞执行，所以 `current` 口径只能是
 * 「最近一次 schedule() 产出的最大并行组宽度」——这是分组结果里唯一的并发水位事实。
 */
export interface ToolSchedulerSnapshot {
  /** 生效的并发上限（默认 DEFAULT_MAX_CONCURRENCY，可经配置下调/上调）。 */
  maxConcurrency: number;
  /** 最近一次 schedule() 的最大并行组宽度；0 = 本实例尚无调度。 */
  lastScheduleMaxParallelGroupWidth: number;
}

export class ToolScheduler {
  private itemsMap = new Map<ToolCallId, ToolScheduleItem>();
  private maxConcurrency: number;
  private readOnlyTools: Set<string>;
  /**
   * 纯诊断记录（D5 R2）：只被 snapshot() 读取，任何调度分支都不读它——分组结果在它被
   * 写下之前已完全确定，schedule() 的返回值逐字节不受影响。这是刻意的单向事实流：
   * 投影可以观察调度，调度绝不观察投影。
   */
  private lastScheduleMaxParallelGroupWidth = 0;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS;
  }

  schedule(tools: ToolDependency[]): ToolSchedule {
    const items = tools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      dependencies: tool.dependsOn,
      canRunParallel: this.canRunInParallel(tool),
      readOnly:
        tool.readOnly ?? (tool.toolName ? this.readOnlyTools.has(tool.toolName) : undefined),
      destructive: tool.destructive,
      concurrentSafe: tool.concurrentSafe,
      sideEffectScope: tool.sideEffectScope,
    }));

    this.itemsMap = new Map(items.map((item) => [item.toolCallId, item]));

    const sorted = this.topologicalSort(items);
    const groups = this.groupByParallel(sorted);
    this.validateNoCycles(groups);
    // D5 纯诊断记录：在全部调度决策（分组、环校验）完成之后写，见字段注释。
    this.lastScheduleMaxParallelGroupWidth = groups.reduce(
      (widest, group) => Math.max(widest, group.length),
      0,
    );

    return {
      items,
      parallelGroups: groups,
      executionOrder: groups.flat(),
    };
  }

  /** D5 只读快照：不改变任何调度状态（连诊断字段也只读不写）。 */
  snapshot(): ToolSchedulerSnapshot {
    return {
      maxConcurrency: this.maxConcurrency,
      lastScheduleMaxParallelGroupWidth: this.lastScheduleMaxParallelGroupWidth,
    };
  }

  private canRunInParallel(tool: ToolDependency): boolean {
    const hasToolName = typeof tool.toolName === "string" && tool.toolName.length > 0;
    const hasSafetyMetadata =
      tool.readOnly !== undefined ||
      tool.destructive !== undefined ||
      tool.concurrentSafe !== undefined ||
      tool.sideEffectScope !== undefined;

    if (!hasToolName && !hasSafetyMetadata) {
      return true;
    }

    const readOnly =
      tool.readOnly ?? (hasToolName ? this.readOnlyTools.has(tool.toolName!) : false);
    if (tool.destructive) return false;
    if (tool.concurrentSafe === true) return true;
    if (tool.concurrentSafe === false) return false;
    if (readOnly) return true;
    return tool.sideEffectScope === "none";
  }

  private topologicalSort(items: ToolScheduleItem[]): ToolScheduleItem[] {
    const result: ToolScheduleItem[] = [];
    const remaining = new Map(items.map((item) => [item.toolCallId, item]));
    const inDegree = new Map<string, number>();

    for (const item of items) {
      inDegree.set(item.toolCallId, item.dependencies.length);
    }

    const queue = items
      .filter((item) => item.dependencies.length === 0)
      .map((item) => item.toolCallId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const item = remaining.get(current);

      if (!item) continue;

      result.push(item);
      remaining.delete(current);

      for (const [toolId, depItem] of remaining) {
        if (depItem.dependencies.includes(current)) {
          const newDegree = (inDegree.get(toolId) ?? 0) - 1;
          inDegree.set(toolId, newDegree);
          if (newDegree === 0) {
            queue.push(toolId);
          }
        }
      }
    }

    if (remaining.size > 0) {
      throw createCoreError(
        CoreErrorType.InvalidStateTransition,
        "Circular dependency detected in tool scheduling",
        {
          context: {
            remaining: Array.from(remaining.keys()),
          },
          recoverable: false,
        },
      );
    }

    return result;
  }

  private groupByParallel(items: ToolScheduleItem[]): ToolCallId[][] {
    if (items.length === 0) return [];

    const levels = new Map<ToolCallId, number>();
    const byLevel = new Map<number, ToolScheduleItem[]>();

    for (const item of items) {
      const dependencyLevel =
        item.dependencies.length === 0
          ? -1
          : Math.max(...item.dependencies.map((dep) => levels.get(dep) ?? 0));
      const level = dependencyLevel + 1;
      levels.set(item.toolCallId, level);
      const levelItems = byLevel.get(level) ?? [];
      levelItems.push(item);
      byLevel.set(level, levelItems);
    }

    const groups: ToolCallId[][] = [];
    const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);

    for (const level of sortedLevels) {
      let parallelGroup: ToolCallId[] = [];

      const flushParallelGroup = () => {
        if (parallelGroup.length === 0) return;
        groups.push(parallelGroup);
        parallelGroup = [];
      };

      for (const item of byLevel.get(level) ?? []) {
        if (item.canRunParallel) {
          // Flush if current group is full
          if (parallelGroup.length >= this.maxConcurrency) {
            flushParallelGroup();
          }
          parallelGroup.push(item.toolCallId);
          continue;
        }

        flushParallelGroup();
        groups.push([item.toolCallId]);
      }

      flushParallelGroup();
    }

    return groups;
  }

  private validateNoCycles(groups: ToolCallId[][]): void {
    for (const group of groups) {
      const groupSet = new Set(group);

      for (const toolId of group) {
        const item = this.itemsMap.get(toolId);
        if (!item) continue;

        for (const dep of item.dependencies) {
          if (groupSet.has(dep)) {
            throw createCoreError(
              CoreErrorType.InvalidStateTransition,
              `Circular dependency detected: ${toolId} depends on ${dep} in same group`,
              {
                context: { toolId, dependency: dep, group },
                recoverable: false,
              },
            );
          }
        }
      }
    }
  }
}

// -----------------------------------------------
// Default instance
// -----------------------------------------------

export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
]);

export const defaultToolScheduler = new ToolScheduler();
