// relay 独立启动器（specs/browser-relay-inplace-capture.md「集成与共享桶申请」节，编排器裁决：
// 启动面放插件包内而非 @acode/cli 子命令——插件是叶子包，cli 依赖插件会反转依赖方向）。
// 打包产物 scripts/relay-server.mjs（build.mjs 出）或开发树
// `node --import tsx apps/acode-cli/packages/browser-use-plugin/src/relay/main.ts` 直跑。
// 显式 opt-in：relay 永不隐式启动；token 值永不进任何输出（安全节红线）。
import process from "node:process";
import { pathToFileURL } from "node:url";
import { startRelayServer, type RelayServer } from "./server.js";

export const DEFAULT_RELAY_PORT = 9224;

export interface RelayLaunchOptions {
  port: number;
  /** 缺省关闭 token 校验（仅回环边界）；提供则扩展与下游客户端都必须出示。 */
  token?: string;
  /** 被驱动标签归入青色 ACode 标签组（缺省开；--no-group 关）。 */
  group: boolean;
}

export type RelayArgsResult =
  | { ok: true; help?: false; options: RelayLaunchOptions }
  | { ok: false; help?: boolean; error?: string };

const USAGE = `Usage:
  relay-server.mjs [--port <n>] [--token <secret>] [--no-group]

  --port <n>      回环监听端口（默认 ${DEFAULT_RELAY_PORT}；0=临时端口）
  --token <s>     共享密钥：扩展 ?token= 与下游客户端都必须出示；缺省关闭校验
  --no-group      不把被驱动标签归入青色 ACode 标签组（不推荐：组是用户可见的安全指示）
`;

/** 纯函数参数解析（--flag value 与 --flag=value 双形态；未知旗标/坏值拒绝）。 */
export function parseRelayArgs(argv: readonly string[]): RelayArgsResult {
  const options: RelayLaunchOptions = { port: DEFAULT_RELAY_PORT, group: true };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const equalsAt = raw.indexOf("=");
    const flag = equalsAt >= 0 ? raw.slice(0, equalsAt) : raw;
    const inlineValue = equalsAt >= 0 ? raw.slice(equalsAt + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined) return undefined;
      index += 1;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return { ok: false, help: true };
      case "--no-group":
        if (inlineValue !== undefined) return { ok: false, error: `--no-group 不接受值：${raw}` };
        options.group = false;
        break;
      case "--port": {
        const value = takeValue();
        if (value === undefined) return { ok: false, error: "--port 缺少值" };
        if (!/^\d+$/.test(value)) return { ok: false, error: `--port 必须是数字：${value}` };
        const port = Number(value);
        if (port > 65535) return { ok: false, error: `--port 超出范围：${value}` };
        options.port = port;
        break;
      }
      case "--token": {
        const value = takeValue();
        // token 值不回显进错误信息（安全节红线：token 不入日志/输出）。
        if (value === undefined || value.trim() === "") return { ok: false, error: "--token 缺少非空值" };
        options.token = value;
        break;
      }
      default:
        return { ok: false, error: `未知参数：${flag}` };
    }
  }
  return { ok: true, options };
}

/** 启动并驻留；SIGINT/SIGTERM 优雅关停。导出供测试注入信号源。 */
export async function runRelayLauncher(
  options: RelayLaunchOptions,
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    onSignal?: (handler: () => void) => () => void;
  },
): Promise<number> {
  let server: RelayServer;
  try {
    server = startRelayServer({
      port: options.port,
      token: options.token,
      group: options.group,
      // 服务端日志只落 stderr 且由 server 内部保证不含 token（R2 安全节）。
      log: (message, data) => io.stderr(`[browser-relay] ${message} ${JSON.stringify(data ?? {})}`),
    });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let port: number;
  try {
    port = await server.whenListening;
  } catch (error) {
    // EADDRINUSE：显式报「端口被占」（可能已有一个 relay 在跑）——租约语义的单机形态，
    // 静默抢占或复用都会掩盖冲突（lease.ts 同款立场）。
    const reason = error instanceof Error ? error.message : String(error);
    io.stderr(
      `无法在 127.0.0.1:${options.port} 启动：${reason}\n` +
        "端口可能已被另一个 relay 或无关进程占用；换 --port 或停掉占用者。",
    );
    return 1;
  }
  io.stdout(`ACode browser-relay listening on 127.0.0.1:${port}`);
  io.stdout(`token auth: ${options.token !== undefined ? "on" : "off"} · tab group: ${options.group ? "on" : "off"}`);
  io.stdout(`drive it with: agent-browser --cdp ${port} snapshot`);
  return await new Promise<number>((resolveExit) => {
    // 单一 whenStopped 消费者 + signaled 标志：信号关停退出码 0，服务端因内部错误
    // 自行关闭退出码 1（两个 .then 竞争时注册序会决定胜者，优雅路径会被误判失败）。
    let signaled = false;
    const off =
      io.onSignal ??
      ((handler: () => void) => {
        process.once("SIGINT", handler);
        process.once("SIGTERM", handler);
        return () => {
          process.removeListener("SIGINT", handler);
          process.removeListener("SIGTERM", handler);
        };
      });
    const detach = off(() => {
      signaled = true;
      server.stop();
    });
    void server.whenStopped.then(() => {
      detach();
      resolveExit(signaled ? 0 : 1);
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseRelayArgs(process.argv.slice(2));
  if (!parsed.ok) {
    const sink = parsed.help ? process.stdout : process.stderr;
    if (parsed.error) sink.write(`${parsed.error}\n\n`);
    sink.write(USAGE);
    process.exitCode = parsed.help ? 0 : 1;
    return;
  }
  process.exitCode = await runRelayLauncher(parsed.options, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
