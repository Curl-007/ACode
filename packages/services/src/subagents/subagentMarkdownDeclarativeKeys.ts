// 声明键批② GUI 往返姊妹模块（specs/subagent-declarative-keys.md 接线需求 3）。
// subagentMarkdown.ts 补四组新键后越过 400 行 max-lines ratchet，按仓库拆分先例
// （core hooks runner.ts 拆分 / services 值哈希投影拆分）把新键的往返语义与通用
// frontmatter 标量助手收进本模块；主文件从这里导入，本模块不反向依赖（无模块环）。
//
// 解析语义对齐 runtime 单点 core/subagent/profile-declarative.ts：
// - isolation：裸键/空串视同未声明；非空非法值 = 拒整个 profile（「声明了隔离却
//   静默跑共享 cwd」比不隔离更糟），诊断 code 与 runtime 一致（agent_invalid_isolation），
//   GUI 列表与 CLI 对齐；
// - observer 三键归并防孤儿：无 observer 时 observerMessage/observeSubagents 丢弃
//   （runtime 同样忽略并警告）；
// - initialPrompt/observerMessage 与 description 同约定：解析期把字面 `\n` 还原为
//   换行，序列化期成对转义（往返稳定）；
// - hooks 仅内联 JSON 对象形态：loose frontmatter 对 `{...}` 值走 JSON.parse，
//   多行 YAML block 形态在逐行 loose 解析下会退化成空数组（runtime 判非对象丢弃），
//   非对象值这里同样丢弃（GUI 不呈现 runtime 会拒绝的键）。
import type { AgentIsolationMode, SubAgentConfig } from "@acode/shared";

// isolation 闭集与 runtime 单点同值；GUI 面不引入第二裁决。
const VALID_ISOLATION_MODES = new Set<AgentIsolationMode>(["worktree"]);

export interface DeclarativeRoundtripKeys {
  isolation?: AgentIsolationMode;
  observer?: string;
  observerMessage?: string;
  observeSubagents?: boolean;
  initialPrompt?: string;
  hooks?: Record<string, unknown>;
}

export type ParseDeclarativeRoundtripResult =
  | { keys: DeclarativeRoundtripKeys }
  | { denial: { code: string; message: string } };

export function parseDeclarativeRoundtripKeys(
  frontmatter: Record<string, unknown>,
  path: string,
): ParseDeclarativeRoundtripResult {
  const isolation = parseIsolationMode(frontmatter.isolation);
  if (isolation === "denied") {
    return {
      denial: {
        code: "agent_invalid_isolation",
        message: `Agent frontmatter isolation only supports "worktree": ${path}`,
      },
    };
  }
  const observer = scalarString(frontmatter.observer);
  return {
    keys: {
      ...(isolation ? { isolation } : {}),
      ...(observer ? { observer } : {}),
      ...(observer && scalarString(frontmatter.observerMessage)
        ? { observerMessage: scalarString(frontmatter.observerMessage)!.replace(/\\n/gu, "\n") }
        : {}),
      ...(observer ? optionalBooleanEntry(frontmatter.observeSubagents) : {}),
      ...(scalarString(frontmatter.initialPrompt)
        ? { initialPrompt: scalarString(frontmatter.initialPrompt)!.replace(/\\n/gu, "\n") }
        : {}),
      ...(isObjectRecord(frontmatter.hooks) ? { hooks: frontmatter.hooks } : {}),
    },
  };
}

export function appendDeclarativeRoundtripKeys(
  lines: string[],
  config: SubAgentConfig,
): void {
  // GUI 保存不得再丢这四组键。observer 三键只在 observer 在场时序列化（孤儿键
  // runtime 会丢弃，GUI 不生产）；isolation 是闭集 token，plain 写法即安全。
  if (config.isolation) {
    lines.push(`isolation: ${config.isolation}`);
  }
  if (config.observer) {
    appendQuotedText(lines, "observer", config.observer);
    appendQuotedText(lines, "observerMessage", config.observerMessage);
    if (config.observeSubagents !== undefined) {
      lines.push(`observeSubagents: ${config.observeSubagents ? "true" : "false"}`);
    }
  }
  appendQuotedText(lines, "initialPrompt", config.initialPrompt);
  if (config.hooks && Object.keys(config.hooks).length > 0) {
    // hooks 必须写成**单行内联 JSON**：loose frontmatter 解析器对 `{...}` 值走
    // JSON.parse，而多行 YAML block 形态在逐行 loose 解析下退化成空数组、被
    // runtime 判非对象丢弃（「仅内联 JSON 对象形态」的往返侧原因）。
    lines.push(`hooks: ${JSON.stringify(config.hooks)}`);
  }
}

/** isolation 三态：undefined = 未声明（缺席/裸键/空串）；"denied" = 非空非法值（拒整个 profile）。 */
function parseIsolationMode(value: unknown): AgentIsolationMode | "denied" | undefined {
  if (value === undefined || isEmptyBareFrontmatterValue(value)) return undefined;
  return normalizeEnum(value, VALID_ISOLATION_MODES) ?? "denied";
}

/** 裸键（`key:` 后无值）在 loose 解析器里落为空数组/空串——视同未声明（core isEmptyBareValue 同款）。 */
function isEmptyBareFrontmatterValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "string" && value.trim().length === 0;
}

function optionalBooleanEntry(value: unknown): { observeSubagents: boolean } | Record<string, never> {
  const parsed = parseOptionalBoolean(value);
  return parsed === undefined ? {} : { observeSubagents: parsed };
}

/** 自由文本/单 token 键：手写引号 + escapeYamlString（与 name/description 同配对，解析期还原 \n）。 */
function appendQuotedText(lines: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  lines.push(`${key}: "${escapeYamlString(value)}"`);
}

// ── 通用 frontmatter 标量助手（自主文件迁入，单源；主文件从这里导入）──

export function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeEnum<T extends string>(value: unknown, valid: Set<T>): T | undefined {
  const raw = scalarString(value);
  return raw && valid.has(raw as T) ? (raw as T) : undefined;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
