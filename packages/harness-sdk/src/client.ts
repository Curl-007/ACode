// AcodeHarnessClient——Harness API v1 TypeScript SDK 主入口（connect/launch 双模式）。
// 参照 jcode (MIT) sdk crate 的双模式形态，自撰实现。

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HarnessConnection,
  type HarnessConnectionOptions,
  type HarnessServerInfo,
} from "./connection.js";
import { prepareLaunchRuntime } from "./launch.js";
import { HarnessSession, type CreateSessionInput } from "./session.js";
import { HarnessLaunchError } from "./errors.js";
import type { HarnessSessionSummary } from "@acode/shared/harness-api";

export interface AcodeHarnessClientOptions extends HarnessConnectionOptions {
  /** 权限 fail-closed 超时（缺省 SDK_PERMISSION_TIMEOUT_MS=120s；超时=拒绝）。 */
  permissionTimeoutMs?: number;
}

export interface ConnectOptions {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface LaunchOptions {
  /** 隔离 state home；缺省 ~/.acode/sdk/<uuid>/。 */
  runtimeDir?: string;
  /** 缺省 true：只继承 ACode 自有凭据库（加密文件成对拷贝；钥匙串模式 fail，见 launch.ts 文件头）。 */
  inheritCredentials?: boolean;
  /** harness 入口命令；缺省本仓库 entry-harness.ts（ts 源经 tsx 运行）。 */
  harnessCommand?: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  agentEnv?: NodeJS.ProcessEnv;
  /** internal（缺省）：agent 自治唤醒/空闲退出；external：禁用空闲自退，由外部调度持有生命周期。 */
  wakeMode?: "internal" | "external";
}

export interface LaunchInfo {
  runtimeDir: string;
  credentialInheritance:
    | { status: "none"; reason: string }
    | { status: "inherited"; copiedFiles: string[]; zeroPlaintext: true }
    | { status: "failed"; reason: string };
}

export class AcodeHarnessClient {
  readonly #connection: HarnessConnection;
  readonly #options: AcodeHarnessClientOptions;
  readonly #launchInfo: LaunchInfo | undefined;
  /** M3：client 登记的活跃 session 集合——close（disconnect）时统一回收。 */
  readonly #sessions = new Set<HarnessSession>();

  private constructor(
    connection: HarnessConnection,
    options: AcodeHarnessClientOptions,
    launchInfo: LaunchInfo | undefined,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#launchInfo = launchInfo;
  }

  /** connect 模式：连接既有 harness 服务端（本地 stdio / 远端经消费方自行套 ssh）。 */
  static async connect(
    options: ConnectOptions,
    clientOptions: AcodeHarnessClientOptions = {},
  ): Promise<AcodeHarnessClient> {
    const connection = await HarnessConnection.connect(
      {
        command: options.command,
        args: options.args ?? [],
        ...(options.env ? { env: options.env } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      clientOptions,
    );
    return new AcodeHarnessClient(connection, clientOptions, undefined);
  }

  /**
   * launch 模式：建隔离 runtime 目录（ACODE_DATA_BASE_DIR）+ spawn harness 入口。
   * 继承只针对 ACode 自有凭据库（加密文件成对拷贝，零明文）；第三方 IDE 凭据红线不碰。
   */
  static async launch(
    options: LaunchOptions = {},
    clientOptions: AcodeHarnessClientOptions = {},
  ): Promise<AcodeHarnessClient> {
    const prepared = await prepareLaunchRuntime({
      runtimeDir: options.runtimeDir,
      inheritCredentials: options.inheritCredentials,
      env: options.env,
    });
    // M7(1)：凭据继承 fail 必须 fail 整个 launch（spec 附录 C「fail 并报告」语义）——
    // 此前 failed 只被塞进 launchInfo 静默继续，子进程在无凭据的 runtime 里
    // 一路跑到首次模型调用才炸出不可解密错误。
    if (prepared.credentialInheritance.status === "failed") {
      throw new HarnessLaunchError(
        `harness launch aborted: credential inheritance failed — ${prepared.credentialInheritance.reason}`,
      );
    }
    const harnessCommand = options.harnessCommand ?? resolveHarnessCommand(process.env);
    // wakeMode：external 禁用 agent 空闲自退（ACODE_AGENT_IDLE_EXIT_MS=0），
    // 生命周期由外部调度持有；internal 保持引擎自治（缺省行为不动）。
    const wakeEnv = options.wakeMode === "external" ? { ACODE_AGENT_IDLE_EXIT_MS: "0" } : {};
    const env = {
      ...process.env,
      ...options.env,
      ...options.agentEnv,
      ...prepared.envPatch,
      ...wakeEnv,
    };
    const connection = await HarnessConnection.connect(
      { command: harnessCommand.command, args: harnessCommand.args, env },
      clientOptions,
    );
    return new AcodeHarnessClient(connection, clientOptions, {
      runtimeDir: prepared.paths.runtimeDir,
      credentialInheritance: prepared.credentialInheritance,
    });
  }

  get serverInfo(): HarnessServerInfo {
    return this.#connection.serverInfo;
  }

  get launchInfo(): LaunchInfo | undefined {
    return this.#launchInfo;
  }

  async createSession(input: CreateSessionInput): Promise<HarnessSession> {
    const result = (await this.#connection.request("create_session", {
      workspacePath: resolve(input.cwd),
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.toolDenylist ? { toolDenylist: input.toolDenylist } : {}),
    })) as { sessionId: string };
    const session = new HarnessSession(this, {
      sessionId: result.sessionId,
      workspacePath: resolve(input.cwd),
      workspaceIdentity: input.workspaceIdentity,
      permissionTimeoutMs: this.#options.permissionTimeoutMs,
    });
    // M3：登记活跃 session——client.close()（disconnect）时统一回收监听器与队列。
    this.#sessions.add(session);
    return session;
  }

