import { fork } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { resolveCanonicalServerLayout, resolveServerLayout } from "./runtime/paths.js";
import { runUpdateCommand } from "./runtime/updateCommand.js";
export { readPersistedStatus } from "./runtime/statusSnapshot.js";
// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：子命令实现拆入 ./cli/
// 叶子（io/serviceRegistration/serve/control/uninstall），此处仅保留入口编排与
// 原导出面转发；export 符号集与拆前逐名一致。
export {
  serviceRegistrationEnabled,
  daemonStartupMode,
  isRegisteredServiceEntry,
  SERVER_SERVICE_ARGS,
  shouldRegisterService,
} from "./cli/serviceRegistration.js";
export { APPLY_UPDATE_TIMEOUT_MS } from "./cli/control.js";
export type { CliIO, ServerCliRuntimeOptions } from "./cli/io.js";
import { stderr, stdout, type CliIO, type ServerCliRuntimeOptions } from "./cli/io.js";
import { runServe } from "./cli/serve.js";
import { runControl } from "./cli/control.js";
import { runUninstall } from "./cli/uninstall.js";

export async function runServerCli(
  argv: readonly string[],
  io: CliIO = {},
  runtimeOptions: ServerCliRuntimeOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parseServerCliArguments(argv);
    const command = parsed.argv[0];
    if (!command) {
      return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
    // 同一物理 data-root 的符号链接别名会派生不同 control endpoint 和 OS service
    // identity。生命周期命令统一在 IO 前收敛 root，避免第二个 Supervisor 绕过探测重复注册。
    const layout = ["serve", "status", "stop", "restart", "update", "uninstall"].includes(command)
      ? await resolveCanonicalServerLayout(parsed.layout.serverRoot)
      : parsed.layout;
    switch (command) {
      case "serve":
        return await runServe(
          parsed.argv.slice(1),
          io,
          json,
          layout,
          runtimeOptions,
          import.meta.url,
        );
      case "status":
      case "stop":
      case "restart":
        return await runControl(command, io, json, {}, layout);
      case "update":
        return await runUpdateCommand(parsed.argv, io, json, layout, () =>
          runControl("apply-update", io, json, { force: parsed.argv.includes("--force") }, layout),
        );
      case "uninstall":
        return await runUninstall(io, json, layout);
      default:
        return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
  } catch (error: unknown) {
    if (json)
      stdout(io, { ok: false, error: error instanceof Error ? error.message : String(error) });
    else stderr(io, error);
    return 1;
  }
}

function parseServerCliArguments(argv: readonly string[]): {
  argv: readonly string[];
  layout: ReturnType<typeof resolveServerLayout>;
} {
  const rootOptionIndexes = argv.flatMap((value, index) =>
    value === "--server-root" ? [index] : [],
  );
  if (rootOptionIndexes.length > 1) throw new Error("--server-root may only be specified once");
  const rootOptionIndex = rootOptionIndexes[0];
  if (rootOptionIndex === undefined) return { argv, layout: resolveServerLayout() };
  const serverRoot = argv[rootOptionIndex + 1];
  if (!serverRoot) throw new Error("--server-root requires an absolute path");
  if (!isAbsolute(serverRoot)) throw new Error("--server-root must be an absolute path");
  return {
    argv: argv.filter(
      (_value, index) => index !== rootOptionIndex && index !== rootOptionIndex + 1,
    ),
    layout: resolveServerLayout(serverRoot),
  };
}

async function delegateLegacyCli(argv: readonly string[], io: CliIO): Promise<number> {
  const candidate =
    process.env.ACODE_LEGACY_CLI_ENTRY?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "acode.cjs");
  try {
    await access(candidate);
  } catch {
    stdout(io, argv.length ? `Unknown command: ${argv[0]}` : "ACode TUI");
    return argv.length ? 1 : 0;
  }
  const child = fork(candidate, [...argv], { stdio: "inherit" });
  return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
