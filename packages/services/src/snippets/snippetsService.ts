import { randomUUID } from "node:crypto";
import {
  PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY,
  comparePromptSnippetsForDisplay,
  normalizePromptSnippetNameKey,
  resolvePromptSnippetValidationError,
  type PromptSnippet,
  type PromptSnippetFramework,
} from "@acode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ISnippetsService,
  PromptSnippetBuiltinUsageEntry,
  PromptSnippetDeleteParams,
  PromptSnippetListParams,
  PromptSnippetUpdateParams,
  PromptSnippetUseParams,
  PromptSnippetWriteParams,
  PromptSnippetsListResult,
} from "./snippets.js";
import { SnippetsRepo } from "./snippetsRepo.js";
import { detectFrameworks } from "./frameworkDetection.js";
import { loadBuiltinSnippets, type BuiltinSnippetsResult } from "./builtinSnippets.js";

const log = createServiceLogger("snippets");

/** 内置库按进程记忆化：内容只随插件版本变化，不需要每次开面板都读盘。 */
let builtinCache: Promise<BuiltinSnippetsResult> | null = null;

function getBuiltinSnippets(): Promise<BuiltinSnippetsResult> {
  if (!builtinCache) {
    builtinCache = loadBuiltinSnippets().catch((error) => {
      // loadBuiltinSnippets 自身不抛错；这里只是防御，失败后清缓存以便下次重试。
      builtinCache = null;
      log.warn(undefined, "snippets.builtin.load_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { entries: [], status: "loadError" as const };
    });
  }
  return builtinCache;
}

/** 测试用：清掉内置库记忆化，避免跨用例串状态。 */
export function resetBuiltinSnippetsCache(): void {
  builtinCache = null;
}

export interface SnippetsServiceOptions {
  repo?: SnippetsRepo;
  /** 远程工作区：workspacePath 是本机路径，技术栈探测不成立（§4.5）。 */
  isRemote?: boolean;
  now?: () => number;
  generateId?: () => string;
}

export function createSnippetsService(options: SnippetsServiceOptions = {}): ISnippetsService {
  const repo = options.repo ?? new SnippetsRepo();
  const now = options.now ?? (() => Date.now());
  const generateId =
    options.generateId ?? (() => `snp_${randomUUID().replaceAll("-", "").slice(0, 12)}`);

  function resolveWorkspaceKey(params: PromptSnippetListParams): string {
    return (
      params.workspaceIdentity?.trim() ||
      params.workspacePath ||
      PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY
    );
  }

  async function list(params: PromptSnippetListParams): Promise<PromptSnippetsListResult> {
    const workspaceKey = resolveWorkspaceKey(params);
    const [snippets, builtin, builtinUsage, frameworks] = await Promise.all([
      repo.listVisible(workspaceKey),
      getBuiltinSnippets(),
      repo.listBuiltinUsage(),
      detectFrameworksSafe(params, workspaceKey),
    ]);
    return {
      snippets,
      builtinEntries: builtin.entries,
      builtinStatus: builtin.status,
      builtinUsage,
      frameworks,
    };
  }

  async function detectFrameworksSafe(
    params: PromptSnippetListParams,
    workspaceKey: string,
  ): Promise<PromptSnippetFramework[]> {
    if (!params.workspacePath || options.isRemote) {
      return [];
    }
    try {
      const result = await detectFrameworks({
        workspacePath: params.workspacePath,
        workspaceKey,
        now: now(),
      });
      log.debug(undefined, "snippets.framework.detected", {
        workspaceKey,
        frameworks: result.frameworks,
        cached: result.cached,
      });
      return result.frameworks;
    } catch (error) {
      // 探测失败 → framework 分组整体不出现，不影响其他 4 组。
      log.debug(undefined, "snippets.framework.detect_failed", {
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  function assertValid(params: PromptSnippetWriteParams): {
    name: string;
    category: string;
    content: string;
  } {
    const error = resolvePromptSnippetValidationError(params);
    if (error) {
      throw Object.assign(new Error(`snippets.invalid.${error}`), {
        code: `snippets.invalid.${error}`,
      });
    }
    return {
      name: params.name.trim(),
      category: params.category.trim(),
      content: params.content,
    };
  }

  async function create(params: PromptSnippetWriteParams): Promise<PromptSnippet> {
    const fields = assertValid(params);
    const workspaceKey = resolveWorkspaceKey(params);
    const nameKey = normalizePromptSnippetNameKey(fields.name);
    // 同名拒绝（不静默改名）；唯一索引是最终防线，这里给出可读错误。
    if (await repo.findByNameKey(workspaceKey, nameKey)) {
      throw Object.assign(new Error("snippets.error.duplicateName"), {
        code: "snippets.error.duplicateName",
      });
    }
    return repo.insert({
      snippetId: generateId(),
      workspaceKey,
      ...fields,
      kind: params.kind,
      now: now(),
    });
  }

  async function update(params: PromptSnippetUpdateParams): Promise<PromptSnippet> {
    const fields = assertValid(params);
    const existing = await repo.findById(params.snippetId);
    if (!existing) {
      throw Object.assign(new Error("snippets.error.notFound"), {
        code: "snippets.error.notFound",
      });
    }
    const nameKey = normalizePromptSnippetNameKey(fields.name);
    const conflicting = await repo.findByNameKey(existing.workspaceKey, nameKey);
    if (conflicting && conflicting.snippetId !== params.snippetId) {
      throw Object.assign(new Error("snippets.error.duplicateName"), {
        code: "snippets.error.duplicateName",
      });
    }
    // 更新沿用既有 workspace_key 与 use_count/last_used_at（repo 的 UPDATE 不含这两列）。
    const updated = await repo.update({
      snippetId: params.snippetId,
      workspaceKey: existing.workspaceKey,
      ...fields,
      kind: params.kind,
      now: now(),
    });
    if (!updated) {
      throw Object.assign(new Error("snippets.error.notFound"), {
        code: "snippets.error.notFound",
      });
    }
    return updated;
  }

  async function remove(params: PromptSnippetDeleteParams): Promise<void> {
    await repo.deleteById(params.snippetId);
  }

  async function recordUse(params: PromptSnippetUseParams): Promise<void> {
    const timestamp = now();
    if (params.builtin) {
      await repo.incrementBuiltinUseCount(params.snippetId, timestamp);
      return;
    }
    await repo.incrementUseCount(params.snippetId, timestamp);
  }

  async function detectFrameworksOnly(
    params: PromptSnippetListParams,
  ): Promise<PromptSnippetFramework[]> {
    return detectFrameworksSafe(params, resolveWorkspaceKey(params));
  }

  return {
    list,
    create,
    update,
    delete: remove,
    recordUse,
    detectFrameworks: detectFrameworksOnly,
  };
}

/** 展示排序（§3.5）。UI 与服务共用同一比较器，避免两处规则漂移。 */
export function sortPromptSnippetsForDisplay(
  snippets: PromptSnippet[],
  locale: string,
): PromptSnippet[] {
  return [...snippets].sort((left, right) =>
    comparePromptSnippetsForDisplay(
      { id: left.snippetId, name: left.name, useCount: left.useCount, lastUsedAt: left.lastUsedAt },
      {
        id: right.snippetId,
        name: right.name,
        useCount: right.useCount,
        lastUsedAt: right.lastUsedAt,
      },
      locale,
    ),
  );
}

export type { PromptSnippetBuiltinUsageEntry };
