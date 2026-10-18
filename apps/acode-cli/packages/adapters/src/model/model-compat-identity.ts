// ============================================================
// 模型身份分类最小面（omp 价值提取波 2 · WI-12）
// ============================================================
// spec: apps/acode-cli/specs/model-compat-flags.md R2。
// omp taxonomy.ts 的最小吸收：class 匹配器 rank exact(4) > bounded(3) > prefix(1) > glob(0)，
// 同 rank 平局取非通配字节更长者，跨 class 平局抛 AmbiguousModelError（fail-closed，
// 禁止静默取先者）。不做 omp 全 taxonomy（namespace 档、identity override、LRU 均不引入）；
// family/revision 只解析暴露，波 2 规则不消费。
// 纯函数直算：解析只发生在 bindModel（每模型一次），非热路径，不加缓存。

/** Provider 配置的 wire API 类型（与 packages/provider 的 api.type 词汇同值，字符串字面量本地承载）。 */
export type ModelWireApiType =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions";

/** 模型 class 词汇（最小版，覆盖 ACode 已接模板；未知一律 unknown，规则不得对 unknown 赋值）。 */
export type ModelClass =
  | "claude"
  | "gpt"
  | "grok"
  | "glm"
  | "kimi"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "mimo"
  | "unknown";

export type ModelMatcherKind = "exact" | "bounded" | "prefix" | "glob";

/** omp MATCHER_RANK 的照抄（无 namespace 档）。 */
export const MATCHER_KIND_RANK: Readonly<Record<ModelMatcherKind, number>> = Object.freeze({
  exact: 4,
  bounded: 3,
  prefix: 1,
  glob: 0,
});

export interface ModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiType: ModelWireApiType;
  /** modelId 最后一个 "/" 之后的段（网关路由前缀剥离），已小写。 */
  readonly bare: string;
  readonly modelClass: ModelClass;
  /** bare 的首个纯字母 token（最小版 family；波 3 再细化）。 */
  readonly family: string | undefined;
  /** bare 中首个 \d+(\.\d+)*（最小版 revision；波 2 规则不消费）。 */
  readonly revision: string | undefined;
}

/** 两个 class 的匹配器同 rank 且同长度命中同一 id（omp AmbiguousIdentityError 对应物）。 */
export class AmbiguousModelError extends Error {
  constructor(
    readonly modelId: string,
    readonly first: ModelClass,
    readonly second: ModelClass,
  ) {
    super(`模型身份歧义：\`${modelId}\` 同时命中 class \`${first}\` 与 \`${second}\` 且等秩`);
    this.name = "AmbiguousModelError";
  }
}

interface ClassMatcher {
  readonly kind: ModelMatcherKind;
  readonly token: string;
}

/**
 * class 词汇表。builtin 模型 id 大小写混用（"GLM-5.3" 与 "glm-5.3" 同族），匹配统一小写。
 * glm 用 bounded（"charglm-4" 等衍生名不得误入 glm class）；qwen 用 prefix（"qwen3.8-max"
 * 数字紧随，bounded 也能中，但 prefix 覆盖 "qwen-" 之外的裸拼写法，与 omp qwen class 一致）。
 */
const CLASS_MATCHERS: readonly (readonly [ModelClass, ClassMatcher])[] = Object.freeze([
  ["claude", { kind: "prefix", token: "claude-" }],
  ["gpt", { kind: "prefix", token: "gpt-" }],
  ["grok", { kind: "prefix", token: "grok-" }],
  ["glm", { kind: "bounded", token: "glm" }],
  ["kimi", { kind: "prefix", token: "kimi-" }],
  ["deepseek", { kind: "prefix", token: "deepseek-" }],
  ["qwen", { kind: "prefix", token: "qwen" }],
  ["minimax", { kind: "prefix", token: "minimax-" }],
  ["mimo", { kind: "prefix", token: "mimo-" }],
]);

export function classifyModel(input: {
  providerId: string;
  modelId: string;
  apiType: ModelWireApiType;
}): ModelIdentity {
  const bare = bareOf(input.modelId).toLowerCase();
  const modelClass = resolveClass(input.modelId, bare);
  return Object.freeze({
    providerId: input.providerId,
    modelId: input.modelId,
    apiType: input.apiType,
    bare,
    modelClass,
    family: resolveFamily(bare),
    revision: resolveRevision(bare),
  });
}

/** 匹配器语义（供规则表复用）：exact/bounded/prefix/glob 对已小写的 bare id。 */
export function matcherHits(kind: ModelMatcherKind, token: string, bare: string): boolean {
  switch (kind) {
    case "exact":
      return bare === token;
    case "bounded":
      return boundedMatch(bare, token);
    case "prefix":
      return bare.startsWith(token);
    case "glob":
      return globMatch(token, bare);
  }
}

/** omp boundedMatch 语义：token 后必须是串尾或 - _ . : 0-9 之一。 */
function boundedMatch(value: string, token: string): boolean {
  if (value === token) return true;
  if (!value.startsWith(token)) return false;
  const next = value.charCodeAt(token.length);
  return (
    next === 45 || // -
    next === 95 || // _
    next === 46 || // .
    next === 58 || // :
    (next >= 48 && next <= 57) // 0-9
  );
}

/** 最小 glob：仅 * 与 ?，逐段贪心回溯（规则表 token 都是短模式，无需编译缓存）。 */
export function globMatch(pattern: string, subject: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < subject.length) {
    const pc = pattern[p];
    if (pc === "*") {
      star = p;
      mark = s;
      p += 1;
      continue;
    }
    if (p < pattern.length && (pc === "?" || pc === subject[s])) {
      p += 1;
      s += 1;
      continue;
    }
    if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
      continue;
    }
    return false;
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function resolveClass(modelId: string, bare: string): ModelClass {
  let winner: { rank: readonly [number, number]; modelClass: ModelClass } | undefined;
  for (const [modelClass, matcher] of CLASS_MATCHERS) {
    if (!matcherHits(matcher.kind, matcher.token, bare)) continue;
    // 平局裁决照抄 omp：rank 高者胜；同 rank 取非通配字节更长者；仍平局 → 抛。
    const rank = [MATCHER_KIND_RANK[matcher.kind], nonWildcardBytes(matcher.token)] as const;
    if (
      winner &&
      winner.rank[0] === rank[0] &&
      winner.rank[1] === rank[1] &&
      winner.modelClass !== modelClass
    ) {
      throw new AmbiguousModelError(modelId, winner.modelClass, modelClass);
    }
    if (
      !winner ||
      winner.rank[0] < rank[0] ||
      (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])
    ) {
      winner = { rank, modelClass };
    }
  }
  return winner?.modelClass ?? "unknown";
}

function nonWildcardBytes(pattern: string): number {
  let count = 0;
  for (const char of pattern) {
    if (char !== "*" && char !== "?") count += 1;
  }
  return count;
}

function bareOf(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

function resolveFamily(bare: string): string | undefined {
  const match = /^[a-z]+/.exec(bare);
  return match?.[0];
}

function resolveRevision(bare: string): string | undefined {
  const match = /\d+(?:\.\d+)*/.exec(bare);
  return match?.[0];
}
