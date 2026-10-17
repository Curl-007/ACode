// ============================================================
// Skill `paths` 声明解析（specs/skill-frontmatter-governance.md R5）
// ============================================================
// 声明侧归一：花括号展开（预算双上限，超限原样保留+warn）、剥尾 `/**`、空项丢弃、
// 全 `**` 视为未声明。触发判定（glob × 触碰路径）是消费侧逻辑，在 core
// （core/src/agent/skill-path-triggers.ts）——core 不依赖 adapters，两侧以
// `governance.pathTriggers` 的归一产物为交接面。
// 语法调查依据（还原工程，只读复核）：chunk-z9xtzw2s.js `wRt`/`_`/`j`（列表归一+
// 花括号预算展开）、chunk-9h4eq2mz.js `Iun`（剥尾 `/**`、全 `**` 弃权）。

import type { SkillDiagnostic } from "@acode/contracts";

/** 花括号展开预算（参考同构量级）：结果条数与累计字节双上限，超限不展开。 */
const BRACE_EXPANSION_MAX_RESULTS = 512;
const BRACE_EXPANSION_MAX_BYTES = 65_536;
const MAX_MESSAGE_LENGTH = 120;

export interface PathTriggerParseContext {
  skillName: string;
  path: string;
  diagnostics: SkillDiagnostic[];
}

/**
 * 把 `paths` 的原始条目（列表归一后）整理为触发 glob 声明。
 * 返回 undefined = 未声明（含「全 `**` 无意义声明」的弃权，R5）。
 */
export function parsePathTriggerDeclarations(
  entries: readonly string[],
  context: PathTriggerParseContext,
): string[] | undefined {
  const expanded = entries.flatMap((entry) => expandBraces(entry.trim(), context));
  const patterns = expanded
    .map((entry) => (entry.endsWith("/**") ? entry.slice(0, -3) : entry).trim())
    .filter((entry) => entry.length > 0);
  // 空集或全 `**`（无意义的全命中声明）都视为未声明（参考 Iun 同构；every 对空集
  // 恒真，长度检查冗余）。
  if (patterns.every((pattern) => pattern === "**")) return undefined;
  return patterns;
}

function expandBraces(pattern: string, context: PathTriggerParseContext): string[] {
  if (!pattern.includes("{")) return [pattern];
  const results: string[] = [];
  const pending = [pattern];
  let budgetBytes = BRACE_EXPANSION_MAX_BYTES;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const match = /^([^{]*)\{([^}]+)\}(.*)$/.exec(current);
    if (!match) {
      results.push(current);
      continue;
    }
    const [, head = "", body = "", tail = ""] = match;
    const options = body.split(",").map((option) => option.trim());
    budgetBytes -= current.length;
    const projected = results.length + pending.length + options.length;
    if (budgetBytes < 0 || projected > BRACE_EXPANSION_MAX_RESULTS) {
      // 预算超限：原样保留不展开（参考同构降级）——判定侧把 `{…}` 当字面量，
      // 宁可不触发也不产生组合爆炸。
      context.diagnostics.push({
        code: "skill_frontmatter_value_invalid",
        severity: "warning",
        message:
          `Skill ${context.skillName}: paths brace pattern "${truncate(pattern)}" exceeds ` +
          "the expansion budget; kept unexpanded",
        path: context.path,
        skillName: context.skillName,
      });
      return [pattern];
    }
    for (let index = options.length - 1; index >= 0; index--) {
      pending.push(`${head}${options[index] ?? ""}${tail}`);
    }
  }
  return results;
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH)}…` : value;
}
