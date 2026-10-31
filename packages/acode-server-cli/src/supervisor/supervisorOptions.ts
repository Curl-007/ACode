// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：Supervisor 构造契约（CoreLauncher / SupervisorOptions 接口），与
// CoreHealthOptions 居于 coreHealth.ts 同例；接口原样迁移，未导出语义变化——
// 两者在 supervisor.ts 中本就未导出，此处仅以 type 导出供 supervisor.ts 引回。
import { type ChildProcess } from "node:child_process";
import { type ReleaseManifest } from "../contracts.js";
import { type ServerLayout } from "../runtime/paths.js";

export interface CoreLauncher {
  launch(generation: number, release?: ReleaseManifest | null): ChildProcess;
}

export interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  version: string;
  serviceRegistered?: boolean;
  /** 测试和诊断可缩短 ready 等待；生产默认保持 15 秒。 */
  coreReadyTimeoutMs?: number;
  /** 测试可缩短 Core 优雅退出和强杀后的终态等待；生产分别默认 5 秒和 2 秒。 */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  /** Core 心跳新鲜度窗口；默认 30 秒（Core 默认每 10 秒发送一次）。 */
  coreHeartbeatTimeoutMs?: number;
  /** 测试可缩短健康检查轮询间隔；默认不超过 1 秒。 */
  coreHeartbeatCheckIntervalMs?: number;
  now?: () => number;
  onStopped?: () => void;
}
