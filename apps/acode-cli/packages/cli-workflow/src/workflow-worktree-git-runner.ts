import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyGitPostureGateway, type GitPosture } from "@acode/shared";
// env/overlay 面是 node-only，根 barrel 不承载（specs/git-invocation-hardening.md R7）。
import { getCliGitInvocationEnv } from "@acode/shared/node";

/** git 执行结果面（stdout/stderr 文本）。 */
export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/** git 执行面注入点（测试替身）；缺省 execFile("git")。 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

const execFileAsync = promisify(execFile);

/**
 * argv posture 网关接线（apps/acode-cli/specs/git-invocation-hardening.md R6）：
 * 包装 runner，spawn 前把 argv 过 shared 判定器；拒绝 = 调用点编程错误
 * （EGITPOSTURE fail-closed 冒泡，不降级为命令失败）。
 */
export function withGitPosture(posture: GitPosture, git: GitRunner): GitRunner {
  // async 包装：判定器的同步拒绝必须成为 runner 契约的 promise 拒绝，而非同步抛出。
  return async (args, cwd) => git(applyGitPostureGateway(posture, args), cwd);
}

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      // git 调用硬化漏斗（specs/git-invocation-hardening.md 消费点 #4）：
      // workflow worktree 隔离在无人值守路径执行，防弹窗挂死/hooks 停用/防串仓。
      env: getCliGitInvocationEnv(),
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    // execFile 对非零退出 reject：stderr 优先入错误文本（调用方按文本判别 already-exists/lock 形态）。
    throw new Error(
      String(failure.stderr?.trim() || failure.message || "git command failed").trim(),
    );
  }
};
