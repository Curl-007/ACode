// ============================================================
// Subagent declarative frontmatter keys（第二批：代理侧）
// (specs/subagent-declarative-keys.md R1/R2/R3/R4/R5)
// ============================================================
//
// 新声明键的解析/校验/诊断单点：isolation: worktree、observer 三键、
// initialPrompt、代理级 hooks。profile.ts 已近 400 行 ratchet 上限，
// 新键解析不进 profile.ts——本模块只做「frontmatter 值 → 声明位」的纯
// 转换与闭集诊断，消费面（runner 的隔离编排 / 观察者孵化）各自持有。
//
// 安全裁决（spec R1）：
// - isolation 非法值 = 拒绝整个 profile（声明了隔离却静默跑共享 cwd 是
//   「假装隔离比不隔离更糟」，session-worktree spec R8 同款）；
// - project 源剥离 hooks（仓库输入不得经 frontmatter 注册命令执行面，
//   与 permissionMode 剥离同款判据）；
// - hooks 畸形 = 丢弃 + 诊断（fail-closed，绝不带病注册）。

/** 声明式文件系统隔离模式（闭集单值；spec R2）。 */
export type AgentIsolationMode = "worktree";

/** observer 三键归并后的内聚声明（spec R3）。 */
export interface SubagentObserverDeclaration {
  /** 观察者代理类型（必须是已注册 profile 名；未注册时孵化降级 warn）。 */
  agentType: string;
  /** 追加在 harness 缺省 preamble 之后的补充说明（observerMessage）。 */
  message?: string;
  /** 本体派生的子代理是否继承其观察者；缺省 true（observeSubagents）。 */
  observeSubagents?: boolean;
}

/**
 * 代理级 hooks 原始声明（形状同 settings.json hooks）。本批只落声明面：
 * 注册/注销在 child 运行期的消费面归 hooks 模块所有权（spec R5，接线项 1）。
 */
export type AgentHooksDeclaration = Readonly<Record<string, unknown>>;

export interface DeclarativeAgentKeys {
  hooks?: AgentHooksDeclaration;
  initialPrompt?: string;
  isolation?: AgentIsolationMode;
  observer?: SubagentObserverDeclaration;
}

export interface DeclarativeKeysDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface ParseDeclarativeAgentKeysResult {
  keys: DeclarativeAgentKeys;
  /** 致命：整个 profile 拒绝装配（isolation 非法值）。 */
  denial?: DeclarativeKeysDiagnostic;
  /** 非致命：键丢弃 + 提示（hooks 畸形 / observer 孤儿键）。 */
  warning?: DeclarativeKeysDiagnostic;
}

const VALID_ISOLATION_MODES: ReadonlySet<string> = new Set(["worktree"]);

/**
 * 解析新声明键。diagnostic 优先级（spec R1）：denial（isolation）短路返回；
 * 非致命警告单槽，hooks 畸形优先于 observer 孤儿键（profile.ts 侧再与
 * memory 诊断合流：memory > hooks > observer）。
 */
export function parseDeclarativeAgentKeys(
  values: Record<string, unknown>,
  input: { path?: string; source: "built-in" | "project" | "user" },
): ParseDeclarativeAgentKeysResult {
  const where = input.path ?? "<inline>";
  const keys: DeclarativeAgentKeys = {};
  let warning: DeclarativeKeysDiagnostic | undefined;

  // isolation（R2）：空值（裸键/空串）视同未声明；任何非空非法值拒绝整个 profile
  // ——隔离是安全声明，对非法值宽容会让「声明了隔离」的代理静默跑在共享 cwd 上。
  if (values.isolation !== undefined && !isEmptyBareValue(values.isolation)) {
    const isolation = scalarText(values.isolation);
    if (isolation !== undefined && VALID_ISOLATION_MODES.has(isolation)) {
      keys.isolation = isolation as AgentIsolationMode;
    } else {
      const rendered = describeRawValue(values.isolation);
      return {
        keys: {},
        denial: {
          code: "agent_invalid_isolation",
          message: `Agent frontmatter isolation only supports "worktree" (got ${rendered}): ${where}`,
          path: input.path,
        },
      };
    }
  }

  // hooks（R1/R5）：仅内联 JSON 对象形态；project 源剥离（仓库输入不得注册 hooks）。
  if (input.source !== "project" && values.hooks !== undefined) {
    const hooks = values.hooks;
    if (isPlainObject(hooks)) {
      keys.hooks = hooks;
    } else {
      warning = {
        code: "agent_invalid_hooks",
        message: `Agent frontmatter hooks must be an inline JSON object (same shape as settings.json hooks): ${where}`,
        path: input.path,
      };
    }
  }

  // observer 三键（R3）：归并为一个声明对象；孤儿键丢弃 + 警告。
  const observerType = scalarText(values.observer);
  if (observerType !== undefined) {
    const message = scalarText(values.observerMessage);
    const observeSubagents = parseBooleanFlag(values.observeSubagents);
    keys.observer = {
      agentType: observerType,
      ...(message === undefined ? {} : { message }),
      ...(observeSubagents === undefined ? {} : { observeSubagents }),
    };
  } else if (values.observerMessage !== undefined || values.observeSubagents !== undefined) {
    warning ??= {
      code: "agent_observer_declaration_incomplete",
      message: `Agent frontmatter observerMessage/observeSubagents require an observer agent type: ${where}`,
      path: input.path,
    };
  }

  // initialPrompt（R4）：作主会话时自动首发；子代理派发链路零消费。
  const initialPrompt = scalarText(values.initialPrompt);
  if (initialPrompt !== undefined) {
    keys.initialPrompt = initialPrompt;
  }

  return { keys, ...(warning === undefined ? {} : { warning }) };
}

/**
 * 主会话入口的 initialPrompt 解析接口（spec R4）：入口（--agent 类装配面）落地时
 * 调用；trim 后非空才返回。子代理派发链路不得消费本函数（派发 prompt 归调用方）。
 */
export function resolveMainSessionInitialPrompt(profile: {
  initialPrompt?: string;
}): string | undefined {
  const value = profile.initialPrompt?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 与 profile.ts 的 scalarString 同语义（局部复制避免运行时循环 import）。 */
function scalarText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 宽松布尔（与 profile.ts optionalBoolean 同款容忍度）：bool 或 true/false 字面量。 */
function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 裸键（`key:` 后无值）在宽松解析器里落为空数组/空串——视同未声明。 */
function isEmptyBareValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "string" && value.trim().length === 0;
}

/** 诊断消息用的原始值渲染（截断防日志注入刷屏；诊断是本地通道，不进遥测 token 面）。 */
function describeRawValue(value: unknown): string {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length > 60 ? `${rendered.slice(0, 57)}...` : rendered;
}
