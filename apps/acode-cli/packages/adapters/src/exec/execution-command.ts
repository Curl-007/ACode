import { existsSync } from "node:fs";
import { extname } from "node:path";
import { sanitizeACodeRuntimeEnvInPlace } from "@acode/shared";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import {
  resolveEffectiveBashShellSelection,
  type BashShellProvider,
} from "./bash-shell-provider.js";
import { applyExecHijackEnvGuard } from "./exec-hijack-env-guard.js";
import { applyExecutionTextEnv } from "./outputEncoding.js";
import { windowsExecutableCandidates } from "./windows-executable.js";
import type {
  ExecutionCommand,
  ExecutionEnvOverlay,
  ExecutionShellDialect,
} from "@acode/contracts";
import { SESSION_WORKTREE_ENV_KEYS } from "@acode/contracts";

const WINDOWS_COMMAND_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export interface ResolvedSpawnCommand {
  args: string[];
  cwdDialect: ExecutionShellDialect;
  envOverlay?: Record<string, string>;
  file: string;
  shell: boolean | string;
  usesLoginShell?: boolean;
}

export function buildExecutionEnv(
  overlay?: ExecutionEnvOverlay,
  options: {
    network?: NetworkEgressEnvPolicy;
    platform?: NodeJS.Platform;
    processEnv?: NodeJS.ProcessEnv;
    /**
     * 会话 worktree 写围栏 env（specs/session-worktree-lifecycle.md R4-2/R7-5）。
     * undefined = provider 未接线（零行为变化）；在场（含空对象）= 已接线：
     * 名单键（SESSION_WORKTREE_ENV_KEYS）按结果 set/delete——缺席键从继承 env 里
     * 删除，防父进程环境中的陈旧边界值漏给未绑定会话。overlay.set/unset 的显式
     * 意图仍在后应用、保持优先。
     */
    sessionWorktree?: Record<string, string>;
  } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.processEnv ?? process.env;
  const env: Record<string, string> = {};

  if (overlay?.base !== "empty") {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    // Bash/tool 子进程不能直接继承运行时的 NODE_ENV、http_proxy 或证书变量。
    // 网络变量会在 applyNetworkEgressEnv 中从 ACode 内部封存恢复，避免 app/provider 运行时先被污染。
    // 安全加固 P2：Bash 子进程是不可信执行面（模型生成的任意命令），在既有黑名单之上
    // 追加剥离敏感凭据键（AWS_ 前缀、GITHUB_TOKEN、SSH_AUTH_SOCK、_API_KEY 后缀等）；
    // 用户可经 ACODE_TOOL_ENV_INHERIT_ALLOWLIST 显式放行，overlay.set 的显式注入在下方
    // 后置、不受剥离影响。
    sanitizeACodeRuntimeEnvInPlace(env, { stripSensitiveCredentials: true });
    // 安全加固 P2 扩展（specs/subprocess-env-credential-allowlist.md R4，W2-SEC5）：
    // 同一剥离点挂第二类封闭键集——执行劫持向量（代码注入/网络重定向/shell 行为）。
    // 威胁不是泄密而是让子进程执行攻击者代码/降级 TLS；固定黑名单键（NODE_OPTIONS/
    // ELECTRON_RUN_AS_NODE/代理/证书）在上一步已无条件剥离，本键集覆盖其余劫持面，
    // allowlist 语义与凭据类共用 ACODE_TOOL_ENV_INHERIT_ALLOWLIST 通道。必须在
    // applyNetworkEgressEnv 之前执行：代理/CA 的受控重建（ACODE_* 显式来源）后置生效。
    // win32 的 COMSPEC 规范重建（SystemRoot 推导）在 guard 内完成。
    applyExecHijackEnvGuard(env, { platform });
  }

  applyExecutionTextEnv(env, platform);

  applyNetworkEgressEnv(env, {
    network: options.network,
    platform,
    sourceEnv,
    toolEnvPassthrough: overlay?.base !== "empty",
  });

  if (options.sessionWorktree !== undefined) {
    const injected = options.sessionWorktree;
    for (const key of SESSION_WORKTREE_ENV_KEYS) {
      const value = injected[key];
      if (value === undefined) {
        deleteEnvKey(env, key, platform);
      } else {
        setEnvKey(env, key, value, platform);
      }
    }
  }

  for (const key of overlay?.unset ?? []) {
    deleteEnvKey(env, key, platform);
  }

  for (const [key, value] of Object.entries(overlay?.set ?? {})) {
    setEnvKey(env, key, value, platform);
  }

  return env;
}

