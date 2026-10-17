// ============================================================
// 技能 paths 触发判定（specs/skill-frontmatter-governance.md R5）
// ============================================================
// 路径触发式渐进披露的消费侧纯函数：模型触碰某文件时，判定哪些声明了 `paths` 的
// 技能应被激活。声明侧归一（花括号展开/剥尾 `/**`）在 adapters
// （adapters/src/skills/path-triggers.ts）；本文件只做判定，输入即
// `governance.pathTriggers` 的归一产物。文件触碰事件源的接线（Read/Edit/Write/
// ApplyPatch → 触发检查 → 清单重建）见 spec R5 接线注记。
//
// 匹配语义对齐参考的 gitignore 风格（ignore 库同构子集）：
// - 含 `/` 的模式锚定工作目录根；不含 `/` 的模式在任意深度按段匹配；
// - `**` 跨段、`*` 段内、`?` 单字符、`{a,b}` 择一（声明侧已展开，这里冗余兼容，
//   展开超预算的模式按字面处理）；
// - 命中目录即命中其下全部（目录级联）；
// - 绝对路径逃逸出工作目录、`..` 上跳、空路径 → 不触发（fail-closed 宁不动作）；
// - `!` 取反模式不支持，按字面处理（登记项）。

import { relative } from "node:path";
import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "../tool/path-normalization.js";

/** 判定侧花括号展开上限（声明侧预算之外的最后防线；超限按字面匹配）。 */
const MATCHER_BRACE_EXPANSION_LIMIT = 64;

export interface SkillPathTriggerInput {
  /** `governance.pathTriggers` 归一产物。 */
  patterns: readonly string[];
  /** 模型触碰的文件路径（绝对或相对工作目录）。 */
  touchedPath: string;
  workingDirectory: string;
}

export function matchesSkillPathTrigger(input: SkillPathTriggerInput): boolean {
  const relativePath = toRelativePosixPath(input.touchedPath, input.workingDirectory);
  if (relativePath === undefined) return false;
  return input.patterns.some((pattern) => matchesPattern(pattern, relativePath));
}

/** 批量判定：返回被 touchedPath 激活的模式子集（接线侧做技能级归并用）。 */
export function matchedSkillPathPatterns(
  patterns: readonly string[],
  touchedPath: string,
  workingDirectory: string,
): string[] {
  const relativePath = toRelativePosixPath(touchedPath, workingDirectory);
  if (relativePath === undefined) return [];
  return patterns.filter((pattern) => matchesPattern(pattern, relativePath));
}

/**
 * 触碰路径 → 工作目录相对的正斜杠形态。逃逸（绝对路径不在工作目录下、`..` 上跳、
 * 空串）返回 undefined——触发判定 fail-closed：宁可不动作，不猜目标。
 * Windows：反斜杠/混合分隔符与 Git Bash 盘符别名（/c/…）经工具路径比较器归一
 * （与 Read/Edit/Write 输入同一归一哲学）；POSIX 上反斜杠是合法文件名字符，不转换。
 */
function toRelativePosixPath(touchedPath: string, workingDirectory: string): string | undefined {
  const trimmed = touchedPath.trim();
  if (trimmed.length === 0) return undefined;
  const isWindows = currentPlatform === "win32";
  const candidate = isWindows ? trimmed.replaceAll("\\", "/") : trimmed;
  const relativePath = (
    isAbsolutePath(candidate)
      ? relative(
          normalizeToolPathForComparison(workingDirectory),
          normalizeToolPathForComparison(trimmed),
        )
      : candidate
  ).replaceAll("\\", "/");
  if (relativePath.length === 0) return undefined;
  if (relativePath === ".." || relativePath.startsWith("../") || isAbsolutePath(relativePath)) {
    return undefined;
  }
  return relativePath;
}

function isAbsolutePath(value: string): boolean {
  // POSIX 绝对路径与 Windows 盘符形（C:/…）；Git Bash 别名形（/c/…）由比较器归位。
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function matchesPattern(pattern: string, relativePath: string): boolean {
  for (const candidate of expandBracesForMatch(pattern)) {
    const normalized = candidate.trim().split("\\").join("/").replace(/^\/+/, "");
    if (normalized.length === 0) continue;
    // 目录形（尾 `/`）与一般模式统一走「命中本体或命中其前缀目录」的级联语义。
    const body = normalized.replace(/\/+$/, "");
    if (body.length === 0) continue;
    const regex = patternToRegExp(body);
    if (regex.test(relativePath)) return true;
  }
  return false;
}

function patternToRegExp(pattern: string): RegExp {
  // gitignore 锚定规则：含 `/` 的模式锚根；否则任意深度按段匹配。
  const anchored = pattern.includes("/");
  const prefix = anchored ? "^" : "^(?:[^/]+/)*";
  // 目录级联：命中目录本身即命中其下全部路径。
  return new RegExp(`${prefix}${globToRegExpSource(pattern)}(?:/.*)?$`);
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const rest = pattern.slice(index);
    if (rest.startsWith("**/")) {
      // `a/**/b` 匹配 a/b、a/x/b、a/x/y/b（零或多段）。
      source += "(?:[^/]+/)*";
      index += 3;
      continue;
    }
    if (rest.startsWith("**")) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] ?? "";
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    index += 1;
  }
  return source;
}

function expandBracesForMatch(pattern: string): string[] {
  if (!pattern.includes("{")) return [pattern];
  const results: string[] = [];
  const pending = [pattern];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const match = /^([^{]*)\{([^}]+)\}(.*)$/.exec(current);
    if (!match) {
      results.push(current);
      continue;
    }
    if (results.length + pending.length > MATCHER_BRACE_EXPANSION_LIMIT) {
      // 超预算：剩余含花括号的形态按字面处理（`{`/`}` 会被转义成字面字符）。
      results.push(current);
      continue;
    }
    const [, head = "", body = "", tail = ""] = match;
    for (const option of body.split(",")) {
      pending.push(`${head}${option.trim()}${tail}`);
    }
  }
  return results;
}
