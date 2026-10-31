// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ../cli.ts 拆出。
// 职责：control 子命令（status/stop/restart/apply-update）的请求组装与转发，
// 以及 control endpoint 不可用时的 persisted status 回退读取。
import { ACODE_VERSION } from "@acode/shared";
import { controlRequestSchema, createStoppedServerStatus } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { readPersistedStatusDetailed } from "../runtime/statusSnapshot.js";
import { stdout, type CliIO } from "./io.js";

// apply-update 服务端最坏路径包含旧 Core 停止、新 Core ready 等待、新 Core 回滚停止、
// 旧 Core ready 等待以及旧 Core ready 超时后的再次停止，默认有界预算约为 51 秒，另需
// 为 current/pending 文件操作和 IPC 调度留出余量。客户端超时必须覆盖完整回滚路径，
// 否则 CLI 会在 update 仍在后台执行时误报超时。
export const APPLY_UPDATE_TIMEOUT_MS = 90_000;

export async function runControl(
  command: string,
  io: CliIO,
  json: boolean,
  extra: Record<string, unknown> = {},
  layout = resolveServerLayout(),
): Promise<number> {
  const request = controlRequestSchema.parse({ id: "cli", command, ...extra });
  let result: unknown;
  try {
    result = await requestControl(
      layout.controlEndpoint,
      request,
      command === "apply-update" ? APPLY_UPDATE_TIMEOUT_MS : undefined,
    );
  } catch (error: unknown) {
    if (command === "status") {
      const persisted = await readPersistedStatusDetailed(layout);
      result = persisted.status ?? createStoppedServerStatus(ACODE_VERSION);
    } else if (command === "stop" && isControlEndpointUnavailable(error)) {
      const persisted = await readPersistedStatusDetailed(layout);
      if (persisted.state === "invalid" || persisted.state === "unreadable") {
        throw error;
      }
      if (
        persisted.status &&
        persisted.status.state !== "stopped" &&
        persisted.status.state !== "uninstalled"
      ) {
        throw error;
      }
      // Supervisor 停止时会先关闭 control socket，再由 CLI 落盘 stopped 状态。
      // 重复 stop 发生在这个窗口后不应因为 socket 不存在而变成失败。
      result = persisted.status ?? createStoppedServerStatus(ACODE_VERSION);
    } else {
      throw error;
    }
  }
  if (json) stdout(io, result);
  else stdout(io, result ?? "ok");
  return 0;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL";
}