export function resolveExecutionCommand(
  command: ExecutionCommand,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    resolvedShell?: ResolvedSpawnCommand;
  } = {},
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (command.mode === "shell") {
    if (options.resolvedShell) {
      return applyResolvedShellCommand(options.resolvedShell, command.command);
    }

    if (command.shellProfile === "posix-bash") {
      const resolution = resolveEffectiveBashShellSelection({
        env,
        exists: options.exists,
        override: command.shellOverride,
        platform,
      });
      if (resolution.provider) {
        return createShellProviderCommand(resolution.provider, command.command);
      }
    }

    return {
      args: [],
      cwdDialect: defaultCwdDialect(platform),
      file: command.command,
      shell: resolveShell(command.shell, env, platform),
    };
  }

  if (platform !== "win32") {
    return {
      args: command.args ?? [],
      cwdDialect: "posix",
      file: command.file,
      shell: false,
    };
  }

  const resolvedFile = resolveWindowsExecutable(command.file, {
    cwd: options.cwd,
    env,
    exists: options.exists,
  });
  if (!isWindowsCommandShim(resolvedFile)) {
    return {
      args: command.args ?? [],
      cwdDialect: "cmd",
      file: resolvedFile,
      shell: false,
    };
  }

  // Note: Windows .cmd/.bat shims cannot be spawned directly with shell:false.
  // Route them through cmd.exe while keeping normal .exe argv execution shell-free.
  return {
    args: createCmdShimArgs(resolvedFile, command.args ?? []),
    cwdDialect: "cmd",
    file: getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe",
    shell: false,
  };
}

function createShellProviderCommand(
  provider: BashShellProvider,
  command: string,
): ResolvedSpawnCommand {
  if (provider.dialect === "cmd") {
    return {
      args: [],
      cwdDialect: provider.dialect,
      envOverlay: provider.envOverlay,
      file: command,
      shell: provider.shell,
    };
  }

  return {
    args: ["-c", "-l", command],
    cwdDialect: provider.dialect,
    envOverlay: provider.envOverlay,
    file: provider.file,
    shell: provider.shell,
    usesLoginShell: true,
  };
}

export function setResolvedShellLoginMode(
  resolved: ResolvedSpawnCommand,
  useLoginShell: boolean,
): ResolvedSpawnCommand {
  if (resolved.shell !== false || resolved.args[0] !== "-c") return resolved;
  if (resolved.usesLoginShell !== true) return resolved;

  const command = resolved.args.at(-1) ?? "";
  return {
    ...resolved,
    args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
  };
}

export function applyResolvedShellCommand(
  resolved: ResolvedSpawnCommand,
  command: string,
): ResolvedSpawnCommand {
  if (resolved.cwdDialect === "cmd") {
    return {
      ...resolved,
      args: [],
      file: command,
    };
  }

  if (resolved.shell === false && resolved.args[0] === "-c" && resolved.usesLoginShell === true) {
    const useLoginShell = resolved.args[1] === "-l";
    return {
      ...resolved,
      args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
    };
  }

  return {
    ...resolved,
    args: [],
    file: command,
  };
}

export const applyResolvedShellCommandForTest = applyResolvedShellCommand;

export function defaultCwdDialect(platform: NodeJS.Platform): ExecutionShellDialect {
  return platform === "win32" ? "cmd" : "posix";
}

function resolveShell(
  shell: true | string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): true | string {
  if (typeof shell === "string") return shell;
  if (platform === "win32") {
    return getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe";
  }
  return true;
}

function resolveWindowsExecutable(
  file: string,
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  },
): string {
  const exists = options.exists ?? existsSync;
  const candidates = windowsExecutableCandidates(file, options.env, options.cwd);
  return candidates.find((candidate) => exists(candidate)) ?? file;
}

function isWindowsCommandShim(file: string): boolean {
  return WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(file).toLowerCase());
}

function createCmdShimArgs(file: string, args: string[]): string[] {
  const commandLine = [file, ...args].map(quoteCmdArgument).join(" ");
  return ["/d", "/s", "/c", commandLine];
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(value)) return value;
  return `"${value.replace(/(["%&()<>^|])/g, "^$1")}"`;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
