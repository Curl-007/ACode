// ============================================================
// Tool Path Policy
// ============================================================

import { isAbsolute, normalize, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@acode/contracts";
import { evaluateSessionWorktreeWriteFence } from "../worktree/session-worktree-fence.js";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: "read" | "write" | "execute";
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(options.workingDirectory, "workingDirectory");
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  //
  // 会话 worktree 写围栏（specs/session-worktree-lifecycle.md R4）是上面这条现状的
  // 唯一例外，且只在会话绑定了受管 worktree 时存在：write 解析后按 workingDirectory
  // 查进程内围栏注册表，命中绑定且目标落在该仓库主 checkout（repoRoot）内 →
  // warn 档记录放行 / enforce 档抛 PermissionDenied（既有权限语义，不另造审批面）。
  // 未绑定会话、read/execute、repoRoot 外路径的行为与改动前逐字节一致。
  if (options.operation === "write") {
    evaluateSessionWorktreeWriteFence({ workingDirectory, targetPath: resolvedPath });
  }
  return resolvedPath;
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
