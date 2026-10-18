// ============================================================
// compat 规则表与解析（omp 价值提取波 2 · WI-12）
// ============================================================
// spec: apps/acode-cli/specs/model-compat-flags.md R3。
// TS 表承载 omp KDL 规则语义（rules/classes/*.kdl、rules/providers/*.kdl 的对应物）：
// 规则 = 身份匹配域 + 稀疏 compat 标志；解析一次性发生在 bindModel（烘焙），请求期零
// 字符串匹配。等秩冲突照抄 omp 纪律：同 rank 同 priority 给同一标志赋不同值 → 抛
// AmbiguousCompatOverlapError（fail-closed），禁止静默覆盖。
// 纪律：业务代码禁止按模型 id 字符串/正则分支，只准消费本模块解析出的结构化标志。

import {
  modelCompatFlagsDataSchema,
  type ModelCompatFlagsData,
  type ResolvedModelCompatData,
} from "@acode/shared/model-config";
import {
  classifyModel,
  matcherHits,
  type ModelClass,
  type ModelMatcherKind,
  type ModelWireApiType,
} from "./model-compat-identity.js";

export interface ModelCompatRuleMatch {
  /** 收窄命中：wire API 类型（缺省 = 不限）。 */
  readonly apiTypes?: readonly ModelWireApiType[];
  /** 收窄命中：精确 providerId（coding-plan 场景预留；缺省 = 不限）。 */
  readonly providerIds?: readonly string[];
  /** class 级匹配（rank 2，omp namespace 档对应物）。 */
  readonly class?: ModelClass;
  /** 模型 id matcher（rank = kind rank：exact 4 / bounded 3 / prefix 1 / glob 0）。 */
  readonly model?: { readonly kind: ModelMatcherKind; readonly token: string };
}

export interface ModelCompatRule extends ModelCompatRuleMatch {
  /** 显式优先级，破同 rank 平局（omp priority=10 模式；缺省 0）。 */
  readonly priority?: number;
  readonly flags: ModelCompatFlagsData;
}

/** 等秩规则给同一标志赋不同值（omp AmbiguousOverlapError 的运行期等价物）。 */
export class AmbiguousCompatOverlapError extends Error {
  constructor(
    readonly modelId: string,
    readonly flag: string,
    readonly first: unknown,
    readonly second: unknown,
  ) {
    super(
      `compat 规则等秩冲突：\`${modelId}\` 的标志 \`${flag}\` 同时被赋 ` +
        `${JSON.stringify(first)} 与 ${JSON.stringify(second)}；用 priority 破平局或修正规则`,
    );
    this.name = "AmbiguousCompatOverlapError";
  }
}

/**
 * 种子规则表（波 2 · 4 条，每条带证据注释；新增规则必须同步补测试——无测试标志 = 未来散落的 if）。
 * 排序不影响语义（冲突由 rank/priority 裁决），但同 rank 合并顺序必须确定 → 解析按表序遍历。
 */
export const MODEL_COMPAT_RULES: readonly ModelCompatRule[] = Object.freeze([
  // S1 · OpenAI 系 tool-call id 档案：^[A-Za-z0-9_-]{1,40}$。
  // 证据：omp rules/providers/openai.kdl:115 uses-openai-tool-call-id-limit #true；
  // ACode core 合成 id 超长——`settings-${randomUUID()}`=45 字符、`launch-${randomUUID()}`=43
  // （core/runtime/methods/dynamic-workflow-run-{settings,start}.ts）、`${id}-media-N` 后缀
  // （core/runtime/helpers/tool-result-media-persistence.ts:61），随历史回放进 OpenAI
  // Responses（builtin 已接 gpt-5.x/6）。xAI grok 无 omp 规则佐证，暂不赋值。
  {
    class: "gpt",
    flags: { toolCallIdProfile: "openai-40" },
  },
  // S2 · kimi-k3 的 chat wire tool 消息必须带 name。
  // 证据：omp rules/providers/factory-droid.kdl:1066 models "kimi-k3" requires-tool-result-name
  // #true；AI SDK openai-compatible 序列化 tool-role 消息只发 {role,tool_call_id,content}
  // 不发 name（@ai-sdk/openai-compatible dist 已核实），Moonshot 系端点要求 name。
  // anthropic 路由的 kimi-k3 body 无 chat 形状，转换器自然 no-op，无需 apiTypes 收窄。
  {
    model: { kind: "bounded", token: "kimi-k3" },
    flags: { requiresToolResultName: true },
  },
  // S3 · 旧式 chat template 只接受一个开头 system（迁移 transform.ts 存量 kind-gate，
  // 赋值面与现状全等：apiType openai-chat-completions ⇔ 旧 providerKind openai-compatible，
  // model-execution.ts toAiSdkProviderConfig 一一映射）。
  {
    apiTypes: ["openai-chat-completions"],
    flags: { singleLeadingSystem: true },
  },
  // S4 · 部分 Anthropic-compatible 服务要求 mid-conversation system content 为纯字符串
  // （迁移 anthropic-stream-compat.ts request 分支，赋值面与现状全等：全部 anthropic-messages）。
  {
    apiTypes: ["anthropic-messages"],
    flags: { requiresStringSystemContent: true },
  },
]);

/** class 级规则的 rank（omp namespace 档）；无 model/class 的 wire 级规则最弱。 */
const CLASS_RULE_RANK = 2;
const WIRE_RULE_RANK = -1;

