import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseModule, type ESTree } from "meriyah";
import {
  WorkflowScriptMetaSchema,
  type FileSystemPort,
  type TraceContext,
  type WorkflowScriptMeta,
} from "@acode/contracts";

const SCRIPT_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkflowScriptDocument {
  body: string;
  content: string;
  hash: string;
  meta: WorkflowScriptMeta;
  path: string;
}

export async function readWorkflowScriptDocument(input: {
  fileSystemPort: FileSystemPort;
  scriptPath: string;
  traceContext: TraceContext;
}): Promise<WorkflowScriptDocument> {
  const scriptPath = resolve(input.scriptPath);
  const script = await input.fileSystemPort.readTextFile({
    maxBytes: SCRIPT_READ_MAX_BYTES,
    path: scriptPath,
    trace: input.traceContext,
  });
  if (script.truncated) {
    throw new Error(`Workflow script is too large: ${scriptPath}`);
  }
  const parts = extractWorkflowScriptParts(script.content);
  const rawMeta = parts.meta;
  const meta = WorkflowScriptMetaSchema.parse(rawMeta);
  return {
    body: parts.body,
    content: script.content,
    hash: stableHash(script.content),
    meta,
    path: scriptPath,
  };
}

export function stableHash(value: unknown): string {
  const content = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractWorkflowScriptParts(source: string): {
  body: string;
  meta: unknown;
} {
  const match = /export\s+const\s+meta\s*=/u.exec(source);
  if (!match) throw new Error("Workflow script must begin with `export const meta = {...}`.");
  let objectStart = match.index + match[0].length;
  while (/\s/u.test(source[objectStart] ?? "")) objectStart += 1;
  if (source[objectStart] !== "{") throw new Error("Workflow meta must be an object literal.");
  const objectEnd = findObjectLiteralEnd(source, objectStart);
  // Parse only the declaration prefix. The body is a function-like DSL and may contain top-level
  // `return`, which is invalid in an ESM Program but valid once inserted into the child wrapper.
  let ast: ESTree.Program;
  try {
    ast = parseModule(`${source.slice(0, objectEnd + 1)};`, { next: true, ranges: true });
  } catch (error) {
    throw new Error(
      `Workflow script syntax is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const first = ast.body[0] as AstNode | undefined;
  const declaration = first?.type === "ExportNamedDeclaration" ? first.declaration : undefined;
  const variable =
    isNode(declaration) && declaration.type === "VariableDeclaration" ? declaration : undefined;
  const declarators = Array.isArray(variable?.declarations) ? variable.declarations : undefined;
  const declarator = declarators?.length === 1 ? (declarators[0] as AstNode) : undefined;
  const id = declarator?.id as AstNode | undefined;
  if (
    first?.type !== "ExportNamedDeclaration" ||
    variable?.kind !== "const" ||
    declarator === undefined ||
    id?.type !== "Identifier" ||
    id.name !== "meta"
  ) {
    throw new Error("Workflow script must begin with `export const meta = {...}`.");
  }
  const init = declarator.init as AstNode | undefined;
  if (!init || init.type !== "ObjectExpression") {
    throw new Error("Workflow meta must be an object literal.");
  }
  const end = typeof init.end === "number" ? init.end : objectEnd;
  const start = typeof init.start === "number" ? init.start : objectStart;
  if (start < 0 || end <= start) throw new Error("Workflow meta object literal is not closed.");
  let bodyStart = end + 1;
  while (/\s/.test(source[bodyStart] ?? "")) bodyStart += 1;
  if (source[bodyStart] === ";") bodyStart += 1;
  return {
    body: source.slice(bodyStart).trimStart(),
    meta: readLiteral(init),
  };
}

function findObjectLiteralEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index = scanString(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = scanLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = scanBlockComment(source, index + 2);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Workflow meta object literal is not closed.");
}

function scanString(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  throw new Error("Workflow meta string literal is not closed.");
}

function scanLineComment(source: string, start: number): number {
  const index = source.indexOf("\n", start);
  return index === -1 ? source.length - 1 : index;
}

function scanBlockComment(source: string, start: number): number {
  const index = source.indexOf("*/", start);
  if (index === -1) throw new Error("Workflow meta block comment is not closed.");
  return index + 1;
}

type AstNode = { [key: string]: unknown; end?: number; start?: number; type?: string };

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function readLiteral(node: AstNode): unknown {
  switch (node.type) {
    case "Literal": {
      const value = node.value;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return value;
      }
      throw new Error("Workflow meta only permits string, number, boolean, or null literals.");
    }
    case "UnaryExpression": {
      const operator = node.operator;
      if (operator !== "-" && operator !== "+") {
        throw new Error(`Workflow meta unary operator is not allowed: ${String(operator)}`);
      }
      const value = readLiteral(node.argument as AstNode);
      if (typeof value !== "number")
        throw new Error("Workflow meta unary literal must be numeric.");
      return operator === "-" ? -value : value;
    }
    case "ArrayExpression": {
      const elements = node.elements;
      if (!Array.isArray(elements)) throw new Error("Workflow meta array is malformed.");
      return elements.map((element) => {
        if (!isNode(element)) throw new Error("Workflow meta array holes are not allowed.");
        return readLiteral(element);
      });
    }
    case "ObjectExpression": {
      const properties = node.properties;
      if (!Array.isArray(properties)) throw new Error("Workflow meta object is malformed.");
      const result: Record<string, unknown> = {};
      for (const property of properties) {
        if (!isNode(property) || property.type !== "Property") {
          throw new Error("Workflow meta spread, methods, and accessors are not allowed.");
        }
        if (property.computed === true || property.method === true || property.kind !== "init") {
          throw new Error("Workflow meta computed keys, methods, and accessors are not allowed.");
        }
        const key = property.key as AstNode;
        const name =
          key?.type === "Identifier"
            ? key.name
            : key?.type === "Literal" && typeof key.value === "string"
              ? key.value
              : undefined;
        if (typeof name !== "string")
          throw new Error("Workflow meta object keys must be literal names.");
        result[name] = readLiteral(property.value as AstNode);
      }
      return result;
    }
    case "TemplateLiteral": {
      const expressions = node.expressions;
      const quasis = node.quasis;
      if (!Array.isArray(expressions) || expressions.length !== 0 || !Array.isArray(quasis)) {
        throw new Error("Workflow meta template interpolation is not allowed.");
      }
      return quasis
        .map((quasi) => (isNode(quasi) && isNode(quasi.value) ? quasi.value.cooked : ""))
        .join("");
    }
    default:
      throw new Error(`Workflow meta expression is not a pure literal: ${String(node.type)}`);
  }
}
