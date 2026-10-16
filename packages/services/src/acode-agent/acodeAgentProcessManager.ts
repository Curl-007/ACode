import { resolveACodeAgentSpawnCwd } from "#src/acode-agent/acodeAgentSpawnCwd.js";
import type { ACodeAgentStorageStartupSnapshot } from "#src/acode-agent/acodeAgent.js";
/* eslint-disable max-lines -- acodeAgentProcessManager 集中维护 agent 子进程启动、复用、超时回收和 runtime identity，拆分会扩大进程生命周期状态同步面 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@acode/rpc";
import {
  parseACodeProcessDiagnostic,
  classifyAgentEngineError,
  ACODE_AGENT_LIFECYCLE_LOG_MARKER,
  ACODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ACODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ACODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@acode/shared/process-diagnostic";
import {
  ACODE_AGENT_RUNTIME,
  ACODE_AGENT_BYTECODE_ENTRY_FILE,
  ACODE_AGENT_IDLE_EXIT_CODE,
  ACODE_AGENT_IDLE_EXIT_ENV_KEY,
  ACODE_AGENT_IDLE_EXIT_GRACE_MS,
  ACODE_AGENT_MAX_OLD_SPACE_MB_ENV_KEY,
  ACODE_RUNTIME_ENV_KEY,
  DEFAULT_AGENT_MAX_OLD_SPACE_MB,
  acodeProtocolNotifications,
  acodeRuntimeIdleExitParamsSchema,
  appendMaxOldSpaceToNodeOptions,
  isPackagedACodeDesktopRuntime,
  resolveMaxOldSpaceMb,
  resolveWorkspaceKey,
  resolveACodeRuntimeEnv,
  sanitizeACodeRuntimeEnv,
  type ACodeProvider,
} from "@acode/shared";
import {
  findACodeAgentRuntimeBinary,
  findACodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ACodeProtocolClient } from "./acodeProtocolClient.js";
import { ACodeStdioTransport } from "./acodeStdioTransport.js";
import { readACodeStdioTapDevState } from "./acodeStdioTapDevConfig.js";
import {
  AGENT_SPARE_DISABLED_OUTCOME,
  AgentSparePrewarmPool,
  narrowAgentSpareStartOutcome,
  type AgentSparePoolTiming,
  type AgentSparePrewarmConfig,
  type AgentSpareStartOutcome,
} from "./acodeAgentSparePrewarm.js";
import type { ACodeAgentPresentationSurface } from "./acodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

export interface ACodeAgentCommand {
  /** 本地配套 CLI bundle 的存储专用 Worker 入口；远端/自定义命令不推断能力。 */
  storagePreparationEntry?: string;
  /** 本次部署的 Agent 支持迁移前的启动通知；旧自定义命令保持原协议。 */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ACodeAgentCommandResolverContext {
  presentationSurface?: ACodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  /**
   * 本次 spawn 的目标 agent 引擎。缺省/`glm` = native，走既有 app-server 候选链；
   * codex/opencode/gemini 走外部引擎 binary 解析。
   */
  engineId?: ACodeProvider;
}

export type ACodeAgentCommandResolver = (
  context: ACodeAgentCommandResolverContext,
) => Promise<ACodeAgentCommand | null> | ACodeAgentCommand | null;

/**
 * chat lane 备用进程预热装配(spec: packages/services/specs/agent-process-prewarm.md)。
 * CUA 等 workspace 姿态知识留在装配方(node.ts),manager 只消费两个注入 hook。
 */
export interface ACodeAgentSparePrewarmOptions {
  /** 装配时解析的启用/池大小事实(node.ts 经 resolveAgentSparePrewarmConfig 产出)。 */
  config?: AgentSparePrewarmConfig;
  /** 备件 spawn 的中性 cwd;缺省 os.homedir()。认领前备件不绑定任何 workspace(spec R5)。 */
  prewarmCwd?: string;
  /** 备件 spawn 时记录的上下文事实(如 cuaEnabled),供认领门禁消费(spec R5)。 */
  collectSpawnContextFacts?: (context: {
    workspacePath: string;
    workspaceKey: string;
  }) => Record<string, boolean>;
  /**
   * 同步认领门禁(spec R2/R5):返回 false 不消耗备件(outcome=spare_miss_ineligible)。
   * 必须同步可判,否则会破坏认领的全同步单飞语义。
   */
  resolveClaimEligibility?: (
    context: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
    spare: { facts: Record<string, boolean> },
  ) => boolean;
  /** 调度参数注入(测试用);生产走 AGENT_SPARE_POOL_TIMING_DEFAULTS。 */
  timing?: Partial<AgentSparePoolTiming>;
}

export interface ACodeAgentProcessManagerOptions {
  commandResolver?: ACodeAgentCommandResolver;
  presentationSurface?: ACodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * 进程泳道标识。同一 workspace 的不同泳道各走独立 manager 实例；lane 会写入
   * runtimeIdentity 与 spawn/exit 日志，便于排障区分。
   * 缺省为 chat 主泳道，不追加任何标记。
   */
  lane?: string;
  /**
   * 空闲回收阈值：连接上没有请求在飞持续超过该时长，就主动回收整棵进程树，
   * 下次 getClient 透明重新拉起。只给 mcp-status 这类“按需探测、进程内挂着 MCP 子进程”
   * 的控制面 lane 使用；chat / plugin 缺省不回收。
   */
  idleTimeoutMs?: number;
  /**
   * 关闭 CLI 侧空闲自退(spec: packages/services/specs/chat-lane-idle-reclaim.md R8):
   * spawn env 注入 ACODE_AGENT_IDLE_EXIT_MS=0。plugin lane 维持现状不回收;
   * mcp-status lane 已有 Host 侧 idleTimeoutMs,单一所有者,不叠加第二套机制。
   * chat lane 缺省启用 CLI 侧空闲退出,不允许调用方经 service options 关闭(Omit)。
   */
  disableCliIdleExit?: boolean;
  /**
   * 仅当默认进程 cwd 等于目标 workspace 且该目录不可用时使用。
   * 业务 workspacePath/workspaceKey 不随 cwd 兜底改变。
   */
  spawnFallbackCwd?: string;
  /**
   * 每次 spawn agent 子进程前解析的额外环境变量（在 process.env 之后、workspace 变量之前合入）。
   * 用于把设置页的代理等配置注入子进程；按 spawn 时读取，天然「下次启动生效」。
   *
   * context 携带本次 spawn 的 workspace 标识三元组（workspacePath/workspaceIdentity/workspaceKey），
   * 让 CUA broker 凭据注入能按 workspace 记录 Helper admission（见 services/node.ts 的
   * cuaProductHelperWorkspaceRegistry）。Helper lifecycle 不再回收或重启已有 Agent。
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * 可选的外部 spawn admission hook。CUA 默认装配不再注入 Helper recovery gate，
   * 避免 Helper lifecycle 阻塞或间接重启 Agent；保留该通用 hook 供其他产品策略使用。
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
  /**
   * 备用进程预热(spec: packages/services/specs/agent-process-prewarm.md)。
   * 只有 chat lane 主 manager 装配;plugin/mcp-status lane 的显式字段装配不透传,
   * 传入即启用 timing 日志(config.enabled=false 时 outcome 恒 spare_miss_disabled)。
   */
  sparePrewarm?: ACodeAgentSparePrewarmOptions;
}

