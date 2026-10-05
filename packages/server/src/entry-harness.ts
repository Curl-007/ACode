// acode-harness 独立入口：Harness API v1 公开稳定面的 stdio 形态。
// 入口选择（spec 附录同步登记）：acode-server-cli 是 supervisor 守护进程命令面
// （serve/status/stop/restart/update/uninstall + data-root 锁/OS service 注册），
// 在其上挂 --stdio 直连形态会绕过锁与生命周期治理；故按 spec R3 的第二选项走独立 bin。
//
// 与 entry-stdio 的关键差异：握手即回应（hello_ack 不依赖服务面初始化），
// services 懒构造（首个方法请求才 createLocalServices）——嵌入方可先验版本/能力再决定驱动。

import { disposeServiceResourcesAndWait, getAppConfigDir } from "@acode/services/node";
import { ACODE_VERSION, SERVICE_AUTHORITY_MODE_ENV, formatLogPrefix } from "@acode/shared";
import { HARNESS_API_VERSION_MAJOR, HARNESS_API_VERSION_MINOR } from "@acode/shared/harness-api";
import { createHarnessApiServer } from "./harness/index.js";
import { registerStdioProcessLifecycle } from "./stdio-lifecycle.js";
import { createStdioServices } from "./stdioServices.js";
import { createStdioTransport } from "./harness/transport.js";
import {
  materializeBundledACodeBuiltinProviderConfig,
  readBundledACodeBuiltinProviderConfig,
} from "./bundledACodeBuiltinProviderConfig.js";

// stdio 模式下 stdout 只承载协议帧；所有日志（含 services 内 console 输出）一律 stderr。
const log = (...args: unknown[]) =>
  console.error(formatLogPrefix("acode-harness", process.pid), ...args);
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

if (process.argv.includes("--version")) {
  process.stdout.write(
    `${JSON.stringify({ version: ACODE_VERSION, harnessApi: `${HARNESS_API_VERSION_MAJOR}.${HARNESS_API_VERSION_MINOR}` })}\n`,
  );
  process.exit(0);
}

async function main() {
  // 测试钩子（仅测试环境使用）：ACODE_HARNESS_TEST_DROP_EVENT_SEQ 命中的事件帧跳写，
  // 用于 SDK seq gap 检测验证；生产不设置该变量时零影响。
  const dropSeqRaw = process.env.ACODE_HARNESS_TEST_DROP_EVENT_SEQ;
  const testDropEventSeq = dropSeqRaw ? Number.parseInt(dropSeqRaw, 10) : undefined;

  let disposed = false;
  let servicesDisposeTarget: Parameters<typeof disposeServiceResourcesAndWait>[0] | undefined;
  const server = createHarnessApiServer({
    transport: createStdioTransport(process.stdin, process.stdout),
    // 懒工厂：握手与版本拒绝路径完全不触碰服务面；首个方法请求才装配
    // createLocalServices（复用 stdio 服务的 authority/env 推导链）。
    services: async () => {
      const acodeBuiltinProviderConfigFilePath = await materializeBundledACodeBuiltinProviderConfig(
        {
          environmentConfigRoot: getAppConfigDir(),
          content: readBundledACodeBuiltinProviderConfig(),
        },
      );
      const { authorityModeParseResult, services } = createStdioServices({
        env: process.env,
        acodeBuiltinProviderConfigFilePath,
      });
      if (authorityModeParseResult.invalidRawValue) {
        log(
          `${SERVICE_AUTHORITY_MODE_ENV}=${authorityModeParseResult.invalidRawValue} 非法，按默认本机 Environment 权威模式启动`,
        );
      }
      servicesDisposeTarget = services;
      return services;
    },
    serverName: "acode-harness",
    ...(Number.isFinite(testDropEventSeq) ? { testDropEventSeq } : {}),
    log: (message) => log(message),
  });

  registerStdioProcessLifecycle({
    stdin: process.stdin,
    signalSource: process,
    log,
    stopRpc: () => server.stop(),
    // harness entry 与远端 stdio entry 同为 ServiceCollection owner：
    // 退出前必须走同一异步回收契约（Agent 进程树清理），不能直接 process.exit。
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (servicesDisposeTarget) {
        await disposeServiceResourcesAndWait(servicesDisposeTarget);
      }
    },
    exit: (code) => process.exit(code),
  });
  log(`harness api v${HARNESS_API_VERSION_MAJOR}.${HARNESS_API_VERSION_MINOR} ready (stdio)`);
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
