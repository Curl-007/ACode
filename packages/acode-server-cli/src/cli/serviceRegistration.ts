// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ../cli.ts 拆出。
// 职责：OS service 注册判定族（启用开关、daemon 启动模式、service 入口识别与
// 注册条件）。serve 叶子与 cli.ts 导出面都消费这组纯判定，集中于此避免模块环。

export function serviceRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACODE_SERVER_SKIP_SERVICE_REGISTRATION !== "1";
}

export function daemonStartupMode(env: NodeJS.ProcessEnv = process.env): "service" | "fallback" {
  return serviceRegistrationEnabled(env) ? "service" : "fallback";
}

export function isRegisteredServiceEntry(args: readonly string[]): boolean {
  return args.includes("--service-entry");
}

export const SERVER_SERVICE_ARGS = ["serve", "--supervisor"] as const;

export function shouldRegisterService(
  daemonRequested: boolean,
  supervisorProcess: boolean,
): boolean {
  return daemonRequested && !supervisorProcess;
}
