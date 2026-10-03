import { normalizeLineEndings } from "./edit-matchers.js";

/**
 * ApplyPatch 补丁格式（V4A 风格）的自有解析器与路径提取。
 *
 * 规格：apps/acode-cli/specs/apply-patch-tool.md R1。解析结果供 handler 消费；
 * `extractApplyPatchTargetPaths` 供旁路免疫熔断器（permission/bypass-immune-breakers.ts）
 * 做路径逃逸检查——breaker 必须对**畸形**补丁也尽力提取，所以两者刻意不共用严格解析：
 * 严格解析负责拒绝，宽松提取负责兜底安全。
 */

export interface ApplyPatchHunkLine {
  type: "context" | "remove" | "add";
  text: string;
}

export type ApplyPatchSection =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "update"; path: string; hunks: ApplyPatchHunkLine[][] }
  | { kind: "delete"; path: string }
  | { kind: "move"; from: string; to: string | undefined };

export type ApplyPatchParseFailureCode = "invalid" | "empty";

export type ApplyPatchParseResult =
  | { ok: true; sections: ApplyPatchSection[] }
  | { ok: false; code: ApplyPatchParseFailureCode; reason: string };

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";

interface RawSection {
  kind: ApplyPatchSection["kind"];
  path: string;
  moveTo?: string;
  body: string[];
}

function fail(code: ApplyPatchParseFailureCode, reason: string): ApplyPatchParseResult {
  return { ok: false, code, reason };
}

/** 解析 `***` 指令行；返回 null 表示未知指令。 */
function parseDirective(
  line: string,
): { kind: "add" | "update" | "delete" | "move" | "moveTo"; path: string } | null {
  const patterns = [
    { prefix: "*** Add File: ", kind: "add" as const },
    { prefix: "*** Update File: ", kind: "update" as const },
    { prefix: "*** Delete File: ", kind: "delete" as const },
    { prefix: "*** Move File: ", kind: "move" as const },
    { prefix: "*** Move to: ", kind: "moveTo" as const },
  ];
  for (const { prefix, kind } of patterns) {
    if (line.startsWith(prefix)) {
      const path = line.slice(prefix.length).trim();
      if (path === "") return null;
      return { kind, path };
    }
  }
  return null;
}

function finalizeSection(raw: RawSection): ApplyPatchSection | { error: string } {
  if (raw.kind === "add") {
    const lines: string[] = [];
    for (const bodyLine of raw.body) {
      if (!bodyLine.startsWith("+")) {
        return {
          error: `Every line in an '*** Add File' section must start with '+', got: ${JSON.stringify(bodyLine.slice(0, 80))}`,
        };
      }
      lines.push(bodyLine.slice(1));
    }
    return { kind: "add", path: raw.path, lines };
  }

  if (raw.kind === "delete") {
    const unexpected = raw.body.find((bodyLine) => bodyLine.trim() !== "");
    if (unexpected !== undefined) {
      return {
        error: `'*** Delete File' sections take no body lines, got: ${JSON.stringify(unexpected.slice(0, 80))}`,
      };
    }
    return { kind: "delete", path: raw.path };
  }

  if (raw.kind === "move") {
    const unexpected = raw.body.find((bodyLine) => bodyLine.trim() !== "");
    if (unexpected !== undefined) {
      return {
        error: `Content hunks after '*** Move File' are not supported, got: ${JSON.stringify(unexpected.slice(0, 80))}`,
      };
    }
    return { kind: "move", from: raw.path, to: raw.moveTo };
  }

  // update：body → hunks。`@@` 提示行开新 hunk 且不参与匹配（v1）；hunk 行前缀
  // " "=context、"-"=remove、"+"=add；空行容忍为空的 context 行（模型丢前导空格的常见形态）。
  const hunks: ApplyPatchHunkLine[][] = [];
  let current: ApplyPatchHunkLine[] | undefined;
  for (const bodyLine of raw.body) {
    if (bodyLine.startsWith("@@")) {
      current = [];
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      current = [];
      hunks.push(current);
    }
    if (bodyLine.startsWith(" ")) {
      current.push({ type: "context", text: bodyLine.slice(1) });
    } else if (bodyLine.startsWith("-")) {
      current.push({ type: "remove", text: bodyLine.slice(1) });
    } else if (bodyLine.startsWith("+")) {
      current.push({ type: "add", text: bodyLine.slice(1) });
    } else if (bodyLine === "") {
      current.push({ type: "context", text: "" });
    } else {
      return {
        error: `Malformed hunk line in '*** Update File: ${raw.path}': ${JSON.stringify(bodyLine.slice(0, 80))}. Prefix every line with ' ' (keep), '-' (remove) or '+' (add).`,
      };
    }
  }
  if (hunks.length === 0 || hunks.every((hunk) => hunk.length === 0)) {
    return { error: `'*** Update File: ${raw.path}' has no hunk lines.` };
  }
  return { kind: "update", path: raw.path, hunks: hunks.filter((hunk) => hunk.length > 0) };
}

