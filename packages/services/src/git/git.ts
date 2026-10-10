import type {
  GitBranchMutationResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitFileChange,
  GitSwitchBranchRequest,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IGitService {
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  push(params: GitPushRequest): Promise<GitPushResult>;
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git, {
  allowedMethods: [
    "getRepositorySummary",
    "getWorkspaceRepositoryInfo",
    "getLocalBranches",
    "getCommitGraph",
    "switchBranch",
    "createBranchAndSwitch",
    "getChanges",
    "getIgnoredPaths",
    "getDiff",
    "getBranchComparison",
    "stagePaths",
    "unstagePaths",
    "discardPaths",
    "generateCommitMessage",
    "commit",
    "push",
    "getIdentity",
    "refresh",
  ],
  argumentValidators: {
    getRepositorySummary: (args) => requireGitParams(args, ["workspacePath"]),
    getWorkspaceRepositoryInfo: (args) => requireGitParams(args, ["workspacePath"]),
    getLocalBranches: (args) => requireGitParams(args, ["workspacePath"]),
    getCommitGraph: (args) => requireGitParams(args, ["workspacePath"]),
    switchBranch: (args) => requireGitParams(args, ["workspacePath", "targetBranchName"]),
    createBranchAndSwitch: (args) => requireGitParams(args, ["workspacePath", "branchName"]),
    getChanges: (args) => requireGitParams(args, ["workspacePath", "sourceId"]),
    getIgnoredPaths: (args) => {
      const value = requireGitParams(args, ["workspacePath"]);
      requireStringArrayField(value, "paths");
    },
    getDiff: (args) => requireGitParams(args, ["workspacePath", "path"]),
    getBranchComparison: (args) => requireGitParams(args, ["workspacePath"]),
    stagePaths: (args) => {
      const value = requireGitParams(args, ["workspacePath"]);
      requireStringArrayField(value, "paths");
    },
    unstagePaths: (args) => {
      const value = requireGitParams(args, ["workspacePath"]);
      requireStringArrayField(value, "paths");
    },
    discardPaths: (args) => {
      const value = requireGitParams(args, ["workspacePath"]);
      requireStringArrayField(value, "paths");
    },
    generateCommitMessage: (args) => requireGitParams(args, ["workspacePath"]),
    commit: (args) => {
      const value = requireGitParams(args, ["workspacePath"]);
      // message 是自由文本内容，非 id/path；保持宽容只校验字符串类型，
      // 空消息等业务约束由 service/git 层负责，避免传输边界误拒。
      if (typeof value.message !== "string") throw new Error("invalid message");
    },
    push: (args) => requireGitParams(args, ["workspacePath"]),
    getIdentity: (args) => requireGitParams(args, ["workspacePath"]),
    refresh: (args) => requireGitParams(args, ["workspacePath"]),
  },
});

// 所有 Git 方法都接收单一 request 对象，且都以 workspacePath 定位仓库。
// 校验器只做顶层确定检查：对象形态 + 明确的必需字符串字段（path/id/分支名/message），
// 不解析 diff/commit 结果等嵌套业务结构，保持宽容以免误伤合法桌面调用。
function requireGitParams(
  args: readonly unknown[],
  requiredStringFields: readonly string[],
): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected a single request object");
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a request object");
  }
  const record = value as Record<string, unknown>;
  for (const field of requiredStringFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(`invalid ${field}`);
    }
  }
  return record;
}

function requireStringArrayField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`invalid ${field}`);
  }
}
