import { spawn } from "node:child_process";
import {
  DEFAULT_GIT_DISCOVERY_TIMEOUT_MS,
  getGitBinaryCandidates,
  getGitCommandEnv,
  type GitCommandEnvOptions,
} from "../config.js";

export interface GitEnvironmentProvider {
  resolveGitBinary(): Promise<string | null>;
  /**
   * options 透传给 getGitCommandEnv（按调用点协议放行，specs/git-hardening-presets.md
   * P1/P6）：缺省 = 协议全拒。无参 fake 实现仍类型兼容（可选参数）。
   */
  createCommandEnv(options?: GitCommandEnvOptions): NodeJS.ProcessEnv;
}

async function canExecuteGitCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function createGitEnvironmentProvider(): GitEnvironmentProvider {
  let cachedGitBinaryPromise: Promise<string | null> | null = null;

  return {
    async resolveGitBinary(): Promise<string | null> {
      if (cachedGitBinaryPromise) {
        return await cachedGitBinaryPromise;
      }

      const env = getGitCommandEnv();
      // Git binary 的探测在一次会话里不会频繁变化，
      // 这里缓存第一次探测结果，避免每个 Git RPC 都重复打一遍 `git --version`。
      cachedGitBinaryPromise = (async () => {
        for (const candidate of getGitBinaryCandidates()) {
          if (await canExecuteGitCandidate(candidate, env)) {
            return candidate;
          }
        }
        return null;
      })();

      return await cachedGitBinaryPromise;
    },

    createCommandEnv(options?: GitCommandEnvOptions): NodeJS.ProcessEnv {
      return getGitCommandEnv(options);
    },
  };
}
