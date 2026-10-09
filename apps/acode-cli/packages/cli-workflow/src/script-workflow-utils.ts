import type {
  ScriptWorkflowRunStats,
  ScriptWorkflowStorePort,
  SessionId,
  SessionStorePort,
  WorkflowAgentCallInput,
} from "@acode/contracts";
import {
  formatViolations,
  validate as validateJsonSchema,
  type JsonSchema,
} from "@acode/dynamic-workflow";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const STRUCTURED_OUTPUT_PROMPT =
  "Return only JSON that conforms to the provided JSON Schema. Do not wrap it in Markdown.";

const WORKFLOW_SCHEMA_KEYS = new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "anyOf",
  "const",
  "default",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "prefixItems",
  "properties",
  "required",
  "type",
]);
const WORKFLOW_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

export class WorkflowLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveAcquire) => this.queue.push(resolveAcquire));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

export function buildAgentPrompt(input: WorkflowAgentCallInput): string {
  const blocks = [];
  if (input.opts?.instructions) blocks.push(input.opts.instructions);
  if (input.opts?.skills?.length) {
    blocks.push(`Use these skills if they are available: ${input.opts.skills.join(", ")}`);
  }
  blocks.push(input.prompt);
  if (input.opts?.schema) {
    const schema = assertWorkflowOutputSchema(input.opts.schema);
    blocks.push(`${STRUCTURED_OUTPUT_PROMPT}\nSchema:\n${JSON.stringify(schema)}`);
  }
  return blocks.join("\n\n");
}

/**
 * Script workflows use the same deliberately small JSON Schema subset as the
 * dynamic workflow compiler. The check happens before starting a child and
 * again on the parsed response so malformed schemas and malformed model output
 * both fail closed at the workflow boundary.
 */
export function assertWorkflowOutputSchema(value: unknown): JsonSchema {
  const errors: string[] = [];
  inspectWorkflowSchema(value, "$", errors, new Set());
  if (errors.length > 0) throw new Error(`Invalid workflow output schema: ${errors[0]}`);
  return value as JsonSchema;
}

export function parseStructuredResponse(response: string, schema?: unknown): unknown {
  const candidate = extractJsonResponse(response);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    throw new Error("Workflow agent returned non-JSON structured output", { cause: error });
  }
  if (schema !== undefined) {
    const normalized = assertWorkflowOutputSchema(schema);
    const violations = validateJsonSchema(normalized, value);
    if (violations.length > 0) {
      throw new Error(
        `Workflow agent returned JSON that does not conform to schema:\n${formatViolations(violations)}`,
      );
    }
  }
  return value;
}

