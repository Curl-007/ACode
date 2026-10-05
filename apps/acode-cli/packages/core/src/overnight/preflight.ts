// 机制参照 jcode (MIT)：crates/jcode-app-core/src/overnight.rs（preflight 采集：usage 投影、
// 资源快照、Git 快照，写入工件并注入 coordinator prompt），自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 R5）。
//
// preflight 是引擎工件而非模型内容：宿主在 run 启动前采集、由接线层**直接 fs 写**到
// `.acode/overnight/<runId>/preflight.md`。不经 Write 工具的理由：R5 的「产物只经工具写」
// 约束针对 coordinator 会话的产物（卡片/晨报——它们是模型动作的结果，必须走权限管线）；
// preflight 是宿主在 coordinator 存在**之前**采集的环境事实，没有「经模型工具写」的语义，
// 走工具路径反而要求先 fork 出会话再回头写 run 目录，时序不成立。
// 采集面全部注入，保持本模块可离线单测（与 supervisor 同款依赖注入形态）。

/** R5：进程内存快照（CLI 进程可自采；平台服务增强是后续可选项，不阻塞本面）。 */
export interface OvernightPreflightMemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

/** R5：git 分支与脏状态（fork 前的工作区事实，供 coordinator 判断从哪继续）。 */
export interface OvernightPreflightGitSnapshot {
  branch?: string;
  dirty?: boolean;
  error?: string;
}

export interface OvernightPreflightCollectors {
  collectMemory(): OvernightPreflightMemorySnapshot;
  collectGitStatus(): Promise<OvernightPreflightGitSnapshot>;
  /**
   * usage 投影（jcode 的 risk/confidence/区间）。ACode 侧暂无等价的稳定 usage 投影面，
   * 注入为可选字符串（markdown 片段）；缺席时报告显式标注缺失而非静默省略。
   */
  collectUsageSnapshot?(): Promise<string | undefined>;
}

export interface OvernightPreflightInput {
  runId: string;
  startedAtMs: number;
  durationMs: number;
  targetWakeAtMs: number;
  parentTaskId: string;
}

/** preflight 工件路径（workspace 相对；接线层 fs 写）。 */
export function overnightPreflightPath(runId: string): string {
  return `.acode/overnight/${runId}/preflight.md`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

/**
 * 采集并渲染 preflight 报告。采集失败不抛出（preflight 是观测面不是准入面——
 * 拿不到 git 状态的 workspace 照样能挂机，报告里如实标注错误即可）。
 */
export async function collectOvernightPreflight(
  input: OvernightPreflightInput,
  collectors: OvernightPreflightCollectors,
): Promise<string> {
  let memory: OvernightPreflightMemorySnapshot | undefined;
  try {
    memory = collectors.collectMemory();
  } catch {
    memory = undefined;
  }
  let git: OvernightPreflightGitSnapshot | undefined;
  try {
    git = await collectors.collectGitStatus();
  } catch (error) {
    git = { error: error instanceof Error ? error.message : String(error) };
  }
  let usageBlock: string | undefined;
  try {
    usageBlock = await collectors.collectUsageSnapshot?.();
  } catch {
    usageBlock = undefined;
  }

  const lines: string[] = [
    `# Overnight preflight ${input.runId}`,
    "",
    `- startedAt: ${new Date(input.startedAtMs).toISOString()}`,
    `- parentTaskId: ${input.parentTaskId}`,
    `- duration: ${Math.round(input.durationMs / 60_000)} 分钟`,
    `- targetWakeAt: ${new Date(input.targetWakeAtMs).toISOString()}`,
    "",
    "## 进程资源快照",
    memory
      ? [
          `- rss: ${formatBytes(memory.rssBytes)}`,
          `- heapUsed: ${formatBytes(memory.heapUsedBytes)}`,
          `- heapTotal: ${formatBytes(memory.heapTotalBytes)}`,
          `- external: ${formatBytes(memory.externalBytes)}`,
        ].join("\n")
      : "（内存采集失败）",
    "",
    "## Git 快照",
    git?.error
      ? `（git 状态采集失败：${git.error}）`
      : [`- branch: ${git?.branch ?? "unknown"}`, `- dirty: ${git?.dirty === true ? "yes" : "no"}`].join("\n"),
    "",
    "## Usage 投影",
    usageBlock?.trim() ?? "（本次运行未采集 usage 投影）",
    "",
    "## 电源提示",
    "- 系统可能入睡（本引擎不做 keepAwake，见 spec 未做与取舍 4）；醒来后的墙钟跳进按相位自动前跳处理。",
    "",
  ];
  return lines.join("\n");
}
