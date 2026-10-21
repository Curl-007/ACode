import { spawn } from "node:child_process";
import { applyGitPostureGateway } from "@acode/shared";
import { getCliGitInvocationEnv } from "@acode/shared/node";

const GIT_COMMAND = "git";
const GIT_BRANCH_ARGS = ["symbolic-ref", "--quiet", "--short", "HEAD"];
const DEFAULT_GIT_TIMEOUT_MS = 750;
const DEFAULT_GIT_OUTPUT_LIMIT_BYTES = 512;
const DETACHED_HEAD_LABEL = "HEAD";

type GitCommandResult = {
  exitCode: number | null;
  stdout: string;
};

type GitCommandRunner = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    maxOutputBytes: number;
    timeoutMs: number;
  },
) => Promise<GitCommandResult>;

export async function resolveWorkspaceGitBranch(options: {
  maxOutputBytes?: number;
  runCommand?: GitCommandRunner;
  timeoutMs?: number;
  workspaceDirectory: string;
}): Promise<string | undefined> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const runCommand = options.runCommand ?? runGitCommand;
  // argv posture 网关 read 档（git-invocation-hardening.md R6 消费点 #5）：
  // `-C <dir>` 前缀是网关位置劫持拒绝面，目录定位改由 spawn cwd 承载（非劫持等价物）。
  const result = await runCommand(GIT_COMMAND, applyGitPostureGateway("read", GIT_BRANCH_ARGS), {
    cwd: options.workspaceDirectory,
    maxOutputBytes,
    timeoutMs,
  }).catch(() => ({ exitCode: -1, stdout: "" }));

  if (result.exitCode !== 0) return undefined;

  const branch = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!branch || branch === DETACHED_HEAD_LABEL) return undefined;
  return branch;
}

async function runGitCommand(
  file: string,
  args: string[],
  options: {
    cwd: string;
    maxOutputBytes: number;
    timeoutMs: number;
  },
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        // git 调用硬化漏斗（specs/git-invocation-hardening.md 消费点 #5）：
        // TUI 分支徽标是自动触发的只读面，防弹窗挂死/hooks 停用/防串仓。
        env: getCliGitInvocationEnv(),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: -1, stdout: "" });
      return;
    }

    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish({ exitCode: -1, stdout });
    }, options.timeoutMs);

    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > options.maxOutputBytes) {
        child.kill();
        finish({ exitCode: -1, stdout });
      }
    });
    child.on("error", () => finish({ exitCode: -1, stdout }));
    child.on("close", (exitCode) => finish({ exitCode, stdout }));
  });
}