interface ManagedACodeAgentProcess {
  client: ACodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  cleanupPromise?: Promise<void>;
  engineId: ACodeProvider;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** CLI 宣告帧携带的静默时长;兜底归因(仅退出码)路径无值。 */
  idleExitAnnounced?: { quiescentMs: number; announcedAt: number };
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ACodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  /**
   * 当前登记的 workspaceKey(spec: agent-process-prewarm.md R2)。普通进程恒等于 spawn 时
   * 的 key;备件在认领时从合成 prewarm key 改写为真实 key,所有 handler 以本字段为准,
   * 不得再消费 spawn 闭包捕获的旧 key。
   */
  workspaceKey: string;
  /**
   * 备件标记:存在即为预热 spawn 的进程。claimed=false 期间不发布任何真实 workspace
   * 生命周期事件;errorName 供池的失败归因(白名单收窄后进日志)。
   */
  prewarm?: {
    claimed: boolean;
    facts: Record<string, boolean>;
    errorName?: string;
  };
  /** available/restarted 恰好发布一次的守卫(claim 与 spawn 事件竞态,spec R2)。 */
  runtimeAvailableAnnounced?: boolean;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

/** 池索引的备件包装;进程事实全部在 managed 上,record 只带认领门禁与记账所需元数据。 */
interface ManagedSpareRecord {
  managed: ManagedACodeAgentProcess;
  facts: Record<string, boolean>;
  spawnedAt: number;
}

type SpareClaimDecision =
  | { client: ACodeProtocolClient; spare: ManagedSpareRecord }
  | { outcome: AgentSpareStartOutcome };

/** 合成 prewarm key 前缀:含 `__` 与 `:`,不与 resolveWorkspaceKey(identity||path)冲突。 */
const AGENT_SPARE_PREWARM_KEY_PREFIX = "__acode-agent-spare__";

type AgentProcessCleanupReason =
  | "cli-idle-exit"
  | "cli-idle-exit-code"
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

function buildE2EAgentCoverageEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const artifactDir = env.ACODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ACODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "acode-e2e-coverage-preload.cjs");
  // CLI bundle 未压缩时解析耗时可能超过 E2E 的早退窗口，普通 shutdown
  // handler 尚未注册就收到 SIGTERM。用 NODE_OPTIONS preload 在解析 bundle 前接管落盘。
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * （CLI 重连重订边界）：同一 workspace 的 agent 进程被重建（超时回收/崩溃后
 * 首个 getClient 重新拉起）。v4 订阅（sessions-index/workspace-config/conversation）
 * 都活在 CLI 进程内存里，进程换代即失效——订阅方收到本事件后必须重发 subscribe。
 */
interface ACodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ACodeAgentRuntimeIdentity;
}

export interface ACodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ACodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

interface ACodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** 进程泳道标识；chat 主泳道缺省为空。 */
  lane?: string;
}

interface ACodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("acode-agent");

const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
const AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_STDERR_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_STDERR_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

