// ============================================================
// Prompt File Routing - APPEND_SYSTEM / SYSTEM / TITLE_SYSTEM 文件路由（WI-10 R5）
// ============================================================
//
// Ported from oh-my-pi (MIT) — packages/coding-agent/src/system-prompt.ts +
// main.ts（discoverAppendSystemPromptFile / discoverTitleSystemPromptFile /
// discoverSystemPromptOverride）, Copyright (c) 2025 Mario Zechner & Stencil Labs
//
// 移植说明：omp 走 capability 注册表 + findConfigFile（.omp/.claude 配置基座）；
// ACode 无 capability 面，发现语义收敛为「project walk-up 优先、user 目录兜底」，
// 对齐 ACode AGENTS.md 的 walk-up 惯例与 omp「project beats user」优先级。
// Bun API 降解：Bun.file(...).text() → node:fs/promises readFile（异步 IO），
// 且 readFileText 可注入（测试不触真实盘）。
//
// 语义（specs/stable-prefix-pause-gate.md R5）：
// - APPEND_SYSTEM.md：保留默认提示词只追加 → ContextBuilderConfig.appendSystemPrompt
//   → identity.append 段（registry-main.ts）。
// - SYSTEM.md：替换指令块 → 映射既有 customSystemPrompt 通道（显式 CLI 值优先）。
// - TITLE_SYSTEM.md：会话标题提示词覆盖 → title-generation-sidecar 的
//   SESSION_TITLE_SYSTEM_PROMPT 替代（消费点在 runtime/methods，接线归 runtime
//   所有者，本模块只提供发现+读取）。
// - 全空白文件 = 缺席；读取抛错 = 跳过该候选继续下一优先级，绝不 fail 会话。
// - 不做 include 展开 / 模板渲染：内容逐字返回（用户数据）。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const APPEND_SYSTEM_PROMPT_FILE_NAME = "APPEND_SYSTEM.md";
export const SYSTEM_PROMPT_FILE_NAME = "SYSTEM.md";
export const TITLE_SYSTEM_PROMPT_FILE_NAME = "TITLE_SYSTEM.md";

/** 项目根探测上限：walk-up 最多爬 8 层目录（防 / 一路爬到根扫全盘）。 */
const DEFAULT_PROJECT_WALK_UP_LIMIT = 8;

export type PromptFileScope = "project" | "user";

export interface PromptFileHit {
  /** 命中文件的绝对路径。 */
  path: string;
  /** 逐字内容（未 trim；渲染层自行处理空白）。 */
  content: string;
  scope: PromptFileScope;
}

export interface PromptFileRouting {
  /** APPEND_SYSTEM.md：保留默认提示词只追加。 */
  appendSystem?: PromptFileHit;
  /** SYSTEM.md：替换指令块（映射 customSystemPrompt 通道）。 */
  systemOverride?: PromptFileHit;
  /** TITLE_SYSTEM.md：会话标题提示词覆盖。 */
  titleSystem?: PromptFileHit;
}

export interface PromptFileRoutingOptions {
  /** 会话工作目录（walk-up 起点）。 */
  workingDirectory: string;
  /** 用户配置目录；缺席默认 ~/.acode。 */
  userConfigDir?: string;
  /** walk-up 层数上限；缺席默认 8。 */
  projectWalkUpLimit?: number;
  /** 注入式读文件（测试用）；缺席走 node:fs/promises。 */
  readFileText?: (path: string) => Promise<string>;
  /** 可选诊断出口：非 ENOENT 读取失败 warn；缺席静默。 */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * 解析三类提示词文件路由。每文件名独立解析、互不影响；
 * 优先级 = project（近 cwd 者胜，同层裸文件 > .acode 子目录）> user。
 */
export async function loadPromptFileRouting(
  options: PromptFileRoutingOptions,
): Promise<PromptFileRouting> {
  const [appendSystem, systemOverride, titleSystem] = await Promise.all([
    discoverPromptFile(APPEND_SYSTEM_PROMPT_FILE_NAME, options),
    discoverPromptFile(SYSTEM_PROMPT_FILE_NAME, options),
    discoverPromptFile(TITLE_SYSTEM_PROMPT_FILE_NAME, options),
  ]);
  return {
    ...(appendSystem ? { appendSystem } : {}),
    ...(systemOverride ? { systemOverride } : {}),
    ...(titleSystem ? { titleSystem } : {}),
  };
}

/** 单文件发现：首个「存在且非全空白」的候选即停。 */
export async function discoverPromptFile(
  fileName: string,
  options: PromptFileRoutingOptions,
): Promise<PromptFileHit | undefined> {
  for (const candidate of projectCandidatePaths(fileName, options)) {
    const hit = await tryReadPromptFile(candidate, "project", options);
    if (hit) return hit;
  }
  const userConfigDir = options.userConfigDir ?? join(homedir(), ".acode");
  return tryReadPromptFile(join(userConfigDir, fileName), "user", options);
}

/** project 候选序列：walk-up 每层先裸文件后 .acode 子目录（近 cwd 者权威）。 */
function projectCandidatePaths(
  fileName: string,
  options: PromptFileRoutingOptions,
): string[] {
  const limit = options.projectWalkUpLimit ?? DEFAULT_PROJECT_WALK_UP_LIMIT;
  const candidates: string[] = [];
  let current = resolve(options.workingDirectory);
  for (let depth = 0; depth < limit; depth++) {
    candidates.push(join(current, fileName));
    candidates.push(join(current, ".acode", fileName));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

async function tryReadPromptFile(
  path: string,
  scope: PromptFileScope,
  options: PromptFileRoutingOptions,
): Promise<PromptFileHit | undefined> {
  const read = options.readFileText ?? ((target: string) => readFile(target, "utf8"));
  try {
    const content = await read(path);
    // 全空白文件 = 缺席：不渲染空段、不覆盖更低优先级候选之外的任何面。
    if (!content.trim()) return undefined;
    return { path, content, scope };
  } catch (error) {
    if (!isFileNotFound(error)) {
      // EACCES/EISDIR 等真实读取故障：跳过候选继续下一优先级，warn 留痕。
      options.logger?.warn("Prompt file read failed; candidate skipped", {
        event: "prompt_file.read_failed",
        module: "core.context",
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
