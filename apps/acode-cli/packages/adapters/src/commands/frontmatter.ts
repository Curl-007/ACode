// ============================================================
// Custom command frontmatter 解析helper（自 index.ts 按架构 ratchet 行数门禁抽出，
// 逻辑逐字保留）+ shell 键闭集解析（specs/skill-frontmatter-governance.md R7 ×
// specs/powershell-tool.md 交叉登记的接线面）。
// ============================================================

import { basename } from "node:path";
import type { CustomCommandDiagnostic, CustomCommandShellPreference } from "@acode/contracts";

export function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return content;
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

export function emptyFrontmatter(): { keys: string[]; values: Record<string, string> } {
  return { keys: [], values: {} };
}

export function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: CustomCommandDiagnostic[],
): { keys: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const keys: string[] = [];

  for (const [index, line] of frontmatter.split(/\r?\n/).entries()) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "custom_command_invalid_frontmatter",
        message: `Invalid frontmatter line ${index + 1} in ${basename(path)}`,
        path,
        severity: "warning",
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    keys.push(key);
    values[key] = line.slice(separator + 1).trim();
  }

  return { keys, values };
}

export function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseBoolean(value: string | undefined): boolean {
  const scalar = parseScalar(value)?.toLowerCase();
  return scalar === "true" || scalar === "yes";
}

export function parseList(value: string | undefined): string[] {
  const scalar = parseScalar(value);
  if (!scalar) return [];
  const withoutBrackets = scalar.replace(/^\[/, "").replace(/\]$/, "");
  return withoutBrackets
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * shell 键（R7）：闭集 `bash|powershell`（trim + 小写归一）；空值 → 缺席；非法值 →
 * invalid 原文回传（调用方出 warning 诊断并回落 bash，与技能面 shell 解析同向——
 * 缺省 bash 跨平台一致）。
 */
export function parseCommandShellPreference(value: string | undefined): {
  shell?: CustomCommandShellPreference;
  invalid?: string;
} {
  const scalar = parseScalar(value);
  if (scalar === undefined) return {};
  const normalized = scalar.toLowerCase();
  if (normalized === "bash" || normalized === "powershell") {
    return { shell: normalized };
  }
  return { invalid: scalar };
}
