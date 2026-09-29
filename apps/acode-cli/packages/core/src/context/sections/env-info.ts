// ============================================================
// Environment Info Section Builder
// ============================================================

import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@acode/contracts";
import { estimateTokens } from "../utils.js";

const ENVIRONMENT_HEADING = "# Environment";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
const NODE_VERSION_LABEL = "Node version";
const OPERATING_SYSTEM_LABEL = "Operating system";
const NOT_A_GIT_REPOSITORY = "not a git repository";
const YES_LABEL = "yes";
const NO_LABEL = "no";
// adapters/src/context/index.ts:81 产出的 osVersion 形如 "<platform> <release> <arch>"；
// 采集失败/降级路径（runtime/methods/context.ts:264）填 "unknown"，渲染时按无明细处理。
const UNKNOWN_OS_DETAIL = "unknown";
// P6（方案 §4）：platform 是 Node process.platform 原值；补一行人类可读的系统家族名 + 版本明细，
// 让模型不必自己解析 "win32 10.0.26200 x64"。未收录的平台回落显示原值，不猜家族名。
const OPERATING_SYSTEM_FAMILY_BY_PLATFORM: Readonly<Record<string, string>> = Object.freeze({
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
});
// P6：not-a-git-repo 显式指令段（条件出现，仅非 git 目录渲染）。文本自撰英文
// （prompt-language-policy.md R7）；git 目录的版本控制上下文由 git 快照段承载，不重复。
const NOT_A_GIT_REPOSITORY_INSTRUCTION = [
  `The working directory is ${NOT_A_GIT_REPOSITORY}: there is no history, no diffs, and no blame to consult, and git commands that expect a repository will fail here.`,
  "Do not describe or infer version-control state you cannot observe — if git context matters for the task, say it is unavailable and work from the files themselves.",
].join(" ");
const GIT_SYSTEM_CONTEXT_PREFIX =
  "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";
const CURRENT_BRANCH_LABEL = "Current branch";
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
const GIT_USER_LABEL = "Git user";
const STATUS_LABEL = "Status";
const RECENT_COMMITS_LABEL = "Recent commits";
const CLEAN_GIT_STATUS = "(clean)";
const DIRTY_GIT_STATUS = "(dirty)";
const UNKNOWN_GIT_STATUS = "(unknown)";

export function buildEnvInfoSection(envInfo: EnvInfo, model?: Model): ContextSection {
  const content = buildEnvInfoContent(envInfo, model);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = buildGitSystemContextContent(envInfo);

  return {
    name: "System Context",
    source: "system_context",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(info: EnvInfo, model?: Model): string {
  const hasGitRepository = isEnvInfoGitRepository(info);
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment:",
    `- ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    `- ${IS_GIT_REPOSITORY_LABEL}: ${hasGitRepository ? YES_LABEL : NO_LABEL}`,
    `- ${PLATFORM_LABEL}: ${info.platform}`,
    `- ${SHELL_LABEL}: ${info.shell}`,
    // OS Version 保留原始采集值（与子代理侧 subagent/system-prompt.ts:36 的字段对齐）；
    // Operating system 是 P6 补的人类可读明细行。
    `- ${OS_VERSION_LABEL}: ${info.osVersion}`,
    `- ${OPERATING_SYSTEM_LABEL}: ${describeOperatingSystem(info)}`,
    // P6：Node version 行仅在有值时渲染——contracts 里 nodeVersion 是必填，
    // 但旧环境快照/降级路径可能缺席或为空，宁可缺行也不渲染 "undefined"。
    ...(isNonEmptyText(info.nodeVersion) ? [`- ${NODE_VERSION_LABEL}: ${info.nodeVersion}`] : []),
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model
      ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`]
      : []),
  ];

  // P6：not-a-git-repo 显式指令段条件出现——仅非 git 目录渲染（验收：段落条件出现）。
  if (!hasGitRepository) {
    lines.push("", NOT_A_GIT_REPOSITORY_INSTRUCTION);
  }

  return lines.join("\n");
}

/** 人类可读的系统家族名 + 版本明细，例 "Windows (10.0.26200 x64)"；明细缺席时只给家族名。 */
function describeOperatingSystem(info: EnvInfo): string {
  const family = OPERATING_SYSTEM_FAMILY_BY_PLATFORM[info.platform] ?? info.platform;
  const detail = osVersionDetail(info);
  if (!detail || detail === family) {
    return family;
  }
  return `${family} (${detail})`;
}

/** 从 osVersion 里剥掉与 platform 重复的前缀，只留 release/arch 明细；"unknown" 视为无明细。 */
function osVersionDetail(info: EnvInfo): string {
  const osVersion = isNonEmptyText(info.osVersion) ? info.osVersion.trim() : "";
  if (!osVersion || osVersion === UNKNOWN_OS_DETAIL) {
    return "";
  }
  const platformPrefix = `${info.platform} `;
  return osVersion.startsWith(platformPrefix) ? osVersion.slice(platformPrefix.length).trim() : osVersion;
}

function isNonEmptyText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${CURRENT_BRANCH_LABEL}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${MAIN_BRANCH_LABEL}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${GIT_USER_LABEL}: ${info.gitUser}`);
  }

  lines.push("", `${STATUS_LABEL}:\n${formatGitStatus(info)}`);
  lines.push("", `${RECENT_COMMITS_LABEL}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return DIRTY_GIT_STATUS;
  }
  if (info.gitStatus === "clean") {
    return CLEAN_GIT_STATUS;
  }
  return UNKNOWN_GIT_STATUS;
}

function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}