export function ruleRank(rule: ModelCompatRuleMatch): number {
  if (rule.model) {
    // exact 4 > bounded 3 > prefix 1 > glob 0（identity 模块同一张 rank 表）。
    return matcherRank(rule.model.kind);
  }
  if (rule.class) return CLASS_RULE_RANK;
  return WIRE_RULE_RANK;
}

function matcherRank(kind: ModelMatcherKind): number {
  switch (kind) {
    case "exact":
      return 4;
    case "bounded":
      return 3;
    case "prefix":
      return 1;
    case "glob":
      return 0;
  }
}

export function ruleMatches(
  rule: ModelCompatRuleMatch,
  identity: {
    readonly apiType: ModelWireApiType;
    readonly providerId: string;
    readonly bare: string;
    readonly modelClass: ModelClass;
  },
): boolean {
  if (rule.apiTypes && !rule.apiTypes.includes(identity.apiType)) return false;
  if (rule.providerIds && !rule.providerIds.includes(identity.providerId)) return false;
  if (rule.class && rule.class !== identity.modelClass) return false;
  if (rule.model && !matcherHits(rule.model.kind, rule.model.token.toLowerCase(), identity.bare)) {
    return false;
  }
  // class:"unknown" 不得被 class 级规则命中之外的方式误伤：无匹配域的规则不存在（表校验保证）。
  return true;
}

/**
 * 解析模型的 compat 档案（烘焙入口，bindModel 调用一次）。
 * 合并语义：逐 flag 取最高 rank 赋值；同 rank 取 priority 大者；同 rank 同 priority
 * 赋不同值 → AmbiguousCompatOverlapError；同值幂等。null 与缺省同义（通用行为）。
 */
export function resolveModelCompat(input: {
  providerId: string;
  modelId: string;
  apiType: ModelWireApiType;
}): ResolvedModelCompatData {
  return resolveCompatFromRules(MODEL_COMPAT_RULES, classifyModel(input), input.modelId);
}

/** 纯函数解析核（规则可注入，供单测构造等秩冲突/优先级场景）。 */
export function resolveCompatFromRules(
  rules: readonly ModelCompatRule[],
  identity: {
    readonly apiType: ModelWireApiType;
    readonly providerId: string;
    readonly bare: string;
    readonly modelClass: ModelClass;
  },
  modelId: string,
): ResolvedModelCompatData {
  const values = new Map<string, { rank: number; priority: number; value: unknown }>();

  for (const rule of rules) {
    if (!ruleMatches(rule, identity)) continue;
    const rank = ruleRank(rule);
    const priority = rule.priority ?? 0;
    for (const [flag, raw] of Object.entries(rule.flags)) {
      if (raw === undefined || raw === null) continue;
      const current = values.get(flag);
      if (!current || rank > current.rank || (rank === current.rank && priority > current.priority)) {
        values.set(flag, { rank, priority, value: raw });
        continue;
      }
      if (rank === current.rank && priority === current.priority && current.value !== raw) {
        throw new AmbiguousCompatOverlapError(modelId, flag, current.value, raw);
      }
      // rank/priority 更低，或同值：忽略（幂等合并）。
    }
  }

  return Object.freeze(Object.fromEntries(values.entries().map(([k, v]) => [k, v.value])));
}

/** 管道快速判定：无任何已启用标志 → 直通（不读 body，字节级零变化）。 */
export function hasCompatFlags(flags: ResolvedModelCompatData): boolean {
  return Object.keys(flags).length > 0;
}

// ------------------------------------------------------------
// 加载期校验（"编译期"等价物）：词汇表强制 + 同签名静态冲突检测。
// 模块导入即执行；失败 = 响亮炸（不允许带病表进入运行期）。
// ------------------------------------------------------------
validateModelCompatRules(MODEL_COMPAT_RULES);

/** 纯函数校验核（表可注入，供单测构造非法表）。 */
export function validateModelCompatRules(rules: readonly ModelCompatRule[]): void {
  // 同签名（同匹配域同优先级）规则的 flag 累积值：新规则与累积值冲突即抛，
  // 保证 A=true / B=false 这类传递性冲突不被"只对比首条"漏检。
  const seen = new Map<string, Map<string, unknown>>();
  for (const rule of rules) {
    // 词汇表强制：未知标志 / 非法值在加载期被 zod strict 拒绝。
    modelCompatFlagsDataSchema.parse(rule.flags);
    if (!rule.model && !rule.class && !rule.apiTypes && !rule.providerIds) {
      throw new Error("compat 规则必须至少有一个匹配域（model/class/apiTypes/providerIds）");
    }
    const signature = JSON.stringify({
      apiTypes: rule.apiTypes ?? null,
      providerIds: rule.providerIds ?? null,
      class: rule.class ?? null,
      model: rule.model ?? null,
      priority: rule.priority ?? 0,
    });
    const accumulated = seen.get(signature) ?? new Map<string, unknown>();
    for (const [flag, value] of Object.entries(rule.flags)) {
      if (value === undefined || value === null) continue;
      const previous = accumulated.get(flag);
      if (previous !== undefined && previous !== value) {
        throw new AmbiguousCompatOverlapError(signature, flag, previous, value);
      }
      accumulated.set(flag, value);
    }
    seen.set(signature, accumulated);
  }
}