function redactAgentDiagnostic(value: string): string {
  return (
    value
      .replace(AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_STDERR_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // 裸 key 也必须在跨进程诊断和生产日志之前遮盖。
      .replace(AGENT_STDERR_API_KEY_PATTERN, "$1<redacted>")
  );
}

const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ACODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function buildACodeAgentSpawnPreflight(
  command: ACodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ACodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveACodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn 的 ENOENT 既可能来自 command 缺失，也可能来自 cwd 缺失。
    // 生产日志在 spawn 前同时记录两者可见性，避免把工作区路径丢失误判成自动更新丢 binary。
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceACodeAgentCommand(
  context: ACodeAgentCommandResolverContext,
): ACodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/acode-cli/packages/cli/dist/acode.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ACODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), ACODE_AGENT_BYTECODE_ENTRY_FILE)
      : distEntrypoint;
    // 此同步 command resolver 沿用既有 existsSync 契约；显式试验不能静默回退成 JS。
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker 与 Electron Node 子进程的 V8 snapshot 可不同；临时存储准备继续用 JS。
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // 桌面端 host 运行在 Electron utility process 中，process.execPath 指向 Electron Helper。
      // 这里显式启用 Node 运行模式，避免内置 acode-agent 被当成 Electron/Chromium 子进程启动并卡在 GPU 初始化。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/acode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedACodeAgentBinaryCommand(
  context: ACodeAgentCommandResolverContext,
): ACodeAgentCommand | null {
  // 旧 resolver 只识别 ACODE_AGENT_SERVER_COMMAND env 和 monorepo 源码树。
  // SSH 远端把 acode-server.cjs 单文件部署到 ~/.acode/server/，宿主进程的 cwd 不在仓库内、
  // env 也不会被 ssh exec 继承，即使 acode-agent 已经部署到 ~/.acode/server/agents/glm/，
  // resolver 也找不到，第一次 getClient 就抛 "ACode agent server command is not configured"。
  // 这里复用 findACodeAgentRuntimeBinary 的候选链（含 GLM_BINARY_PATH env、
  // packagedResourcesPath、~/.acode/server/agents/glm、bundled-agents 等），
  // 把已部署的原生 binary 当成最终兜底，远端/桌面打包形态都能命中。
  const binaryPath = findACodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ACODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

/**
 * J5-L1：生产 agent 入口解析——优先 V8 字节码 loader（若随包 staged），否则 acode.cjs。
 *
 * 安全设计（关键）：字节码 .jsc 严格绑定编译时的 Electron/V8/平台/架构 + cachedDataVersionTag，
 * 而 cachedDataVersionTag 依赖 V8 标志（编译/加载侧经 configureBytecodeRuntime 设
 * --no-lazy --no-flush-bytecode）。host 进程无法在不污染自身 V8 行为的前提下复现该 tag，
 * 故 **host 侧不做指纹预检**（预检通过但 loader 硬失败仍是 P0）。权威校验放在 agent 进程内的
 * loader：本 resolver 选用 loader 时同时设 ACODE_BYTECODE_FALLBACK=1，loader 在字节码失配/损坏时
 * require 同目录 acode.cjs 优雅回退（最坏情况 = 回退现状 JS，agent 照常启动）。
 * dev 显式试验路径（resolveBundledWorkspaceACodeAgentCommand）不设此 env → loader 硬失败暴露问题。
 */
function resolveElectronRuntimeACodeAgentCommand(
  context: ACodeAgentCommandResolverContext,
): ACodeAgentCommand | null {
  // 桌面打包态：host 跑在 Electron utility process 里，process.execPath 指向 Electron Helper，
  // 它内置的 Node runtime 与 acode-cli 目标版本一致（Electron 41 = Node 24.x）。
  // 这里直接用 app 自带的 Electron Node 执行打进 resources/glm 的 acode.cjs，
  // 不再随包内置一份独立 Node 二进制（体积从 ~180MB 降到 ~16MB，且跨平台同一份 JS）。
  // 用 process.versions.electron 作为闸门：远端 SSH/WSL host 由系统 Node 运行、没有 electron，
  // 会跳过这里继续走原生二进制兜底，桌面/远端两条链路互不影响。
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findACodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  // J5-L1：生产优先 V8 字节码入口（就绪 -44%，见 docs/j5-performance-baseline.md §3）。
  // 安全（对抗复核 F3）：字节码 loader 只认 **已解析 JS bundle 的同目录兄弟**，不跑独立候选链——
  // 独立链会下沉到 ~/.acode/server/agents/glm 等用户可写目录，打包态下任何同用户进程写入
  // acode.bytecode.cjs 即可劫持 agent 入口（回退 agent-command-env-gate 加固）。同目录兄弟保证
  // loader 与 acode.cjs 同源于同一可信目录（生产=只读签名区 process.resourcesPath/glm）。
  // loader 内置优雅回退（ACODE_BYTECODE_FALLBACK=1）：字节码失配/损坏 → agent 进程内 require acode.cjs。
  // storagePreparationEntry 恒为 JS bundle：Worker 与 Electron Node 子进程 V8 snapshot 可不同（沿用既有语义）。
  const bytecodeSibling = join(dirname(bundlePath), ACODE_AGENT_BYTECODE_ENTRY_FILE);
  const bytecodeLoaderPath = existsSync(bytecodeSibling) ? bytecodeSibling : null;
  const entrypoint = bytecodeLoaderPath ?? bundlePath;
  return {
    command: process.execPath,
    args: [entrypoint, ...ACODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // 关键：必须以纯 Node 模式启动，否则子进程会被当成 Electron/Chromium 子进程卡在 GPU 初始化。
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // 仅在实际选用字节码 loader 时设回退标志；走 JS bundle 时无需设（loader 不会被执行）。
      ...(bytecodeLoaderPath ? { ACODE_BYTECODE_FALLBACK: "1" } : {}),
    },
  };
}

export function resolveDefaultACodeAgentCommand(
  context: ACodeAgentCommandResolverContext,
): ACodeAgentCommand | null {
  // 引擎联合只剩 native(glm)（外部引擎槽位已下线，spec: agent-engine-external-slots-removal.md）；
  // context.engineId 仅作形状保留，所有输入都走下方 native 候选链。

  // 安全加固 P2（agent-command-env-gate R1）：打包态忽略 ACODE_AGENT_SERVER_COMMAND 族。
  // launchctl setenv / shell profile / Windows 用户环境变量可在用户级权限下注入 GUI 应用
  // 的启动环境；这三个变量能整体替换 agent spawn 命令，等于每个任务静默运行攻击者二进制。
  // 非打包态（dev/独立 CLI/远程 server）照常生效——那些场景用户就是管理员。
  const command = isPackagedACodeDesktopRuntime()
    ? undefined
    : process.env.ACODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ACODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ACODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // 顺序：env 显式覆盖 → monorepo dev 源码/dist（dev 改源码立刻生效，不会被远端历史装的 native binary
  // 抢先匹配）→ 桌面打包态 Electron Node runtime 跑 acode.cjs → 已部署 native binary（远端 SSH 兜底）。
  const bundled =
    resolveBundledWorkspaceACodeAgentCommand(context) ??
    resolveElectronRuntimeACodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedACodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ACodeAgentCommand | null,
  presentationSurface: ACodeAgentCommandResolverContext["presentationSurface"],
): ACodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug 原因：旧逻辑无条件消费下一个 token，孤立的 --surface 会把后续
      // --stdio 等 option 一并吞掉，导致自定义 Agent 命令失去协议启动参数。
      // 只有明确的非 option value 才属于 --surface；其他 option 继续走原参数链路。
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

function wrapACodeAgentCommandWithStdioTapDevProxy(
  command: ACodeAgentCommand,
  workspaceKey: string,
): ACodeAgentCommand {
  const tapState = readACodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/acode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ACode stdio tap proxy enabled but script not found");
    return command;
  }

  // 开发态 raw stdio 帧数据量和消息流同级，不能打进普通 info 日志。
  // 这里只在显式开关打开时用旁路 proxy 写盘，生产构建和默认开发路径都不受影响。
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export class ACodeAgentProcessManager {
  private readonly processesByWorkspaceKey = new Map<string, ManagedACodeAgentProcess>();
  private readonly ownedProcesses = new Set<ManagedACodeAgentProcess>();
  private readonly startingByWorkspaceKey = new Map<string, Promise<ACodeProtocolClient>>();
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ACodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ACodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ACodeAgentCommandResolver;
  private readonly presentationSurface: ACodeAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ACodeAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ACodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly disableCliIdleExit: boolean;
  private readonly sparePrewarmOptions: ACodeAgentSparePrewarmOptions | undefined;
  /** config.enabled=false 时不创建池;timing 日志按 disabled 归因(spec R3/R6)。 */
  private readonly sparePool: AgentSparePrewarmPool<ManagedSpareRecord> | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ACodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ACodeAgentRuntimeLifecycleEvent>();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** 进程换代通知（generation>1 时触发）；v4 订阅方据此重订，见 ACodeAgentRuntimeRestartedEvent。 */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** 进程真实 spawn 后 available，当前 protocol client 关闭后 unavailable。 */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ACodeAgentProcessManagerOptions) {
    this.commandResolver = options?.commandResolver ?? resolveDefaultACodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
    this.disableCliIdleExit = options?.disableCliIdleExit === true;
    this.sparePrewarmOptions = options?.sparePrewarm;
    const sparePrewarmConfig = this.sparePrewarmOptions?.config;
    if (this.sparePrewarmOptions && sparePrewarmConfig?.enabled) {
      this.sparePool = new AgentSparePrewarmPool<ManagedSpareRecord>(
        {
          spawnSpare: () => this.spawnSpareProcess(),
          logger: {
            info: (message, context) => log(message, context),
            warn: (message, context) => warnLog(message, context),
          },
        },
        {
          poolSize: sparePrewarmConfig.poolSize,
          ...(this.sparePrewarmOptions.timing ? { timing: this.sparePrewarmOptions.timing } : {}),
        },
      );
      this.sparePool.start();
      log("ACode agent spare prewarm enabled", { poolSize: sparePrewarmConfig.poolSize });
    } else if (this.sparePrewarmOptions) {
      // kill switch / size=0 / 非 desktop-local 缺省策略:只留 disabled 归因,不孵化进程。
      log("ACode agent spare prewarm disabled", {
        reason: sparePrewarmConfig?.disabledReason ?? "unconfigured",
      });
    }
  }

  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // 进程生命周期上报是旁路观测，临时失败不得阻断 agent 启动或回收。
      warnLog("ACode agent process lifecycle reporter failed", error);
    }
  }

  private clearIdleTimer(managed: ManagedACodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * 空闲回收：每次在飞请求归零就重置计时；到点时若仍无请求在飞且该进程仍是当前活跃实例，
   * 主动回收整棵进程树（含挂在其下的 MCP 子进程）。归因为 expected/idle-timeout，
   * 不会被监控当作崩溃。到点时有新请求在飞则什么都不做，等下一次归零重新计时。
   */
  private scheduleIdleReclaim(managed: ManagedACodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      // 认领可能改写 managed.workspaceKey(spec: agent-process-prewarm.md R2);
      // 判等与日志一律读当前登记 key,不消费排程时捕获的旧值。
      const workspaceKey = managed.workspaceKey;
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // 自定义 Agent 的旧启动请求可能先结清，再继续数据库准备；无在飞 RPC 不代表迁移空闲。
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ACode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // 空闲计时器不能把 host 进程钉在事件循环里。
    timer.unref?.();
    managed.idleTimer = timer;
  }

  private recordTerminationIntent(
    managed: ManagedACodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // protocol close 可能是 Agent 崩溃的结果，只有 Host 主动发起的回收
    // 才能建立退出意图。首次 cleanup 原因是根因事实，后续 app quit 等幂等回收不能
    // 把已经发生的异常 protocol close 改写成 expected。
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  private reportRuntimeUnavailable(managed: ManagedACodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
  }

  private reportRuntimeReady(managed: ManagedACodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: managed.engineId,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  private cleanupManagedProcess(
    managed: ManagedACodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close 只会使 client 不再可复用，不代表它对应的
    // OS 进程已退出。将回收 Promise 绑在 managed process 上，timeout、restart 和
    // app quit 可以共用同一次幂等回收，Host 也不会丢失已退休进程的所有权。
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(() => {
        cleanupCompleted = true;
        log("ACode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    if (options.reportError !== false) {
      void cleanupPromise.catch((error) => {
        errorLog("ACode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
          error,
        });
      });
    }
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(managed: ManagedACodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  private async cleanupManagedProcessWithRetry(
    managed: ManagedACodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // 首次 cleanup 的进程树/exit 观察可能只是中间态；在 retry 成功时，
      // 首次 rejection 不应提前升级为生产 error 告警。最终失败仍由本方法统一上报一次。
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows 进程表查询/exit 事件可能短暂落后，首次 cleanup 会误报 root
      // 残留。restart/app quit 都不能把这种中间态暴露给调用方，需重试一次并复用
      // transport 内部快照；真实残留会在第二次 cleanup 继续抛出。
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ACode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ACode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    engineId?: ACodeProvider;
  }): Promise<ACodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ACode agent process manager is disposed.");
    }
    const workspaceKey = resolveWorkspaceKey(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
      return existing.client;
    }

    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ACode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ACode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      return client;
    }

    // 进程获取决策点(spec: agent-process-prewarm.md R2/R3):复用既有进程与并入在飞
    // 启动都不是获取事件,不打 timing 日志;只有走到认领/冷启动分叉才记 outcome。
    // 认领全同步(无 await),两个 workspace 并发时恰好一个拿到备件(单飞)。
    const acquisitionStartedAt = Date.now();
    let missOutcome: AgentSpareStartOutcome | undefined;
    if (this.sparePrewarmOptions) {
      const decision = this.tryClaimSpare(params, workspaceKey);
      if ("client" in decision) {
        this.logSessionStartTiming({
          outcome: "spare_hit",
          workspaceKey,
          acquisitionMs: Date.now() - acquisitionStartedAt,
          spare: decision.spare,
        });
        return decision.client;
      }
      missOutcome = decision.outcome;
    }

    // agent 启动前置后，host warmup 和 UI 首次 readWorkspacePresentation/sendPrompt
    // 可能同时进入 getClient。这里按 workspaceKey 收敛启动中的 promise，避免同一工作区重复 spawn。
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
      if (missOutcome !== undefined) {
        // 冷启动成败都要落 miss 归因:失败路径的 acquisitionMs 就是失败前的等待时长,
        // 错误详情由既有 errorLog/reporter 承载,timing 日志不带自由文本(spec R3)。
        this.logSessionStartTiming({
          outcome: missOutcome,
          workspaceKey,
          acquisitionMs: Date.now() - acquisitionStartedAt,
        });
      }
    }
  }

  /**
   * 只读取已经登记的 runtime client；被动 observer 使用本入口避免 getClient 的隐式 spawn。
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ACodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /**
   * 备件池诊断投影(spec: agent-process-prewarm.md R1/R4):测试与资源管理器只读入口;
   * 未装配 sparePrewarm 时返回 null(与「装配了但 disabled」可区分)。
   */
  getSparePrewarmState(): {
    configured: true;
    enabled: boolean;
    standbyCount: number;
    consecutiveFailures: number;
    circuitOpen: boolean;
    spawnInFlight: boolean;
    pendingTrigger: string | null;
    disposed: boolean;
  } | null {
    if (!this.sparePrewarmOptions) {
      return null;
    }
    if (!this.sparePool) {
      return {
        configured: true,
        enabled: false,
        standbyCount: 0,
        consecutiveFailures: 0,
        circuitOpen: false,
        spawnInFlight: false,
        pendingTrigger: null,
        disposed: this.disposed,
      };
    }
    const snapshot = this.sparePool.snapshot();
    return {
      configured: true,
      enabled: true,
      standbyCount: snapshot.standbyCount,
      consecutiveFailures: snapshot.consecutiveFailures,
      circuitOpen: snapshot.circuitOpen,
      spawnInFlight: snapshot.spawnInFlight,
      pendingTrigger: snapshot.pendingTrigger,
      disposed: snapshot.disposed || this.disposed,
    };
  }

  /** 资源管理器：当前仍存活的受管 runtime（pid + workspace + client） */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ACodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ACodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Agent service 首次通过 provider/model 门禁后调用；同一 runtime 只上报一次。 */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ACodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient 可能早于 ChildProcess 的异步 spawn 事件返回，也可能在 await 期间
    // 被新 runtime 替换。只给返回该 entry 的进程标 ready，并由 spawn 回调保证 start → ready 顺序。
    this.reportRuntimeReady(managed);
  }

  /**
   * 孵化一个不绑定 workspace 的备件进程(spec: agent-process-prewarm.md R1/R5)。
   * 复用 startClient 的完整装配面(env 组装、admission、代际/disposed 检查),
   * 不另建第二套 spawn 实现;以合成 key 登记,认领时 rekey 到真实 workspace。
   */
  private async spawnSpareProcess(): Promise<ManagedSpareRecord> {
    const prewarmOptions = this.sparePrewarmOptions;
    if (!prewarmOptions) {
      throw new Error("ACode agent spare prewarm is not configured.");
    }
    const prewarmCwd = prewarmOptions.prewarmCwd?.trim() || homedir();
    const spareId = randomUUID();
    const prewarmKey = `${AGENT_SPARE_PREWARM_KEY_PREFIX}:${spareId}`;
    // 预热 context 无 identity:备件在认领前不携带 workspace 身份 env(spec R5)。
    const facts =
      prewarmOptions.collectSpawnContextFacts?.({
        workspacePath: prewarmCwd,
        workspaceKey: prewarmKey,
      }) ?? {};
    // 与 getClient 同构的 admission 登记:disposeAll 的 abortAllPendingStarts 能中止在飞备件 spawn。
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(prewarmKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(prewarmKey, controllers);
    }
    controllers.add(admissionAbortController);
    try {
      await this.startClient(
        { workspacePath: prewarmCwd },
        prewarmKey,
        0,
        admissionAbortController.signal,
        facts,
      );
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(prewarmKey);
      }
    }
    const managed = this.processesByWorkspaceKey.get(prewarmKey);
    if (!managed) {
      // spawn 后进程立即退出且 onClose 已摘除登记:按失败交给池退避,不索引死备件。
      throw new Error("ACode agent spare prewarm process exited before it was pooled.");
    }
    const record: ManagedSpareRecord = { managed, facts, spawnedAt: managed.startedAt };
    // 丢失观察:client close 是进程退出的权威边界(既有 onClose 回收流程之后触发)。
    // 认领后的生命周期归 workspace 流程所有,池不再记账(take 已在认领时完成)。
    managed.client.onClose(() => {
      if (managed.prewarm?.claimed) return;
      this.sparePool?.onLost(record, {
        lifetimeMs: Date.now() - record.spawnedAt,
        ...(managed.prewarm?.errorName !== undefined
          ? { errorName: managed.prewarm.errorName }
          : {}),
      });
    });
    return record;
  }

  /**
   * 同步认领决策(spec R2):遍历待命索引,死备件当场按丢失记账淘汰,门禁拒绝不消耗备件;
   * 命中即 take(池同步单飞)+ rekey 登记。全路径无 await。
   */
  private tryClaimSpare(
    params: { workspacePath: string; workspaceIdentity?: string },
    workspaceKey: string,
  ): SpareClaimDecision {
    const pool = this.sparePool;
    if (!pool) {
      return { outcome: AGENT_SPARE_DISABLED_OUTCOME };
    }
    const eligibility = this.sparePrewarmOptions?.resolveClaimEligibility;
    let sawIneligible = false;
    for (const entry of pool.standbyEntries()) {
      const managed = entry.managed;
      if (managed.exited || managed.child.killed || managed.prewarm?.claimed) {
        // watch 回调尚未送达的死备件:当场淘汰并按短寿/长寿分类进补位调度(幂等)。
        pool.onLost(entry, {
          lifetimeMs: Date.now() - entry.spawnedAt,
          ...(managed.prewarm?.errorName !== undefined
            ? { errorName: managed.prewarm.errorName }
            : {}),
        });
        continue;
      }
      if (
        eligibility &&
        !eligibility(
          {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            workspaceKey,
          },
          { facts: entry.facts },
        )
      ) {
        sawIneligible = true;
        continue;
      }
      if (!pool.take(entry)) {
        continue;
      }
      this.claimSpareRecord(entry, params, workspaceKey);
      return { client: managed.client, spare: entry };
    }
    if (sawIneligible) {
      return { outcome: "spare_miss_ineligible" };
    }
    return { outcome: pool.missOutcome() };
  }

  /**
   * 认领 rekey(spec R2):备件成为目标 workspace 的当前 runtime。登记迁移、代际递增、
   * identity 重建、事件补发全部同步完成;顺序镜像正常 spawn 的 restarted → available。
   */
  private claimSpareRecord(
    record: ManagedSpareRecord,
    params: { workspacePath: string; workspaceIdentity?: string },
    workspaceKey: string,
  ): void {
    const managed = record.managed;
    const prewarmKey = managed.workspaceKey;
    if (managed.prewarm) {
      managed.prewarm.claimed = true;
    }
    if (this.processesByWorkspaceKey.get(prewarmKey) === managed) {
      this.processesByWorkspaceKey.delete(prewarmKey);
    }
    managed.workspaceKey = workspaceKey;
    managed.workspace = {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    };
    const generation = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, generation);
    managed.runtimeIdentity = {
      generation,
      identity: this.lane
        ? `${workspaceKey}:${generation}:${managed.child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${generation}:${managed.child.pid ?? "unknown"}`,
      ...(typeof managed.child.pid === "number" ? { processId: managed.child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    log("ACode agent spare process claimed", {
      workspaceKey,
      pid: managed.child.pid,
      runtimeIdentity: managed.runtimeIdentity.identity,
      spareAgeMs: Math.max(0, Date.now() - record.spawnedAt),
    });
    if (managed.spawned) {
      // available 只认真实 spawn 过的进程;claim 早于 spawn 事件的竞态由 spawn handler
      // 以 claimed=true 补发(announced 守卫保证恰好一次)。
      this.announceRuntimeAvailable(managed);
    }
    // 待命期的 storageStartup 事件用合成 key 发布,真实 key 的订阅方错过了;
    // 认领时以真实 key 补发一次当前快照(onDidChange 后续增量已读 managed.workspaceKey)。
    this.storageStartupEmitter.fire({
      workspaceKey,
      snapshot: {
        generation,
        state: managed.client.storageStartup.snapshot ?? null,
      },
    });
  }

  /** available/restarted 的恰好一次发布点;claim 与 spawn handler 共用(announced 守卫)。 */
  private announceRuntimeAvailable(managed: ManagedACodeAgentProcess): void {
    if (managed.runtimeAvailableAnnounced || managed.exited) {
      return;
    }
    const workspaceKey = managed.workspaceKey;
    if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
      return;
    }
    managed.runtimeAvailableAnnounced = true;
    if (managed.runtimeIdentity.generation > 1) {
      this.runtimeRestartedEmitter.fire({
        workspaceKey,
        runtimeIdentity: managed.runtimeIdentity,
      });
    }
    this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, managed.runtimeIdentity.identity);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "available",
    });
  }

  /** session start timing 日志(spec R3):outcome 恒经闭集收窄,自由文本不进本日志。 */
  private logSessionStartTiming(event: {
    outcome: AgentSpareStartOutcome;
    workspaceKey: string;
    acquisitionMs: number;
    spare?: ManagedSpareRecord;
  }): void {
    const outcome = narrowAgentSpareStartOutcome(event.outcome);
    log("ACode agent session start timing", {
      ...(outcome ? { outcome } : {}),
      workspaceKey: event.workspaceKey,
      acquisitionMs: event.acquisitionMs,
      ...(event.spare
        ? {
            sparePid: event.spare.managed.child.pid,
            spareAgeMs: Math.max(0, Date.now() - event.spare.spawnedAt),
            storageReady: event.spare.managed.client.storageStartup.snapshot?.phase === "ready",
          }
        : {}),
    });
  }

  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      engineId?: ACodeProvider;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
    /** 存在即为备件 spawn(spec: agent-process-prewarm.md R1):记录认领门禁事实。 */
    prewarmFacts?: Record<string, boolean>,
  ): Promise<ACodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    // 引擎联合只剩 native(glm)：engineId 恒为 ACODE_AGENT_PROVIDER，旧 provider 值已在上游归一。
    const engineId: ACodeProvider = "glm";
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
      engineId,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "ACode agent server command is not configured. Set ACODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ACode agent process start was cancelled.");
    }
    const effectiveCommand = wrapACodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ACode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery 可能在 command resolve 期间开始；先等待一次，确保 env 解析使用
    // recovery 后的 broker 凭据，而不是把旧状态带到 spawn 边界。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // 设置页代理等运行时 env 在 process.env 之后合入（覆盖继承的同名 shell 变量），
    // 但仍让 command.env（部署特定）保持最高优先级。
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // app 正在关闭时，启动中的 warmup 可能刚完成 command/env resolve。
      // 这时继续 spawn 会绕过 disposeAllAndWait 的快照，重新制造一个无人托管的 agent 进程。
      throw new Error("ACode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // 切模型会重启单个 workspace。旧启动请求如果在重启后才恢复，
      // 不能继续 spawn 并写回进程池，否则新配置会被旧 agent 覆盖。
      throw new Error("ACode agent process start was cancelled.");
    }
    // cwd 探测也让出事件循环，必须放在最终 admission 与销毁/代际检查之前。
    const spawnPreflight = await buildACodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve 本身是异步的，恢复屏障可能在这段时间重新关闭；必须在 spawn 前
    // 再等待并复查代际，不能只依赖第一次 admission。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ACode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ACode agent process start was cancelled.");
    }
    // app 以本地开发方式启动时，让 agent 子进程也带上 ACODE_RUNTIME_ENV=development；
    // 不再传 NODE_ENV，避免用户 shell/runtime 变量影响 ACode 运行模式或泄漏到 Bash 工具。
    const runtimeEnv = resolveACodeRuntimeEnv(process.env);
    log("ACode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const agentSpawnEnv: Record<string, string> = {
      ...sanitizeACodeRuntimeEnv(process.env),
      [ACODE_RUNTIME_ENV_KEY]: runtimeEnv,
      ...spawnEnv,
      ...effectiveCommand.env,
      // 身份/隔离语义使用 workspaceIdentity；cwd 继续使用 workspacePath。
      ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
      // lane 级策略优先级最高:plugin/mcp-status 显式关闭 CLI 空闲自退(spec
      // chat-lane-idle-reclaim.md R8),不允许被继承 env 覆盖;chat lane 不注入,
      // 走 CLI 缺省(启用)与 ACODE_AGENT_IDLE_EXIT_MS 调优。
      ...(this.disableCliIdleExit ? { [ACODE_AGENT_IDLE_EXIT_ENV_KEY]: "0" } : {}),
      ...buildE2EAgentCoverageEnv(),
    };
    // v8 堆上限护栏(spec: packages/services/specs/agent-v8-heap-guard.md R2):
    // 在 coverage env 之后合并,保留既有 NODE_OPTIONS 片段(如 E2E preload);
    // 继承的用户值已被 sanitize 剔除,这里只注入 Host 装配的护栏值。
    const guardedNodeOptions = appendMaxOldSpaceToNodeOptions(
      agentSpawnEnv.NODE_OPTIONS,
      resolveMaxOldSpaceMb(
        process.env[ACODE_AGENT_MAX_OLD_SPACE_MB_ENV_KEY],
        DEFAULT_AGENT_MAX_OLD_SPACE_MB,
      ),
    );
    if (guardedNodeOptions !== undefined) {
      agentSpawnEnv.NODE_OPTIONS = guardedNodeOptions;
    }
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // agent 可能再派生实际 runtime/MCP 子进程。POSIX 下让 wrapper 进入独立进程组，
      // 关闭时才能按进程树整体回收；Windows 保持非 detached，交给 taskkill /T 处理。
      detached: shouldSpawnInDetachedProcessGroup(),
      env: agentSpawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    const transport = new ACodeStdioTransport(child, {
      onStderrLine: (line) => {
        const diagnostic = parseACodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // 根因：只保存 exit tail 会漏掉存活 runtime 的异常；此旁路不依赖 debug 开关。
          // 身份绑定创建时的 child，不能查当前 workspace，避免重启后的迟到事件串进程。
          // workspace/generation 读 managed 当前值:备件认领后异常必须归属真实 workspace
          // (spec: agent-process-prewarm.md R2)。
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: engineId,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: managed.workspace.workspacePath,
              runtimeGeneration: managed.runtimeIdentity.generation,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // 脱敏占位符可能比原文长，必须再次限长，避免 IPC schema 拒绝合法异常。
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ACODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ACODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ACODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // POSIX 下 child 由本 manager 以 detached=true 启动，pid 同时就是 Host
      // 拥有的独立 PGID；异常 root exit 后 cleanup 仍可按组回收同组后代。
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ACodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    // Agent 进程重启后，Host 仍需要 runtime identity 区分新旧订阅和运行命令。
    // Provider Registry 由新 Worker 从所属 Environment 的 Config 重建，不再由 UI 重新下发。
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // 生命周期事件关联只需要本次 runtime 的不透明身份，不能复用包含 workspaceKey 的协议 identity。
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ACodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const managed: ManagedACodeAgentProcess = {
      child,
      client,
      engineId,
      exited: false,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspaceKey,
      ...(prewarmFacts ? { prewarm: { claimed: false, facts: prewarmFacts } } : {}),
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      // 登记/发布 key 读 managed 当前值:备件认领后 storage 事件必须归属真实 workspace。
      const currentWorkspaceKey = managed.workspaceKey;
      if (this.processesByWorkspaceKey.get(currentWorkspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(managed);
      }
      this.storageStartupEmitter.fire({
        workspaceKey: currentWorkspaceKey,
        snapshot: {
          generation: managed.runtimeIdentity.generation,
          state: client.storageStartup.snapshot ?? null,
        },
      });
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(managed));
    }
    // chat lane 空闲回收(spec: packages/services/specs/chat-lane-idle-reclaim.md R3):
    // CLI 完成静默自检后在退出前宣告;Host 据此建立 expected 终止意图,随后的
    // protocol close/exit 不再被当作崩溃。宣告帧先于 EOF 到达(stdout 帧序保证),
    // 竞态丢帧由退出码兜底(见 exit handler)。
    client.onNotification((message) => {
      if (message.method !== acodeProtocolNotifications.runtimeIdleExit) return;
      if (this.disposed || managed.exited) return;
      if (this.processesByWorkspaceKey.get(managed.workspaceKey) !== managed) return;
      const parsed = acodeRuntimeIdleExitParamsSchema.safeParse(message.params);
      if (!parsed.success) {
        warnLog("忽略非法 runtime/idleExit 宣告帧", {
          workspaceKey: managed.workspaceKey,
          pid: child.pid,
          issues: parsed.error.issues.map((issue) => issue.code),
        });
        return;
      }
      // 已有终止意图(app quit / watchdog 等)优先;宣告帧不改写既有根因事实。
      if (managed.terminationIntent) return;
      managed.idleExitAnnounced = {
        quiescentMs: parsed.data.quiescentMs,
        announcedAt: Date.now(),
      };
      this.recordTerminationIntent(managed, "cli-idle-exit");
      log("ACode agent announced idle exit", {
        workspaceKey: managed.workspaceKey,
        pid: child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        quiescentMs: parsed.data.quiescentMs,
      });
      // 宽限:宣告后 CLI 走 1.5s 退出链;超时未退说明退出路径卡死,主动回收防悬挂。
      const graceTimer = setTimeout(() => {
        if (this.disposed || managed.exited) return;
        if (this.processesByWorkspaceKey.get(managed.workspaceKey) !== managed) return;
        warnLog("ACode agent idle-exit grace elapsed; reclaiming", {
          workspaceKey: managed.workspaceKey,
          pid: child.pid,
          graceMs: ACODE_AGENT_IDLE_EXIT_GRACE_MS,
        });
        this.processesByWorkspaceKey.delete(managed.workspaceKey);
        this.reportRuntimeUnavailable(managed);
        void this.cleanupManagedProcessWithRetry(
          managed,
          "idle-timeout",
          "idle-timeout-retry",
          "idle exit grace",
        ).catch(() => undefined);
      }, ACODE_AGENT_IDLE_EXIT_GRACE_MS);
      // 宽限计时器不能把 host 进程钉在事件循环里(与空闲回收计时器同规则)。
      graceTimer.unref?.();
      child.once("exit", () => clearTimeout(graceTimer));
    });
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() 会先返回 ChildProcess，再异步报告 cwd/command ENOENT。
      // 旧代码在确认 spawn 成功前就发布 runtimeRestarted，订阅方随即重连并再次触发
      // 启动，最终形成失败启动 -> 假重启 -> 自激风暴。只有 spawn 事件才表示
      // 新 CLI 运行时真实存在，可以安全通知 v4 订阅方重订。
      // 备件在认领前不发布任何真实 workspace 事件(spec: agent-process-prewarm.md R2);
      // 认领早于 spawn 事件的竞态由 claimed 标记接回本发布点,announced 守卫保证恰好一次。
      if (!(managed.prewarm && !managed.prewarm.claimed)) {
        this.announceRuntimeAvailable(managed);
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: engineId,
            ...(this.lane ? { lane: this.lane } : {}),
            // 备件如实上报预热 cwd(待命进程事实);认领后的 exit/exception 归属真实
            // workspace,读 managed 当前值。
            workspacePath: managed.workspace.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration: managed.runtimeIdentity.generation,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ACode agent process started", {
        workspaceKey: managed.workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
        ...(managed.prewarm ? { spare: !managed.prewarm.claimed } : {}),
      });
    });
    child.once("error", (error) => {
      // 备件失败归因:池的熔断 warn 只带白名单收窄后的 error name(spec R3/R4)。
      if (managed.prewarm) {
        managed.prewarm.errorName = error.name;
      }
      errorLog(
        `ACode agent process error${this.processLifecycleReporter?.onError ? ` ${ACODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey: managed.workspaceKey,
          pid: child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: engineId,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: managed.workspace.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration: managed.runtimeIdentity.generation,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      managed.exited = true;
      this.clearIdleTimer(managed);
      const endedAt = Date.now();
      // 空闲退出兜底归因(spec: chat-lane-idle-reclaim.md R3):宣告帧丢失/与 EOF 竞态时,
      // 保留退出码是受控退出的唯一剩余证据;signal 崩溃 code 为 null,不会误命中。
      const idleExitCodeFallback =
        !managed.terminationIntent && code === ACODE_AGENT_IDLE_EXIT_CODE;
      const terminationKind =
        managed.terminationIntent?.kind ?? (idleExitCodeFallback ? "expected" : "unexpected");
      // 协议解析/stream 故障会先触发 protocol-close，再由 Host 用 SIGTERM
      // 回收仍存活的进程。若只透传主动 termination intent，desktop 只能看到最终信号，
      // 无法区分协议故障与受控退出；保留首次 cleanup 原因作为结构化根因。
      const terminationReason =
        managed.terminationIntent?.reason ??
        (idleExitCodeFallback ? "cli-idle-exit-code" : managed.firstCleanupReason);
      // 协议已立即失效，但 exit 先于 stderr EOF；保留旧 runtime 闭包身份收齐最后诊断。
      await transport.waitForStderrDrain();
      const stderr = stderrTail.snapshot();
      // 外部引擎（codex/opencode/gemini）多以「未安装/运行时缺失/运行时崩溃」退出。
      // 用镜像 ZCode 的签名表把 stderr tail 归类，便于上层区分「该自动重试」与
      // 「该提示用户安装/配置引擎」。native 通常不命中，保持 unclassified。
      const engineErrorKind =
        terminationKind === "unexpected" && stderr.tail.length > 0
          ? classifyAgentEngineError(stderr.tail.join("\n"))
          : "unclassified";
      const exitContext = {
        workspaceKey: managed.workspaceKey,
        pid: child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        engineId,
        code,
        signal,
        terminationKind,
        terminationReason,
        ...(engineErrorKind !== "unclassified" ? { engineErrorKind } : {}),
        // 未被认领就退出的备件:池按丢失分类补位(spec: agent-process-prewarm.md R4)。
        ...(managed.prewarm && !managed.prewarm.claimed ? { spare: true } : {}),
      };
      // 之前日志只有新的 "process started"，缺少旧 pid 的退出轨迹。
      // agent native crash 后 UI 只会看到 protocol close/Session is not active，无法判断是崩溃还是主动重启。
      log("ACode agent process exited", exitContext);
      if (terminationReason === "cli-idle-exit" || terminationReason === "cli-idle-exit-code") {
        // 与 mcp-status lane 的 "idle timeout; reclaiming" 日志对称的生产可用事件;
        // quiescentMs 来自 CLI 宣告帧,退出码兜底路径无值。
        log("ACode agent process idle-exited", {
          ...exitContext,
          quiescentMs: managed.idleExitAnnounced?.quiescentMs,
          uptimeMs: Math.max(0, endedAt - startedAt),
        });
      }
      if (terminationKind === "unexpected") {
        // Agent 顶层异常只写 stderr 并以非零 code 退出；stderr 过去仅走开发态
        // debug，生产日志只剩 code=1，无法还原异常。不能只按非零 code 判断：signal crash
        // 和长期运行的 Agent 自行 exit 0 同样是非预期退出。
        // 已有独立生命周期事件，显式标记包装日志，避免 Electron 将其再计为 JS 异常。
        errorLog(
          `ACode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ACODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
          {
            ...exitContext,
            stderr,
          },
        );
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onExit({
            pid: child.pid!,
            provider: engineId,
            ...(this.lane ? { lane: this.lane } : {}),
            // 认领改绑后退出必须归属真实 workspace,读 managed 当前值(spec R2)。
            workspacePath: managed.workspace.workspacePath,
            exitCode: code,
            signal,
            endedAt,
            terminationKind,
            runtimeReady: managed.readyAt != null,
            ...(terminationReason ? { terminationReason } : {}),
            runtimeGeneration: managed.runtimeIdentity.generation,
            runtimeInstanceId,
            uptimeMs: Math.max(0, endedAt - startedAt),
            stderrLineCount: stderr.lineCount,
            ...(terminationKind === "unexpected" && stderr.tail.length > 0
              ? { stderrTail: stderr.tail }
              : {}),
          }),
        );
      }
    });
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(managed.workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ACode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey: managed.workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ACode agent request timed out; disposing stale protocol client", {
        workspaceKey: managed.workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(managed.workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout 说明协议请求/响应链路已经不可信。旧实现只 reject 当前请求，
      // 但 child 仍未 exit，后续同 workspace 会继续复用坏 client 并反复超时。
      // 这里主动回收进程树，让下一次 getClient 重新拉起干净的 app-server。
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(managed.workspaceKey) === managed;
      log("ACode agent protocol client closed", {
        workspaceKey: managed.workspaceKey,
        pid: child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(managed.workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // 根 child 的 exit 不等于同组 MCP 后代已退出。即使 protocol close
        // 来自根进程退出，也必须按原进程组完成幂等回收后才能释放 Host 所有权。
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    return client;
  }

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ACodeAgentRuntimeIdentity> {
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity 是查询接口，旧实现却复用了启动型 getClient，
    // 导致 provider 保存等被动探测按 workspace 数量隐式 spawn Agent CLI。
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ACode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    engineId?: ACodeProvider;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ACODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      // 外部引擎未安装时 resolveDefaultACodeAgentCommand 抛 missingBinaryMessage，
      // 这里透传为 canStart.reason，供 UI/诊断 surface「引擎未安装/运行时缺失」。
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose 不能把尚未完成的 start promise 从追踪表中删掉。删除会让
    // recovery/UI 的下一次 getClient 再开一条 spawn，旧 promise 随后又可能越过异步
    // resolve 回写进程池，形成同一 workspace 的 spawn/dispose 风暴。代际检查会让旧
    // promise 在真正 spawn 前失败，finally 再按 promise identity 清理 map。
    if (managed) {
      // restartWorkspaceProcess 只应回收当前 workspace 的 agent。
      // 不能复用 disposeAll，否则会把整个 manager 标记为已关闭，后续首发/预热无法重新拉起。
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ACode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ACode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    // 池先停:dispose 后不得再排程补位;在飞备件 spawn 由 abortAllPendingStarts 中止,
    // 已 spawn 的备件在 ownedProcesses 里随下方循环统一回收(spec R1)。
    this.sparePool?.dispose();
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.sparePool?.dispose();
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // app/host 退出时旧逻辑只同步 dispose client，底层进程树的 SIGKILL 兜底
    // 依赖 unref timer，host 自己退出后 timer 不会再执行，acode-cli 会残留为孤儿进程。
    // 这里让 host 可以等待每个 workspace 的 agent 进程树完成 graceful + force 清理。
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
