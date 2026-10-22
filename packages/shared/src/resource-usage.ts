/**
 * 资源管理器（Process Monitor）快照与进程行形状。
 *
 * 独立叶子模块：protocol.ts 有 400 行闸（1.0.3 合并叠加后触及，与 desktopAppSettings.ts
 * 同款拆分产物），Process Monitor 段自包含、段外零引用，收敛到这里具名导出；protocol.ts
 * re-export 保持既有导入面（channels.ts / contract.ts / index.ts 及外部 `@acode/shared`
 * 消费者零改动）。
 */

/** 资源管理器分类：基础服务 / 内置插件 / 社区插件 */
export type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

/** 基础服务分组键；插件分组键为插件名或 MCP server name */
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/** 资源管理器中的一个进程行（CPU 为整机归一化百分比，内存为字节） */
export interface ResourceUsageProcess {
  pid: number;
  /** 进程显示名，如 acode-main / acode-agent-acode-demo / node_repl */
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /** false 表示只知道拓扑，指标尚未采到（显示为 —） */
  sampled: boolean;
}

/** Host 侧采样得到的外部进程行（Agent / MCP / 终端等），由 main 合并进快照 */
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/** 资源管理器一次完整快照，由 main 进程合并 Electron 指标、系统总量与 Host 采样后返回 */
export interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: {
    cpuPercent: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
  };
  app: {
    cpuPercent: number;
    memoryBytes: number;
  };
  processes: ResourceUsageProcess[];
}
