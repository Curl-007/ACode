// ============================================================
// `acode acp` 子命令入口（K8 ACP 宿主适配）。
//
// 职责只有接线：console 边界（ACP stdout 是严格 NDJSON 协议通道）、
// workspace 边界根（进程启动 cwd）、in-process services 生命周期
// （@acode/server/harness-inprocess 公开面）、帧循环起停。
// 协议/映射/会话状态机分别在 acp/{protocol,mapping,session-registry}.ts——
// 本文件不承载任何判定逻辑。
//
// 参照 jcode (MIT) src/cli/acp.rs 的入口组织法，自撰实现。
// ============================================================

import { ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV } from "@acode/provider-node";
import { createInProcessHarnessServices } from "@acode/server/harness-inprocess";
import { HARNESS_MAX_LINE_LENGTH } from "@acode/shared/harness-api";
import {
  ACP_LINE_TOO_LONG,
  createStreamLineSink,
  createStreamLineSource,
} from "./acp/protocol.js";
import { createInProcessHarnessLink } from "./acp/in-process-harness.js";
import { AcpHostAdapter } from "./acp/session-registry.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import type { RunContext } from "@acode/shared-types";
import type { RunDependencies } from "./cli-types.js";

declare const __CLI_VERSION__: string | undefined;

/**
 * 运行 ACP 宿主适配进程：stdin/stdout 上讲 Agent Client Protocol v1，
 * 引擎调用经进程内 K7 harness 桥直达 services（不绕道子进程，spec R1）。
 * 返回码只反映进程级故障——正常生命周期由 stdin 关闭驱动（返回 0）。
 */
export async function runAcpCommand(ctx: RunContext, deps: RunDependencies, version: string): Promise<number> {
  // stdout 只承载 ACP 帧：任何 console 输出（三方依赖的 debug 等）一律引到 stderr。
  // F5：main.ts 已在 import run 之前为 acp 形态安装同款边界——此处保留为幂等
  // 兜底（本命令也可能经测试/嵌入方直接装配）。
  const restoreConsole = installStderrConsoleBoundary(ctx.stderr);
  const log = (message: string): void => {
    ctx.stderr.write(`[acp] ${message}\n`);
  };
  try {
    // workspace 边界根：ACP client 启动本进程的 cwd（session/new 的 cwd
    // 必须落在其内——R3 cwd 越界拒绝的「既有治理」锚点）。
    const allowedRoot = (deps.cwd ?? process.cwd)();

    // in-process services：懒构造 + 退出回收。内置 provider 配置文件路径由
    // main.ts 的 prepareCliProviderRuntimeEnv 物化并经 env 传入（与 CLI 同源，
    // 无 ACP 特权路径——R3 凭据红线：本命令不触碰任何凭据内容）。
    const builtinProviderConfigPath = process.env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV];
    if (!builtinProviderConfigPath) {
      throw new Error(
        `${ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is not set; the acp command requires the CLI provider runtime env (run through the acode entrypoint)`,
      );
    }
    const lifecycle = createInProcessHarnessServices({
      env: process.env,
      acodeBuiltinProviderConfigFilePath: builtinProviderConfigPath,
      onInvalidAuthorityMode: (invalidRawValue) => {
        log(`invalid service authority mode '${invalidRawValue}'; falling back to local environment authority`);
      },
    });

    const link = await createInProcessHarnessLink({
      services: lifecycle.services,
      serverName: "acode-acp",
      log,
    });

    const output = createStreamLineSink(ctx.stdout);
    const adapter = new AcpHostAdapter({
      io: {
        // F4（K8 对抗复核）：stdin 单行接入 HARNESS_MAX_LINE_LENGTH（与 K7
        // harness 传输同一出处）——超限回 line_too_long 语义的 JSON-RPC error
        // （id:null，截断行解析不出请求 id）后断链，防无界缓冲 OOM。
        input: createStreamLineSource(ctx.stdin, {
          onOversize: ({ lineLength }) => {
            log(`input line exceeds ${HARNESS_MAX_LINE_LENGTH} characters (${lineLength}); closing connection`);
            output.writeLine(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: ACP_LINE_TOO_LONG,
                  message: `input line exceeds ${HARNESS_MAX_LINE_LENGTH} characters; closing connection`,
                },
              }),
            );
          },
        }),
        output,
      },
      link,
      allowedRoot,
      agentVersion: version,
      log,
      stderr: (message) => log(message),
    });

    try {
      await adapter.run();
    } finally {
      await lifecycle.dispose();
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`acode acp failed: ${message}\n`);
    return 1;
  } finally {
    restoreConsole();
  }
}