function inspectWorkflowSchema(
  value: unknown,
  path: string,
  errors: string[],
  visiting: Set<object>,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be a JSON Schema object`);
    return;
  }
  if (visiting.has(value)) {
    errors.push(`${path} contains a cyclic schema object`);
    return;
  }
  visiting.add(value);
  for (const key of Object.keys(value)) {
    if (!WORKFLOW_SCHEMA_KEYS.has(key)) errors.push(`${path}.${key} uses an unsupported keyword`);
  }
  const type = value.type;
  if (
    type !== undefined &&
    !(
      (typeof type === "string" && WORKFLOW_SCHEMA_TYPES.has(type)) ||
      (Array.isArray(type) &&
        type.length > 0 &&
        type.every((item) => typeof item === "string" && WORKFLOW_SCHEMA_TYPES.has(item)))
    )
  ) {
    errors.push(`${path}.type must name a supported JSON type`);
  }
  if (value.$ref !== undefined && typeof value.$ref !== "string") errors.push(`${path}.$ref must be a string`);
  if (value.format !== undefined && typeof value.format !== "string") errors.push(`${path}.format must be a string`);
  if (value.description !== undefined && typeof value.description !== "string")
    errors.push(`${path}.description must be a string`);
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string") errors.push(`${path}.pattern must be a string`);
    else {
      try {
        new RegExp(value.pattern);
      } catch {
        errors.push(`${path}.pattern must be a valid regular expression`);
      }
    }
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    const number = value[key];
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isInteger(number) || number < 0)
    )
      errors.push(`${path}.${key} must be a non-negative integer`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    const number = value[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number)))
      errors.push(`${path}.${key} must be a finite number`);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string"))
      errors.push(`${path}.required must be an array of strings`);
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.every(isJsonValue)))
    errors.push(`${path}.enum must be an array of JSON values`);
  if (value.const !== undefined && !isJsonValue(value.const)) errors.push(`${path}.const must be a JSON value`);
  if (value.default !== undefined && !isJsonValue(value.default)) errors.push(`${path}.default must be a JSON value`);
  inspectSchemaChildren(value, path, errors, visiting);
  visiting.delete(value);
}

function inspectSchemaChildren(
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
  visiting: Set<object>,
): void {
  const properties = schema.properties;
  if (properties !== undefined) {
    if (!isRecord(properties)) errors.push(`${path}.properties must be an object`);
    else for (const [key, child] of Object.entries(properties)) inspectWorkflowSchema(child, `${path}.properties.${key}`, errors, visiting);
  }
  const defs = schema.$defs;
  if (defs !== undefined) {
    if (!isRecord(defs)) errors.push(`${path}.$defs must be an object`);
    else for (const [key, child] of Object.entries(defs)) inspectWorkflowSchema(child, `${path}.$defs.${key}`, errors, visiting);
  }
  const anyOf = schema.anyOf;
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || anyOf.length === 0) errors.push(`${path}.anyOf must contain at least one schema`);
    else anyOf.forEach((child, index) => inspectWorkflowSchema(child, `${path}.anyOf[${index}]`, errors, visiting));
  }
  const prefixItems = schema.prefixItems;
  if (prefixItems !== undefined) {
    if (!Array.isArray(prefixItems)) errors.push(`${path}.prefixItems must be an array`);
    else prefixItems.forEach((child, index) => inspectWorkflowSchema(child, `${path}.prefixItems[${index}]`, errors, visiting));
  }
  for (const key of ["items", "additionalProperties"] as const) {
    const child = schema[key];
    if (child !== undefined && !(key === "additionalProperties" && typeof child === "boolean"))
      inspectWorkflowSchema(child, `${path}.${key}`, errors, visiting);
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function extractJsonResponse(response: string): string {
  const trimmed = response.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const objectStart = firstJsonStart(trimmed);
  if (objectStart < 0) return trimmed;
  const objectEnd = findJsonValueEnd(trimmed, objectStart);
  return objectEnd < 0 ? trimmed : trimmed.slice(objectStart, objectEnd + 1);
}

function firstJsonStart(value: string): number {
  const objectIndex = value.indexOf("{");
  const arrayIndex = value.indexOf("[");
  if (objectIndex < 0) return arrayIndex;
  if (arrayIndex < 0) return objectIndex;
  return Math.min(objectIndex, arrayIndex);
}

function findJsonValueEnd(value: string, start: number): number {
  const stack: string[] = [];
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"' || char === "'") {
      index = scanJsonString(value, index, char);
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function scanJsonString(value: string, start: number, quote: string): number {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index;
  }
  return value.length - 1;
}

export function mergedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isScriptWorkflowStore(
  store: SessionStorePort,
): store is SessionStorePort & ScriptWorkflowStorePort {
  return "createScriptWorkflowRun" in store && "createScriptWorkflowActivity" in store;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

export async function collectScriptWorkflowSessionStats(
  sessionStore: SessionStorePort,
  sessionId: SessionId,
  createEmptyStats: () => ScriptWorkflowRunStats,
): Promise<ScriptWorkflowRunStats> {
  const messages = await sessionStore.messages({ sessionID: sessionId });
  const stats = createEmptyStats();
  stats.agentCalls = 1;
  for (const message of messages) {
    stats.toolCalls += message.parts.filter((part) => part.type === "tool").length;
    if (message.info.role !== "assistant") continue;
    stats.tokens.cacheRead += message.info.tokens.cache.read;
    stats.tokens.cacheWrite += message.info.tokens.cache.write;
    stats.tokens.input += message.info.tokens.input;
    stats.tokens.output += message.info.tokens.output;
    stats.tokens.reasoning += message.info.tokens.reasoning;
    stats.tokens.total +=
      message.info.tokens.total ??
      message.info.tokens.input + message.info.tokens.output + message.info.tokens.reasoning;
  }
  return stats;
}

export function inferScriptWorkflowScope(
  scriptPath: string,
  workingDirectory: string,
): "explicit" | "project" | "user" {
  if (isWithin(scriptPath, join(workingDirectory, ".acode", "workflows"))) return "project";
  if (isWithin(scriptPath, join(homedir(), ".acode", "workflows"))) return "user";
  return "explicit";
}

function isWithin(filePath: string, directory: string): boolean {
  const rel = relative(directory, filePath);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