  /** M3 内部：session.close() 时从登记表摘除（幂等）。 */
  unregisterSession(session: HarnessSession): void {
    this.#sessions.delete(session);
  }

  /** M3 诊断：连接层事件监听器数量（session 泄漏回归观测点）。 */
  get connectionListenerCount(): number {
    return this.#connection.eventListenerCount;
  }

  async listSessions(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<HarnessSessionSummary[]> {
    const result = (await this.#connection.request("list_sessions", {
      workspacePath: resolve(params.workspacePath),
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.includeArchived ? { includeArchived: params.includeArchived } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    })) as { sessions: HarnessSessionSummary[] };
    return result.sessions;
  }

  async getModels(): Promise<{
    providers: { providerId: string; providerName?: string; models: { modelId: string }[] }[];
    preferredSelection?: { providerId: string; modelId: string };
  }> {
    return (await this.#connection.request("get_models", {})) as never;
  }

  async readFile(params: { path: string; offset?: number; length?: number }): Promise<{
    path: string;
    content: string;
    offset: number;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
    isBinary: boolean;
  }> {
    return (await this.#connection.request("read_file", params)) as never;
  }

  async findFiles(params: { rootPath: string; query: string; limit?: number }): Promise<{
    entries: { name: string; path: string; relativePath?: string; type: "file" | "directory" }[];
  }> {
    return (await this.#connection.request("find_files", {
      ...params,
      rootPath: resolve(params.rootPath),
    })) as never;
  }

  /** 内部：session 面复用的请求通道。 */
  request(method: string, params?: unknown): Promise<unknown> {
    return this.#connection.request(method, params);
  }

  /** 订阅连接层事件帧（session 面内部使用；消费方一般用 session.events()）。 */
  addEventListener(
    listener: (frame: {
      sessionId: string;
      seq: number;
      event: import("@acode/shared/harness-api").HarnessEvent;
    }) => void,
  ): () => void {
    return this.#connection.addEventListener(listener);
  }

  async close(): Promise<void> {
    // M3：disconnect 时统一收口所有登记的 session（移除连接级监听器、
    // 结束 events() 迭代器、清权限计时器、best-effort 退订）再关连接。
    for (const session of Array.from(this.#sessions)) {
      await session.close().catch(() => undefined);
    }
    await this.#connection.close();
  }

  /** 立即终止子进程（测试/宿主强制回收；正常关闭走 close）。 */
  kill(): void {
    this.#connection.kill();
  }
}

/**
 * 解析 harness 入口命令（L1 + 缺省链）：
 * 1. `ACODE_HARNESS_COMMAND_JSON`（JSON 数组形态，优先）——命令路径/参数可含空格；
 * 2. `ACODE_HARNESS_COMMAND`（旧空格分隔格式，兼容保留；含空格路径请用 JSON 形态）；
 * 3. 缺省：本仓库 entry-harness.ts（开发/monorepo 场景经 tsx 运行）。
 * 导出供消费方诊断解析结果与测试回归使用。
 */
export function resolveHarnessCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const jsonOverride = env.ACODE_HARNESS_COMMAND_JSON?.trim();
  if (jsonOverride) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonOverride);
    } catch {
      throw new Error("ACODE_HARNESS_COMMAND_JSON is not valid JSON; expected [command, ...args]");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      throw new Error("ACODE_HARNESS_COMMAND_JSON must be a non-empty JSON array of strings");
    }
    const [command, ...args] = parsed as [string, ...string[]];
    return { command, args };
  }
  const override = env.ACODE_HARNESS_COMMAND?.trim();
  if (override) {
    const [command = "", ...args] = override.split(/\s+/);
    if (command.length > 0) return { command, args };
  }
  const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  // SDK 源位于 packages/harness-sdk/src；entry-harness 位于兄弟包 packages/server/src。
  const entry = join(sdkRoot, "..", "server", "src", "entry-harness.ts");
  return { command: process.execPath, args: ["--import", "tsx", entry] };
}