export function parseApplyPatch(patchText: string): ApplyPatchParseResult {
  const lines = normalizeLineEndings(patchText).split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (lines[index] !== BEGIN_MARKER) {
    return fail("invalid", `Patch must start with '${BEGIN_MARKER}'.`);
  }
  index += 1;

  const raws: RawSection[] = [];
  let current: RawSection | undefined;
  let sawEnd = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === END_MARKER) {
      sawEnd = true;
      index += 1;
      break;
    }
    if (line.startsWith("*** ")) {
      const directive = parseDirective(line);
      if (!directive) {
        return fail("invalid", `Unknown patch directive: ${JSON.stringify(line.slice(0, 80))}`);
      }
      if (directive.kind === "moveTo") {
        if (current?.kind !== "move") {
          return fail("invalid", `'*** Move to:' must directly follow '*** Move File:'.`);
        }
        current.moveTo = directive.path;
        continue;
      }
      if (current) raws.push(current);
      current = { kind: directive.kind, path: directive.path, body: [] };
      continue;
    }
    if (!current) {
      // Begin 与首个 section 之间只容忍空白行。
      if (line.trim() === "") continue;
      return fail(
        "invalid",
        `Patch line outside of a file section: ${JSON.stringify(line.slice(0, 80))}`,
      );
    }
    current.body.push(line);
  }
  if (!sawEnd) {
    return fail("invalid", `Patch must end with '${END_MARKER}'.`);
  }
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() !== "") {
      return fail("invalid", `Unexpected content after '${END_MARKER}'.`);
    }
  }
  if (current) raws.push(current);
  if (raws.length === 0) {
    return fail("empty", "Patch contains no file sections.");
  }

  const sections: ApplyPatchSection[] = [];
  const seenPaths = new Set<string>();
  for (const raw of raws) {
    const finalized = finalizeSection(raw);
    if ("error" in finalized) return fail("invalid", finalized.error);
    // v1 单文件单 section：同一路径出现在多个 section 会造成应用序歧义，直接拒绝。
    const identities =
      finalized.kind === "move" ? [finalized.from, finalized.to] : [finalized.path];
    for (const identity of identities) {
      if (identity === undefined) continue;
      if (seenPaths.has(identity)) {
        return fail(
          "invalid",
          `Path ${JSON.stringify(identity)} appears in multiple sections; combine them into one section.`,
        );
      }
      seenPaths.add(identity);
    }
    sections.push(finalized);
  }
  return { ok: true, sections };
}

// breaker 用宽松提取：不做整体语法校验、不抛错，畸形补丁也尽力把 section 头里的目标
// 路径捞出来（漏提取的兜底是 handler 侧 resolveWorkspacePath 与既有 path-policy）。
const SECTION_PATH_PATTERN = /^\*\*\* (?:Add|Update|Delete|Move) File:[ \t]*(.+?)[ \t]*$/;
const MOVE_TO_PATTERN = /^\*\*\* Move to:[ \t]*(.+?)[ \t]*$/;

export function extractApplyPatchTargetPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const rawLine of patchText.split(/\r?\n/)) {
    const match = SECTION_PATH_PATTERN.exec(rawLine) ?? MOVE_TO_PATTERN.exec(rawLine);
    const candidate = match?.[1]?.trim();
    if (candidate) paths.push(candidate);
  }
  return paths;
}
