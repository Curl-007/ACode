// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：control 请求分发（原 Supervisor.handleControl 的 switch：ping/status/stop/
// restart/prepare-update/apply-update/prepare-uninstall/confirm-uninstall）。
// 对 Supervisor 私有方法的调用经构造注入的宿主闭包完成，分支语义逐字保留。
import { createServiceLogger } from "@acode/services/node";
import {
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type ServerStatus,
} from "../contracts.js";
import { type LifecycleOperationKind } from "./lifecycleOperationGate.js";

// 与 supervisor.ts 同一 scope：生命周期事件按运维排障判据用 info/warn/error。
const log = createServiceLogger("server-supervisor");

export interface ControlDispatchHost {
  status(): ServerStatus;
  stopInternal(reason: string): Promise<ServerStatus>;
  start(): Promise<ServerStatus>;
  applyUpdate(force: boolean): Promise<unknown>;
  /** 原 this.runningTaskCount 实时读取。 */
  getRunningTaskCount(): number;
  runLifecycleOperation<T>(kind: LifecycleOperationKind, operation: () => Promise<T>): Promise<T>;
  startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void;
}

export async function dispatchControlRequest(
  host: ControlDispatchHost,
  request: ControlRequest,
): Promise<unknown> {
  switch (request.command) {
    case "ping":
      return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
    case "status":
      return host.status();
    case "stop":
      host.startAcknowledgedLifecycleOperation("stop", () => host.stopInternal("control request"));
      return { stopping: true };
    case "restart":
      host.startAcknowledgedLifecycleOperation("restart", async () => {
        await host.stopInternal("restart");
        await host.start();
      });
      return { restarting: true };
    case "prepare-update":
      return {
        status: host.getRunningTaskCount() ? "blocked" : "ready",
        runningTaskCount: host.getRunningTaskCount(),
      };
    case "apply-update":
      return await host.runLifecycleOperation("update", () =>
        host.applyUpdate(request.force === true),
      );
    case "prepare-uninstall":
      return {
        status: host.getRunningTaskCount() ? "blocked" : "ready",
        runningTaskCount: host.getRunningTaskCount(),
      };
    case "confirm-uninstall":
      if (request.confirmation !== "DELETE")
        throw new Error("Uninstall confirmation must be DELETE");
      // uninstall 前需要检查运行任务：
      // prepare-uninstall 会返回 blocked 却没有任何调用方消费它，confirm-uninstall
      // 直接停 Core 删数据，运行中的任务会被无提示中断。这里在最后防线上强制 guard，
      // 有运行任务时返回结构化错误并保持原状态。
      if (host.getRunningTaskCount() > 0) {
        throw new Error(
          `Cannot uninstall while ${host.getRunningTaskCount()} task(s) are running; stop the server first`,
        );
      }
      log.info(undefined, "uninstall confirmed, stopping server");
      host.startAcknowledgedLifecycleOperation("uninstall", () => host.stopInternal("uninstall"));
      return { uninstalled: true };
  }
}
