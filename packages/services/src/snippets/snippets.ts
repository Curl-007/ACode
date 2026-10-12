import type {
  PromptSnippet,
  PromptSnippetBuiltinEntry,
  PromptSnippetFramework,
  PromptSnippetKind,
} from "@acode/shared";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 用户片段的写入载荷（创建/更新共用；`snippetId` 仅更新时必填）。 */
export interface PromptSnippetWriteParams {
  name: string;
  category: string;
  content: string;
  kind: PromptSnippetKind;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface PromptSnippetListParams {
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface PromptSnippetDeleteParams {
  snippetId: string;
}

export interface PromptSnippetUpdateParams extends PromptSnippetWriteParams {
  snippetId: string;
}

export interface PromptSnippetUseParams {
  snippetId: string;
  /** 内置条目走 `builtin_snippet_usage`，用户片段走 `snippets`。由调用方按条目来源显式声明。 */
  builtin: boolean;
}

export interface PromptSnippetBuiltinUsageEntry {
  snippetId: string;
  useCount: number;
  lastUsedAt: number | null;
}

export interface PromptSnippetsListResult {
  /** 当前 workspaceKey 可见的用户片段（含 `__global__`），已按展示排序。 */
  snippets: PromptSnippet[];
  /** 内置库条目；插件缺失/停用/解析失败时为空数组。 */
  builtinEntries: PromptSnippetBuiltinEntry[];
  /** 内置库整体状态，供 UI 区分「没装」与「解析失败」。 */
  builtinStatus: "ready" | "unavailable" | "loadError";
  /** 内置条目使用计数（独立表），只包含出现过的行。 */
  builtinUsage: PromptSnippetBuiltinUsageEntry[];
  /** 当前工作区探测到的技术栈；探测失败或无命中时为空数组。 */
  frameworks: PromptSnippetFramework[];
}

/**
 * 代码片段 / 快捷短语服务：用户片段的唯一读写入口。
 *
 * UI 不得直接读 SQLite；使用计数也只由本服务在「内容已成功写入输入框」后写入。
 * 本服务不新增任何网络出口，片段只落本机。
 */
export interface ISnippetsService {
  list(params: PromptSnippetListParams): Promise<PromptSnippetsListResult>;
  create(params: PromptSnippetWriteParams): Promise<PromptSnippet>;
  update(params: PromptSnippetUpdateParams): Promise<PromptSnippet>;
  delete(params: PromptSnippetDeleteParams): Promise<void>;
  /**
   * 使用计数自增。`UPDATE ... SET use_count = use_count + 1`，多窗口并发不丢计数；
   * 写失败不得影响插入，调用方只记 warn。
   */
  recordUse(params: PromptSnippetUseParams): Promise<void>;
  /** 技术栈探测；带 60s 内存缓存（按 workspaceKey）。探测失败返回空数组。 */
  detectFrameworks(params: PromptSnippetListParams): Promise<PromptSnippetFramework[]>;
}

export const ISnippetsService = createServiceDescriptor<ISnippetsService>(ServiceChannels.Snippets);
