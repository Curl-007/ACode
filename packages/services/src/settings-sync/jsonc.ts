// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md R7.5
// JSONC 解析（纯函数，单一实现）：去字符串外的 `//`、`/* */` 注释与尾逗号后再 JSON.parse。
//
// 安全契约（R7.5 / N14）：
// - 注释与尾逗号替换为**等长空白**（注释保留换行），避免破坏行号定位；
// - 解析失败只回 `{ ok: false, line? }`，**绝不**回显 `JSON.parse` 的错误消息——
//   实测 V8 在部分分支会把手把源码片段塞进 message（如 `Unexpected token ',', "{…}" is not valid JSON`），
//   而外部 MCP 配置的 env/header 里可能带凭据，message 一律不得外泄；
// - 空文本（或纯空白）视为「无内容」→ `{ ok: true, value: undefined }`。
export interface JsoncParseSuccess {
  readonly ok: true;
  readonly value: unknown;
}

export interface JsoncParseFailure {
  readonly ok: false;
  /** 尽力而为的行号；部分 V8 错误分支不暴露位置，此时缺省。 */
  readonly line?: number;
}

export type JsoncParseResult = JsoncParseSuccess | JsoncParseFailure;

export function parseJsonc(text: string): JsoncParseResult {
  const stripped = stripComments(text);
  if (!stripped.ok) return stripped;
  const body = removeTrailingCommas(stripped.text);
  if (body.trim().length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    const line = jsonErrorLine(error, body);
    return line === undefined ? { ok: false } : { ok: false, line };
  }
}

/** 去注释：注释字符替换为空白，换行原样保留（保持行号与列距）。 */
function stripComments(text: string): { ok: true; text: string } | JsoncParseFailure {
  const chars = text.split("");
  let index = 0;
  let line = 1;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      if (char === "\n") line += 1;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const startLine = line;
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      let closed = false;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          chars[index] = " ";
          chars[index + 1] = " ";
          index += 2;
          closed = true;
          break;
        }
        if (text[index] === "\n") line += 1;
        else chars[index] = " ";
        index += 1;
      }
      // 未闭合块注释：位置自明（起始行），直接给行号而不借道 error.message。
      if (!closed) return { ok: false, line: startLine };
      continue;
    }
    if (char === "\n") line += 1;
    index += 1;
  }
  return { ok: true, text: chars.join("") };
}

/** 去尾逗号：字符串外的 `,` 若其后（跳过空白）紧跟 `}` 或 `]` 则以空白替换。 */
function removeTrailingCommas(text: string): string {
  const chars = text.split("");
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ",") continue;
    let lookahead = index + 1;
    while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead += 1;
    if (text[lookahead] === "}" || text[lookahead] === "]") chars[index] = " ";
  }
  return chars.join("");
}

/** 只从错误消息里抽行号（`line N` 或 `position N`）；消息本身绝不返回、绝不记录。 */
function jsonErrorLine(error: unknown, text: string): number | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const message = error.message;
  const lineMatch = /line (\d+)/i.exec(message);
  if (lineMatch) {
    const line = Number(lineMatch[1]);
    return Number.isFinite(line) ? line : undefined;
  }
  const positionMatch = /position (\d+)/i.exec(message);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    if (!Number.isFinite(position) || position < 0) return undefined;
    return text.slice(0, Math.min(position, text.length)).split("\n").length;
  }
  return undefined;
}